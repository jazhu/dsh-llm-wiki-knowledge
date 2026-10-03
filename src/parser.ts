// Local-first document parsing for the LLM-WIKI knowledge base.
//
// Pipeline (always runs, zero external deps):
//   1. extractText  — pull readable text out of the uploaded bytes by mime type
//   2. chunkText    — split into wiki sections with headings
//   3. extractEntities — light NLP: capitalized terms, noun phrases, key phrases
//   4. linkChunks  — connect chunks to shared entities (wiki cross-links)
//
// When a DeepSeek API key is configured, `enrichChunk` is offered as an
// optional pass that asks the model for a one-line summary + key entities +
// related concepts, upgrading the local output. Local results are always valid
// on their own.

import type { OutlineEntry, OutlineSource, WikiChunk } from './types.ts'
import { extractPdfText } from './pdf-extract.ts'
import { cleanHeadingTitle, detectTextOutline, looksLikeHeading, normalizeOutline } from './outline.ts'

// ---- 1. text extraction ---------------------------------------------------

export interface ExtractResult {
  text: string
  warning?: string
  /** Per-page line-separated text (PDF only) — drives page-aware chunking. */
  pages?: string[]
  /** The document's real table of contents, when one could be recovered. */
  outline?: OutlineEntry[]
  outlineSource?: OutlineSource
}

/**
 * Async entry point. Everything except PDF runs through the synchronous
 * `extractText` below; PDF is routed to the real pdf.js parser (with a
 * graceful fallback to the old regex salvage if pdf.js cannot read it).
 */
export async function extractTextAsync(
  name: string,
  mime: string,
  data: Buffer,
): Promise<ExtractResult> {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'pdf' || (mime || '').toLowerCase() === 'application/pdf') {
    // Content sniffing: the declared mime/extension can lie (e.g. an HTML
    // file uploaded with a .pdf name, or a truncated download). Route by
    // what the bytes actually are instead of what they claim to be.
    if (looksLikePdf(data)) {
      try {
        const res = await extractPdfText(data)
        // Bookmark tree first; if the PDF carries none, fall back to heading
        // lines in the extracted text (still far better than nothing).
        if (res.outline?.length) {
          return {
            text: res.text,
            pages: res.pages,
            outline: res.outline,
            outlineSource: 'pdf-bookmarks',
            warning: res.warning,
          }
        }
        const detected = detectTextOutline(res.text)
        const out: ExtractResult = { text: res.text, pages: res.pages, warning: res.warning }
        if (detected.length) {
          out.outline = detected
          out.outlineSource = 'text-headings'
        }
        return out
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Fall back to the best-effort regex salvage so the document still
        // produces *something* rather than failing outright.
        return {
          text: salvagePdfText(data),
          warning: `PDF 解析失败（${message}）；已回退到二进制原文提取，内容可能不完整`,
        }
      }
    }
    if (looksLikeHtml(data)) {
      return {
        text: stripHtml(decodeSafe(data)),
        warning: '声明为 PDF 但内容实为 HTML，已按 HTML 解析',
      }
    }
    return {
      text: decodeSafe(data).replace(/[^\x20-\x7E\u4E00-\u9FFF\s]/g, ' '),
      warning: '声明为 PDF 但缺少 %PDF- 文件头，不是有效的 PDF 文件，已按纯文本尽力解析',
    }
  }

  const res = extractText(name, mime, data)
  // Markdown / text / stripped HTML: recover headings so these formats get the
  // same structure-driven mind map the bookmarked PDFs get.
  const outline = detectTextOutline(res.text)
  const markdown = ext === 'md' || ext === 'markdown'
  if (!outline.length) return res
  return {
    ...res,
    outline,
    outlineSource: markdown ? 'markdown-headings' : 'text-headings',
  }
}

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1')

/** Real PDFs carry a `%PDF-` header (spec allows a little leading junk). */
function looksLikePdf(data: Buffer): boolean {
  return data.subarray(0, 1024).includes(PDF_MAGIC)
}

