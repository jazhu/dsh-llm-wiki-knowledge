// Shared data model for the knowledge-base plugin.
// Both the host half (routes/store) and the client half (display) agree on these
// shapes through the /kb-api JSON contract.

export type DocStatus =
  | 'queued'
  | 'extracting'
  | 'parsing'
  | 'enriching'
  | 'indexing'
  | 'done'
  | 'error'
  /**
   * Local extraction finished: text pulled, outline detected, chunks cut and
   * flushed — but no LLM summary bought yet. This is the resting state after
   * every upload, because extraction is free and instant while enrichment costs
   * money and takes minutes. It is also the state enrichment is entered from.
   */
  | 'extracted'
  /**
   * Stopped by the user (POST /kb-api/cancel/:id). A cancelled document keeps
   * whatever chunks were already flushed, so `增强` can resume it — the
   * chunks it did NOT pay for are exactly the ones a re-run will still buy.
   */
  | 'cancelled'

/**
 * A user-created folder. Folders nest arbitrarily deep; `parentId` is null /
 * absent for a top-level folder. Documents live in exactly one folder (or none,
 * which renders at the root).
 */
export interface Folder {
  id: string
  name: string
  parentId?: string
  createdAt: string
}

export interface WikiChunk {
  id: string
  index: number
  /** Short heading derived from the chunk (first line / sentence). */
  title: string
  text: string
  tokens: number
  /** Entities (nouns / named concepts) detected in this chunk. */
  entities: string[]
  /** Wiki-style cross-links: entity labels this chunk references. */
  links: string[]
  /** One-sentence gist from LLM enrichment (absent when enrichment is off). */
  summary?: string
  /** True when `title` is a real heading (document outline / section title). */
  heading?: boolean
  /** Source page (1-based) when the document exposed page-aware extraction. */
  page?: number
  /** Ancestor section titles, outermost first (outline-backed documents only). */
  sectionPath?: string[]
}

/** One entry of a document's real table of contents / PDF bookmark tree. */
export interface OutlineEntry {
  /** 1-based nesting depth (1 = chapter). */
  level: number
  title: string
  /** 1-based source page; 0 when the source has no page numbers (text/HTML). */
  page: number
  /** Ancestor titles, outermost first (without `title` itself). */
  path?: string[]
}

export type OutlineSource = 'pdf-bookmarks' | 'text-headings' | 'markdown-headings'

export interface KnowledgeDoc {
  id: string
  name: string
  originalName: string
  mime: string
  size: number
  uploadedAt: string
  status: DocStatus
  /** 0..100 */
  progress: number
  error?: string
  /** Warning about partial extraction (e.g. binary salvaged text). */
  warning?: string
  chunkCount: number
  entityCount: number
  /** Chunks that actually carry an LLM summary (<= chunkCount). */
  enhancedChunks?: number
  summary?: string
  /**
   * Real table of contents of the document (PDF bookmarks, Markdown headings or
   * detected heading lines). Empty / absent when nothing heading-like was found.
   */
  outline?: OutlineEntry[]
  /** Where `outline` came from, for display. */
  outlineSource?: OutlineSource
  /** File name of the generated Markdown export inside `<dataDir>/md/`. */
  mdFile?: string
  /** File name of the generated mind-map outline inside `<dataDir>/md/`. */
  mindmapFile?: string
  /** ISO timestamp of the last successful export write. */
  exportedAt?: string
  /**
   * User-assigned labels. Free-form strings, lower-cased and de-duplicated by
   * the host, so a filter or a `kb_search` narrowing can rely on them verbatim.
   */
  tags?: string[]
  /**
   * Owning folder. Absent / null means the document sits at the root of the
   * library, which is where every document imported before folders existed
   * (and before this field did) stays.
   */
  folderId?: string
  /**
   * Chunks still waiting for a summary. Derived by the store on every write;
   * 0 means the document is fully enhanced, which is what the 已增强/未增强
   * filter keys on (together with `enhancedChunks`).
   */
  pendingEnhance?: number
}

export interface GraphNode {
  id: string
  label: string
  /** 'doc' for document hubs, 'entity' for extracted concepts. */
  kind: 'doc' | 'entity'
  weight: number
  docId?: string
}

export interface GraphEdge {
  source: string
  target: string
  /** relationship kind: 'contains' (doc->entity) or 'relates' (entity->entity). */
  kind: 'contains' | 'relates'
  weight: number
}

export interface KnowledgeGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface StatusResponse {
  ok: boolean
  dataDir: string
  deepseekConfigured: boolean
  documentCount: number
  chunkCount: number
  entityCount: number
  graph: { nodeCount: number; edgeCount: number }
}
