// The knowledge base's model-facing tools.
//
// Registering tools is what turns the knowledge base from a file the user has
// to read into something the assistant can consult mid-conversation. Until this
// existed, answering from imported manuals meant running `kb-retrieve.mjs` in a
// terminal and pasting substrings back — unusable for a question phrased in
// natural language.
//
// Four tools, split along the lines retrieval actually needs:
//
//   kb_list_documents  what is in the library at all
//   kb_search          passages, plus any document a title-shaped query names
//   kb_read_document   one document, reassembled, page by page
//   kb_ask             delegate a broad question and get a cited answer
//
// The split is not decoration. `kb_search` returns fragments, and a fragment is
// rarely enough context: a configuration chapter is a page of commands with
// caveats, and an answer built from one isolated paragraph is usually wrong in a
// way that reads as right. `kb_read_document` exists so the model can pull the
// whole section once a fragment looks relevant. `kb_ask` is the opposite trade:
// it hands the question to a model over the same corpus and returns a conclusion
// with citations, which is right for a question spanning many documents and
// wrong whenever the model needs to judge the evidence itself.
//
// The definitions are built locally rather than imported from
// `@deepseek-ai/dsh-tools`, for two reasons:
//
//   * `defineTool` in the installed build is a plain identity function (all
//     validation happens in `ToolRuntime.register`), so an equivalent local
//     shim is behaviour-identical and needs no build-time dependency on a
//     package that ships no type declarations;
//   * it keeps the shape here readable, which matters because the parameter DSL
//     is unusual: `parameters` is an implicit property map, not a JSON Schema
//     object, and each property is a *value* schema whose own `required: true`
//     makes it mandatory.

import { formatHits, type RetrieveHit } from './retrieve.ts'
import type { AskAnswer } from './kb-ask.ts'

export const KB_SEARCH_TOOL_NAME = 'kb_search'
export const KB_LIST_TOOL_NAME = 'kb_list_documents'
export const KB_READ_TOOL_NAME = 'kb_read_document'
export const KB_ASK_TOOL_NAME = 'kb_ask'
/** Every tool this plugin contributes, in the order a model should reach for them. */
export const KB_TOOL_NAMES = [KB_LIST_TOOL_NAME, KB_SEARCH_TOOL_NAME, KB_READ_TOOL_NAME, KB_ASK_TOOL_NAME] as const

/** One property = one tool argument. `required: true` makes it mandatory. */
export interface ToolParameterSpec {
  type: string
  required?: true
  description?: string
  enum?: readonly (string | number)[]
  items?: ToolParameterSpec
  minimum?: number
  maximum?: number
  default?: unknown
}

export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, ToolParameterSpec>
  output: { schema: unknown; render(args: unknown, value: unknown): { type: 'text'; text: string }[] }
  isConcurrencySafe(): boolean
  execute(args: Record<string, unknown>, exec?: { signal?: AbortSignal }): Promise<string>
}

/**
 * Local stand-in for the host's `defineTool`. Validation, description rendering
 * and dispatch all live in `ToolRuntime.register`; this only fixes the shape so
 * the definition is readable and typed at the call site.
 */
function defineTool<T extends ToolDefinitionLike>(options: T): T {
  return options
}

/** One document as the tools report it. */
export interface KbDocumentRow {
  id: string
  name: string
  /** 0-100 parse progress; a document below 100 is still being enriched. */
  progress: number
  status: string
  chunkCount: number
  enhancedChunks: number
  tags: string[]
  /** Outline depth, or 0 when the document has no table of contents. */
  outlineEntries: number
  /** The LLM summary of the document's first sections, when one exists. */
  summary: string
}

/** One page of a document, as `kb_read_document` returns it. */
export interface KbDocumentPage {
  doc: KbDocumentRow
  page: number
  pageSize: number
  total: number
  hasMore: boolean
  /** Section titles covering this page, so the model knows what it is reading. */
  sectionTitles: string[]
  content: string
  /** True when `content` was cut to fit the character budget. */
  truncated: boolean
}