/** HTML detection on the first 4KB, tolerant of BOM/whitespace before the tag. */
function looksLikeHtml(data: Buffer): boolean {
  const head = data.subarray(0, 4096).toString('utf-8').replace(/^\uFEFF/, '').toLowerCase()
  return /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<title[\s>]/.test(head)
}

export function extractText(name: string, mime: string, data: Buffer): ExtractResult {
  const lower = (mime || '').toLowerCase()
  const ext = name.toLowerCase().split('.').pop() ?? ''

  if (lower === 'text/plain' || ext === 'txt' || ext === 'md' || ext === 'markdown') {
    return { text: decodeSafe(data) }
  }
  if (lower === 'application/json' || ext === 'json') {
    try {
      const obj = JSON.parse(data.toString('utf-8'))
      return { text: jsonToText(obj) }
    } catch {
      return { text: decodeSafe(data) }
    }
  }
  if (lower.includes('html') || ext === 'html' || ext === 'htm') {
    return { text: stripHtml(decodeSafe(data)) }
  }
  if (lower === 'text/csv' || ext === 'csv') {
    return { text: decodeSafe(data) }
  }
  if (ext === 'pdf') {
    if (looksLikePdf(data)) return { text: salvagePdfText(data), warning: 'PDF 二进制内容，已尝试提取可见文本（可能不完整）' }
    if (looksLikeHtml(data)) return { text: stripHtml(decodeSafe(data)), warning: '声明为 PDF 但内容实为 HTML，已按 HTML 解析' }
    return { text: decodeSafe(data).replace(/[^\x20-\x7E\u4E00-\u9FFF\s]/g, ' '), warning: '声明为 PDF 但缺少 %PDF- 文件头，不是有效的 PDF 文件，已按纯文本尽力解析' }
  }
  if (ext === 'docx' || lower.includes('officedocument.wordprocessingml')) {
    return { text: salvageOoxml(data), warning: 'DOCX 二进制内容，已尝试提取文档文本' }
  }
  // Fallback: try UTF-8, keep printable-ish ranges.
  return { text: decodeSafe(data), warning: '未知格式，已按纯文本尽力解析' }
}

function decodeSafe(data: Buffer): string {
  try {
    return data.toString('utf-8')
  } catch {
    return data.toString('latin1')
  }
}

function jsonToText(obj: unknown, depth = 0): string {
  const indent = '  '.repeat(depth)
  if (obj === null) return 'null'
  if (typeof obj === 'string') return obj
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj)
  if (Array.isArray(obj)) {
    return obj.map((v) => jsonToText(v, depth + 1)).join('\n')
  }
  if (typeof obj === 'object') {
    return Object.entries(obj)
      .map(([k, v]) => `${indent}${k}: ${jsonToText(v, depth + 1)}`)
      .join('\n')
  }
  return String(obj)
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

// Very small PDF text salvage: pull streams of printable text between BT/ET
// and any parenthesised string literals in content streams. Good enough for a
// preview; not a real PDF parser.
function salvagePdfText(data: Buffer): string {
  const raw = data.toString('latin1')
  const out: string[] = []
  const re = /\((?:[^()\\]|\\.)*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const s = m[0].slice(1, -1).replace(/\\(.)/g, '$1')
    if (s.trim().length > 1) out.push(s)
  }
  const joined = out.join(' ').replace(/\s+/g, ' ').trim()
  return joined || decodeSafe(data).replace(/[^\x20-\x7E\u4E00-\u9FFF\s]/g, ' ')
}

