// dsh-llm-wiki-knowledge — host half (Node).
//
// Mounts a same-origin JSON API at /kb-api/* on the dsh web server and runs the
// document parsing + knowledge-graph pipeline. The browser half is same-origin
// with this server, so it never needs CORS. Routes mount through
// ctx.inject(['webServer']) so headless profiles without a web server still
// load the plugin harmlessly.
//
// Flow:
//   POST /kb-api/upload   (multipart: file + name)  -> stores raw bytes, enqueues EXTRACTION only
//   GET  /kb-api/docs      -> list documents (+ progress/status/folderId/pendingEnhance)
//   GET  /kb-api/doc/:id   -> one document + its wiki chunks
//   DELETE /kb-api/doc/:id -> delete a document + its chunks + its exports
//   GET  /kb-api/graph     -> derived knowledge graph (nodes + edges)
//   GET  /kb-api/status    -> store stats + deepseek config state
//   POST /kb-api/parse/:id -> (re)extract a document on demand
//   POST /kb-api/enrich/:id -> buy LLM summaries for the chunks that lack one
//   POST /kb-api/enrich-all -> same, for every document that still has unenhanced chunks
//   POST /kb-api/cancel/:id -> stop a queued/running job, keeping finished work
//   GET  /kb-api/doc/:id/md       -> generated Markdown export (?download=1)
//   GET  /kb-api/doc/:id/mindmap  -> mind-map outline Markdown (markmap source)
//   POST /kb-api/export/:id       -> (re)generate both exports from stored chunks
//   POST /kb-api/tags/:id        -> replace a document's tag list
//   POST /kb-api/search          -> BM25 retrieval (same engine the kb_search tool uses)
//   GET  /kb-api/doc/:id/read    -> one document's chunks, reassembled in reading order
//                                  (?page= &pageSize= — what kb_read_document returns)
//   GET  /kb-api/folders         -> the folder tree
//   POST /kb-api/folder          -> create a folder ({name, parentId?})
//   POST /kb-api/folder/:id      -> rename (name) or move (parentId) one folder
//   DELETE /kb-api/folder/:id    -> delete a folder; its documents move up, not away
//   POST /kb-api/doc/:id/folder  -> move a document into a folder ({folderId?})
//
// Extraction and enrichment are separate jobs on purpose: extraction is local,
// free and seconds long, so it runs on upload; enrichment costs provider calls
// and takes minutes, so the user starts it. See parse-runner.ts.

import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { KnowledgeStore, normalizeTags } from './store.ts'
import { ParseRunner, MAX_ENRICH_CHUNKS, DEFAULT_ENRICH_CONCURRENCY } from './parse-runner.ts'
import { pickProvider, type DshLlmRuntime } from './dsh-llm.ts'
import { readDocExport, writeDocExports } from './doc-export.ts'
import { ChunkIndex, formatHits, DEFAULT_TOP_K, MAX_TOP_K } from './retrieve.ts'
import { defineKbTools, KB_TOOL_NAMES } from './kb-search-tool.ts'
import { readDocumentPage, toDocumentRow } from './kb-docs.ts'
import { askCorpus, ASK_DEFAULT_PASSAGES } from './kb-ask.ts'
import type { DocStatus, KnowledgeDoc } from './types.ts'

export const name = 'dsh-llm-wiki-knowledge'
// webServer is intentionally absent so headless profiles load the plugin fine.
export const inject: readonly string[] = []

export interface Config {
  dataDir: string
  deepseekApiKey: string
  deepseekBaseUrl: string
  deepseekModel: string
  maxConcurrent: number
  /** Fixed loopback port for the self-hosted /kb-api server. */
  apiPort: number
  /**
   * Which LLM backend performs chunk enrichment.
   * - 'dsh'     — the DSH host's own `llm` service (same model the chat uses;
   *               no API key needed).
   * - 'api-key' — direct api.deepseek.com calls with deepseekApiKey.
   * - 'auto'    — 'dsh' when the host exposes the service, else 'api-key'.
   */
  llmBackend: 'auto' | 'dsh' | 'api-key'
  /** Provider route inside the host llm service (default deepseek-official). */
  llmProvider: string
  /** Model id passed through to the host llm service. */
  llmModel: string
  /** Enriched chunks per document; `0` enriches every chunk (slow). */
  maxEnrichChunks: number
  /** Concurrent enrichment requests per document. */
  enrichConcurrency: number
  /**
   * Require `X-KB-Token` on every functional `/kb-api` route. Enabled by
   * default: the loopback API is otherwise reachable from any web page the user
   * visits while the harness is running.
   */
  apiTokenEnabled: boolean
}

export const DEFAULT_CONFIG: Config = {
  dataDir: '',
  deepseekApiKey: '',
  deepseekBaseUrl: 'https://api.deepseek.com',
  deepseekModel: 'deepseek-chat',
  maxConcurrent: 2,
  apiPort: 18771,
  llmBackend: 'auto',
  // Defaults match the host's own agent default (cordis.patch.yml:
  // agent-default-model = workbuddy / glm-5.3-flash). When a host has no
  // workbuddy route, pickProvider falls back to whatever IS registered.
  llmProvider: 'workbuddy',
  llmModel: 'glm-5.3-flash',
  maxEnrichChunks: MAX_ENRICH_CHUNKS,
  enrichConcurrency: DEFAULT_ENRICH_CONCURRENCY,
  apiTokenEnabled: true,
}

function resolveConfig(config?: Partial<Config>, profileDataDir?: string): Config {
  const dataDir =
    config?.dataDir ||
    process.env.DSH_KB_DATA_DIR ||
    (profileDataDir ? profileDataDir.replace(/[\\/]+$/, '') + '/kb' : '') ||
    // The data directory deliberately keeps the plugin's former name: it is the
    // path every existing document already lives under, and renaming it would
    // orphan the uploaded manuals (24 MB of PDFs, plus their generated md).
    join(homedir(), '.dsh', 'dsh-knowledge-base')
  const backend = config?.llmBackend ?? DEFAULT_CONFIG.llmBackend
  return {
    dataDir,
    deepseekApiKey: config?.deepseekApiKey ?? DEFAULT_CONFIG.deepseekApiKey,
    deepseekBaseUrl: config?.deepseekBaseUrl ?? DEFAULT_CONFIG.deepseekBaseUrl,
    deepseekModel: config?.deepseekModel ?? DEFAULT_CONFIG.deepseekModel,
    maxConcurrent: config?.maxConcurrent ?? DEFAULT_CONFIG.maxConcurrent,
    apiPort: config?.apiPort ?? DEFAULT_CONFIG.apiPort,
    llmBackend: backend === 'dsh' || backend === 'api-key' ? backend : 'auto',
    llmProvider: config?.llmProvider ?? DEFAULT_CONFIG.llmProvider,
    llmModel: config?.llmModel ?? DEFAULT_CONFIG.llmModel,
    maxEnrichChunks: config?.maxEnrichChunks ?? DEFAULT_CONFIG.maxEnrichChunks,
    enrichConcurrency: config?.enrichConcurrency ?? DEFAULT_CONFIG.enrichConcurrency,
    apiTokenEnabled: config?.apiTokenEnabled ?? DEFAULT_CONFIG.apiTokenEnabled,
  }
}

// ---- user-adjustable settings (settings tab) --------------------------------

/** Runtime-mutable settings persisted to <dataDir>/settings.json. */
interface KbSettings {
  /** Master switch for LLM chunk enrichment. */
  llmEnabled: boolean
  /** Provider route inside the host llm service (e.g. workbuddy). */
  llmProvider: string
  /** Model id passed through to the provider route (e.g. glm-5.3-flash). */
  llmModel: string
  /**
   * Per-document enrichment ceiling. `0` = no ceiling (enrich every chunk).
   * Raising it and re-parsing tops coverage up in batches, because chunks that
   * already carry a summary are never enriched twice.
   */
  maxEnrichChunks: number
  /** Concurrent enrichment requests per document (1..8). */
  enrichConcurrency: number
  /**
   * Master switch for HTTP token authentication. When `true`, every functional
   * `/kb-api` route rejects requests without a matching `X-KB-Token`.
   */
  apiTokenEnabled: boolean
  /**
   * The bearer secret for `/kb-api`, persisted in plaintext next to the model
   * settings. Generated on demand, rotatable, and cleared when auth is off.
   */
  apiToken: string
}

const SETTINGS_FILE = 'settings.json'
const MAX_ENRICH_CONCURRENCY = 8

