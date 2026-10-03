// Parse orchestrator: drives queued documents through the pipeline with
// progress reporting and bounded concurrency. Local parsing always runs;
// DeepSeek enrichment (when configured) upgrades each chunk.

import { buildChunks, extractTextAsync } from './parser.ts'
import { enrichChunk, type DeepSeekConfig } from './deepseek.ts'
import { enrichChunkViaDsh } from './dsh-llm.ts'
import type { DshLlmRuntime } from './dsh-llm.ts'
import { writeDocExports, groupSections } from './doc-export.ts'
import type { KnowledgeDoc, KnowledgeStore } from './store.ts'
import type { DocStatus, WikiChunk } from './types.ts'

export interface RunnerDeps {
  store: KnowledgeStore
  deepseek: DeepSeekConfig | undefined
  maxConcurrent: number
  /** Host llm service backend (preferred over deepseek when present). */
  dshLlm?: { runtime: DshLlmRuntime; provider: string; model: string }
  /** In-flight enrichment requests per document. */
  enrichConcurrency?: number
  /**
   * Chunks bought per enrichment batch; `<= 0` buys the whole document in one
   * batch. Not a total: `runEnrich` keeps batching until nothing is left.
   */
  maxEnrichChunks?: number
  /**
   * Called whenever a document's chunks reach a new persisted state (first
   * flush, each persistence tick, and the final write). Lets the host keep a
   * retrieval index in step without the runner knowing what one is. Failures
   * are swallowed here — a stale index is a degraded search, not a failed parse.
   *
   * `final` is true only for the authoritative end-of-run write, so an
   * expensive listener can act once instead of on every tick.
   */
  onChunksPersisted?: (docId: string, final: boolean) => void
}

/**
 * Chunks enriched per LLM batch. This used to be the per-document *total*, which
 * meant a 2500-chunk manual could only ever be partly enriched and the user had
 * had to press 增强 repeatedly. It is now only the size of one batch: the runner
 * keeps buying batches until the document has no chunk left, so the number the
 * user sets trades memory/CPU (how much is bought before the first write lands)
 * against nothing else. Raising it just makes each batch bigger.
 */
export const MAX_ENRICH_CHUNKS = 400
/** Default in-flight enrichment requests. */
export const DEFAULT_ENRICH_CONCURRENCY = 4

/**
 * Choose which chunks get an LLM pass when the document exceeds the budget.
 *
 * A flat `chunks.slice(0, budget)` starves the document: the probing run over
 * the StoneOS CLI manual (2534 chunks) collapsed into ~137 sections, so the
 * first 400 chunks reached only ~21 of them and 82% of the mind map's 100
 * displayed sections fell back to a local excerpt — the map looked "only
 * partly enriched" even though 400 provider calls had been spent.
 *
 * So: pass 1 gives EVERY section its opening chunk (this is what makes the
 * outline summaries appear), then pass 2 spends what is left round-robin, so
 * remaining coverage is spread evenly over the whole document instead of
 * piling up in the first chapters. The result is returned in document order so
 * progress reporting stays monotonic and the doc-level summary still comes
 * from the document's beginning.
 */
export function selectEnrichTargets(chunks: WikiChunk[], budget: number): WikiChunk[] {
  if (budget <= 0 || chunks.length <= budget) return chunks
  const groups = groupSections(chunks).map((s) => s.chunks)
  const picked: WikiChunk[] = []
  const cursor = groups.map(() => 0)
  for (let i = 0; i < groups.length && picked.length < budget; i++) {
    if (groups[i].length > 0) {
      picked.push(groups[i][0])
      cursor[i] = 1
    }
  }
  let progressed = true
  while (picked.length < budget && progressed) {
    progressed = false
    for (let i = 0; i < groups.length && picked.length < budget; i++) {
      const at = cursor[i]
      if (at < groups[i].length) {
        picked.push(groups[i][at])
        cursor[i] = at + 1
        progressed = true
      }
    }
  }
  const pos = new Map(chunks.map((c, i) => [c, i]))
  return picked.sort((a, b) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0))
}