// Minimal DOCX/OOXML text salvage: the document text sits in <w:t> runs inside
// word/document.xml, which is stored (optionally zlib-compressed) in the zip.
function salvageOoxml(data: Buffer): string {
  try {
    // Look for the uncompressed XML marker first (some writers store it raw).
    const raw = data.toString('latin1')
    const idx = raw.indexOf('<w:t')
    if (idx >= 0) {
      return extractWtRuns(raw)
    }
    // Try to find a deflate stream after the local-file header for
    // word/document.xml. This is best-effort.
    const marker = 'word/document.xml'
    const mi = raw.indexOf(marker)
    if (mi >= 0) {
      // search forward for a zlib header (0x78 0x9c / 0x78 0x01 / 0x78 0xda)
      for (let i = mi; i < raw.length - 2; i++) {
        if (raw.charCodeAt(i) === 0x78 && (raw.charCodeAt(i + 1) === 0x9c || raw.charCodeAt(i + 1) === 0x01 || raw.charCodeAt(i + 1) === 0xda)) {
          const deflated = data.subarray(i)
          const inflated = inflateRaw(deflated)
          if (inflated) return extractWtRuns(inflated.toString('latin1'))
        }
      }
    }
  } catch {
    /* ignore */
  }
  return decodeSafe(data).replace(/[^\x20-\x7E\u4E00-\u9FFF\s]/g, ' ')
}

function extractWtRuns(xml: string): string {
  const out: string[] = []
  const re = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1].replace(/<[^>]+>/g, ''))
  }
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

// Lightweight inflate for raw deflate (no zlib header). We only attempt the
// common case; if it fails we fall back to raw text.
function inflateRaw(buf: Buffer): Buffer | undefined {
  try {
    // Node exposes zlib; use the synchronous inflate with raw strategy.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const zlib = (globalThis as any).require?.('zlib')
    if (!zlib) return undefined
    return zlib.inflateRawSync(buf)
  } catch {
    return undefined
  }
}

// ---- 2. chunking into wiki sections --------------------------------------

const CHUNK_TARGET = 900 // characters per chunk (soft)
const CHUNK_HARD = 1200 // never emit a block larger than this

/**
 * Break one (possibly enormous, separator-less) block into <=CHUNK_TARGET
 * pieces. Used for binary salvage output (PDF/DOCX) that arrives as one giant
 * run with no blank lines — without this the whole file becomes a single
 * multi-megabyte chunk, which later blows up the renderer when displayed.
 */
function forceSplit(block: string): string[] {
  const out: string[] = []
  const step = CHUNK_TARGET
  for (let i = 0; i < block.length; i += step) {
    const piece = block.slice(i, i + step).trim()
    if (piece) out.push(piece)
  }
  return out
}

export function chunkText(text: string): string[] {
  const clean = (text || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim()
  if (clean === '') return []

  // Split on headings (# or lines that look like titles) and blank lines.
  const blocks = clean.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean)
  const chunks: string[] = []
  let cur = ''
  for (const block of blocks) {
    // A single block bigger than the hard cap can never be tamed by
    // accumulation, so split it immediately (covers PDF/DOCX salvage output).
    if (block.length > CHUNK_HARD) {
      if (cur.trim()) {
        chunks.push(cur.trim())
        cur = ''
      }
      chunks.push(...forceSplit(block))
      continue
    }
    if (cur.length + block.length > CHUNK_TARGET && cur.length > 0) {
      chunks.push(cur.trim())
      cur = ''
    }
    cur += (cur ? '\n\n' : '') + block
    if (cur.length >= CHUNK_TARGET) {
      chunks.push(cur.trim())
      cur = ''
    }
  }
  if (cur.trim()) chunks.push(cur.trim())
  // If we got nothing (single huge block without separators), force-split.
  if (chunks.length === 0 && clean.length > 0) {
    chunks.push(...forceSplit(clean))
  }
  return chunks
}

// ---- 3. entity extraction ------------------------------------------------

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'this', 'that', 'these',
  'those', 'it', 'its', 'as', 'at', 'by', 'from', 'we', 'you', 'they', 'he',
  'she', 'his', 'her', 'their', 'our', 'your', 'i', 'not', 'no', 'yes', 'if',
  'then', 'than', 'so', 'can', 'will', 'would', 'should', 'may', 'might',
  '的', '了', '和', '与', '及', '或', '是', '在', '我们', '他们', '它们', '这个', '那个',
  '一种', '可以', '通过', '使用', '对于', '以及', '由于', '因此', '一个', '没有', '这样',
])