/** Fresh 192-bit secret, URL-safe so it survives copy/paste and query strings. */
function newApiToken(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * Constant-time token comparison. Length is compared first (that part is not
 * secret) and the byte comparison only runs on equal-length inputs.
 */
function tokenMatches(expected: string, provided: string): boolean {
  if (!expected || !provided) return false
  const a = Buffer.from(expected, 'utf-8')
  const b = Buffer.from(provided, 'utf-8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function readSettings(dataDir: string, fallback: KbSettings): KbSettings {
  try {
    const raw = readFileSync(join(dataDir, SETTINGS_FILE), 'utf-8')
    const obj = JSON.parse(raw) as Partial<KbSettings>
    return {
      llmEnabled: typeof obj.llmEnabled === 'boolean' ? obj.llmEnabled : fallback.llmEnabled,
      llmProvider: typeof obj.llmProvider === 'string' && obj.llmProvider ? obj.llmProvider : fallback.llmProvider,
      llmModel: typeof obj.llmModel === 'string' && obj.llmModel ? obj.llmModel : fallback.llmModel,
      maxEnrichChunks: numOr(obj.maxEnrichChunks, fallback.maxEnrichChunks),
      enrichConcurrency: clampConcurrency(numOr(obj.enrichConcurrency, fallback.enrichConcurrency)),
      apiTokenEnabled: typeof obj.apiTokenEnabled === 'boolean' ? obj.apiTokenEnabled : fallback.apiTokenEnabled,
      apiToken: typeof obj.apiToken === 'string' ? obj.apiToken.trim() : fallback.apiToken,
    }
  } catch {
    return fallback
  }
}

/** Finite, non-negative integer or the fallback. */
function numOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

/** Concurrency is clamped to 1..MAX_ENRICH_CONCURRENCY. */
function clampConcurrency(value: number): number {
  if (!Number.isFinite(value) || value < 1) return DEFAULT_ENRICH_CONCURRENCY
  return Math.min(MAX_ENRICH_CONCURRENCY, Math.floor(value))
}

function writeSettings(dataDir: string, settings: KbSettings): void {
  try {
    mkdirSync(dataDir, { recursive: true })
    const target = join(dataDir, SETTINGS_FILE)
    const tmp = target + '.tmp'
    writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf-8')
    renameSync(tmp, target) // atomic-ish on both NTFS and POSIX
  } catch {
    /* best-effort: settings loss only resets defaults on next boot */
  }
}

// Structural slice of the cordis Context the host half needs.
interface ContextLike {
  effect(body: () => (() => void) | void, label?: string): void
  inject(deps: readonly string[], callback: (ctx: ContextLike) => void): () => void
  logger?: { warn(message: string): void; info?(message: string): void }
  webServer?: {
    register(entry: {
      kind: 'prefix' | 'exact'
      path: string
      handler: (req: NodeIncomingMessage, res: NodeServerResponse) => void | Promise<void>
    }): () => void
  }
  webRuntime?: { trustedHosts: readonly string[] }
  /**
   * The host's tool registry (@deepseek-ai/dsh-tools). Registering `kb_search`
   * here is what lets the assistant read the knowledge base directly, instead of
   * the user having to run a helper script in a terminal. Absent on profiles
   * without an agent runtime, so every use is guarded.
   */
  tools?: {
    register(definition: unknown): () => void
  }
  /**
   * Best-effort: resolves the profile data directory so the KB persists next
   * to other profile data. Optional — falls back to cwd/kb.
   */
  getConfigPath?: () => string | undefined
  /**
   * The host's provider-neutral LLM service (@deepseek-ai/dsh-llm). Probed
   * best-effort via readHostProperty — absent on headless/minimal profiles.
   */
  llm?: DshLlmRuntime
}

interface NodeIncomingMessage {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  on(event: 'data', listener: (chunk: Buffer) => void): void
  on(event: 'end', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
}

interface NodeServerResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Buffer): void
}

const API_PREFIX = '/kb-api'

/**
 * Statuses that mean a parse was in flight. `/cancel` and the startup resume
 * both key off this set, so it lives next to the route table rather than in the
 * runner (the HTTP layer needs it before the runner exists).
 */
const RESUMABLE = new Set<DocStatus>([
  'queued',
  'extracting',
  'parsing',
  'enriching',
  'indexing',
])

function writeJson(res: NodeServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

function writeError(res: NodeServerResponse, code: string, message: string, status = 400): void {
  writeJson(res, status, { ok: false, error: { code, message } })
}

/**
 * Serve a text/markdown body. `download=1` switches to an attachment; the file
 * name is sent twice (ASCII fallback + RFC 5987 UTF-8) because original names
 * are frequently Chinese.
 */
function writeMarkdown(
  res: NodeServerResponse,
  status: number,
  text: string,
  filename?: string,
  download = false,
): void {
  const headers: Record<string, string> = { 'content-type': 'text/markdown; charset=utf-8' }
  if (filename) {
    const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
    headers['content-disposition'] =
      `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  }
  res.writeHead(status, headers)
  res.end(text)
}

/**
 * Read one optional host property without tripping cordis's context proxy.
 *
 * cordis 4 wraps every Context in a Proxy whose `get` trap treats a property it
 * does not own as a *service lookup*, and raises
 * `cannot get property "<name>" without inject` when the service is not part of
 * the fiber's `inject` set. Because `apply()` runs inside a live fiber, a plain
 * `ctx.getConfigPath?.()` therefore THROWS instead of yielding `undefined` —
 * which aborted activation and made DSH report the whole plugin as
 * `fiberPhase: "failed"`. Probing inside a try/catch is the only portable way to
 * ask "is this extra available?".
 */
function readHostProperty(ctx: ContextLike, key: string): unknown {
  try {
    const value = (ctx as unknown as Record<string, unknown>)[key]
    if (typeof value === 'function') return (value as () => unknown).call(ctx)
    return value
  } catch {
    return undefined
  }
}

/**
 * Best-effort profile directory. The cordis loader exposes `baseDir`; some dsh
 * builds additionally expose `getConfigPath`. Neither is guaranteed, and asking
 * for an unavailable one throws, so each probe is individually swallowed.
 */
function readProfileDir(ctx: ContextLike): string | undefined {
  for (const key of ['baseDir', 'getConfigPath']) {
    const value = readHostProperty(ctx, key)
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function activate(ctx: ContextLike, config?: Partial<Config>): void {
  const resolved = resolveConfig(config, readProfileDir(ctx))

  // Host `llm` service. Reading `ctx.llm` directly trips the cordis context
  // proxy ("cannot get property without inject") — the same trap documented on
  // readHostProperty — so the service is acquired through `ctx.inject(['llm'])`
  // exactly like `webServer` further down. The inject callback can fire after
  // activation, and the service may be absent entirely, so every consumer reads
  // this mutable binding instead of a captured snapshot.
  let llmRuntime: DshLlmRuntime | undefined
  const probeLlm = (candidate: unknown): DshLlmRuntime | undefined => {
    const rt = candidate as DshLlmRuntime | undefined
    return rt && typeof rt.stream === 'function' ? rt : undefined
  }
  /**
   * The cordis context proxy resolves a provided service only when the reading
   * fiber (or one of its ancestors) declares it in `inject` — that is why a bare
   * `ctx.llm` read throws `cannot get property "llm" without inject`. `ctx.reflect`
   * is an own property of every context, and `ReflectService.get(name, strict)`
   * reads the same service store *without* the inject requirement, so it is a
   * synchronous and reliable second path. `strict = true` skips a provider fiber
   * that is not ACTIVE yet; the non-strict retry accepts one that is still
   * loading, and the `ctx.inject(['llm'])` registration below re-runs
   * `applyBackend()` once the real service is definitely active.
   */
  const probeLlmViaReflect = (c: unknown): DshLlmRuntime | undefined => {
    try {
      const reflect = (c as { reflect?: { get?: (name: string, strict?: boolean) => unknown } })?.reflect
      if (!reflect || typeof reflect.get !== 'function') return undefined
      return probeLlm(reflect.get('llm')) ?? probeLlm(reflect.get('llm', false))
    } catch {
      return undefined
    }
  }
  llmRuntime = probeLlm(readHostProperty(ctx, 'llm')) ?? probeLlmViaReflect(ctx)

  // User-adjustable settings survive across restarts in <dataDir>/settings.json.
  // The plugin Config is only the initial fallback.
  let settings: KbSettings = readSettings(resolved.dataDir, {
    llmEnabled: true,
    llmProvider: resolved.llmProvider,
    llmModel: resolved.llmModel,
    maxEnrichChunks: resolved.maxEnrichChunks,
    enrichConcurrency: resolved.enrichConcurrency,
    apiTokenEnabled: DEFAULT_CONFIG.apiTokenEnabled,
    apiToken: '',
  })
  // A token must exist the moment auth is on, otherwise every route would
  // reject every caller and the panel could never authenticate itself. Mint it
  // once here and persist so the user finds it in the settings tab.
  if (settings.apiTokenEnabled && !settings.apiToken) {
    settings = { ...settings, apiToken: newApiToken() }
    writeSettings(resolved.dataDir, settings)
  }

  /**
   * Compute which enrichment backend to use for a given settings snapshot.
   * Shared by activation and POST /kb-api/settings so both paths agree.
   *
   * `useDsh=false` here means "no enrichment at all" when the toggle is off;
   * the API-key fallback only applies while the toggle is on but the host llm
   * service is unavailable.
   */
  const decideBackend = (s: KbSettings): { useDsh: boolean; provider: string; note?: string } => {
    if (!s.llmEnabled) return { useDsh: false, provider: '', note: 'LLM 增强已关闭（设置）' }
    if (!llmRuntime) return { useDsh: false, provider: s.llmProvider, note: '宿主未暴露 llm 服务' }
    const pick = pickProvider(llmRuntime, s.llmProvider)
    if (!pick) return { useDsh: false, provider: s.llmProvider, note: '宿主 llm 服务未注册任何 provider' }
    return { useDsh: true, provider: pick.provider, note: pick.note }
  }

  /** Translate a backend decision into what the runner + HTTP handlers see. */
  const buildRunnerBackend = (d: { useDsh: boolean; provider: string }, s: KbSettings) => ({
    dshLlm: d.useDsh && llmRuntime
      ? { runtime: llmRuntime, provider: d.provider, model: s.llmModel }
      : undefined,
    // Only run the direct-API-key enricher as a *fallback while the toggle is
    // on*: an explicit "LLM 增强已关闭" from settings must stay off even when
    // an API key exists.
    deepseek: !d.useDsh && s.llmEnabled && resolved.deepseekApiKey
      ? {
          apiKey: resolved.deepseekApiKey,
          baseUrl: resolved.deepseekBaseUrl,
          model: resolved.deepseekModel,
        }
      : undefined,
  })

  let decision = decideBackend(settings)

  // Mutable snapshot shared with HTTP handlers (handleApiRequest lives at
  // module scope and cannot see activate() locals) — updated in place on
  // POST /settings and whenever the llm service appears.
  const llmInfo: LlmInfo = {
    backend: 'off',
    deepseekConfigured: false,
  }

  // Declared *before* applyBackend(): the first applyBackend() call happens
  // below, and `runner?.setBackend(...)` inside it would otherwise hit the
  // temporal dead zone and abort activation with
  // "Cannot access 'runner' before initialization".
  let store: KnowledgeStore | undefined
  let runner: ParseRunner | undefined
  let server: any
  /** Document ids that were mid-run when the previous host process ended. */
  let resumed: string[] = []
  /**
   * Retrieval index over every stored chunk, so `kb_search` can answer a
   * question from the whole knowledge base without the model having to know
   * which documents exist. Built once from the persisted index at startup, then
   * kept in step by the parse runner (see `reindex` below).
   */
  const searchIndex = new ChunkIndex()
  /** Number of documents currently in the retrieval index (for /status). */
  let indexedDocs = 0

  /**
   * Recompute the effective backend from the current settings + llm runtime,
   * push it into the shared llmInfo snapshot, and hot-swap the parse runner.
   * Called at activation, on POST /settings, and when the llm service arrives.
   */
  const applyBackend = (): void => {
    decision = decideBackend(settings)
    llmInfo.backend = decision.useDsh
      ? 'dsh'
      : settings.llmEnabled && resolved.deepseekApiKey ? 'api-key' : 'off'
    llmInfo.provider = decision.useDsh ? decision.provider : undefined
    llmInfo.model = decision.useDsh ? settings.llmModel : undefined
    llmInfo.note = decision.note
    llmInfo.deepseekConfigured = Boolean(resolved.deepseekApiKey) || decision.useDsh
    runner?.setBackend(buildRunnerBackend(decision, settings))
    if (decision.note) ctx.logger?.warn?.(`[dsh-llm-wiki-knowledge] LLM backend: ${decision.note}`)
    ctx.logger?.info?.(
      `[dsh-llm-wiki-knowledge] LLM backend: ${decision.useDsh ? `dsh (${decision.provider} / ${settings.llmModel})` : llmInfo.backend}`,
    )
  }
  applyBackend()

  const ensureStore = async (): Promise<KnowledgeStore> => {
    if (!store) {
      store = new KnowledgeStore(resolved.dataDir || 'kb-data')
      await store.init()
      runner = new ParseRunner({
        store,
        maxConcurrent: resolved.maxConcurrent,
        maxEnrichChunks: settings.maxEnrichChunks,
        enrichConcurrency: settings.enrichConcurrency,
        ...buildRunnerBackend(decision, settings),
        // Keep the retrieval index in step with what the runner flushes. Only
        // the end-of-run write re-indexes: a mid-parse tick fires every few
        // seconds, and re-tokenising the document each time stalls the event
        // loop for as long as the document is big. A search that lands
        // mid-parse therefore uses the previous state, which is at most one
        // parse old — and the text it returns is already on disk.
        onChunksPersisted: (docId: string, final: boolean) => {
          if (final) reindex(docId)
        },
      })
      // A document that was mid-run when the host last went away is still
      // marked `enriching`/`parsing` in the index: the queue is in-memory only,
      // so nothing would ever pick it up again. Re-queue those now — anything the
      // previous process flushed is carried over, so a resume buys only the
      // difference.
      resumed = runner.resumeInterrupted()
      // Warm the retrieval index from what is already on disk. Only finished
      // documents are indexed: a half-enriched document still has valid text, so
      // it is included, but one that never produced chunks is not.
      rebuildSearchIndex()
    }
    return store
  }

  /**
   * Re-index one document (or drop it) after the runner changes its chunks.
   * Called on the runner's `onIndexed` hook and by the delete route.
   */
  /**
   * Drop and rebuild one document's postings. A re-parse is the only common
   * caller; re-tagging a document goes through here too, because the tag is
   * part of the indexed `Doc` record and `ChunkIndex.add` replaces that record
   * (the re-index is O(chunks) but only for the one document that changed).
   */
  const reindex = (docId: string): void => {
    const st = store
    if (!st) return
    const doc = st.getDoc(docId)
    const chunks = st.getChunks(docId)
    if (!doc || chunks.length === 0) {
      if (searchIndex.size > 0) {
        searchIndex.remove(docId)
        indexedDocs = Math.max(0, indexedDocs - 1)
      }
      return
    }
    searchIndex.add(doc, chunks)
    indexedDocs++
  }

  const rebuildSearchIndex = (): void => {
    const st = store
    if (!st) return
    searchIndex.clear()
    let n = 0
    for (const doc of st.listDocs()) {
      const chunks = st.getChunks(doc.id)
      if (chunks.length === 0) continue
      searchIndex.add(doc, chunks)
      n++
    }
    indexedDocs = n
    ctx.logger?.info?.(`[dsh-llm-wiki-knowledge] retrieval index: ${n} documents, ${searchIndex.size} chunks`)
  }

  /** Shared search entry point for the HTTP route and the `kb_search` tool. */
  const searchWith = (query: string, opts: { topK?: unknown; docId?: unknown; tags?: unknown } = {}): ReturnType<ChunkIndex['search']> => {
    const topK = numOr(opts.topK, DEFAULT_TOP_K)
    const docId = typeof opts.docId === 'string' && opts.docId.trim() ? opts.docId.trim() : undefined
    return searchIndex.search(query, {
      topK: Math.max(1, Math.min(Math.floor(topK), MAX_TOP_K)),
      docId,
      tags: normalizeTags(opts.tags),
    })
  }

  /** Every stored document, in the shape the tools report it. */
  const documentRows = (): ReturnType<typeof toDocumentRow>[] =>
    (store ? store.listDocs() : []).map(toDocumentRow)

  /**
   * `kb_read_document`: one document's chunks, reassembled in reading order.
   * The store is the single source of truth here, so a page the model reads is
   * text that is already on disk — never a re-parse.
   */
  const readDocument = (docId: string, page: number, pageSize: number) => {
    const st = store
    if (!st) return undefined
    const doc = st.getDoc(docId)
    if (!doc) return undefined
    return readDocumentPage(doc, st.getChunks(docId), page, pageSize)
  }

  /**
   * `kb_ask`: retrieve, then let the host's own model compose an answer from the
   * passages. Omitted from the toolset when no LLM service is registered, and
   * that omission is what the tool description promises — the model is told to
   * fall back to `kb_search` instead of waiting on a provider that is not there.
   */
  const askFromCorpus = (query: string, opts: { docId?: string; tags?: string[]; topK?: number; signal?: AbortSignal }) => {
    const cfg = decision.useDsh ? { provider: decision.provider, model: settings.llmModel } : undefined
    if (!cfg) return Promise.resolve(undefined)
    return askCorpus(
      {
        search: (q, o) => searchWith(q, { topK: o.topK, docId: o.docId, tags: o.tags }),
        dshLlm: llmRuntime,
        config: cfg,
      },
      query,
      { ...opts, topK: opts.topK ?? ASK_DEFAULT_PASSAGES },
    )
  }

  /** Remove a deleted document from retrieval. */
  const dropFromIndex = (docId: string): void => {
    searchIndex.remove(docId)
    indexedDocs = Math.max(0, indexedDocs - 1)
  }

  // Settings controller shared with HTTP handlers. `set` persists to disk,
  // re-decides the backend, and hot-swaps the runner mid-flight. It is always
  // defined: the llm service can arrive after activation, and until it does the
  // controller reports `available() === false` instead of disappearing.
  const settingsCtl = {
    available: (): boolean => Boolean(llmRuntime),
    get: (): KbSettings => settings,
    set: (next: KbSettings): { ok: boolean; note?: string } => {
      settings = next
      writeSettings(resolved.dataDir, settings)
      applyBackend()
      // Budget changes take effect on the next (re)parse, without a restart.
      runner?.setEnrichBudget({
        maxEnrichChunks: settings.maxEnrichChunks,
        enrichConcurrency: settings.enrichConcurrency,
      })
      return { ok: decision.useDsh, note: decision.note }
    },
    listProviders: (): { id: string; name: string }[] => {
      try {
        return llmRuntime?.listProviders?.() ?? []
      } catch {
        return []
      }
    },
    listModels: async (provider: string): Promise<{ id: string; name?: string }[]> => {
      try {
        return (await llmRuntime?.listModels?.(provider)) ?? []
      } catch {
        return []
      }
    },
  }

  // The runtime's `webServer` service is not reliably provided on every host
  // (the desktop profile in particular did not inject it, so the route never
  // registered and the browser got an empty 404 body). To make the KB reachable
  // in ALL profiles, the host half self-hosts its own HTTP server on a fixed
  // loopback port and the client talks to it via an absolute
  // `http://127.0.0.1:<port>/kb-api` URL (CORS-enabled). The fixed port is also
  // known to the client half (shared constant) so no discovery is needed.
  const startServer = () => {
    if (server) return
    server = createServer(async (req: any, res: any) => {
      // Enable CORS so the browser (served from the DSH web origin) can call the
      // loopback API regardless of origin.
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
      // `X-KB-Token` is a non-simple header, so every authenticated browser call
      // is preflighted; without it here the browser drops the token header and
      // the panel would 401 against itself.
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-KB-Token')
      res.setHeader('Access-Control-Max-Age', '300')
      if (req.method === 'OPTIONS') {
        res.statusCode = 204
        res.end()
        return
      }
      try {
        const st = await ensureStore()
        await handleApiRequest({ st, runner: runner!, llmInfo, settings: settingsCtl, res, req, resumedDocs: () => resumed, search: searchWith, indexedDocs: () => indexedDocs, indexedChunks: () => searchIndex.size, dropFromIndex, reindex })
      } catch (error) {
        const message = error instanceof Error ? error.stack || error.message : String(error)
        ctx.logger?.warn(`[dsh-llm-wiki-knowledge] handler error: ${message}`)
        if (!res.headersSent) writeError(res, 'internal', message, 500)
        else { try { res.end() } catch { /* ignore */ } }
      }
    })
    server.once('error', (e: Error) => {
      ctx.logger?.warn(`[dsh-llm-wiki-knowledge] loopback server on :${resolved.apiPort} failed: ${e.message}`)
    })
    server.listen(resolved.apiPort, '127.0.0.1', () => {
      ctx.logger?.info?.(`[dsh-llm-wiki-knowledge] API listening at http://127.0.0.1:${resolved.apiPort}/kb-api`)
    })
  }

  // Start immediately — the self-hosted server does not depend on any runtime
  // service, so it works in web, desktop, and headless profiles alike.
  try { startServer() } catch (e) { ctx.logger?.warn(`[dsh-llm-wiki-knowledge] server start failed: ${e}`) }

  // Release the loopback port when the plugin is unloaded or hot-reloaded.
  // Without this, a second `apply` on the same port would EADDRINUSE and the
  // plugin would silently keep serving the stale instance's handlers.
  try {
    const eff = (ctx as any).effect
    if (typeof eff === 'function') {
      eff.call(ctx, () => () => {
        try { server?.close() } catch { /* ignore */ }
        server = undefined
      }, 'dsh-llm-wiki-knowledge: loopback server')
    }
  } catch { /* ignore */ }

  // Acquire the host llm service through the inject API. This is the reactive
  // way to reach it: a bare `ctx.llm` read throws under the cordis proxy unless
  // the service is in the fiber's inject set (see the probe note at the top of
  // activate). The callback fires once the service is available, which may be
  // after activation — hence the mutable `llmRuntime` binding and the re-run of
  // applyBackend().
  if (ctx.inject) {
    try {
      ctx.inject(['llm'], (lctx: any) => {
        try {
          const rt = probeLlm(lctx?.llm) ?? probeLlmViaReflect(lctx)
          if (!rt) return
          llmRuntime = rt
          applyBackend()
          const ids = settingsCtl.listProviders().map((p) => p.id)
          ctx.logger?.info?.(
            `[dsh-llm-wiki-knowledge] host llm service ready: ${ids.length > 0 ? ids.join(', ') : '(no providers registered)'}`,
          )
        } catch (e) {
          ctx.logger?.warn?.(`[dsh-llm-wiki-knowledge] llm inject failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      })
    } catch { /* ignore */ }
  }

  // Bridge the knowledge base into the conversation: register the kb_* tools on
  // the host tool registry so the assistant can read imported documents itself,
  // instead of the user shelling out to a helper script in a terminal.
  //
  // `tools` is acquired through `ctx.inject(['tools'])` for the same reason `llm`
  // is: a bare read trips the cordis context proxy, and the registry may only
  // exist on profiles that have an agent runtime.
  if (ctx.inject) {
    try {
      ctx.inject(['tools'], (tctx: any) => {
        tctx.effect(() => {
          try {
            const registry = tctx.tools
            if (!registry || typeof registry.register !== 'function') return
            return defineKbTools({
              search: async (query, opts) => {
                await ensureStore()
                return searchWith(query, opts)
              },
              stats: () => ({ docs: indexedDocs, chunks: searchIndex.size }),
              tagCatalog: () => (store ? store.tagCounts() : []),
              listDocuments: () => documentRows(),
              readDocument,
              ask: askFromCorpus,
            }).map((definition) => registry.register(definition))
          } catch (e) {
            ctx.logger?.warn?.(`[dsh-llm-wiki-knowledge] ${KB_TOOL_NAMES.join(' / ')} registration failed: ${e instanceof Error ? e.message : String(e)}`)
            return
          }
        }, `dsh-llm-wiki-knowledge: ${KB_TOOL_NAMES.join(' / ')} tools`)
      })
    } catch { /* ignore */ }
  }

  // Also register on the runtime web server when available (progressive
  // enhancement — never required for the plugin to work). All handlers share
  // the same store, so the two paths are equivalent.
  if (ctx.inject) {
    try {
      ctx.inject(['webServer'], (wctx: any) => {
        wctx.effect(() => {
          try {
            return wctx.webServer.register({
              kind: 'prefix',
              path: API_PREFIX,
              handler: async (req: any, res: any) => {
                try {
                  const st = await ensureStore()
                  await handleApiRequest({ st, runner: runner!, llmInfo, settings: settingsCtl, res, req, resumedDocs: () => resumed, search: searchWith, indexedDocs: () => indexedDocs, indexedChunks: () => searchIndex.size, dropFromIndex, reindex })
                } catch (error) {
                  const message = error instanceof Error ? error.stack || error.message : String(error)
                  ctx.logger?.warn(`[dsh-llm-wiki-knowledge] handler error: ${message}`)
                  if (!res.headersSent) writeError(res, 'internal', message, 500)
                  else { try { res.end() } catch { /* ignore */ } }
                }
              },
            })
          } catch { /* ignore */ }
        }, 'dsh-llm-wiki-knowledge: /kb-api routes')
      })
    } catch { /* ignore */ }
  }
}

/**
 * Plugin entry point.
 *
 * Activation is wrapped so that an unexpected host capability can never mark the
 * fiber `failed` again — a degraded knowledge base that logs a warning is far
 * better than a plugin the GUI reports as 启动异常.
 */
export function apply(ctx: ContextLike, config?: Partial<Config>): void {
  try {
    activate(ctx, config)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      ctx.logger?.warn(`[dsh-llm-wiki-knowledge] activation degraded: ${message}`)
    } catch {
      /* logger itself unavailable — nothing more we can do */
    }
  }
}


interface HandlerDeps {
  st: KnowledgeStore
  runner: ParseRunner
  llmInfo: LlmInfo
  /** Settings state + llm catalog accessors (always set; `available()` reports
   *  whether the host llm service has been injected yet). */
  settings?: {
    available(): boolean
    get(): KbSettings
    set(next: KbSettings): { ok: boolean; note?: string }
    listProviders(): { id: string; name: string }[]
    listModels(provider: string): Promise<{ id: string; name?: string }[]>
  }
  /** Document ids auto-resumed at startup, read lazily (filled in by ensureStore). */
  resumedDocs?(): string[]
  /**
   * Run a query against the retrieval index, lazily (the index is built on the
   * first request that needs the store).
   */
  search?(query: string, opts: { topK?: unknown; docId?: unknown; tags?: unknown }): ReturnType<ChunkIndex['search']>
  indexedDocs?(): number
  indexedChunks?(): number
  /** Forget a deleted document so search stops citing it. */
  dropFromIndex?(docId: string): void
  /**
   * Refresh one document's postings after its record changed without a re-parse
   * (i.e. after tagging) — `ChunkIndex` caches the tag list it indexed with.
   */
  reindex?(docId: string): void
  req: NodeIncomingMessage
  res: NodeServerResponse
}

interface LlmInfo {
  backend: 'dsh' | 'api-key' | 'off'
  provider?: string
  model?: string
  note?: string
  deepseekConfigured: boolean
}

/**
 * Bootstrap for the browser panel: hands the token to a caller that is NOT a
 * hostile web origin. Browsers always send `Origin` on cross-origin fetches, so
 * an absent `Origin` (same-origin request, node/curl, desktop webview) or a
 * loopback `Origin` is accepted. A remote origin such as `https://evil.test`
 * gets the token withheld and must ask the user to paste it in instead.
 *
 * This is the only unauthenticated `/kb-api` route; everything else goes
 * through the `X-KB-Token` check below.
 */
function originIsLocalOrAbsent(req: NodeIncomingMessage): boolean {
  const raw = req.headers['origin']
  const origin = Array.isArray(raw) ? raw[0] : raw
  if (!origin) return true
  try {
    const { hostname } = new URL(origin)
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]' ||
      hostname.endsWith('.localhost')
    )
  } catch {
    return false
  }
}

/**
 * True when the request is allowed through the token gate. `path` is the
 * `/kb-api`-stripped path; `_session` is the documented exemption.
 */
function isAuthExempt(method: string, path: string): boolean {
  if (path === '/_session') return true
  // CORS preflight carries no credentials (and browsers strip custom headers
  // from a preflight), so it must be answered before the token check.
  return method === 'OPTIONS'
}

/** Pull the token from the header, tolerating both browser and CLI shapes. */
function readRequestToken(req: NodeIncomingMessage, searchParams: URLSearchParams): string {
  const raw = req.headers['x-kb-token']
  const header = Array.isArray(raw) ? raw[0] : raw
  if (header) return String(header).trim()
  // Link-based exports (md / mindmap downloads opened in a new tab) cannot set
  // headers, so they may pass the token as a query parameter instead.
  return (searchParams.get('token') ?? '').trim()
}

async function handleApiRequest(deps: HandlerDeps): Promise<void> {
  const { st, runner, llmInfo, settings, req, res } = deps
  const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
  const searchParams = new URL(req.url ?? '/', 'http://dsh.internal').searchParams
  const rest = pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : pathname
  const method = req.method ?? 'GET'

  // Token gate for every functional route. The host `kb_*` tools never reach
  // here: they call the store/search APIs in-process, so they stay usable from
  // the agent even when HTTP auth is on.
  const auth = settings?.get()
  if (auth?.apiTokenEnabled && auth.apiToken && !isAuthExempt(method, rest)) {
    const provided = readRequestToken(req, searchParams)
    if (!tokenMatches(auth.apiToken, provided)) {
      writeError(res, 'unauthorized', '缺少或无效的知识库访问令牌（X-KB-Token）', 401)
      return
    }
  }

  // GET routes
  if (req.method === 'GET' || req.method === undefined) {
    if (rest === '/_session') {
      const current = settings?.get()
      const local = originIsLocalOrAbsent(req)
      writeJson(res, 200, {
        ok: true,
        enabled: Boolean(current?.apiTokenEnabled),
        // Withheld from a non-loopback browser origin; that caller falls back
        // to the manual token input in the panel.
        token: local && current?.apiTokenEnabled ? current.apiToken : '',
        local,
      })
      return
    }
    if (rest === '/' || rest === '/docs') {
      // The outline can hold thousands of entries (a bookmarked manual); the
      // list view only needs its size, so the list stays small and the full
      // outline is served by `GET /doc/:id` for the document that needs it.
      const docs = st.listDocs().map((d) => {
        const view: Record<string, unknown> = { ...d, outlineEntries: d.outline?.length ?? 0 }
        delete view.outline
        return view
      })
      // `folders` rides on the list response so the client tree and the document
      // list can never disagree: one fetch, one consistent snapshot.
      writeJson(res, 200, {
        ok: true,
        docs,
        tags: st.tagCounts(),
        folders: st.listFolders(),
        pendingEnrich: st.listDocs().filter((d) => (d.pendingEnhance ?? 0) > 0).length,
      })
      return
    }
    if (rest === '/folders') {
      // Counts travel with the tree so the client does not have to cross-join
      // folders against documents itself.
      const docs = st.listDocs()
      const rows = st.listFolders().map((f) => ({
        ...f,
        path: st.folderPath(f.id),
        docCount: docs.filter((d) => d.folderId === f.id).length,
      }))
      writeJson(res, 200, { ok: true, folders: rows, rootDocCount: docs.filter((d) => !d.folderId).length })
      return
    }
    if (rest === '/graph') {
      const graph = st.buildGraph()
      writeJson(res, 200, { ok: true, graph })
      return
    }
    if (rest === '/status') {
      writeJson(res, 200, {
        ok: true,
        dataDir: st.root,
        deepseekConfigured: llmInfo.deepseekConfigured,
        llmBackend: llmInfo.backend,
        llmProvider: llmInfo.provider,
        llmModel: llmInfo.model,
        llmNote: llmInfo.note,
        documentCount: st.listDocs().length,
        chunkCount: st.listDocs().reduce((a, d) => a + d.chunkCount, 0),
        entityCount: st.listDocs().reduce((a, d) => a + d.entityCount, 0),
        // Documents auto-resumed after a host restart, so a user who comes back
        // to a session can see that work was picked up rather than restarted.
        resumedDocs: deps.resumedDocs?.() ?? [],
        indexedDocs: deps.indexedDocs?.() ?? 0,
        indexedChunks: deps.indexedChunks?.() ?? 0,
        graph: (() => {
          const g = st.buildGraph()
          return { nodeCount: g.nodes.length, edgeCount: g.edges.length }
        })(),
      })
      return
    }
    // Markdown / mind-map exports. These are written during parsing; if the file
    // is missing (a document parsed by an older build, or a hand-cleaned md/ dir)
    // they are rebuilt on demand from the stored chunks, so the UI never shows an
    // empty brain map for an already-parsed document.
    const exportMatch = rest.match(/^\/doc\/([^/]+)\/(md|mindmap)$/)
    if (exportMatch) {
      const id = decodeURIComponent(exportMatch[1])
      const kind = exportMatch[2] as 'md' | 'mindmap'
      const doc = st.getDoc(id)
      if (!doc) {
        writeError(res, 'not-found', 'document not found', 404)
        return
      }
      let text = await readDocExport(st.root, kind === 'md' ? doc.mdFile : doc.mindmapFile)
      let file = kind === 'md' ? doc.mdFile : doc.mindmapFile
      let cached = text !== undefined
      if (text === undefined) {
        const chunks = st.getChunks(id)
        if (chunks.length === 0) {
          writeError(res, 'not-ready', '文档尚未解析完成，暂无可导出的内容', 409)
          return
        }
        const ex = await writeDocExports(st.root, doc, chunks, st.otherExportNames(id))
        text = kind === 'md' ? ex.md : ex.mindmap
        file = kind === 'md' ? ex.mdFile : ex.mindmapFile
        st.upsertDoc({
          ...doc,
          mdFile: ex.mdFile,
          mindmapFile: ex.mindmapFile,
          exportedAt: new Date().toISOString(),
        })
        cached = false
      }
      if (kind === 'mindmap') {
        // `?download=1` fetches the raw outline instead of the JSON envelope.
        if (searchParams.get('download') === '1') {
          writeMarkdown(res, 200, text, file, true)
          return
        }
        writeJson(res, 200, { ok: true, docId: id, file, cached, markdown: text })
        return
      }
      writeMarkdown(res, 200, text, file ?? `${doc.name}.md`, searchParams.get('download') === '1')
      return
    }
    const docMatch = rest.match(/^\/doc\/([^/]+)$/)
    if (docMatch) {
      const id = decodeURIComponent(docMatch[1])
      const doc = st.getDoc(id)
      if (!doc) {
        writeError(res, 'not-found', 'document not found', 404)
        return
      }
      writeJson(res, 200, { ok: true, doc, chunks: st.getChunks(id) })
      return
    }
    // `GET /kb-api/doc/:id/read` — the same page `kb_read_document` returns, over
    // HTTP, so the client pane can show a document the way the model reads it
    // rather than re-implementing the reassembly in the browser.
    const readMatch = rest.match(/^\/doc\/([^/]+)\/read$/)
    if (readMatch) {
      const id = decodeURIComponent(readMatch[1])
      const doc = st.getDoc(id)
      if (!doc) {
        writeError(res, 'not-found', 'document not found', 404)
        return
      }
      const page = Math.max(1, Math.floor(numOr(Number(searchParams.get('page')), 1)))
      const pageSize = Math.max(1, Math.min(40, Math.floor(numOr(Number(searchParams.get('pageSize')), 8))))
      writeJson(res, 200, { ok: true, ...readDocumentPage(doc, st.getChunks(id), page, pageSize) })
      return
    }
    // Settings tab: current settings + the llm provider/model catalog so the
    // UI can render dropdowns without guessing.
    if (rest === '/settings') {
      const providers = settings ? settings.listProviders() : []
      let models: { id: string; name?: string }[] = []
      const current = settings ? settings.get() : undefined
      if (settings && current) {
        // `?provider=` lets the UI preview another route's model list before
        // switching; defaults to the current provider.
        const provider = searchParams.get('provider') || current.llmProvider
        try {
          models = await settings.listModels(provider)
        } catch {
          models = []
        }
      }
      writeJson(res, 200, {
        ok: true,
        settings: current ?? { llmEnabled: false, llmProvider: '', llmModel: '', maxEnrichChunks: 0, enrichConcurrency: DEFAULT_ENRICH_CONCURRENCY, apiTokenEnabled: false, apiToken: '' },
        providers,
        models,
        backend: llmInfo.backend,
        note: llmInfo.note,
        llmAvailable: settings ? settings.available() : false,
      })
      return
    }
    writeError(res, 'not-found', 'unknown kb-api route', 404)
    return
  }

  // POST routes
  if (req.method === 'POST') {
    if (rest === '/upload') {
      const result = await handleUpload(req, st, runner)
      writeJson(res, result.status, result.body)
      return
    }
    const parseMatch = rest.match(/^\/parse\/([^/]+)$/)
    if (parseMatch) {
      const id = decodeURIComponent(parseMatch[1])
      const doc = st.getDoc(id)
      if (!doc) {
        writeError(res, 'not-found', 'document not found', 404)
        return
      }
      runner.enqueue(id)
      writeJson(res, 200, { ok: true, id })
      return
    }
    // LLM enrichment, as its own job. Uploading only extracts; this is the button
    // (or the batch button) that spends provider calls. Already-enhanced chunks
    // are skipped, so pressing it twice costs nothing the second time — that
    // idempotence is what makes it safe to point a retry at a failed document.
    const enrichMatch = rest.match(/^\/enrich\/([^/]+)$/)
    if (enrichMatch) {
      const id = decodeURIComponent(enrichMatch[1])
      const doc = st.getDoc(id)
      if (!doc) {
        writeError(res, 'not-found', 'document not found', 404)
        return
      }
      if ((doc.chunkCount ?? 0) === 0) {
        writeError(res, 'not-ready', '该文档还没有解析出片段，请先重新解析', 409)
        return
      }
      const pending = doc.pendingEnhance ?? 0
      if (pending === 0) {
        writeJson(res, 200, { ok: true, id, queued: false, pendingEnhance: 0, note: '该文档已全部增强' })
        return
      }
      const queued = runner.enrich(id)
      writeJson(res, 200, {
        ok: true,
        id,
        queued,
        pendingEnhance: pending,
        note: queued
          ? `已开始增强，将自动分批处理剩余 ${pending} 个片段`
          : '该文档已在队列中或正在增强中',
      })
      return
    }
    // One click over the whole library. Documents without an LLM backend still
    // enter the queue: `runEnrich` writes a plain-language note on them instead
    // of failing, so a misconfigured provider produces a visible reason on each
    // document rather than a silent no-op.
    if (rest === '/enrich-all') {
      // An explicit list means the user is looking at a filtered view (one
      // folder, or 「未增强」 only) and means *that* set — otherwise a bulk button
      // would quietly spend provider calls on documents they cannot see. Absent
      // list = the whole knowledge base.
      let only: string[] | null = null
      try {
        const body = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
        if (Array.isArray(body?.docIds)) {
          only = body.docIds.filter((v: unknown): v is string => typeof v === 'string' && !!v)
        }
      } catch {
        writeError(res, 'bad-request', 'invalid JSON body')
        return
      }
      const ids = only ? only.filter((id) => runner.enrich(id)) : runner.enrichPending()
      writeJson(res, 200, {
        ok: true,
        queued: ids.length,
        docIds: ids,
        note: ids.length
          ? `已把 ${ids.length} 篇待增强文档加入队列，将按批自动完成`
          : only
            ? '所选文档都已增强完成'
            : '没有待增强的文档',
      })
      return
    }
    // Stop a queued or running extraction or enrichment. Everything already
    // flushed stays, so a later `增强` resumes instead of re-paying for it.
    const cancelMatch = rest.match(/^\/cancel\/([^/]+)$/)
    if (cancelMatch) {
      const id = decodeURIComponent(cancelMatch[1])
      const doc = st.getDoc(id)
      if (!doc) {
        writeError(res, 'not-found', 'document not found', 404)
        return
      }
      const state = runner.cancel(id)
      if (state === 'not-running') {
        // Nothing in flight. Still normalise the record so a document left in a
        // running-looking state by a previous crash does not keep showing a
        // progress bar forever.
        const patch = RESUMABLE.has(doc.status)
          ? { status: 'cancelled' as const, progress: 0 }
          : {}
        if (Object.keys(patch).length) st.upsertDoc({ ...doc, ...patch })
      }
      const current = st.getDoc(id)
      writeJson(res, 200, {
        ok: true,
        id,
        cancelled: state === 'cancelled' || RESUMABLE.has(doc.status),
        status: current?.status ?? doc.status,
        enhancedChunks: current?.enhancedChunks ?? 0,
        note: state === 'not-running'
          ? '该文档当前没有在提取或增强'
          : '已停止；已完成的片段和小结都保留，可点「增强」接着做',
      })
      return
    }
    // (Re)generate the Markdown + mind-map exports from the *stored* chunks.
    // Needed for documents parsed before the export feature existed, and useful
    // after re-parsing with a different enrichment backend.
    const exportRunMatch = rest.match(/^\/export\/([^/]+)$/)
    if (exportRunMatch) {
      const id = decodeURIComponent(exportRunMatch[1])
      const doc = st.getDoc(id)
      if (!doc) {
        writeError(res, 'not-found', 'document not found', 404)
        return
      }
      const chunks = st.getChunks(id)
      if (chunks.length === 0) {
        writeError(res, 'not-ready', '文档尚未解析完成，暂无可导出的内容', 409)
        return
      }
      const ex = await writeDocExports(st.root, doc, chunks, st.otherExportNames(id))
      const exportedAt = new Date().toISOString()
      st.upsertDoc({ ...doc, mdFile: ex.mdFile, mindmapFile: ex.mindmapFile, exportedAt })
      writeJson(res, 200, {
        ok: true,
        id,
        mdFile: ex.mdFile,
        mindmapFile: ex.mindmapFile,
        exportedAt,
        bytes: { md: ex.md.length, mindmap: ex.mindmap.length },
      })
      return
    }
    // Replace a document's tag list. The full list is sent every time (not a
    // delta) so the client's optimistic view and the stored record can never
    // drift; normalisation lives in the store so every writer agrees.
    const tagsMatch = rest.match(/^\/tags\/([^/]+)$/)
    if (tagsMatch) {
      const id = decodeURIComponent(tagsMatch[1])
      if (!st.getDoc(id)) {
        writeError(res, 'not-found', 'document not found', 404)
        return
      }
      let body: { tags?: unknown } = {}
      try {
        body = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
      } catch {
        writeError(res, 'bad-request', 'invalid JSON body')
        return
      }
      if (!Array.isArray(body.tags)) {
        writeError(res, 'bad-request', 'tags must be an array of strings')
        return
      }
      const tags = st.setTags(id, body.tags) ?? []
      await st.flush()
      // Tags ride on the search index's Doc entries, so a re-tag has to refresh
      // the one document — otherwise `kb_search` with `tags` would filter on the
      // label the document had when it was last parsed.
      deps.reindex?.(id)
      writeJson(res, 200, { ok: true, id, tags, catalog: st.tagCounts() })
      return
    }
    // Folder creation, renaming, moving, and document moves. All of them touch
    // only index.json metadata — bytes and chunks never move, which is why a
    // folder operation is instant no matter how large the document is.
    if (rest === '/folder') {
      let body: { name?: unknown; parentId?: unknown; id?: unknown } = {}
      try {
        body = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
      } catch {
        writeError(res, 'bad-request', 'invalid JSON body')
        return
      }
      try {
        const folder = st.createFolder(
          typeof body.name === 'string' ? body.name : '',
          typeof body.parentId === 'string' && body.parentId ? body.parentId : undefined,
          typeof body.id === 'string' && body.id ? body.id : undefined,
        )
        await st.flush()
        writeJson(res, 200, { ok: true, folder, folders: st.listFolders() })
      } catch (e) {
        writeError(res, 'bad-request', e instanceof Error ? e.message : String(e), 400)
      }
      return
    }
    const folderMatch = rest.match(/^\/folder\/([^/]+)$/)
    if (folderMatch) {
      const id = decodeURIComponent(folderMatch[1])
      if (!st.getFolder(id)) {
        writeError(res, 'not-found', 'folder not found', 404)
        return
      }
      let body: { name?: unknown; parentId?: unknown } = {}
      try {
        body = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
      } catch {
        writeError(res, 'bad-request', 'invalid JSON body')
        return
      }
      try {
        // A single body may carry both: the UI's rename-then-drag is one
        // request, and applying them in one transaction keeps the tree from
        // flickering through an invalid intermediate state. The move runs first
        // so a rename that would collide at the destination is reported before
        // anything moved; and a body without `parentId` never moves at all —
        // "absent" means "leave the parent alone", not "move to the root".
        const parentId = body.parentId === undefined
          ? undefined
          : typeof body.parentId === 'string' && body.parentId
            ? body.parentId
            : ''
        const moved = parentId === undefined ? st.getFolder(id)! : st.moveFolder(id, parentId || undefined)
        const renamed = typeof body.name === 'string' ? st.renameFolder(id, body.name) : moved
        await st.flush()
        writeJson(res, 200, { ok: true, folder: renamed, folders: st.listFolders() })
      } catch (e) {
        writeError(res, 'bad-request', e instanceof Error ? e.message : String(e), 400)
      }
      return
    }
    const docFolderMatch = rest.match(/^\/doc\/([^/]+)\/folder$/)
    if (docFolderMatch) {
      const id = decodeURIComponent(docFolderMatch[1])
      if (!st.getDoc(id)) {
        writeError(res, 'not-found', 'document not found', 404)
        return
      }
      let body: { folderId?: unknown } = {}
      try {
        body = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
      } catch {
        writeError(res, 'bad-request', 'invalid JSON body')
        return
      }
      if (body.folderId !== undefined && body.folderId !== null && typeof body.folderId !== 'string') {
        writeError(res, 'bad-request', 'folderId must be a string or null')
        return
      }
      try {
        st.setDocFolder(id, body.folderId ? body.folderId : undefined)
        await st.flush()
        writeJson(res, 200, { ok: true, id, folderId: st.getDoc(id)?.folderId, folders: st.listFolders() })
      } catch (e) {
        writeError(res, 'bad-request', e instanceof Error ? e.message : String(e), 400)
      }
      return
    }
    // Retrieval, over HTTP as well as through the `kb_search` tool: the settings
    // tab uses it to answer "does my knowledge base know about X?" without
    // spending a model turn, and the same code path is what the tool calls, so a
    // query that works here is a query the tool can answer.
    if (rest === '/search') {
      let body: { query?: unknown; topK?: unknown; docId?: unknown; tags?: unknown } = {}
      try {
        body = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
      } catch {
        writeError(res, 'bad-request', 'invalid JSON body')
        return
      }
      const query = typeof body.query === 'string' ? body.query.trim() : ''
      if (!query) {
        writeError(res, 'bad-request', 'query is required')
        return
      }
      const hits = deps.search
        ? deps.search(query, {
            topK: body.topK as number,
            docId: typeof body.docId === 'string' && body.docId.trim() ? body.docId : undefined,
            tags: normalizeTags(body.tags),
          })
        : []
      writeJson(res, 200, {
        ok: true,
        query,
        count: hits.length,
        indexedDocs: deps.indexedDocs?.() ?? 0,
        indexedChunks: deps.indexedChunks?.() ?? 0,
        hits: hits.map((h) => ({
          docId: h.docId,
          docName: h.docName,
          docTags: h.docTags,
          chunkId: h.chunk.id,
          title: h.chunk.title,
          page: h.chunk.page,
          sectionPath: h.chunk.sectionPath,
          summary: h.chunk.summary,
          entities: h.chunk.entities.slice(0, 6),
          score: Math.round(h.score * 1000) / 1000,
          matchedTerms: h.matchedTerms,
          snippet: h.snippet,
        })),
        markdown: formatHits(query, hits),
      })
      return
    }
    // Settings tab: persist + hot-swap the enrichment backend. Persisting is
    // deliberately independent of the host llm service being available: the
    // choice is written to <dataDir>/settings.json and takes effect as soon as
    // llmRuntime appears (the `ok`/`note` fields report the current decision).
    if (rest === '/settings') {
      if (!settings) {
        writeError(res, 'internal', 'settings store not initialized', 500)
        return
      }
      let body: any
      try {
        body = JSON.parse((await readBody(req)).toString('utf-8') || '{}')
      } catch {
        writeError(res, 'bad-request', 'invalid JSON body')
        return
      }
      const prev = settings.get()
      // Token lifecycle: enabling auth without a token would lock the panel out
      // forever, so a token is minted on demand; `rotateToken` mints a fresh one
      // so a leaked token can be replaced without restarting the host.
      const wantsEnabled = typeof body.apiTokenEnabled === 'boolean' ? body.apiTokenEnabled : prev.apiTokenEnabled
      const rotate = body.rotateToken === true
      let apiToken = typeof body.apiToken === 'string' && body.apiToken.trim() ? body.apiToken.trim() : prev.apiToken
      if (rotate || (wantsEnabled && !apiToken)) apiToken = newApiToken()
      const next: KbSettings = {
        llmEnabled: typeof body.llmEnabled === 'boolean' ? body.llmEnabled : prev.llmEnabled,
        llmProvider: typeof body.llmProvider === 'string' && body.llmProvider ? body.llmProvider.trim() : prev.llmProvider,
        llmModel: typeof body.llmModel === 'string' && body.llmModel ? body.llmModel.trim() : prev.llmModel,
        // `0` is a meaningful value here (no ceiling), so only reject junk.
        maxEnrichChunks: numOr(body.maxEnrichChunks, prev.maxEnrichChunks),
        enrichConcurrency: clampConcurrency(numOr(body.enrichConcurrency, prev.enrichConcurrency)),
        apiTokenEnabled: wantsEnabled,
        apiToken,
      }
      const result = settings.set(next)
      writeJson(res, 200, { ok: result.ok, note: result.note, settings: settings.get() })
      return
    }
    writeError(res, 'not-found', 'unknown kb-api route', 404)
    return
  }

  // DELETE routes
  if (req.method === 'DELETE') {
    const folderDelMatch = rest.match(/^\/folder\/([^/]+)$/)
    if (folderDelMatch) {
      const id = decodeURIComponent(folderDelMatch[1])
      if (!st.getFolder(id)) {
        writeError(res, 'not-found', 'folder not found', 404)
        return
      }
      // Deleting a folder is never deleting its documents: they move up to the
      // deleted folder's parent (or to the root when it was top-level), so a
      // mis-click costs an empty directory, not a 24 MB manual.
      const result = st.deleteFolder(id)
      await st.flush()
      writeJson(res, 200, { ok: true, ...result, folders: st.listFolders() })
      return
    }
    const delMatch = rest.match(/^\/doc\/([^/]+)$/)
    if (delMatch) {
      const id = decodeURIComponent(delMatch[1])
      const doc = st.getDoc(id)
      if (!doc) {
        writeError(res, 'not-found', 'document not found', 404)
        return
      }
      await st.deleteDoc(id)
      // Drop it from the retrieval index too, or `kb_search` would keep citing a
      // document the user just deleted.
      deps.dropFromIndex?.(id)
      writeJson(res, 200, { ok: true, id })
      return
    }
    writeError(res, 'not-found', 'unknown kb-api route', 404)
    return
  }

  writeError(res, 'method-error', 'method not allowed', 405)
}

// ---- multipart upload -------------------------------------------------------

interface UploadResult {
  status: number
  body: unknown
}

async function handleUpload(
  req: NodeIncomingMessage,
  st: KnowledgeStore,
  runner: ParseRunner,
): Promise<UploadResult> {
  const ct = headerStr(req.headers['content-type'])
  const boundary = parseBoundary(ct)
  if (!boundary) return { status: 400, body: { ok: false, error: { code: 'bad-request', message: 'expected multipart/form-data' } } }

  let buf: Buffer = Buffer.alloc(0)
  try {
    buf = await readBody(req)
  } catch (e) {
    return { status: 400, body: { ok: false, error: { code: 'bad-request', message: 'could not read body: ' + (e as Error).message } } }
  }

  const { file, fields } = scanParts(buf, boundary)
  if (!file) {
    return { status: 400, body: { ok: false, error: { code: 'bad-request', message: 'no file field found' } } }
  }

  // The folder the user was looking at when they dropped the file. A folder id
  // that no longer exists (deleted in another tab, or a stale client) degrades to
  // the root rather than failing the upload — losing a 24 MB manual over a
  // cosmetic mis-click is the wrong trade, and the document is still findable at
  // the top level.
  const askedFolder = typeof fields.folderId === 'string' ? fields.folderId.trim() : ''
  const folderId = askedFolder && st.getFolder(askedFolder) ? askedFolder : undefined

  const size = file.data.length
  // Reject absurd payloads up front: a multi-GB upload would otherwise be
  // fully buffered in memory and then saved to disk, which can take the host
  // down. The parse pipeline also has no business with files this large.
  const MAX_UPLOAD_BYTES = 200 * 1024 * 1024
  if (size > MAX_UPLOAD_BYTES) {
    return { status: 413, body: { ok: false, error: { code: 'payload-too-large', message: `file too large (${size} bytes); limit is ${MAX_UPLOAD_BYTES} bytes` } } }
  }
  if (size === 0) {
    return { status: 400, body: { ok: false, error: { code: 'bad-request', message: 'empty file' } } }
  }

  // Only accept mime types the parser actually knows how to handle. Anything
  // else would either fall through to the (lossy) raw-text path or produce an
  // empty/garbage knowledge base.
  const ALLOWED = new Set([
    'text/plain', 'text/markdown', 'text/csv', 'text/html',
    'application/json', 'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ])
  const byExt: Record<string, string> = {
    txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
    csv: 'text/csv', html: 'text/html', htm: 'text/html',
    json: 'application/json', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }
  const ext = (file.filename || '').toLowerCase().split('.').pop() ?? ''
  const declared = (file.contentType || '').toLowerCase().split(';')[0].trim()
  const mime = ALLOWED.has(declared) ? declared : byExt[ext] || ''
  if (!mime) {
    return { status: 415, body: { ok: false, error: { code: 'unsupported-media', message: `unsupported file type: ${declared || ext || 'unknown'} (supported: txt md csv html json pdf docx)` } } }
  }

  const id = randomUUID()
  // Bound the display name so a malicious/garbage filename can never blow up
  // the JSON store or the client list rendering.
  const originalName = (file.filename || 'upload.bin').slice(0, 240)

  const doc: KnowledgeDoc = {
    id,
    name: originalName,
    originalName,
    mime,
    size,
    uploadedAt: new Date().toISOString(),
    status: 'queued',
    progress: 0,
    chunkCount: 0,
    entityCount: 0,
    ...(folderId ? { folderId } : {}),
  }
  st.upsertDoc(doc)
  await st.saveRaw(id, mime, originalName, size, file.data)
  await st.flush()

  // Kick off EXTRACTION only. The document lands in `extracted` a few seconds
  // later with its chunks, a mind map, and a retrieval index — but with no LLM
  // calls spent. 增强 is a separate job the user starts, because it costs
  // provider calls and can take minutes on a 2500-chunk manual.
  runner.enqueue(id)

  return {
    status: 200,
    body: { ok: true, doc, folderFallback: !!askedFolder && !folderId ? askedFolder : undefined },
  }
}

function headerStr(h: string | string[] | undefined): string {
  return Array.isArray(h) ? h[0] ?? '' : h ?? ''
}

function parseBoundary(ct: string): string | undefined {
  const m = /boundary=("?)([^";]+)\1/i.exec(ct)
  return m ? m[2] : undefined
}

function readBody(req: NodeIncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Split a multipart body into its parts, remembering the non-file ones.
 *
 * The folder id has to travel with the upload, and multipart is the only thing
 * the browser can send a file through, so the id rides as a sibling text field.
 * This used to return only the file part, which left the caller no way to see
 * the fields that came with it.
 */
function scanParts(
  buf: Buffer,
  boundary: string,
): { file?: { filename: string; contentType: string; data: Buffer }; fields: Record<string, string> } {
  const fields: Record<string, string> = {}
  let file: { filename: string; contentType: string; data: Buffer } | undefined
  const delim = Buffer.from(`--${boundary}`)
  let start = buf.indexOf(delim)
  if (start < 0) return { file, fields }
  while (true) {
    // move past delimiter + CRLF
    let scan = start + delim.length
    if (buf[scan] === 0x2d && buf[scan + 1] === 0x2d) {
      // closing boundary "--"
      return { file, fields }
    }
    // header ends at first blank line
    const headerEnd = buf.indexOf('\r\n\r\n', scan)
    if (headerEnd < 0) return { file, fields }
    // The disposition header is ASCII except the filename value, which browsers
    // send as raw UTF-8 bytes (e.g. 中文.pdf). Decoding as UTF-8 keeps
    // non-ASCII filenames intact; reading as latin1 here was what produced the
    // mojibake for Chinese file names.
    const headerText = buf.slice(scan + 2, headerEnd).toString('utf-8')
    const isFile = /name="file"/i.test(headerText)
    const nameMatch = /name="([^"]*)"/i.exec(headerText)
    let filename = ''
    // RFC 5987 form: filename*=UTF-8''%E4%B8%AD... (canonically percent-encoded).
    // Prefer it when present; otherwise fall back to the plain filename="…" value
    // (already UTF-8-decoded above).
    const fnStar = /filename\*=[^;]*''([^;\r\n]+)/i.exec(headerText)
    if (fnStar) {
      try {
        filename = decodeURIComponent(fnStar[1])
      } catch {
        /* keep the raw percent-encoded value */
      }
    }
    if (!filename) {
      const fn = /filename="([^"]*)"/i.exec(headerText)
      if (fn) filename = fn[1]
    }
    let contentType = 'application/octet-stream'
    const ct = /content-type:\s*([^\r\n]+)/i.exec(headerText)
    if (ct) contentType = ct[1].trim()

    const contentStart = headerEnd + 4
    // find next boundary
    const next = buf.indexOf(delim, contentStart)
    if (next < 0) return { file, fields }
    const data = buf.slice(contentStart, next - 2) // drop trailing CRLF

    if (isFile && data.length > 0) {
      // Keep scanning: the browser appends `file` BEFORE the sibling text fields,
      // so returning here would discard the `folderId` that follows it. Remember
      // the file and continue until the closing boundary.
      file = { filename, contentType, data }
      start = next
      continue
    }
    // not the file part; a small text field like `folderId` lands here
    if (nameMatch && data.length > 0 && data.length <= 200) {
      fields[nameMatch[1]] = data.toString('utf-8')
    }
    start = next
  }
}