/**
 * `Promise.all` with a bounded number of concurrent calls. Order is preserved.
 * `onDone` is awaited-compatible fire-and-forget used for progress reporting.
 * `signal` stops the sweep: already-started calls are still awaited (their
 * results are the ones we want to keep), no *new* call is started.
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onDone?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  const width = Math.max(1, Math.min(limit | 0 || 1, items.length))
  let next = 0
  let done = 0
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
      done++
      onDone?.(done, items.length)
    }
  }
  await Promise.all(Array.from({ length: width }, worker))
  return out
}

/** Everything the runner needs to know about which enrichment backend to use. */
export interface BackendSelection {
  dshLlm?: { runtime: DshLlmRuntime; provider: string; model: string }
  deepseek?: DeepSeekConfig
}

/** Thrown internally to unwind a run the user cancelled. Never escapes `runOne`. */
class Cancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'Cancelled'
  }
}

/**
 * Statuses that mean "a run was in flight when the process went away".
 * `extracted` is absent on purpose: it is a resting state, not a half-finished
 * run — the chunks it describes are already complete on disk, and re-running
 * extraction would only re-derive them.
 */
const RESUMABLE: ReadonlySet<string> = new Set<DocStatus>([
  'queued',
  'extracting',
  'parsing',
  'enriching',
  'indexing',
])

/**
 * One unit of queued work. Extraction and enrichment share a queue (and its
 * concurrency cap) because both are LLM-or-CPU work the user should not have
 * running in unbounded parallel — a bulk enrich of 50 documents would otherwise
 * open 50 documents' worth of provider calls at once.
 */
type WorkItem = { docId: string; phase: 'parse' | 'enrich' }

/**
 * Minimum wall-clock gap between two incremental chunk writes.
 *
 * The index file holds *every* chunk of *every* document, so a flush mid-run
 * rewrites tens of megabytes. Enrichment completes a call every few seconds, so
 * writing on every completion would turn a 15-minute enrichment into a 15-minute
 * disk benchmark. One write every 20s bounds the loss from a hard kill to ~20s
 * of paid-for calls while keeping the write rate negligible.
 */
const PERSIST_MIN_INTERVAL_MS = 20_000

export class ParseRunner {
  private queue: WorkItem[] = []
  private running = 0
  private active = new Set<string>()
  private controllers = new Map<string, AbortController>()

  constructor(private deps: RunnerDeps) {}

  /**
   * Hot-swap the enrichment backend (settings tab: toggle + provider/model).
   * In-flight parses keep the backend they started with; the next parse picks
   * up the new selection.
   */
  setBackend(sel: BackendSelection): void {
    this.deps = { ...this.deps, dshLlm: sel.dshLlm, deepseek: sel.deepseek }
  }

  /**
   * Hot-swap the enrichment budget. Raising it and re-parsing an existing
   * document tops coverage up in batches: chunks that already carry a summary
   * are never paid for twice, so each pass only buys the difference.
   */
  setEnrichBudget(patch: { maxEnrichChunks?: number; enrichConcurrency?: number }): void {
    this.deps = { ...this.deps, ...patch }
  }

  /** Cap the number of documents accepted, so a flood of uploads cannot grow an
   * unbounded in-memory queue (each entry also pins a parse task). */
  private static readonly MAX_QUEUED = 200

  /**
   * Enqueue a freshly-uploaded document for parsing.
   *
   * Duplicates are dropped: a document already waiting, or one whose run has not
   * yet published a result, is not enqueued again. That last case matters
   * because a run publishes `status: 'done'` *before* it finishes writing the
   * markdown and mind-map files, so a "re-parse" request that arrives in that
   * window (a double click, a poller that saw the fresh `done`) must still be
   * accepted — while a request that lands while chunks are still being produced
   * must not, or it would throw away the summaries being paid for right now.
   */
  enqueue(docId: string): boolean {
    return this.push(docId, 'parse')
  }

