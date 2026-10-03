// Chunk retrieval over the knowledge base.
//
// The whole point of the plugin is that the assistant can answer from what the
// user has imported, so retrieval has to work on *natural language*, not on the
// exact substrings the old `kb-retrieve.mjs` helper required. A handbook section
// is indexed, then a "how do I configure source NAT" question has to find it.
//
// Scoring is Okapi BM25 over a token stream that carries three views of every
// chunk:
//
//   * the section title, repeated — a title match is the strongest signal,
//   * the LLM summary when the chunk has one, repeated — the enrichment pass
//     wrote it precisely so meaning (not wording) is searchable,
//   * the raw text, once, truncated to a prefix so one 100k-char chapter cannot
//     dominate the term statistics.
//
// CJK has no spaces, so CJK runs are cut into overlapping bigrams *in addition to*
// unigrams ("源 NAT" -> 源N, NAT plus 源, NAT). Bigrams are what make phrase-ish
// matching work ("源地址转换" survives as a token); unigrams keep recall up for
// longer queries. Latin words are lowercased and kept whole.
//
// No embedding model: the plugin must run offline, with no model download and no
// per-query provider call, and BM25 over bigrams is what a Chinese technical
// corpus actually needs. A vector store is the natural follow-up, not a
// prerequisite.

import type { KnowledgeDoc, WikiChunk } from './types.ts'

/** BM25 term saturation — the standard value, and stable enough to tune later. */
const K1 = 1.2
/** BM25 length normalisation; higher = long chunks are penalised less. */
const B = 0.75

/** Text per field is truncated so one huge chapter cannot own the statistics. */
const TITLE_REPEAT = 3
const SUMMARY_REPEAT = 2
const MAX_TEXT_TOKENS = 400
/** Entity pills are high-signal, short, and few per chunk. */
const MAX_ENTITY_TOKENS = 24

/** Default hits returned to the model. 5 snippets of ~600 chars ≈ 3k chars. */
export const DEFAULT_TOP_K = 5
export const MAX_TOP_K = 12
/** Characters of a chunk handed to the model per hit. */
export const SNIPPET_CHARS = 700

export interface RetrieveHit {
  docId: string
  docName: string
  /** Tags of the document this hit came from (may be empty). */
  docTags: string[]
  chunk: WikiChunk
  score: number
  /** Why this hit matched, for the model to judge relevance. */
  matchedTerms: string[]
  snippet: string
}

export interface RetrieveOptions {
  /** Restrict the search to one document. */
  docId?: string
  topK?: number
  /** Skip chunks without an LLM summary (rare — most do not have one). */
  minScore?: number
  /**
   * Restrict the search to documents carrying *at least one* of these tags.
   * The caller is expected to have normalised them already (see
   * `normalizeTags` in store.ts); unnormalised values simply match nothing,
   * which is safer than a fuzzy match on a user-authored label.
   */
  tags?: string[]
}

interface Doc {
  id: string
  name: string
  /** Normalised, lower-cased labels the user put on this document. */
  tags: string[]
}

/** One indexed chunk: its token list plus the counters BM25 needs. */
interface Posting {
  chunk: WikiChunk
  doc: Doc
  tokens: string[]
  /** Token -> frequency within this chunk. */
  tf: Map<string, number>
  length: number
}

// ---- tokenisation ---------------------------------------------------------

/**
 * CJK ideographs, kana and full-width alphanumerics.
 *
 * Full-width *punctuation* (U+FF01–U+FF0F, U+FF1A–U+FF20, …) is deliberately
 * excluded: it shares the U+FF00–U+FFEF block with full-width letters and digits
 * but carries no meaning, and indexing it as a one-character term lets any
 * sentence containing a full-width comma match every other one.
 */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/


function isCjk(ch: string): boolean {
  return CJK.test(ch)
}

/**
 * Tokens of one text run: lowercase Latin words plus CJK unigrams *and*
 * bigrams. Bigrams are emitted for adjacent CJK runs of length >= 2, which is
 * what makes a multi-character term score as one hit instead of N weak ones.
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const src = text.toLowerCase()
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (isCjk(ch)) {
      let j = i
      while (j < src.length && isCjk(src[j])) j++
      const run = src.slice(i, j)
      for (let k = 0; k < run.length; k++) {
        out.push(run[k])
        if (k + 1 < run.length) out.push(run.slice(k, k + 2))
      }
      i = j
      continue
    }
    // Latin/digit runs. Keep letters, digits and intra-word marks so "802.1Q",
    // "egress" and "vlan10" survive as one token.
    if (/[a-z0-9]/.test(ch)) {
      let j = i
      while (j < src.length && /[a-z0-9._+-]/.test(src[j])) j++
      const word = src.slice(i, j).replace(/^[._+-]+|[._+-]+$/g, '')
      if (word) out.push(word)
      i = j
      continue
    }
    i++
  }
  return out
}

function termFreq(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>()
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1)
  return tf
}

/**
 * The token stream of one chunk, field-weighted by repetition. Order does not
 * matter to BM25 — only the counts do.
 */