export function extractEntities(text: string, max = 12): string[] {
  const scores = new Map<string, number>()
  const candidate = (term: string) => {
    const t = term.trim()
    if (t.length < 2) return
    if (STOPWORDS.has(t.toLowerCase())) return
    if (/^\d+$/.test(t)) return
    scores.set(t, (scores.get(t) ?? 0) + 1)
  }

  // Latin: Title Case / ALLCAPS phrases.
  const latin = text.match(/[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*/g) ?? []
  for (const p of latin) {
    if (p.split(' ').length <= 3) candidate(p)
  }
  // Latin: quoted / hyphenated technical terms.
  const quoted = text.match(/["“”][^"“”]{2,40}["“”]/g) ?? []
  for (const q of quoted) candidate(q.replace(/["“”]/g, ''))

  // CJK: sliding window of 2-4 chars, score by frequency; keep distinctive.
  const cjk = text.match(/[一-鿿]{2,6}/g) ?? []
  const cjkFreq = new Map<string, number>()
  for (const w of cjk) {
    for (let len = 2; len <= Math.min(4, w.length); len++) {
      for (let i = 0; i + len <= w.length; i++) {
        const sub = w.slice(i, i + len)
        cjkFreq.set(sub, (cjkFreq.get(sub) ?? 0) + 1)
      }
    }
  }
  // Keep CJK terms that appear 2+ times (likely real concepts, not noise).
  for (const [term, freq] of cjkFreq) {
    if (freq >= 2) scores.set(term, (scores.get(term) ?? 0) + freq)
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([t]) => t)
}

// ---- 4. build wiki chunks (local) ----------------------------------------

/** One chunk before entities/links are attached. */
interface ChunkSeed {
  text: string
  /** Real section title (outline) or heading line when known. */
  title?: string
  page?: number
  sectionPath?: string[]
  heading?: boolean
}

/**
 * Shared tail of every chunk builder: entity extraction, storage cap, tokens
 * and wiki cross-links. Keeping this in one place means an outline-backed
 * document and a salvaged one produce structurally identical chunks.
 */
function materializeChunks(docId: string, seeds: ChunkSeed[]): WikiChunk[] {
  const allEntities = new Set<string>()
  const local = seeds.map((seed, index) => {
    const ents = extractEntities(seed.text)
    ents.forEach((e) => allEntities.add(e))
    // Hard cap on stored/returned text. Entities are still extracted from the
    // full piece above; this only bounds how much we persist and ship to the
    // client, which otherwise can crash the renderer on a multi-MB chunk.
    const capped = seed.text.length > CHUNK_HARD ? seed.text.slice(0, CHUNK_HARD) + '…' : seed.text
    const title = seed.title ?? titleFrom(seed.text)
    const chunk: WikiChunk = {
      id: `${docId}#${index}`,
      index,
      title,
      text: capped,
      tokens: Math.ceil(seed.text.length / 4),
      entities: ents,
      links: [],
    }
    if (seed.heading ?? (seed.title ? true : looksLikeHeading(seed.text.split('\n')[0]))) {
      chunk.heading = true
    }
    if (seed.page) chunk.page = seed.page
    if (seed.sectionPath?.length) chunk.sectionPath = [...seed.sectionPath]
    return chunk
  })
  // Cross-link: any chunk whose text references an entity defined elsewhere.
  const entityList = [...allEntities]
  for (const chunk of local) {
    const lower = chunk.text.toLowerCase()
    const links = entityList.filter(
      (e) => e !== chunk.title && lower.includes(e.toLowerCase()) && !chunk.entities.includes(e),
    )
    chunk.links = links.slice(0, 8)
  }
  return local
}

export function buildLocalChunks(docId: string, text: string): WikiChunk[] {
  const pieces = chunkText(text)
  return materializeChunks(
    docId,
    pieces.map((piece) => ({
      text: piece,
      title: looksLikeHeading(piece.split('\n')[0]) ? titleFrom(piece) : undefined,
    })),
  )
}

// Section-aligned chunking for page-aware documents (PDF). A chunk must never
// straddle a section boundary, so the resulting `title` is a real chapter /
// section name instead of whatever text sat at a 900-character offset.

/** Titles come from outline levels 1..3; deeper entries only influence breaks. */
const TITLE_MAX_LEVEL = 3
/** Don't start a new chunk for a section that would be shorter than this. */
const SECTION_MIN_CHARS = 320

/**
 * Split a document into chunks using its real outline and page mapping.
 *
 * `pages[i]` is the line-separated text of page i+1. While walking the pages we
 * track the deepest outline entry that has already started; a page whose
 * heading belongs to a different section flushes the current chunk (as long as
 * it has accumulated enough text), and the hard cap flushes unconditionally.
 */
export function buildChunksFromPages(
  docId: string,
  pages: readonly string[],
  outline: readonly OutlineEntry[] | undefined,
): WikiChunk[] {
  const entries = normalizeOutline(outline)
  const seeds: ChunkSeed[] = []
  let cur: string[] = []
  let curLen = 0
  let curTitle: string | undefined
  let curPath: string[] | undefined
  let curPage = 0
  let curHeading = false

  const flush = (): void => {
    if (!cur.length) return
    const body = cur.join('\n').trim()
    cur = []
    curLen = 0
    if (!body) return
    // A single line longer than the hard cap (e.g. a page whose text items
    // carry no EOL markers) still has to be broken up.
    const pieces = body.length > CHUNK_HARD ? forceSplit(body) : [body]
    for (const text of pieces) {
      seeds.push({
        text,
        title: curTitle,
        page: curPage,
        sectionPath: curPath,
        heading: curHeading,
      })
    }
    curTitle = undefined
    curPath = undefined
    curHeading = false
  }

  // Outline entries in page order; `cursor` only moves forward.
  const byPage = entries.filter((e) => e.page > 0)
  let cursor = -1
  let sectionTitle: string | undefined
  let sectionPath: string[] | undefined
  /** No chunk has been emitted yet for the current section. */
  let sectionFresh = false
  const titleForPage = (page: number): { title?: string; path?: string[] } => {
    while (cursor + 1 < byPage.length && byPage[cursor + 1].page <= page) {
      cursor++
      const entry = byPage[cursor]
      if (entry.level <= TITLE_MAX_LEVEL) {
        sectionTitle = entry.title
        sectionPath = entry.path?.length ? [...entry.path, entry.title] : [entry.title]
        sectionFresh = true
      }
    }
    return { title: sectionTitle, path: sectionPath }
  }

  for (let i = 0; i < pages.length; i++) {
    const page = i + 1
    const lines = (pages[i] ?? '').split('\n').filter((l) => l.trim())
    if (!lines.length) continue
    const before = sectionTitle
    const next = titleForPage(page)
    // A section boundary starts a new chunk — but only once the previous one
    // holds enough text, otherwise short sections would produce stubs.
    if (next.title !== before && cur.length && curLen >= SECTION_MIN_CHARS) flush()
    for (const line of lines) {
      const cost = line.length + 1
      if (cur.length && curLen + cost > CHUNK_HARD) flush()
      if (!cur.length) {
        // Capture the metadata once, when the chunk starts: a chunk that
        // swallowed two short sections stays attributed to the first one.
        curPage = page
        curTitle = next.title
        curPath = next.path
        curHeading = sectionFresh && Boolean(next.title) ? true : looksLikeHeading(line)
        sectionFresh = false
      }
      cur.push(line)
      curLen += cost
    }
  }
  flush()
  return materializeChunks(docId, seeds)
}

/**
 * Pick the chunk builder for an extraction result: page-aware documents get
 * section-aligned chunks, everything else uses the text heuristics.
 */
export function buildChunks(docId: string, extract: ExtractResult): WikiChunk[] {
  if (extract.pages?.length) return buildChunksFromPages(docId, extract.pages, extract.outline)
  return buildLocalChunks(docId, extract.text)
}

function titleFrom(piece: string): string {
  const firstLine = cleanHeadingTitle(piece.split('\n')[0] ?? '')
  if (firstLine.length <= 60) return firstLine || '片段'
  return firstLine.slice(0, 57) + '…'
}