  /**
   * Queue an enrichment pass for a document.
   *
   * Extraction is deliberately NOT re-run: the chunks are already on disk, so
   * enriching reads them directly. That makes 增强 cheap to re-issue after a
   * cancel, after a provider outage, or simply to top up a document whose
   * earlier run hit the old per-document cap.
   */
  enrich(docId: string): boolean {
    return this.push(docId, 'enrich')
  }

  /**
   * Queue an enrichment pass for every document that still has a chunk without
   * a summary — the 批量增强 button.
   *
   * The filter is deliberately `pendingEnhance > 0` rather than
   * `status !== 'done'`: a document that was interrupted sits in a non-done
   * state but may have nothing left to buy, and a finished one may still be
   * partially enhanced. Asking the store keeps that judgement in one place.
   *
   * Returns the ids it queued so the route can report the count.
   */
  enrichPending(): string[] {
    const ids = this.deps.store
      .listDocs()
      .filter((d) => (d.pendingEnhance ?? 0) > 0)
      .map((d) => d.id)
    for (const id of ids) this.push(id, 'enrich')
    return ids
  }

  /**
   * Append one unit of work, dropping duplicates.
   *
   * A document already waiting is never queued twice. A document whose run is
   * in flight is refused only while that run is still *producing* something
   * (a RESUMABLE status) — a request arriving in the window after `status:
   * 'done'` but before the exports are written is accepted, which is what lets
   * a poller that saw a fresh `done` re-parse without being rejected by the
   * run it just triggered. The one case worth naming: an enrich request for a
   * document mid-enrichment is dropped, because its targets would be recomputed
   * from a half-updated chunk array and paid for twice.
   */
  private push(docId: string, phase: 'parse' | 'enrich'): boolean {
    if (this.queue.length >= ParseRunner.MAX_QUEUED) {
      console.warn(`[dsh-llm-wiki-knowledge] parse queue full (${ParseRunner.MAX_QUEUED}); dropping ${docId}`)
      return false
    }
    if (this.queue.some((q) => q.docId === docId)) return false
    if (this.active.has(docId)) {
      const status = this.deps.store.getDoc(docId)?.status
      // `done`/`error`/`cancelled` mean this run is only finishing its file
      // writes; a run in a RESUMABLE state is still producing chunks.
      if (status && RESUMABLE.has(status)) return false
    }
    this.queue.push({ docId, phase })
    void this.pump()
    return true
  }

  /** True when a run is in flight for this document right now. */
  isActive(docId: string): boolean {
    return this.active.has(docId)
  }

  /**
   * Stop a document. A queued document leaves the queue immediately; a running
   * one is aborted between enrichment calls (an in-flight call is still awaited,
   * so its result is kept and persisted) and the run then unwinds to
   * `status: 'cancelled'`.
   *
   * Cancelling is *not* throwing away work: everything flushed so far stays in
   * the index, and re-issuing 增强 continues from there — the chunks it did NOT
   * pay for are exactly the ones the next pass still buys. So cancelling a
   * 2000-call run after 1800 calls and resuming it costs the remaining 200, not
   * 2000.
   *
   * Returns the state the document ended up in so the HTTP layer can report it.
   */
  cancel(docId: string): 'cancelled' | 'not-running' {
    const wasQueued = this.queue.some((q) => q.docId === docId)
    if (wasQueued) {
      this.queue = this.queue.filter((q) => q.docId !== docId)
      const doc = this.deps.store.getDoc(docId)
      if (doc) this.deps.store.upsertDoc({ ...doc, status: 'cancelled', progress: 0 })
      return 'cancelled'
    }
    const ctl = this.controllers.get(docId)
    if (!ctl) return 'not-running'
    ctl.abort(new Cancelled())
    return 'cancelled'
  }

