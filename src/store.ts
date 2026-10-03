// JSON-backed store for the knowledge base.
//
// Layout (under dataDir):
//   index.json          — { docs, chunks, folders }  (the KB)
//   docs/<id>.bin       — original uploaded bytes (kept for re-parse / preview)
//   docs/<id>.meta.json — { originalName, mime, size }
//   md/<name>.md        — generated Markdown export per document
//   md/<name>.mindmap.md— generated mind-map outline per document
//
// Everything is persisted across restarts. The graph is derived on read from the
// chunks' entities/links, so we never store a stale graph separately.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  Folder,
  GraphEdge,
  GraphNode,
  KnowledgeDoc,
  KnowledgeGraph,
  WikiChunk,
} from './types.ts'

export type { KnowledgeDoc, Folder }

interface IndexFile {
  version: 1
  docs: KnowledgeDoc[]
  chunks: WikiChunk[]
  /**
   * Absent in every index.json written before folders existed. Folders are
   * therefore additive: an old file loads with an empty tree and keeps loading
   * with one, because `init` fills the default and validation only requires
   * `docs` + `chunks` to be arrays.
   */
  folders?: Folder[]
}

/** Longest single tag accepted, and the most tags one document may carry. */
export const MAX_TAG_LEN = 32
export const MAX_TAGS_PER_DOC = 20

/** Longest folder name accepted, and the deepest nesting allowed. */
export const MAX_FOLDER_NAME_LEN = 60
export const MAX_FOLDER_DEPTH = 5

/** Trim a folder name and drop the characters a file name must not contain. */
function normalizeFolderName(raw: string): string {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ').replace(/[\\/:*?"<>|]/g, '')
  if (!name) throw new Error('文件夹名称不能为空')
  if (name.length > MAX_FOLDER_NAME_LEN) throw new Error(`文件夹名称不能超过 ${MAX_FOLDER_NAME_LEN} 个字符`)
  return name
}

/**
 * Folder ids are minted here rather than by the route so the store owns the
 * namespace; `randomUUID` keeps them path-safe, which matters because a folder
 * id travels through the `/kb-api/folder/:id/...` routes.
 */
function randomFolderId(): string {
  return randomUUID()
}

/**
 * Canonical form of a tag list: trimmed, single-spaced, lower-cased, empty
 * values dropped, de-duplicated, caller order preserved, capped.
 *
 * Lower-casing is what makes tags comparable — the UI, the `?tag=` filter and a
 * future `kb_search` narrowing all match with plain equality, so "NAT" written
 * by the user and "nat" coming from elsewhere must not become two tags.
 */
export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const tag = item.trim().replace(/\s+/g, ' ').toLowerCase()
    if (!tag) continue
    const clipped = tag.length > MAX_TAG_LEN ? tag.slice(0, MAX_TAG_LEN) : tag
    if (seen.has(clipped)) continue
    seen.add(clipped)
    out.push(clipped)
    if (out.length >= MAX_TAGS_PER_DOC) break
  }
  return out
}