export interface KbToolsDeps {
  /**
   * Run a query. Awaited because the retrieval index is built lazily on the
   * first call that needs the store, so the tool must not answer before that.
   */
  search(
    query: string,
    opts: { topK?: number; docId?: string; tags?: string[] },
  ): Promise<RetrieveHit[]> | RetrieveHit[]
  /** Corpus size, reported when a query returns nothing so the model can tell
   *  "nothing indexed" from "nothing matched". */
  stats(): { docs: number; chunks: number }
  /** Every tag in use, so the tool can name them when a user asks. */
  tagCatalog(): { tag: string; count: number }[]
  /**
   * Every stored document, newest first. Optional: a host that mounts only the
   * search tool still works, it just cannot report a document the query named.
   */
  listDocuments?(): KbDocumentRow[]
  /** One document's chunks reassembled in reading order. */
  readDocument?(docId: string, page: number, pageSize: number): KbDocumentPage | undefined
  /**
   * Ask a model to answer from the corpus. Absent when no LLM backend is
   * available — `kb_ask` then says so instead of failing the call.
   */
  ask?(query: string, opts: { docId?: string; tags?: string[]; topK?: number; signal?: AbortSignal }): Promise<AskAnswer | undefined>
}

// ---- shared argument reading ----------------------------------------------
//
// The harness hands arguments as `unknown`. A model that gets a type wrong is a
// normal event, not an error worth crashing the turn over, so every reader here
// degrades to a default instead of throwing — except `query`, where an empty
// value means the call did nothing and must be reported.

function argRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {}
}

function stringArrayArg(args: Record<string, unknown>, field: string): string[] {
  const value = args[field]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
}

function boundedIntArg(args: Record<string, unknown>, field: string, fallback: number, max: number): number {
  const value = args[field]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), max)
}

/** Default topK, the number of passages a search hands to the model. */
const DEFAULT_TOP_K = 5
/** Largest number of passages one search may return. */
const MAX_TOP_K = 12

// ---- kb_list_documents -----------------------------------------------------

const LIST_PARAMETERS: Record<string, ToolParameterSpec> = {
  nameLike: {
    type: 'string',
    description: '按文档名模糊过滤（可选）。不填则列出全部文档。',
  },
  tag: {
    type: 'string',
    description: '只看带这个标签的文档（可选），例如 "命令行"。不填则不按标签过滤。',
  },
  limit: {
    type: 'integer',
    description: '最多返回多少篇文档，默认 20。',
    minimum: 1,
    maximum: 100,
  },
}

const LIST_DESCRIPTION = [
  '列出 DSH 知识库中已导入的文档（名称、解析状态、片段数、标签、目录条数）。',
  `${KB_SEARCH_TOOL_NAME} 本身就能检索全部文档，所以只在这两种情况下调用本工具：① 用户想知道知识库里有哪些资料；② 需要某个文档的 id 传给 ${KB_READ_TOOL_NAME} 或 ${KB_SEARCH_TOOL_NAME} 的 docId 参数。`,
  '解析进度不足 100% 的文档只有部分片段带 LLM 小结，检索到的内容可能不完整。',
].join('\n')

function renderDocuments(rows: KbDocumentRow[], filtered: boolean): string {
  // "No documents" and "nothing matched the filter" are different answers, and
  // conflating them sends a user off to import files they already have.
  if (!rows.length) {
    return filtered
      ? '知识库中没有文档匹配这个过滤条件。可以去掉 nameLike / tag 再调用本工具，看看知识库里到底有哪些文档。'
      : '知识库中还没有已解析的文档。'
  }
  const lines = rows.map((d) => {
    const bits = [
      `id: ${d.id}`,
      d.chunkCount ? `${d.chunkCount} 片段` : '未解析',
      d.enhancedChunks ? `${d.enhancedChunks} 段已增强` : '',
      d.outlineEntries ? `目录 ${d.outlineEntries} 条` : '',
      d.tags.length ? `标签：${d.tags.join('、')}` : '',
    ].filter(Boolean)
    return `- ${d.name}（${d.progress}% · ${d.status}｜${bits.join(' · ')}）`
  })
  return `知识库共 ${rows.length} 篇文档：\n${lines.join('\n')}`
}