  /**
   * Re-queue documents whose run was interrupted by a host restart or a crash.
   *
   * Before this existed, a document that was mid-enrichment when the process
   * exited stayed `status: 'enriching'` forever with `chunkCount: 0` and no way
   * out except deleting it — the queue was in-memory only.
   *
   * The phase is recovered from what is on disk, not remembered: a document that
   * reached `saveChunkPatch` has chunks, so its interrupted run was enrichment
   * and is resumed as such — buying only the difference, since the chunks that
   * already carry a summary are skipped. One with no chunks never got past
   * extraction, so extraction simply starts over. Either way the user does not
   * have to notice that a restart happened.
   */
  resumeInterrupted(): string[] {
    const picked: string[] = []
    for (const doc of this.deps.store.listDocs()) {
      if (!RESUMABLE.has(doc.status)) continue
      // A document that never reached chunking has nothing to carry; a
      // `queued` one has no run to resume either — both just start over, which
      // is exactly what the queue was going to do anyway.
      const phase = this.deps.store.getChunks(doc.id).length ? 'enrich' : 'parse'
      picked.push(doc.id)
      this.deps.store.upsertDoc({ ...doc, status: 'queued', progress: 0, error: undefined })
      this.queue.push({ docId: doc.id, phase })
    }
    if (picked.length) {
      console.log(`[dsh-llm-wiki-knowledge] resuming ${picked.length} interrupted document(s): ${picked.join(', ')}`)
    }
    if (picked.length) void this.pump()
    return picked
  }

  /**
   * Apply a patch and return the *merged* record. Callers must carry the result
   * forward (`doc = this.update(...)`): patches are merged onto the record, not
   * onto a run-start snapshot, so earlier fields (e.g. the extraction warning)
   * survive later status updates.
   */
  private update(doc: KnowledgeDoc, patch: Partial<KnowledgeDoc>): KnowledgeDoc {
    const next = { ...doc, ...patch }
    this.deps.store.upsertDoc(next)
    return next
  }

  private async pump(): Promise<void> {
    while (this.queue.length > 0 && this.running < this.deps.maxConcurrent) {
      const item = this.queue.shift()!
      const id = item.docId
      this.active.add(id)
      this.running++
      // Belt and braces: both run phases swallow their own errors, but a throw
      // escaping here becomes an unhandled rejection, which dsh escalates into a
      // fatal host shutdown. Catch so one bad document can never do that.
      const run = item.phase === 'enrich' ? this.runEnrich(id) : this.runOne(id)
      void run.catch((e) => {
        console.error(`[dsh-llm-wiki-knowledge] ${item.phase} task crashed:`, e)
      }).finally(() => {
        this.running--
        this.active.delete(id)
        this.controllers.delete(id)
        void this.pump()
      })
    }
  }

  /** Unwind a cancelled run; kept next to `pump` so the abort path is one read. */
  private checkCancelled(ctl: AbortController): void {
    if (ctl.signal.aborted) throw new Cancelled()
  }

  /**
   * Tell the host a document's chunks changed on disk. Best-effort: a throwing
   * listener must not abort a parse that is otherwise succeeding.
   *
   * `final` distinguishes the authoritative write from the mid-run incremental
   * ones. Re-tokenising a document to refresh a search index is O(chunks) and
   * blocks the event loop — a 2s+ stall for a big manual — so the mid-run
   * flushes only announce *that* something changed and let the host index once,
   * when the run settles.
   */
  private notifyPersisted(docId: string, final = false): void {
    try {
      this.deps.onChunksPersisted?.(docId, final)
    } catch (e) {
      console.warn('[dsh-llm-wiki-knowledge] onChunksPersisted listener failed:', e)
    }
  }

