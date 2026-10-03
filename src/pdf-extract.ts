// Real PDF text extraction using Mozilla's pdf.js (pdfjs-dist).
//
// Why a dedicated module instead of the old regex "salvage":
//   Modern PDF content streams are almost always FlateDecode-compressed, and
//   text is encoded with embedded fonts + ToUnicode maps. A regex that scrapes
//   parenthesised literals out of the raw bytes only ever sees the compressed
//   stream (or worse, decodes the compressed bytes as Latin-1), which is why
//   Chinese uploads came back as garbage. pdf.js decompresses the streams,
//   applies the font/ToUnicode tables, and returns the real glyphs.
//
// Besides the text this module now also returns *structure*:
//   * `pages`   — per-page, line-separated text (pdf.js reports line ends via
//                 `item.hasEOL`; the old code dropped them, so a whole page
//                 collapsed into one 1.3k-character "paragraph" and nothing
//                 downstream could tell a heading from a footnote);
//   * `outline` — the document's embedded bookmark tree with resolved page
//                 numbers, i.e. the real table of contents. This is what the
//                 mind map and the Markdown export are built from.
//
// Portability: pdf.js needs three sibling assets at runtime — its worker
// (pdf.worker.mjs), the CMap tables (cmaps/) for CJK/non-Latin encoding, and
// the standard-14 font data (standard_fonts/). These are copied next to the
// bundled entry by build.mjs, and located here via import.meta.url so the
// plugin is fully self-contained and does not depend on the host's module
// resolution. They are referenced with file:// URLs because pdf.js only
// accepts file/data/node scheme URLs for the worker on Windows.

import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import type { OutlineEntry } from './types.ts'
import { cleanHeadingTitle } from './outline.ts'

const RESOURCE_DIR = dirname(fileURLToPath(import.meta.url))
const resourceUrl = (rel: string): string => pathToFileURL(join(RESOURCE_DIR, rel)).href

// Point pdf.js at the bundled worker. Must be set before any getDocument call.
GlobalWorkerOptions.workerSrc = resourceUrl('pdf.worker.mjs')

// Bound pathological documents: a single multi-thousand-page PDF should not
// hang the background parse queue forever. 3000 covers the largest real manual
// we have seen (2668 pages) while still capping absurd inputs.
const MAX_PDF_PAGES = 3000

/** Outline entries are only useful as structure; keep the tree bounded. */
const MAX_OUTLINE_ENTRIES = 6000
const MAX_OUTLINE_LEVEL = 9

export interface PdfExtractResult {
  text: string
  /** Per-page line-separated text, index 0 = page 1 (only pages actually read). */
  pages?: string[]
  /** Document bookmark tree (flattened, document order) with page numbers. */
  outline?: OutlineEntry[]
  /** How many repeated header/footer lines were dropped as page furniture. */
  furniture?: number
  warning?: string
}

/** The subset of the pdf.js proxy API this module relies on. */
interface PdfOutlineNode {
  title?: unknown
  dest?: unknown
  items?: unknown
}
interface PdfDocLike {
  getOutline(): Promise<unknown>
  getDestination(id: string): Promise<unknown>
  getPageIndex(ref: unknown): Promise<number>
}

/**
 * Resolve one bookmark destination to a 1-based page number. Destinations are
 * either a named string (needs `getDestination`) or an explicit array whose
 * first element is a page reference or a raw page index.
 */
async function resolveDestinationPage(doc: PdfDocLike, dest: unknown): Promise<number> {
  try {
    let explicit = dest
    if (typeof dest === 'string') explicit = await doc.getDestination(dest)
    if (!Array.isArray(explicit)) return 0
    const ref = explicit[0] as unknown
    if (ref && typeof ref === 'object') return (await doc.getPageIndex(ref)) + 1
    if (typeof ref === 'number') return ref + 1
    return 0
  } catch {
    return 0
  }
}