// ---- kb_search -------------------------------------------------------------

const SEARCH_PARAMETERS: Record<string, ToolParameterSpec> = {
  query: {
    type: 'string',
    required: true,
    description:
      '要检索的问题或关键词，使用知识库中的术语自然表述（中文优先）。例如"StoneOS 怎么配置源 NAT"、"IPS 策略的默认动作是什么"。',
  },
  topK: {
    type: 'integer',
    description: `返回的片段数量，默认 ${DEFAULT_TOP_K}，最大 ${MAX_TOP_K}。片段越多覆盖越全，但会占用更多上下文。`,
    minimum: 1,
    maximum: MAX_TOP_K,
  },
  docId: {
    type: 'string',
    description: `限定只检索某一个文档（可选），id 来自 ${KB_LIST_TOOL_NAME}。不填则检索整个知识库。`,
  },
  tags: {
    type: 'array',
    items: { type: 'string' },
    description:
      '只检索带这些标签的文档（可选），例如 ["命令行"]。标签由用户在知识库面板中给文档添加；不填则不按标签过滤。',
  },
}

const SEARCH_DESCRIPTION = [
  '检索 DSH 知识库（用户已导入的 PDF/Markdown/Word/HTML 文档解析后的片段）并返回相关原文片段。',
  '当用户的问题涉及已导入的文档内容、产品手册、配置命令、参数含义时，先调用本工具获取依据，再据此作答。',
  '返回内容包含：所属文档、章节标题、页码、LLM 生成的小结、命中片段原文。当查询读起来像一个文档名时，还会额外列出它命中的文档。',
  '每条命中都带有 docId；若某个片段看起来相关但上下文不足，用 ' + KB_READ_TOOL_NAME + ' 读取该文档的相关章节。',
  '文档可被用户打上标签（如"命令行""webui"）；可用 tags 参数只在带指定标签的文档里检索。',
  '引用答案时请注明文档名与章节；若无命中，直接说明知识库中没有相关内容，不要凭空推测。',
].join('\n')

/**
 * Documents a title-shaped query names, so a model can be handed a file whose
 * body never uses the words in its name.
 *
 * Two conditions, both load-bearing: the query has to look like a name (no
 * interrogative, few tokens — "IPS 的默认动作是什么" is a question, not a
 * title), and the match has to be a substring of the name rather than a token
 * overlap, because a tag or a section title often contains the same characters
 * as the query while the document it belongs to is somewhere else entirely.
 */
function documentsNamedBy(
  query: string,
  hits: RetrieveHit[],
  docs: KbDocumentRow[],
): KbDocumentRow[] {
  const text = query.trim()
  // A question is not a document name, however well the words match.
  if (text.length < 2 || /[？?]|怎么|如何|什么|哪些|是否|为什么|为何|请问|解释|介绍/.test(text)) return []
  if (text.length > 60) return []
  // Space-separated CJK is a question; a real title is written without it.
  if (/\s/.test(text) && /[一-鿿]/.test(text)) return []
  const lower = text.toLowerCase()
  const alreadyHit = new Set(hits.map((h) => h.docId))
  return docs.filter(
    (d) => !alreadyHit.has(d.id) && (d.name.toLowerCase().includes(lower) || lower.includes(d.name.toLowerCase())),
  )
}

/** The documents a title-shaped query named, rendered for the model to act on. */
function renderNamedDocuments(query: string, rows: KbDocumentRow[]): string {
  const block = rows
    .map((d) => `- ${d.name}（docId: ${d.id}${d.chunkCount ? ` · ${d.chunkCount} 片段` : ''}）`)
    .join('\n')
  return `查询「${query}」还匹配到以下文档（可用 ${KB_READ_TOOL_NAME} 读取）：\n${block}`
}