  /** Phase 1: extract text, detect the outline, cut chunks, export. No LLM. */
  private async runOne(docId: string): Promise<void> {
    let doc = this.deps.store.getDoc(docId)
    if (!doc) {
      // The doc vanished before we ran (deleted mid-parse). Drop silently so we
      // don't leave a dangling queued entry or throw on a missing record.
      this.queue = this.queue.filter((q) => q.docId !== docId)
      return
    }
    try {
      const ctl = new AbortController()
      this.controllers.set(docId, ctl)
      doc = this.update(doc, { status: 'extracting', progress: 10, error: undefined })
      const raw = await this.deps.store.readRaw(docId)
      if (!raw) throw new Error('uploaded bytes missing')
      this.checkCancelled(ctl)

      const { text, warning, pages, outline, outlineSource } = await extractTextAsync(
        doc.originalName,
        doc.mime,
        raw,
      )
      // Extraction is the one phase that cannot be interrupted usefully — it is
      // a single in-process call — so the check goes right after it.
      this.checkCancelled(ctl)
      const parsePatch: Partial<KnowledgeDoc> = { status: 'parsing', progress: 30, warning }
      if (outline?.length) {
        parsePatch.outline = outline
        if (outlineSource) parsePatch.outlineSource = outlineSource
      }
      doc = this.update(doc, parsePatch)

      // Page-aware (PDF) documents get section-aligned chunks derived from the
      // real outline; everything else falls back to the text heuristics.
      const localChunks = buildChunks(docId, { text, pages, outline })
      // Re-parsing must not re-pay for chunks that already carry an LLM
      // summary: re-parsing a manual would otherwise spend the same provider
      // calls on the same chunks and add nothing. A summary is carried over
      // when the new chunk contains the old chunk's text verbatim — the
      // extractor rework shifted every boundary, so requiring byte-identical
      // index+text (the old rule) would have thrown away every paid summary.
      const prevEnhanced = (this.deps.store.getChunks(docId) ?? []).filter((c) => !!c.summary)
      const prevByText = new Map(prevEnhanced.map((c) => [c.text, c]))
      const carrySummary = (chunkText: string): string | undefined => {
        const exact = prevByText.get(chunkText)
        if (exact?.summary) return exact.summary
        let best: WikiChunk | undefined
        for (const p of prevEnhanced) {
          // Ignore fragments too short to identify a section (and never let a
          // stale summary land on text it does not cover).
          if (p.text.length < 300 || p.text.length > chunkText.length) continue
          if (!p.summary || !chunkText.includes(p.text)) continue
          if (!best || p.text.length > best.text.length) best = p
        }
        return best?.summary
      }
      const carried: WikiChunk[] = localChunks.map((c) => {
        const summary = carrySummary(c.text)
        return summary ? { ...c, summary } : c
      })
      // Land the chunk set, then publish the document as extracted-and-ready.
      // The `extracted` status is set on the record *before* the final write so
      // that a crash between the two leaves a document whose chunks are on disk
      // and whose status still means "run in flight" — which is exactly what
      // `resumeInterrupted` needs in order to pick it back up as an enrichment.
      this.deps.store.saveChunkPatch(docId, carried)
      doc = this.update(doc, {
        status: 'extracted',
        progress: 40,
        chunkCount: carried.length,
        enhancedChunks: carried.filter((c) => c.summary).length,
      })
      await this.deps.store.flush()
      this.notifyPersisted(docId, false)

      await this.finishDocument(doc, docId, carried)
      await this.deps.store.flush()
    } catch (err) {
      this.failRun(docId, doc, err)
    } finally {
      this.controllers.delete(docId)
    }
  }