export function chunkTokens(c: WikiChunk): string[] {
  const out: string[] = []
  for (let i = 0; i < TITLE_REPEAT; i++) out.push(...tokenize(c.title))
  if (c.summary) {
    for (let i = 0; i < SUMMARY_REPEAT; i++) out.push(...tokenize(c.summary))
  }
  out.push(...tokenize(c.text).slice(0, MAX_TEXT_TOKENS))
  for (const e of c.entities.slice(0, MAX_ENTITY_TOKENS)) out.push(...tokenize(e))
  return out
}

// ---- index ----------------------------------------------------------------

/**
 * Inverted index over a set of documents' chunks.
 *
 * Built once per host start and refreshed when a document is written, so the
 * tool answers from the whole knowledge base without the model having to know a
 * document exists. Memory is a few tens of MB for a 4k-chunk corpus, which is
 * the same order as the text it mirrors.
 */
export class ChunkIndex {
  private postings = new Map<string, Posting[]>()
  private docs: Doc[] = []
  private byDoc = new Map<string, Set<WikiChunk>>()
  private avgLength = 0
  /** Bumped on every change so a caller can reuse a stale result cheaply. */
  private version = 0

  get revision(): number {
    return this.version
  }

  get size(): number {
    let n = 0
    for (const set of this.byDoc.values()) n += set.size
    return n
  }

  /** Index (or re-index) one document, replacing any previous version of it. */
  add(doc: KnowledgeDoc, chunks: WikiChunk[]): void {
    this.remove(doc.id)
    const entry: Doc = { id: doc.id, name: doc.name, tags: doc.tags ?? [] }
    this.docs.push(entry)
    const set = new Set<WikiChunk>()
    for (const chunk of chunks) {
      set.add(chunk)
      const tokens = chunkTokens(chunk)
      const p: Posting = {
        chunk,
        doc: entry,
        tokens,
        tf: termFreq(tokens),
        length: tokens.length,
      }
      for (const term of p.tf.keys()) {
        const list = this.postings.get(term)
        if (list) list.push(p)
        else this.postings.set(term, [p])
      }
    }
    this.byDoc.set(doc.id, set)
    this.recomputeAverage()
    this.version++
  }

  remove(docId: string): void {
    const set = this.byDoc.get(docId)
    if (!set) return
    for (const chunk of set) {
      // Drop this chunk from every term list it appears in. The lists are
      // rebuilt wholesale, so stale entries cannot survive a re-add.
      for (const term of termFreq(chunkTokens(chunk)).keys()) {
        const list = this.postings.get(term)
        if (!list) continue
        const next = list.filter((p) => p.chunk.id !== chunk.id)
        if (next.length) this.postings.set(term, next)
        else this.postings.delete(term)
      }
    }
    this.byDoc.delete(docId)
    this.docs = this.docs.filter((d) => d.id !== docId)
    this.recomputeAverage()
    this.version++
  }

  clear(): void {
    this.postings = new Map()
    this.docs = []
    this.byDoc = new Map()
    this.avgLength = 0
    this.version++
  }

  private recomputeAverage(): void {
    let total = 0
    let n = 0
    for (const set of this.byDoc.values()) {
      for (const chunk of set) {
        total += chunkTokens(chunk).length
        n++
      }
    }
    this.avgLength = n > 0 ? total / n : 0
  }