// ---- kb_read_document ------------------------------------------------------
const READ_PARAMETERS: Record<string, ToolParameterSpec> = {
  docId: {
    type: 'string',
    required: true,
    description: `文档 id，来自 ${KB_SEARCH_TOOL_NAME} 的命中结果或 ${KB_LIST_TOOL_NAME} 的列表。`,
  },
  page: {
    type: 'integer',
    description: '第几页，从 1 开始。默认 1。',
    minimum: 1,
  },
  pageSize: {
    type: 'integer',
    description: '每页多少个片段，默认 8，最大 40。',
    minimum: 1,
    maximum: 40,
  },
}

const READ_DESCRIPTION = [
  '按顺序读取知识库中某篇文档的正文片段（把片段拼回连贯文本），用于 ' + KB_SEARCH_TOOL_NAME + ' 找到相关片段后补充上下文。',
  '第一页会给出文档标题、解析状态和它包含的章节标题，长文档不必翻完才知道自己拿到的是什么。',
  '文档很长时请用 page 继续翻页（返回内容里的「还有更多片段」提示下一页）。',
].join('\n')

function renderDocumentPage(page: KbDocumentPage): string {
  if (page.total === 0) return `文档「${page.doc.name}」还没有解析出任何片段，请提示用户先等待解析完成。`
  const status = page.doc.progress < 100 ? `（解析中 ${page.doc.progress}%，内容可能不完整）` : ''
  const header = [
    `文档：${page.doc.name}${status}`,
    `id: ${page.doc.id}`,
    `片段 ${Math.min(page.pageSize, page.total - (page.page - 1) * page.pageSize)}-${(page.page - 1) * page.pageSize + Math.min(page.pageSize, page.total - (page.page - 1) * page.pageSize)} / 共 ${page.total}`,
  ]
  if (page.doc.tags.length) header.push(`标签：${page.doc.tags.join('、')}`)
  if (page.sectionTitles.length) header.push(`本页涉及章节：${page.sectionTitles.join(' / ')}`)
  const more = page.hasMore ? `\n\n（还有更多片段，可用 page: ${page.page + 1} 继续读取）` : ''
  const cut = page.truncated ? '\n（本页内容已截断，可用更小的 pageSize 精读）' : ''
  return `${header.join('\n')}\n\n${page.content}${cut}${more}`
}

// ---- kb_ask ----------------------------------------------------------------

const ASK_PARAMETERS: Record<string, ToolParameterSpec> = {
  query: {
    type: 'string',
    required: true,
    description: '要回答的问题。适合跨多篇文档、需要综合的宽泛问题。',
  },
  docId: {
    type: 'string',
    description: '只在某一篇文档里回答（可选）。',
  },
  tags: {
    type: 'array',
    items: { type: 'string' },
    description: '只在带这些标签的文档里回答（可选）。',
  },
  topK: {
    type: 'integer',
    description: `送入模型的参考片段数量，默认 12，最大 24。`,
    minimum: 1,
    maximum: 24,
  },
}

const ASK_DESCRIPTION = [
  '把问题交给知识库自己组织答案：先检索片段，再由一个模型综合这些片段给出带引用的成稿答案。',
  '仅在问题是宽泛的、需要跨多篇文档综合时使用——那类问题自己检索往往要来回好几轮。能用 ' + KB_SEARCH_TOOL_NAME + ' 找到确切依据的问题，一律优先用 ' + KB_SEARCH_TOOL_NAME + '：它更快，而且把证据留给你自己判断，而不是给你另一个模型的结论。',
  '返回内容包含：答案正文、引用的文档与片段、使用的模型。如果知识库没有登记 LLM 服务，本工具会说明不可用，此时改用 ' + KB_SEARCH_TOOL_NAME + ' 自行回答。',
].join('\n')