/** Flatten the nested bookmark tree into document order. */
async function readOutline(proxy: unknown): Promise<OutlineEntry[]> {
  const doc = proxy as PdfDocLike
  let raw: unknown
  try {
    raw = await doc.getOutline()
  } catch {
    return []
  }
  if (!Array.isArray(raw) || !raw.length) return []
  const out: OutlineEntry[] = []
  const walk = async (items: unknown[], level: number, path: string[]): Promise<void> => {
    for (const node of items) {
      if (!node || typeof node !== 'object') continue
      const item = node as PdfOutlineNode
      const title = cleanHeadingTitle(typeof item.title === 'string' ? item.title : '')
      const page = item.dest === undefined ? 0 : await resolveDestinationPage(doc, item.dest)
      if (title) {
        out.push({
          level: Math.min(level, MAX_OUTLINE_LEVEL),
          title,
          page,
          path: path.length ? [...path] : undefined,
        })
        if (out.length >= MAX_OUTLINE_ENTRIES) return
      }
      const children = Array.isArray(item.items) ? item.items : []
      if (children.length) {
        await walk(children, level + 1, title ? [...path, title] : path)
        if (out.length >= MAX_OUTLINE_ENTRIES) return
      }
    }
  }
  await walk(raw, 1, [])
  return out
}

/**
 * Drop running headers/footers: short lines repeated on a large share of pages
 * (page numbers, chapter banners, "------- 187 -------"). Titles that recur on
 * every page are furniture, not content — leaving them in used to make every
 * chunk's first line a footer, which is what made the generated mind map
 * meaningless.
 */
function stripPageFurniture(pages: string[][]): number {
  if (pages.length < 20) return 0
  const seen = new Map<string, number>()
  for (const lines of pages) {
    // Only the first/last few lines of a page can be furniture.
    const edge = [...lines.slice(0, 3), ...lines.slice(-3)]
    for (const line of new Set(edge)) {
      if (!line || line.length > 80) continue
      seen.set(line, (seen.get(line) ?? 0) + 1)
    }
  }
  const threshold = Math.max(5, Math.ceil(pages.length * 0.25))
  const drop = new Set<string>()
  for (const [line, count] of seen) {
    if (count >= threshold) drop.add(line)
  }
  // Pagination lines are furniture even when they vary ("187", "- 187 -").
  const isPageNumber = (line: string): boolean => /^[-–—\s.]*\d{1,4}[-–—\s.]*$/.test(line)
  let removed = 0
  for (const lines of pages) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      const atEdge = i < 3 || i >= lines.length - 3
      if ((atEdge && drop.has(line)) || (atEdge && isPageNumber(line))) {
        lines.splice(i, 1)
        removed++
      }
    }
  }
  return removed
}

export async function extractPdfText(data: Buffer): Promise<PdfExtractResult> {
  const doc = await getDocument({
    data: new Uint8Array(data),
    cMapUrl: resourceUrl('cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: resourceUrl('standard_fonts/'),
    useSystemFonts: false,
    disableFontFace: true,
    // We never render; disabling the canvas pipeline keeps the Node worker
    // from trying to polyfill DOMMatrix/Path2D (which it cannot in Node).
    isEvalSupported: false,
  }).promise

  const total = doc.numPages
  const limit = Math.min(total, MAX_PDF_PAGES)
  const pages: string[][] = []
  for (let i = 1; i <= limit; i++) {
    try {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      const lines: string[] = []
      let line = ''
      for (const item of content.items) {
        // TextMarkedContent has no `str`; only TextItem carries glyphs.
        if (!('str' in item)) continue
        line += item.str
        if (item.hasEOL) {
          const trimmed = line.replace(/\s+/g, ' ').trim()
          if (trimmed) lines.push(trimmed)
          line = ''
        }
      }
      const tail = line.replace(/\s+/g, ' ').trim()
      if (tail) lines.push(tail)
      pages.push(lines)
    } catch {
      // A single malformed page must not abort extraction of the whole doc.
      pages.push([])
    }
  }

  const furniture = stripPageFurniture(pages)
  const pageText = pages.map((lines) => lines.join('\n'))
  const text = pageText
    .join('\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
  if (!text) {
    throw new Error('PDF 未提取到文本（可能是扫描件 / 纯图片 PDF，无可选中文字）')
  }

  const outline = await readOutline(doc as unknown)
  const warning =
    total > limit ? `PDF 共 ${total} 页，已截取前 ${limit} 页以避免解析耗尽资源` : undefined
  return {
    text,
    pages: pageText,
    outline,
    furniture,
    warning,
  }
}