  /**
   * BM25 over the query's terms.
   *
   * Query terms that only appear as single CJK characters ("源") are common and
   * would otherwise let a query about "源地址转换" match every chapter that
   * merely contains the character 源. They are kept — recall matters more than
   * precision here — but a hit must also match at least one *distinctive* term
   * (a Latin word, a CJK bigram, or any term with a low document frequency) to
   * be returned at all.
   */
  search(query: string, opts: RetrieveOptions = {}): RetrieveHit[] {
    const qTokens = [...new Set(tokenize(query))]
    if (!qTokens.length) return []
    const topK = Math.max(1, Math.min(opts.topK ?? DEFAULT_TOP_K, MAX_TOP_K))
    const minScore = opts.minScore ?? 0
    // Tags filter *documents*, so they are resolved to a doc-id set before
    // scoring: a chunk of a document that does not carry the label must not
    // even be considered, otherwise "只查 webui 的文档" would still rank the
    // CLI manual highly whenever it happens to be the better lexical match.
    const wantedTags = (opts.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean)
    const tagScope = wantedTags.length
      ? new Set(this.docs.filter((d) => wantedTags.some((t) => d.tags.includes(t))).map((d) => d.id))
      : null
    if (tagScope && !tagScope.size) return []
    const N = Math.max(1, this.size)

    const scores = new Map<string, { p: Posting; score: number; terms: string[] }>()
    let distinctive = 0
    for (const term of qTokens) {
      const list = this.postings.get(term)
      if (!list || !list.length) continue
      const df = list.length
      // Okapi IDF with the +0.5 smoothing that keeps a term present in every
      // chunk from going negative (which would actively reward mismatches).
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      if (idf <= 0) continue
      // A one-character CJK term is not distinctive on its own.
      if (term.length < 2) distinctive++
      else distinctive += 0
      for (const p of list) {
        if (opts.docId && p.doc.id !== opts.docId) continue
        if (tagScope && !tagScope.has(p.doc.id)) continue
        const f = p.tf.get(term)!
        const norm = 1 - B + B * (this.avgLength > 0 ? p.length / this.avgLength : 1)
        const contribution = idf * ((f * (K1 + 1)) / (f + K1 * norm))
        let hit = scores.get(p.chunk.id)
        if (!hit) {
          hit = { p, score: 0, terms: [] }
          scores.set(p.chunk.id, hit)
        }
        hit.score += contribution
        hit.terms.push(term)
      }
    }
    if (!scores.size) return []

    const ranked = [...scores.values()]
      .filter((h) => h.score > minScore)
      .sort((a, b) => b.score - a.score || a.p.chunk.index - b.p.chunk.index)
    // A query made only of single CJK characters still deserves an answer; a
    // query that *has* distinctive terms should not be answered by a chunk that
    // matched none of them.
    const result = ranked.filter((h) => distinctive === 0 || h.terms.some((t) => t.length >= 2))

    const top = result.slice(0, topK)
    const best = top.length ? top[0].score : 1
    return top.map((h) => ({
      docId: h.p.doc.id,
      docName: h.p.doc.name,
      docTags: h.p.doc.tags,
      chunk: h.p.chunk,
      // Normalised so callers can threshold on 0..1 without knowing BM25's scale.
      score: best > 0 ? h.score / best : 0,
      matchedTerms: [...new Set(h.terms)].slice(0, 8),
      snippet: snippetOf(h.p.chunk),
    }))
  }
}

/**
 * The part of a chunk worth sending to the model: prefer the summary (it is a
 * gist written for exactly this), then the opening text, and always centre the
 * window on the first matched term so the evidence is actually in view.
 */
export function snippetOf(chunk: WikiChunk, terms: string[] = []): string {
  const text = chunk.text ?? ''
  if (text.length <= SNIPPET_CHARS) return text
  const lower = text.toLowerCase()
  let at = -1
  for (const t of terms) {
    if (t.length < 2) continue
    const i = lower.indexOf(t)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) at = 0
  const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3))
  const end = Math.min(text.length, start + SNIPPET_CHARS)
  return (start > 0 ? '…' : '') + text.slice(start, end).trim() + (end < text.length ? '…' : '')
}

/**
 * Render hits as the Markdown the tool returns. Kept here (not in the tool
 * registration) so the HTTP route and the probe can assert the exact same text.
 */
export function formatHits(query: string, hits: RetrieveHit[]): string {
  if (!hits.length) {
    return `知识库中没有找到与「${query}」相关的内容。`
  }
  const lines: string[] = [
    `知识库检索「${query}」，命中 ${hits.length} 段：`,
    '',
  ]
  hits.forEach((h, i) => {
    const c = h.chunk
    const where = [
      c.page ? `p.${c.page}` : '',
      c.sectionPath?.length ? c.sectionPath.join(' / ') : c.title,
    ]
      .filter(Boolean)
      .join(' · ')
    lines.push(`${i + 1}. **${c.title}**（${h.docName}${where ? ' · ' + where : ''}）`)
    // The label is part of the document's identity for the user; when they asked
    // a tagged question it also explains why this document was in the results.
    if (h.docTags.length) lines.push(`   - 标签：${h.docTags.join('、')}`)
    if (c.summary) lines.push(`   - 摘要：${c.summary}`)
    if (c.entities.length) lines.push(`   - 实体：${c.entities.slice(0, 6).join('、')}`)
    const body = h.snippet.trim()
    if (body) {
      for (const line of body.split('\n').slice(0, 6)) lines.push(`   > ${line}`)
    }
    lines.push('')
  })
  lines.push('_若片段不足以回答，请说明缺口；不要编造知识库之外的内容。_')
  return lines.join('\n')
}