function renderAskAnswer(answer: AskAnswer): string {
  const parts = [answer.answer]
  if (answer.references.length) {
    const cited = answer.references.map(
      (ref, i) => `[${i + 1}] ${ref.docName}${ref.section ? ' · ' + ref.section : ''}${ref.page ? ' · p.' + ref.page : ''} · docId: ${ref.docId}`,
    )
    parts.push(`引用：\n${cited.join('\n')}`)
  }
  if (answer.model) parts.push(`回答模型：${answer.model}`)
  parts.push('_注意：这是另一个模型基于检索片段的结论。若要复核，请用 ' + KB_SEARCH_TOOL_NAME + ' 读回被引用的片段。_')
  return parts.join('\n\n')
}

// ---- assembly --------------------------------------------------------------

/**
 * Build every tool definition. Returned as plain objects so they can be
 * registered on any host whose registry accepts the same contract; each entry is
 * a separate effect, so unloading the plugin withdraws all of them.
 */
export function defineKbTools(deps: KbToolsDeps): ToolDefinitionLike[] {
  const tools: ToolDefinitionLike[] = []

  tools.push(
    defineTool({
      name: KB_LIST_TOOL_NAME,
      description: LIST_DESCRIPTION,
      parameters: LIST_PARAMETERS,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const record = argRecord(args)
        const nameLike = typeof record.nameLike === 'string' ? record.nameLike.trim().toLowerCase() : ''
        const tag = typeof record.tag === 'string' ? record.tag.trim().toLowerCase() : ''
        const limit = boundedIntArg(record, 'limit', 20, 100)
        if (!deps.listDocuments) {
          return `当前宿主没有提供文档列表，${KB_LIST_TOOL_NAME} 不可用。`
        }
        const rows = deps.listDocuments().filter((d) => {
          if (nameLike && !d.name.toLowerCase().includes(nameLike)) return false
          if (tag && !d.tags.includes(tag)) return false
          return true
        })
        return renderDocuments(rows.slice(0, limit), Boolean(nameLike || tag))
      },
    }),
  )

  tools.push(
    defineTool({
      name: KB_SEARCH_TOOL_NAME,
      description: SEARCH_DESCRIPTION,
      parameters: SEARCH_PARAMETERS,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      // Read-only over an in-memory index: safe to run alongside other tools.
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const record = argRecord(args)
        const query = String(record.query ?? '').trim()
        if (!query) {
          return `${KB_SEARCH_TOOL_NAME} 需要一个非空的 query 参数。`
        }
        if (exec?.signal?.aborted) {
          return '知识库检索已被取消。'
        }
        const { docs, chunks } = deps.stats()
        if (chunks === 0) {
          return '知识库中还没有已解析的文档。请提示用户在知识库面板中导入文档并等待解析完成。'
        }
        const topK = boundedIntArg(record, 'topK', DEFAULT_TOP_K, MAX_TOP_K)
        const docId = typeof record.docId === 'string' && record.docId.trim() ? record.docId.trim() : undefined
        // An unknown tag is a common failure: the model invents a plausible label
        // that no document carries. Say so instead of silently searching everything.
        const normalized = stringArrayArg(record, 'tags').map((t) => t.toLowerCase())
        const catalog = deps.tagCatalog()
        const known = new Set(catalog.map((c) => c.tag))
        const unknown = normalized.filter((t) => !known.has(t))
        if (unknown.length && normalized.length === unknown.length) {
          const available = catalog.length
            ? catalog.slice(0, 20).map((c) => `${c.tag}（${c.count} 篇）`).join('、')
            : '（当前知识库还没有任何标签）'
          return `知识库中没有标签为 ${unknown.map((t) => `「${t}」`).join('、')} 的文档。现有标签：${available}。可以改用这些标签，或不带 tags 参数检索整个知识库。`
        }
        const tags = normalized.filter((t) => known.has(t))
        const hits = await deps.search(query, { topK, docId, tags })
        // A query that reads like a document title may name a file whose body
        // never uses those words. The name match is an enrichment: losing it
        // must not cost the model its passages, so it is appended, never
        // substituted — and it is the *only* answer when the body has no match
        // at all, because "no passages" would send the model off looking for a
        // document that is right there.
        const named = documentsNamedBy(query, hits, deps.listDocuments?.() ?? [])
        if (!hits.length) {
          const scope = docId
            ? '该文档'
            : tags.length
              ? `带标签 ${tags.map((t) => `「${t}」`).join('、')} 的文档`
              : `共 ${docs} 个文档`
          const miss = `在${scope}中没有检索到与「${query}」相关的内容（知识库现有 ${chunks} 个片段）。可以换用文档中的术语再试一次。`
          if (!named.length) return miss
          return `${renderNamedDocuments(query, named)}\n\n${miss}`
        }
        const rendered = formatHits(query, hits)
        if (!named.length) return rendered
        return `${rendered}\n\n${renderNamedDocuments(query, named)}`
      },
    }),
  )

  tools.push(
    defineTool({
      name: KB_READ_TOOL_NAME,
      description: READ_DESCRIPTION,
      parameters: READ_PARAMETERS,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      isConcurrencySafe: () => true,
      async execute(args) {
        const record = argRecord(args)
        const docId = String(record.docId ?? '').trim()
        if (!docId) {
          return `${KB_READ_TOOL_NAME} 需要一个非空的 docId 参数，可用 ${KB_LIST_TOOL_NAME} 查到。`
        }
        const page = boundedIntArg(record, 'page', 1, 10_000)
        const pageSize = boundedIntArg(record, 'pageSize', 8, 40)
        if (!deps.readDocument) {
          return `当前宿主没有提供文档正文读取能力，${KB_READ_TOOL_NAME} 不可用。请只用 ${KB_SEARCH_TOOL_NAME} 返回的片段作答。`
        }
        const result = deps.readDocument(docId, page, pageSize)
        if (!result) {
          return `知识库中没有 id 为 ${docId} 的文档，可用 ${KB_LIST_TOOL_NAME} 查到正确的 id。`
        }
        return renderDocumentPage(result)
      },
    }),
  )

  tools.push(
    defineTool({
      name: KB_ASK_TOOL_NAME,
      description: ASK_DESCRIPTION,
      parameters: ASK_PARAMETERS,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      // An LLM call: never let two of these run against one corpus at once.
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        const record = argRecord(args)
        const query = String(record.query ?? '').trim()
        if (!query) {
          return `${KB_ASK_TOOL_NAME} 需要一个非空的 query 参数。`
        }
        if (exec?.signal?.aborted) return '知识库问答已被取消。'
        if (!deps.ask) {
          return `当前知识库没有登记 LLM 服务，无法用 ${KB_ASK_TOOL_NAME} 组织成稿答案。请改用 ${KB_SEARCH_TOOL_NAME} 检索片段后自行作答。`
        }
        const normalized = stringArrayArg(record, 'tags').map((t) => t.toLowerCase())
        const catalog = deps.tagCatalog()
        const known = new Set(catalog.map((c) => c.tag))
        const unknown = normalized.filter((t) => !known.has(t))
        if (unknown.length && normalized.length === unknown.length) {
          const available = catalog.length
            ? catalog.slice(0, 20).map((c) => `${c.tag}（${c.count} 篇）`).join('、')
            : '（当前知识库还没有任何标签）'
          return `知识库中没有标签为 ${unknown.map((t) => `「${t}」`).join('、')} 的文档。现有标签：${available}。`
        }
        const answer = await deps.ask(query, {
          docId: typeof record.docId === 'string' && record.docId.trim() ? record.docId.trim() : undefined,
          tags: normalized.filter((t) => known.has(t)),
          topK: boundedIntArg(record, 'topK', 12, 24),
          signal: exec?.signal,
        })
        if (!answer) {
          return `${KB_ASK_TOOL_NAME} 没有得到回答（可能 LLM 服务不可用或本次检索没有命中）。请改用 ${KB_SEARCH_TOOL_NAME} 自行作答。`
        }
        return renderAskAnswer(answer)
      },
    }),
  )

  return tools
}

/** Kept for callers that only want the search tool (the original single-tool API). */
export function defineKbSearchTool(deps: KbToolsDeps): ToolDefinitionLike {
  return defineKbTools(deps).find((t) => t.name === KB_SEARCH_TOOL_NAME)!
}