export class KnowledgeStore {
  private index: IndexFile = { version: 1, docs: [], chunks: [] }
  private dirty = false
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly dataDir: string) {}

  get root(): string {
    return this.dataDir
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true })
    await fs.mkdir(path.join(this.dataDir, 'docs'), { recursive: true })
    await fs.mkdir(path.join(this.dataDir, 'md'), { recursive: true })
    const indexPath = path.join(this.dataDir, 'index.json')
    try {
      const raw = await fs.readFile(indexPath, 'utf-8')
      const parsed = JSON.parse(raw) as IndexFile
      if (parsed && Array.isArray(parsed.docs) && Array.isArray(parsed.chunks)) {
        this.index = parsed
        if (!Array.isArray(parsed.folders)) parsed.folders = []
        // `pendingEnhance` and `folderId` arrived after some index.json files were
        // written, so back-fill the derived counter rather than trusting a file
        // that predates it. `folderId` is left alone: absent means root, and
        // inventing a value here would move documents the user never touched.
        for (const doc of parsed.docs) this.stampPending(doc.id)
      }
    } catch {
      // No index yet — start fresh.
    }
  }

  // ---- document ops -------------------------------------------------------

  listDocs(): KnowledgeDoc[] {
    return [...this.index.docs].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))
  }

  getDoc(id: string): KnowledgeDoc | undefined {
    return this.index.docs.find((d) => d.id === id)
  }

  upsertDoc(doc: KnowledgeDoc): void {
    // The graph and every lookup key off the doc id, so a missing/empty id
    // corrupts the whole index. Reject rather than silently storing junk.
    if (!doc || typeof doc.id !== 'string' || doc.id.length === 0) {
      throw new Error('upsertDoc: doc.id is required')
    }
    const i = this.index.docs.findIndex((d) => d.id === doc.id)
    if (i >= 0) this.index.docs[i] = doc
    else this.index.docs.push(doc)
    this.markDirty()
  }

  getChunks(docId: string): WikiChunk[] {
    return this.index.chunks
      .filter((c) => c.id.startsWith(docId + '#'))
      .sort((a, b) => a.index - b.index)
  }

  setChunks(docId: string, chunks: WikiChunk[]): void {
    this.index.chunks = this.index.chunks.filter((c) => !c.id.startsWith(docId + '#'))
    this.index.chunks.push(...chunks)
    this.stampPending(docId)
    this.markDirty()
  }

  /**
   * Persist a *partial* enrichment result without disturbing the rest.
   *
   * A long LLM enrichment pass (hundreds of calls) used to land in exactly one
   * `setChunks` at the very end, so a host exit or crash mid-run threw away
   * every summary that had already been paid for. The runner now calls this
   * every few completed calls: each patch replaces only the listed ids, and the
   * document record is written in the same flush so `chunkCount` / `error` never
   * disagree with the chunk array.
   *
   * Chunks that were never enriched are still written (as the base text the
   * runner built) so the document is readable and searchable mid-run — a
   * resumed run only re-buys the ones whose `summary` is still missing.
   */
  saveChunkPatch(docId: string, chunks: WikiChunk[]): void {
    if (!chunks.length) return
    const patch = new Map<string, WikiChunk>()
    for (const c of chunks) patch.set(c.id, c)
    const next: WikiChunk[] = []
    // Replace in place so the derived graph keeps a stable chunk order; anything
    // the patch introduces that is not stored yet is appended.
    for (const c of this.index.chunks) {
      const hit = patch.get(c.id)
      if (hit) {
        patch.delete(c.id)
        next.push(hit)
      } else if (!c.id.startsWith(docId + '#')) {
        next.push(c)
      }
    }
    for (const c of patch.values()) next.push(c)
    this.index.chunks = next
    this.stampPending(docId)
    this.markDirty()
  }

  /**
   * Keep `pendingEnhance` (= chunks without a summary) in step with the chunk
   * array.
   *
   * It is derived rather than counted at the route because every writer touches
   * the chunk array in a different place — the runner's initial flush, its
   * throttled mid-run patches, `setChunks` on a re-parse, and a delete. Stamping
   * here is the only spot all four pass through, so the 已增强/未增强 filter can
   * never read a count that disagrees with what is on disk.
   *
   * Zero is stored as absent, so a fully-enhanced document's JSON is identical
   * to what a build without this field wrote.
   */
  private stampPending(docId: string): void {
    const doc = this.index.docs.find((d) => d.id === docId)
    if (!doc) return
    let pending = 0
    for (const c of this.index.chunks) {
      if (c.id.startsWith(docId + '#') && !c.summary) pending++
    }
    if (pending) doc.pendingEnhance = pending
    else delete doc.pendingEnhance
  }

  /** How many chunks of a document already carry an LLM summary. */
  enhancedCount(docId: string): number {
    let n = 0
    for (const c of this.index.chunks) {
      if (c.id.startsWith(docId + '#') && c.summary) n++
    }
    return n
  }

  /**
   * Replace a document's tags with a normalised set.
   *
   * Normalisation happens here rather than in the route so every writer (the tag
   * route, an import, a future edit) produces the same shape: trimmed, collapsed
   * to lower case, empty values dropped, de-duplicated, in the caller's order
   * (so the UI keeps the order the user typed) and capped.
   */
  setTags(docId: string, tags: string[]): string[] | undefined {
    const doc = this.index.docs.find((d) => d.id === docId)
    if (!doc) return undefined
    const next = normalizeTags(tags)
    // An empty list is stored as absent rather than `[]`, so the JSON of a
    // never-tagged document is identical to what older builds wrote.
    if (next.length) doc.tags = next
    else delete doc.tags
    this.markDirty()
    return doc.tags ? [...doc.tags] : undefined
  }

  /** Every tag in use, with the number of documents carrying it, for the filter bar. */
  tagCounts(): { tag: string; count: number }[] {
    const m = new Map<string, number>()
    for (const d of this.index.docs) {
      for (const t of d.tags ?? []) m.set(t, (m.get(t) ?? 0) + 1)
    }
    return [...m.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  }

  async saveChunksNow(docId: string, chunks: WikiChunk[]): Promise<void> {
    this.saveChunkPatch(docId, chunks)
    await this.flush()
  }

  // ---- folder ops ---------------------------------------------------------
  //
  // Folders are pure metadata: a document is bytes + chunks regardless of where
  // it sits in the tree, so every operation here is an in-memory array edit plus
  // one `markDirty`. Nothing on disk is moved.

  /** Folders in creation order — the tree is built from this, so the order the
   * user made them in is the order they render in. */
  listFolders(): Folder[] {
    return [...(this.index.folders ?? [])]
  }

  getFolder(id: string): Folder | undefined {
    return (this.index.folders ?? []).find((f) => f.id === id)
  }

  /**
   * Ancestor titles of a folder, outermost first, excluding the folder itself.
   * Read defensively: a missing or cyclic parent (hand-edited index.json) stops
   * the walk instead of looping forever.
   */
  folderPath(id: string): string[] {
    const byId = new Map((this.index.folders ?? []).map((f) => [f.id, f]))
    const out: string[] = []
    const seen = new Set<string>([id])
    let cur = byId.get(id)?.parentId
    while (cur) {
      if (seen.has(cur)) break
      seen.add(cur)
      const f = byId.get(cur)
      if (!f) break
      out.unshift(f.name)
      cur = f.parentId
    }
    return out
  }

  /**
   * Ids of a folder and every folder beneath it, including itself. Used by the
   * delete and the move-cycle check; iterative so a deep tree cannot blow the
   * stack, and cycle-safe so a hand-edited index cannot hang it.
   */
  private folderSubtree(id: string): string[] {
    const folders = this.index.folders ?? []
    const out = [id]
    const seen = new Set([id])
    for (let i = 0; i < out.length; i++) {
      for (const f of folders) {
        if (f.parentId !== out[i] || seen.has(f.id)) continue
        seen.add(f.id)
        out.push(f.id)
      }
    }
    return out
  }

  private folderDepth(id: string | undefined): number {
    return id ? this.folderPath(id).length + 1 : 1
  }

  /**
   * How deep the subtree rooted at `id` goes, i.e. the number of levels below it
   * (0 when it is a leaf). `MAX_FOLDER_DEPTH` caps the *resulting* depth of a
   * new placement, so a folder that already contains a deep branch cannot be
   * pushed deeper than the limit.
   */
  private folderSubtreeHeight(id: string): number {
    const folders = this.index.folders ?? []
    const children = new Map<string, string[]>()
    for (const f of folders) {
      if (!f.parentId) continue
      const list = children.get(f.parentId)
      if (list) list.push(f.id)
      else children.set(f.parentId, [f.id])
    }
    let height = 0
    const walk = (node: string, level: number): void => {
      height = Math.max(height, level)
      for (const child of children.get(node) ?? []) walk(child, level + 1)
    }
    walk(id, 0)
    return height
  }

  /**
   * Create a folder. Throws on a blank/over-long name, a missing parent, or a
   * placement that would exceed `MAX_FOLDER_DEPTH` — the HTTP layer turns that
   * into a 400 with the message, and the UI shows it verbatim.
   */
  createFolder(name: string, parentId?: string, id = randomFolderId()): Folder {
    const clean = normalizeFolderName(name)
    const folders = this.index.folders ?? (this.index.folders = [])
    if (parentId !== undefined) {
      if (!parentId) throw new Error('parentId 不可为空；顶级文件夹请省略该字段')
      if (!folders.some((f) => f.id === parentId)) throw new Error('父文件夹不存在')
      if (this.folderDepth(parentId) >= MAX_FOLDER_DEPTH) {
        throw new Error(`文件夹最多嵌套 ${MAX_FOLDER_DEPTH} 层`)
      }
    }
    if (folders.some((f) => f.name === clean && (f.parentId ?? undefined) === (parentId ?? undefined))) {
      throw new Error('同级下已存在同名文件夹')
    }
    const folder: Folder = { id, name: clean, createdAt: new Date().toISOString() }
    if (parentId) folder.parentId = parentId
    folders.push(folder)
    this.markDirty()
    return folder
  }

  /** Rename a folder. Name-only: the shape of the tree is `moveFolder`'s job. */
  renameFolder(id: string, name: string): Folder {
    const folder = this.getFolder(id)
    if (!folder) throw new Error('文件夹不存在')
    const clean = normalizeFolderName(name)
    if ((this.index.folders ?? []).some(
      (f) => f.id !== id && f.name === clean && (f.parentId ?? undefined) === (folder.parentId ?? undefined),
    )) {
      throw new Error('同级下已存在同名文件夹')
    }
    folder.name = clean
    this.markDirty()
    return folder
  }

  /**
   * Re-parent a folder, or promote it to the root with no `parentId`. Moving a
   * folder into its own subtree is refused (it would detach that subtree from
   * the tree entirely), and so is a move that would nest past the depth cap.
   */
  moveFolder(id: string, parentId?: string): Folder {
    const folder = this.getFolder(id)
    if (!folder) throw new Error('文件夹不存在')
    if (parentId) {
      if (parentId === id) throw new Error('不能把文件夹移动到它自己里面')
      if (!this.getFolder(parentId)) throw new Error('父文件夹不存在')
      if (this.folderSubtree(id).includes(parentId)) throw new Error('不能把文件夹移动到它的子文件夹里面')
      const depth = this.folderDepth(parentId) + this.folderSubtreeHeight(id)
      if (depth > MAX_FOLDER_DEPTH) throw new Error(`移动后文件夹会超过 ${MAX_FOLDER_DEPTH} 层，请先移动子文件夹`)
      folder.parentId = parentId
    } else {
      delete folder.parentId
    }
    this.markDirty()
    return folder
  }

  /**
   * Delete a folder and every folder beneath it. Documents are never deleted
   * with a folder: they are lifted to the deleted folder's own parent, which is
   * the one thing a user cannot reconstruct by hand afterwards.
   */
  deleteFolder(id: string): { removed: number; movedDocs: number } {
    const folder = this.getFolder(id)
    if (!folder) throw new Error('文件夹不存在')
    const gone = new Set(this.folderSubtree(id))
    const parentId = folder.parentId
    let movedDocs = 0
    for (const d of this.index.docs) {
      if (!d.folderId || !gone.has(d.folderId)) continue
      if (parentId) d.folderId = parentId
      else delete d.folderId
      movedDocs++
    }
    this.index.folders = (this.index.folders ?? []).filter((f) => !gone.has(f.id))
    this.markDirty()
    return { removed: gone.size, movedDocs }
  }

  /**
   * Move a document into a folder (or to the root with no `folderId`). A
   * `folderId` that no longer resolves is cleared rather than kept, so a
   * document can never be stranded in a folder the tree does not have.
   */
  setDocFolder(docId: string, folderId?: string): void {
    const doc = this.index.docs.find((d) => d.id === docId)
    if (!doc) throw new Error('文档不存在')
    if (folderId) {
      if (!this.getFolder(folderId)) throw new Error('文件夹不存在')
      doc.folderId = folderId
    } else {
      delete doc.folderId
    }
    this.markDirty()
  }

  async deleteDoc(id: string): Promise<void> {
    if (!id) throw new Error('deleteDoc: id is required')
    const doc = this.index.docs.find((d) => d.id === id)
    this.index.docs = this.index.docs.filter((d) => d.id !== id)
    this.index.chunks = this.index.chunks.filter((c) => !c.id.startsWith(id + '#'))
    this.markDirty()
    try {
      await fs.rm(path.join(this.dataDir, 'docs', id + '.bin'), { force: true })
      await fs.rm(path.join(this.dataDir, 'docs', id + '.meta.json'), { force: true })
    } catch {
      /* ignore */
    }
    // Exported Markdown / mind-map files go with the document.
    for (const f of [doc?.mdFile, doc?.mindmapFile]) {
      if (!f || f.includes('/') || f.includes('\\') || f.startsWith('.')) continue
      try {
        await fs.rm(path.join(this.dataDir, 'md', f), { force: true })
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Export file names already used by *other* documents, so a new export never
   * overwrites a same-named document's Markdown.
   */
  otherExportNames(exceptDocId?: string): string[] {
    const names: string[] = []
    for (const d of this.index.docs) {
      if (d.id === exceptDocId) continue
      if (d.mdFile) names.push(d.mdFile)
      if (d.mindmapFile) names.push(d.mindmapFile)
    }
    return names
  }

  // ---- raw bytes ----------------------------------------------------------

  async saveRaw(id: string, mime: string, originalName: string, size: number, data: Buffer): Promise<void> {
    await fs.writeFile(path.join(this.dataDir, 'docs', id + '.bin'), data)
    await fs.writeFile(
      path.join(this.dataDir, 'docs', id + '.meta.json'),
      JSON.stringify({ originalName, mime, size }),
    )
  }

  async readRaw(id: string): Promise<Buffer | undefined> {
    try {
      return await fs.readFile(path.join(this.dataDir, 'docs', id + '.bin'))
    } catch {
      return undefined
    }
  }

  // ---- graph --------------------------------------------------------------

  /**
   * Cap the derived graph so a pathological document (thousands of distinct
   * entities, or one giant entity co-mentioned everywhere) cannot produce an
   * unbounded node/edge set that the SVG renderer chokes on. We keep the
   * highest-weight nodes/edges rather than truncating arbitrarily.
   */
  private static readonly MAX_NODES = 600
  private static readonly MAX_EDGES = 4000

  buildGraph(): KnowledgeGraph {
    const { nodes, edges } = this.buildGraphRaw()
    if (nodes.length <= KnowledgeStore.MAX_NODES && edges.length <= KnowledgeStore.MAX_EDGES) {
      return { nodes, edges }
    }
    const topNodes = nodes
      .sort((a, b) => b.weight - a.weight)
      .slice(0, KnowledgeStore.MAX_NODES)
    const keep = new Set(topNodes.map((n) => n.id))
    const topEdges = edges
      .filter((e) => keep.has(e.source) && keep.has(e.target))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, KnowledgeStore.MAX_EDGES)
    return { nodes: topNodes, edges: topEdges }
  }

  private buildGraphRaw(): KnowledgeGraph {
    const nodes = new Map<string, GraphNode>()
    const edges: GraphEdge[] = []
    const entityDocs = new Map<string, Set<string>>()
    const entityPairs = new Map<string, number>()

    const ensureEntity = (label: string): string => {
      const key = label.toLowerCase()
      if (!nodes.has('e:' + key)) {
        nodes.set('e:' + key, {
          id: 'e:' + key,
          label,
          kind: 'entity',
          weight: 0,
        })
      }
      return 'e:' + key
    }

    for (const doc of this.index.docs) {
      const docNodeId = 'd:' + doc.id
      nodes.set(docNodeId, {
        id: docNodeId,
        label: doc.name,
        kind: 'doc',
        weight: doc.chunkCount,
        docId: doc.id,
      })

      const chunkEntities = new Set<string>()
      for (const chunk of this.index.chunks.filter((c) => c.id.startsWith(doc.id + '#'))) {
        for (const ent of chunk.entities) {
          const eId = ensureEntity(ent)
          chunkEntities.add(eId)
          const node = nodes.get(eId)!
          node.weight += 1
          let set = entityDocs.get(eId)
          if (!set) {
            set = new Set()
            entityDocs.set(eId, set)
          }
          set.add(docNodeId)
          // doc -> entity
          edges.push({ source: docNodeId, target: eId, kind: 'contains', weight: 1 })
        }
        // relate entities co-mentioned inside the same chunk
        const list = [...chunkEntities]
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const pair = [list[i], list[j]].sort().join('|')
            entityPairs.set(pair, (entityPairs.get(pair) ?? 0) + 1)
          }
        }
        chunkEntities.clear()
      }
    }

    // entity -> entity edges (dedup by pair)
    const seen = new Set<string>()
    for (const [pair, weight] of entityPairs) {
      const [a, b] = pair.split('|')
      const key = [a, b].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      edges.push({ source: a, target: b, kind: 'relates', weight })
    }

    return { nodes: [...nodes.values()], edges }
  }

  // ---- persistence --------------------------------------------------------

  private markDirty(): void {
    this.dirty = true
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    this.writeChain = this.writeChain.then(async () => {
      if (!this.dirty) return
      this.dirty = false
      const tmp = path.join(this.dataDir, 'index.json.tmp')
      const final = path.join(this.dataDir, 'index.json')
      let payload: string
      try {
        // Serialise on a copy of the live index so a parse that keeps merging
        // results into chunks while we write cannot tear a half-written array.
        payload = JSON.stringify(this.index)
      } catch (err) {
        this.dirty = true
        console.error('[dsh-llm-wiki-knowledge] index serialise failed:', err)
        return
      }
      try {
        await fs.writeFile(tmp, payload)
        await fs.rename(tmp, final)
      } catch (err) {
        // Windows refuses `rename` over an existing file while a reader (an
        // editor, a virus scanner, a file indexer) holds it open — EPERM /
        // EACCES, not a real failure. The tmp file is already complete at this
        // point, so fall back to writing the destination in place; only a
        // failure of *that* leaves the old index intact and worth retrying.
        this.dirty = true
        try {
          await fs.writeFile(final, payload)
          this.dirty = false
          await fs.unlink(tmp).catch(() => {})
        } catch (err2) {
          // A failed persistence must not become an unhandled rejection that
          // escalates into a fatal host shutdown. Re-mark dirty so the next
          // flush retries, and log.
          console.error('[dsh-llm-wiki-knowledge] index write failed:', err, '/', err2)
        }
      }
    })
  }

  async flush(): Promise<void> {
    await this.writeChain
  }
}
