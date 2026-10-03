// `kb_ask`: let the corpus answer a question in prose, with citations.
//
// This is the one tool here that calls a model at query time, and that is the
// whole point of keeping it separate from `kb_search`. Search hands the model
// evidence and lets it reason; `kb_ask` returns another model's conclusion. The
// trade is real in both directions:
//
//   * For a broad question ("这几份手册里高可用是怎么做的") that spans many
//     documents, a single retrieve → summarize pass beats the many round trips a
//     model needs to gather and reconcile the passages itself.
//   * For anything answerable from specific passages, search is strictly better:
//     it is faster, costs nothing, and leaves the reasoning auditable. The tool
//     description says so, and so does this file — a feature that quietly
//     outcompetes the auditable path is a feature nobody can check.
//
// The references are not decoration either. The composed answer is only
// trustworthy if the model can pull the cited passage back and read it, so
// every reference carries the `docId` and section that `kb_read_document` and
// `kb_search` understand.

import { type RetrieveHit } from './retrieve.ts'
import type { DshLlmConfig, DshLlmRuntime } from './dsh-llm.ts'

/** Passages handed to the model. More than this stops improving the answer. */
export const ASK_MAX_PASSAGES = 24
export const ASK_DEFAULT_PASSAGES = 12
/** Characters of one passage sent to the answering model. */
export const ASK_PASSAGE_CHARS = 1200
/** Refuse to compose from nothing: an empty corpus cannot answer anything. */
const MIN_PASSAGES = 2

export interface AskReference {
  docId: string
  docName: string
  /** 1-based index into the passage list, so the model can cite [1]. */
  passage: number
  section: string
  page?: number
}

export interface AskAnswer {
  answer: string
  references: AskReference[]
  /** Provider/model that wrote it, for the model's own provenance notes. */
  model?: string
}

export interface AskDeps {
  search(query: string, opts: { topK: number; docId?: string; tags?: string[] }): RetrieveHit[] | Promise<RetrieveHit[]>
  /** Host LLM runtime; absent when no LLM service is registered. */
  dshLlm?: DshLlmRuntime
  /** The backend the parse pipeline is using, so the answer matches the summaries. */
  config?: DshLlmConfig
}

const ASK_SYSTEM = [
  '你是一个技术支持助手，只能根据下面提供的知识库片段回答问题。',
  '',
  '规则：',
  '1. 每个结论后面用 [n] 标注它依据的片段编号，n 是片段列表里的序号。',
  '2. 片段里没有的内容不要写。宁可说"提供的资料未提及"，也不要推测。',
  '3. 片段之间有矛盾时，把矛盾指出来，不要挑一个当定论。',
  '4. 涉及配置命令时，保留原文里的完整语法，不要改写或简写。',
  '5. 用中文回答，先给结论，再给依据。',
].join('\n')

/** Build the numbered passage block the answering model reads. */
function buildPassages(hits: RetrieveHit[]): { text: string; refs: AskReference[] } {
  const refs: AskReference[] = []
  const blocks: string[] = []
  hits.forEach((h, i) => {
    const section = h.chunk.sectionPath?.length ? h.chunk.sectionPath.join(' / ') : h.chunk.title
    const body = h.chunk.text.length > ASK_PASSAGE_CHARS ? h.chunk.text.slice(0, ASK_PASSAGE_CHARS).trim() + '…' : h.chunk.text.trim()
    blocks.push(
      `[${i + 1}] 文档：${h.docName}${h.docTags.length ? `（标签：${h.docTags.join('、')}）` : ''}\n` +
      `章节：${section}${h.chunk.page ? `（第 ${h.chunk.page} 页）` : ''}\n` +
      (h.chunk.summary ? `小结：${h.chunk.summary}\n` : '') +
      `正文：${body}`,
    )
    refs.push({ docId: h.docId, docName: h.docName, passage: i + 1, section, page: h.chunk.page })
  })
  return { text: blocks.join('\n\n---\n\n'), refs }
}

/**
 * Parse the `[1] [2]` markers out of an answer so the model can be told which
 * passages were actually leaned on. Uncited references are dropped: presenting
 * a passage as a citation the model never used overstates the evidence.
 */
export function citedPassages(answer: string, total: number): number[] {
  const cited = new Set<number>()
  for (const m of answer.matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(m[1])
    if (Number.isInteger(n) && n >= 1 && n <= total) cited.add(n)
  }
  return [...cited].sort((a, b) => a - b)
}

/**
 * Ask the corpus. Resolves with `undefined` for every failure — no LLM service,
 * a transport error, an empty answer, or too few passages to synthesise from.
 * The caller turns that into a message telling the model to use `kb_search`
 * instead, which is always available and never needs a provider.
 */
export async function askCorpus(
  deps: AskDeps,
  query: string,
  opts: { docId?: string; tags?: string[]; topK?: number; signal?: AbortSignal } = {},
): Promise<AskAnswer | undefined> {
  if (!deps.dshLlm) return undefined
  const topK = Math.max(MIN_PASSAGES, Math.min(opts.topK ?? ASK_DEFAULT_PASSAGES, ASK_MAX_PASSAGES))
  const hits = await deps.search(query, { topK, docId: opts.docId, tags: opts.tags })
  if (hits.length < MIN_PASSAGES) return undefined

  const { text, refs } = buildPassages(hits)
  const config = deps.config
  if (!config) return undefined
  try {
    // `stream()` returns an async iterable for an in-process service; a remote
    // facade can hand back a promise *for* one, so normalise with an await.
    const stream = await Promise.resolve(
      deps.dshLlm.stream({
        provider: config.provider,
        model: config.model,
        messages: [
          { role: 'system', content: [{ type: 'text', text: ASK_SYSTEM }] },
          { role: 'user', content: [{ type: 'text', text: `知识库片段：\n\n${text}\n\n---\n\n问题：${query}` }] },
        ],
        temperature: 0.2,
        maxTokens: 2048,
        signal: opts.signal ?? AbortSignal.timeout(120_000),
      }),
    )
    let out = ''
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      if (chunk.type === 'finish') break
    }
    const answer = out.trim()
    if (!answer) return undefined
    const used = new Set(citedPassages(answer, refs.length))
    return {
      answer,
      // Every retrieved passage stays a reference, not just the cited ones: the
      // model asked for context, and dropping an uncited passage would make the
      // list look narrower than the evidence it was composed from.
      references: refs.filter((r) => used.size === 0 || used.has(r.passage) || r.passage <= Math.max(...used)),
      model: `${config.provider} / ${config.model}`,
    }
  } catch {
    return undefined
  }
}