  /**
   * Second phase: buy LLM summaries for every chunk that lacks one, in batches
   * of `maxEnrichChunks`, until the document is complete.
   *
   * It is a separate entry point from `runOne` because the two phases have
   * different costs and different triggers. Extraction runs once, automatically,
   * on upload. Enrichment is what the user asks for — per document, or in bulk
   * for everything unenhanced — and it re-reads the chunks already on disk
   * rather than re-extracting, so pressing it twice never re-parses the PDF.
   *
   * Batching matters for two reasons. The first is that a 2500-chunk manual is
   * ~94 minutes of provider time: a single in-memory pass would lose all of it
   * to one crash, whereas each batch lands on disk and the next one re-derives
   * its targets from what is already summarised. The second is ordering: every
   * batch is picked with `selectEnrichTargets`, so pass 1 gives every section its
   * opening chunk — which is exactly what the mind map displays — and later
   * batches deepen coverage. The map therefore fills in chapter by chapter as the
   * run proceeds, instead of the first N chapters being perfect and the rest
   * never being touched.
   */
  private async runEnrich(docId: string): Promise<void> {
    let doc = this.deps.store.getDoc(docId)
    if (!doc) return
    const dsh = this.deps.dshLlm
    const deepseekCfg = this.deps.deepseek
    if (!dsh && !deepseekCfg?.apiKey) {
      // Turning enrichment off is a legitimate setting, not a failure: say so
      // and leave the document readable with its local outline.
      this.update(doc, { error: 'LLM 增强未启用：请在「设置」中打开 LLM 增强并选择 provider/model，再点「开始增强」' })
      return
    }
    const ctl = new AbortController()
    this.controllers.set(docId, ctl)
    try {
      let chunks = this.deps.store.getChunks(docId)
      if (!chunks.length) throw new Error('该文档还没有解析出片段，请先重新解析')
      const batchSize = Math.floor(this.deps.maxEnrichChunks ?? MAX_ENRICH_CHUNKS)
      const limit = this.deps.enrichConcurrency ?? DEFAULT_ENRICH_CONCURRENCY
      const total0 = chunks.length
      doc = this.update(doc, { status: 'enriching', progress: 0, error: undefined })

      // Index of every chunk, so a merged result can be written back by position
      // without re-scanning the array on each of potentially thousands of calls.
      const slot = new Map(chunks.map((c, i) => [c.index, i]))
      const pending: WikiChunk[] = []
      let lastPersist = Date.now()
      const persistPending = (force: boolean): void => {
        if (!pending.length) return
        if (!force && Date.now() - lastPersist < PERSIST_MIN_INTERVAL_MS) return
        const batch = pending.splice(0, pending.length)
        lastPersist = Date.now()
        this.deps.store.saveChunkPatch(docId, batch)
        void this.deps.store.flush()
        this.notifyPersisted(docId, false)
      }

      // Progress is document-wide, not batch-wide: batch 1 of 7 must not show
      // "done" when a third of the document is still unenhanced. `enriched` is
      // count of summarised chunks, so it survives a resume and counts what an
      // earlier run already paid for.
      let enhanced = chunks.filter((c) => c.summary).length
      let progressDoc: KnowledgeDoc = doc
      const publish = (): void => {
        progressDoc = this.update(progressDoc, {
          progress: Math.min(98, Math.round(100 * (enhanced / Math.max(1, total0)))),
          enhancedChunks: enhanced,
        })
        persistPending(false)
      }

      let batchNo = 0
      for (;;) {
        const todo = chunks.filter((c) => !c.summary)
        if (!todo.length) break
        batchNo++
        const batch = batchSize > 0 ? selectEnrichTargets(todo, batchSize) : todo
        console.log(
          `[dsh-llm-wiki-knowledge] enrich ${docId} batch ${batchNo}: ${batch.length} chunk(s) of ${todo.length} remaining`,
        )
        // Counted inside the sweep rather than inferred afterwards, so "this
        // batch bought nothing" is a fact about the batch and not a comparison of
        // two snapshots of the array.
        let gained = 0
        await mapLimit(batch, limit, async (c) => {
          const e = dsh
            ? await enrichChunkViaDsh(
              dsh.runtime,
              { provider: dsh.provider, model: dsh.model },
              ENRICH_SYSTEM,
              `Section title: ${c.title}\n\nSection text:\n${c.text.slice(0, 4000)}`,
              ctl.signal,
            )
            : await enrichChunk(deepseekCfg!, c.title, c.text, ctl.signal)
          // A cancelled or failed call yields nothing; the chunk keeps its local
          // outline/entities, which is the same degradation as a provider outage.
          if (!e || !e.summary) return
          const i = slot.get(c.index)
          if (i === undefined) return
          const base = chunks[i]
          const merged: WikiChunk = {
            ...base,
            summary: e.summary || undefined,
            entities: dedupe([...base.entities, ...e.entities]).slice(0, 12),
            links: dedupe([...base.links, ...e.relations]).slice(0, 8),
          }
          chunks[i] = merged
          pending.push(merged)
          enhanced++
          gained++
        }, (done) => {
          if (done % 5 === 0 || done === batch.length) publish()
        }, ctl.signal)
        // Whatever the sweep managed before the abort still counts.
        persistPending(true)
        this.checkCancelled(ctl)
        publish()
        // A batch that bought no summary at all is a provider outage, not a slow
        // document: looping again would re-ask the same questions forever and
        // spin the queue. Stop, keep what landed, and let the user retry — which
        // they can now do without re-extracting anything.
        if (!gained) {
          console.warn(
            `[dsh-llm-wiki-knowledge] enrich ${docId}: batch ${batchNo} returned no summary for any of ${batch.length} chunk(s); stopping at ${enhanced}/${total0}`,
          )
          doc = this.update(progressDoc, {
            error: `第 ${batchNo} 批 LLM 增强全部失败，仍有 ${chunks.length - enhanced} 个片段未增强；可稍后点「增强」重试`,
          })
          break
        }
      }
      this.checkCancelled(ctl)

      doc = progressDoc
      // Document-level summary comes from the already-merged chunks, so a partial
      // run keeps whatever the earlier batches established.
      const summary = chunks.map((c) => c.summary).filter(Boolean).slice(0, 5).join(' ') || doc.summary || ''
      const enhancedCount = chunks.filter((c) => c.summary).length
      // Drop the previous run's note first: a re-run replaces it instead of
      // stacking a second copy on the document.
      const baseWarn = String(doc.warning ?? '')
        .split('；')
        .map((s) => s.trim())
        .filter((s) => s && !s.startsWith('增强未完成：'))
        .join('；')
      // The old note said "文档较大" because a cap stopped the run part-way. That
      // is no longer what happens — batching runs to completion — so the only
      // incomplete state left is one a provider outage or a stop produced, and
      // the note says so instead of blaming the document's size.
      if (enhancedCount < chunks.length) {
        const sections = groupSections(chunks)
        const covered = sections.filter((s) => s.chunks.some((c) => c.summary)).length
        const note = `增强未完成：${enhancedCount}/${chunks.length} 个片段已有小结（覆盖 ${covered}/${sections.length} 个章节），其余保留本地大纲`
        console.warn(`[dsh-llm-wiki-knowledge] ${note}: ${docId}`)
        doc = this.update(doc, { warning: baseWarn ? `${baseWarn}；${note}` : note })
      } else if (baseWarn !== String(doc.warning ?? '')) {
        doc = this.update(doc, { warning: baseWarn })
      }
      await this.finishDocument(this.update(doc, { enhancedChunks: enhancedCount, summary: summary || undefined }), docId, chunks)
      await this.deps.store.flush()
    } catch (err) {
      this.failRun(docId, doc, err)
    } finally {
      this.controllers.delete(docId)
    }
  }

  /**
   * The common tail of both phases: authoritative chunk write, `done`, retrieval
   * re-index, and the Markdown / mind-map exports.
   *
   * Split out because the two phases reach it from opposite directions and used
   * to be a copy of each other's closing block; keeping one copy is what stops
   * the "enriched" document and the "just extracted" document from drifting
   * apart in their exported files.
   */
  private async finishDocument(doc: KnowledgeDoc, docId: string, chunks: WikiChunk[]): Promise<void> {
    doc = this.update(doc, { status: 'indexing', progress: 99 })
    this.deps.store.saveChunkPatch(docId, chunks)
    // The artifacts are written BEFORE `done` is published, on purpose. `done` is
    // the contract every reader relies on: the UI opens the brain map as soon as
    // it appears, and GET /doc/:id/mindmap serves the file this function writes.
    // Writing them afterwards leaves a window in which a finished document still
    // hands out the previous run's mind map.
    try {
      const ex = await writeDocExports(
        this.deps.store.root,
        doc,
        chunks,
        this.deps.store.otherExportNames(docId),
      )
      doc = this.update(doc, {
        mdFile: ex.mdFile,
        mindmapFile: ex.mindmapFile,
        exportedAt: new Date().toISOString(),
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[dsh-llm-wiki-knowledge] export failed for', docId, e)
      doc = this.update(doc, {
        warning: [doc.warning, `Markdown/脑图导出失败（${msg}）`].filter(Boolean).join('；'),
      })
    }
    doc = this.update(doc, {
      status: 'done',
      progress: 100,
      chunkCount: chunks.length,
      entityCount: new Set(chunks.flatMap((c) => c.entities)).size,
    })
    // Re-index from the final merged chunks, so a search that lands after this
    // returns the enriched summaries.
    this.notifyPersisted(docId, true)
  }

  /**
   * Record a failed or cancelled run. Never throws — see `runOne`'s comment.
   *
   * It is fire-and-forget on purpose: the caller is unwinding a run whose only
   * remaining job is to leave an honest record on disk, and making it awaitable
   * would mean two copies of the same "write the state, swallow the write
   * error" block in the two phases.
   */
  private failRun(docId: string, doc: KnowledgeDoc, err: unknown): void {
    void (async () => {
      if (err instanceof Cancelled) {
        // A user-requested stop, not a failure. Chunks flushed by the
        // incremental writes stay, `progress` is left where it got to so the UI
        // can say "已取消（已完成 x/y）", and nothing is marked as an error.
        const enhanced = this.deps.store.enhancedCount(docId)
        console.log(`[dsh-llm-wiki-knowledge] cancelled ${docId} after ${enhanced} enhanced chunk(s)`)
        try {
          this.update(doc, { status: 'cancelled', enhancedChunks: enhanced })
          await this.deps.store.flush()
          // A cancelled document is final for this run: the summaries it did pay
          // for are worth searching, so index what is on disk.
          this.notifyPersisted(docId, true)
        } catch (writeErr) {
          console.error('[dsh-llm-wiki-knowledge] failed to record cancelled state:', writeErr)
        }
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      // Never let a *write* failure escape: a throw here would surface as an
      // unhandled rejection, and dsh treats that as a fatal load failure and
      // shuts the whole desktop host down.
      try {
        this.update(doc, { status: 'error', progress: 0, error: message })
        await this.deps.store.flush()
      } catch (writeErr) {
        console.error('[dsh-llm-wiki-knowledge] failed to record error state:', writeErr)
      }
    })()
  }
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr.map((s) => s.trim()).filter(Boolean))]
}

// Shared enrichment prompt. Kept here (not in deepseek.ts) so the dsh backend
// and the api-key backend stay word-for-word identical.
export const ENRICH_SYSTEM = [
  'You are a knowledge-base parser. Given a section of a document, return strict JSON only.',
  'Schema: { "summary": string (one sentence, the section gist),',
  '  "entities": string[] (2-8 key concepts/terms in the original language),',
  '  "relations": string[] (0-6 related concepts that this section also touches, short phrases) }.',
  'Output ONLY the JSON object, no markdown fences.',
].join(' ')
