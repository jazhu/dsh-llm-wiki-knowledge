// Real document structure: table of contents, section tree, page mapping.
//
// Why this module exists: pure text heuristics could not recover a manual's
// structure. PDF extraction used to concatenate every page into one
// separator-less run, so the chunker fell back to slicing it every 900
// characters and each slice's "title" was whatever text happened to sit at that
// offset — usually a page footer ("------------ 187 ------------"). The mind map
// therefore had no logic at all.
//
// The fix is to read the structure the document already carries:
//   * PDF: the embedded bookmark tree (`getOutline()`), which gives level,
//     title and destination page for every chapter/section;
//   * Markdown: ATX headings;
//   * plain text / HTML-stripped text: numbered headings ("4.2.1 安全域").
//
// Everything here is pure: given chunks + outline entries it produces the
// section tree used by the Markdown export and the mind map, and it degrades to
// an empty result (callers then fall back to the old text heuristics).

import type { OutlineEntry, OutlineSource, WikiChunk } from './types.ts'

/** Cap on stored outline entries, so a pathological PDF cannot bloat index.json. */
export const MAX_OUTLINE_ENTRIES = 6000

/**
 * Cap on rendered mind-map/markdown nodes (deeper entries get folded). 320 is
 * chosen so the two real manuals (244 / 227 outline entries down to level 2)
 * render as a full chapter → section tree, while a pathological outline still
 * degrades to its chapters plus folded section lists.
 */
export const MAX_MAP_SECTIONS = 320

/** Titles folded under one node ("- 子节：…") before the list is clipped. */
export const MAX_FOLD_TITLES = 12

/** Longest outline title we keep; longer ones are clipped. */
const MAX_TITLE_LEN = 90

export interface DocSection {
  title: string
  /** 1-based outline level of this node (1 = chapter). */
  level: number
  /** Human-readable full path ("4 防火墙 / 安全域"). */
  pathLabel: string
  /** True when this node came from a real outline entry (not a heuristic). */
  fromOutline: boolean
  /** Chunks whose source range belongs to this node itself (no children). */
  chunks: WikiChunk[]
  /** Rendered descendant nodes. */
  children: DocSection[]
  /** Deeper outline titles folded under this node (below the cut level). */
  folded: string[]
  /** Total folded/deeper entries under this node (may exceed `folded.length`). */
  foldedCount: number
}

export interface OutlineSections {
  sections: DocSection[]
  /** Deepest outline level that was rendered. 0 when there was no outline. */
  cut: number
  /** True when entries had to be dropped to respect the node cap. */
  truncated: boolean
  /** Total entries in `outline` (including folded ones). */
  total: number
}

export interface OutlineShape {
  entries: number
  maxLevel: number
  chapters: number
  source?: OutlineSource
}

/** Trim/clean titles and drop unusable entries; order is preserved. */
export function normalizeOutline(raw: readonly OutlineEntry[] | undefined): OutlineEntry[] {
  if (!raw || !raw.length) return []
  const out: OutlineEntry[] = []
  for (const item of raw) {
    if (!item) continue
    const title = cleanHeadingTitle(item.title)
    if (!title) continue
    const level = Number.isFinite(item.level) ? Math.max(1, Math.min(9, Math.round(item.level))) : 1
    const page = Number.isFinite(item.page) ? Math.max(0, Math.round(item.page)) : 0
    out.push({ level, title, page, path: item.path?.length ? [...item.path] : undefined })
    if (out.length >= MAX_OUTLINE_ENTRIES) break
  }
  return out
}

/** Collapse whitespace, strip Markdown hashes/dotted leaders and clip length. */
export function cleanHeadingTitle(raw: string): string {
  let t = String(raw ?? '')
    .replace(/\s+/g, ' ')
    // Dotted leaders and trailing page numbers that some bookmark titles carry.
    .replace(/[\s.·・…]{3,}\s*\d{1,4}$/, '')
    .replace(/^#{1,6}\s*/, '')
    .trim()
  if (t.length > MAX_TITLE_LEN) t = t.slice(0, MAX_TITLE_LEN - 1).trimEnd() + '…'
  return t
}

/** Counts + source, for display in the UI. */
export function outlineShape(
  raw: readonly OutlineEntry[] | undefined,
  source?: OutlineSource,
): OutlineShape {
  const entries = normalizeOutline(raw)
  let maxLevel = 0
  let chapters = 0
  for (const e of entries) {
    if (e.level > maxLevel) maxLevel = e.level
    if (e.level === 1) chapters++
  }
  return { entries: entries.length, maxLevel, chapters, source }
}

/**
 * Deepest level whose cumulative entry count still fits `maxNodes`. Entries
 * below it are folded into their ancestor instead of becoming nodes.
 */
export function pickOutlineCut(
  entries: readonly OutlineEntry[],
  maxNodes = MAX_MAP_SECTIONS,
): { level: number; truncated: boolean } {
  if (!entries.length) return { level: 0, truncated: false }
  const byLevel = new Map<number, number>()
  for (const e of entries) byLevel.set(e.level, (byLevel.get(e.level) ?? 0) + 1)
  const levels = [...byLevel.keys()].sort((a, b) => a - b)
  let cum = 0
  let level = levels[0]
  for (const l of levels) {
    cum += byLevel.get(l) ?? 0
    if (cum <= maxNodes) level = l
    else break
  }
  const kept = entries.filter((e) => e.level <= level).length
  return { level, truncated: kept > maxNodes }
}

/** True when any chunk carries a source page (PDF path). */
function isPageAware(chunks: readonly WikiChunk[]): boolean {
  return chunks.some((c) => typeof c.page === 'number' && c.page > 0)
}

/** First chunk at/after `from` whose text mentions the section title. */
function findTitleMatch(chunks: readonly WikiChunk[], title: string, from: number): number {
  if (!title) return -1
  const needle = title.replace(/\s+/g, '')
  if (needle.length < 2) return -1
  for (let i = Math.max(0, from); i < chunks.length; i++) {
    const hay = chunks[i].text.replace(/\s+/g, '')
    if (hay.includes(needle)) return i
  }
  return -1
}

/**
 * Build the section tree from a document outline.
 *
 * Chunk ownership is partitioned in document order so that no chunk is rendered
 * twice: a node owns the chunks between its own start and the next rendered
 * node's start. Parents therefore only own their intro material, while their
 * sections become child nodes — which is exactly the shape of a real manual.
 */
export function outlineToSections(
  chunks: readonly WikiChunk[],
  rawEntries: readonly OutlineEntry[] | undefined,
  maxNodes = MAX_MAP_SECTIONS,
): OutlineSections {
  const entries = normalizeOutline(rawEntries)
  if (!entries.length || !chunks.length) {
    return { sections: [], cut: 0, truncated: false, total: entries.length }
  }
  const { level: cut, truncated: cutTruncated } = pickOutlineCut(entries, maxNodes)
  const pageMode = isPageAware(chunks)

  // Rendered nodes (level <= cut), in document order.
  const picked: Array<{ entry: OutlineEntry; index: number }> = []
  let truncated = cutTruncated
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.level > cut) continue
    if (picked.length >= maxNodes) {
      truncated = true
      break
    }
    picked.push({ entry, index: i })
  }
  if (!picked.length) return { sections: [], cut, truncated, total: entries.length }

  // Chunk ranges, monotone in document order.
  const own: WikiChunk[][] = picked.map(() => [])
  if (pageMode) {
    // Page mode: a chunk belongs to the last rendered entry that starts at or
    // before its page. Walking the chunks once (instead of each entry's page
    // range) means no page ever falls through a gap: a chapter whose first
    // sub-section bookmark sits on a later page still owns the pages in
    // between, and pages past the last bookmark stay with the last chapter.
    let at = -1
    for (const chunk of chunks) {
      const p = chunk.page ?? 0
      while (at + 1 < picked.length && picked[at + 1].entry.page <= p) at++
      if (at >= 0) own[at].push(chunk)
    }
  } else {
    // No pages: match each title against chunk text with a monotone cursor,
    // then hand each node the chunks up to the next matched node.
    const starts: Array<number | null> = picked.map(() => null)
    let cursor = 0
    for (let j = 0; j < picked.length; j++) {
      const at = findTitleMatch(chunks, picked[j].entry.title, cursor)
      starts[j] = at < 0 ? null : at
      if (at >= 0) cursor = at + 1
    }
    for (let j = 0; j < picked.length; j++) {
      const from = starts[j]
      if (from === null) continue
      let to = chunks.length
      for (let k = j + 1; k < picked.length; k++) {
        const next = starts[k]
        if (next !== null && next > from) {
          to = next
          break
        }
      }
      own[j] = chunks.slice(from, Math.max(from, to))
    }
  }

  // Fold entries below the cut (and any dropped by the node cap) into the
  // nearest preceding rendered node.
  const folded: string[][] = picked.map(() => [])
  const foldedCount = picked.map(() => 0)
  const nodeOfEntry = new Map<number, number>()
  picked.forEach((p, j) => nodeOfEntry.set(p.index, j))
  let current = -1
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.level <= cut) {
      const idx = nodeOfEntry.get(i)
      if (idx !== undefined) {
        current = idx
        continue
      }
      // Level fits but the node cap cut it off: fold it too.
    }
    if (current < 0) continue
    foldedCount[current]++
    if (folded[current].length < MAX_FOLD_TITLES) folded[current].push(entry.title)
  }

  const sections: DocSection[] = picked.map((p, j) => ({
    title: p.entry.title,
    level: p.entry.level,
    pathLabel: [...(p.entry.path ?? []), p.entry.title].join(' / '),
    fromOutline: true,
    chunks: own[j],
    children: [],
    folded: folded[j],
    foldedCount: foldedCount[j],
  }))

  // Nest by level with a stack.
  const roots: DocSection[] = []
  const stack: DocSection[] = []
  for (const node of sections) {
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop()
    if (stack.length) stack[stack.length - 1].children.push(node)
    else roots.push(node)
    stack.push(node)
  }

  return { sections: roots, cut, truncated, total: entries.length }
}

/** Flatten a section tree depth-first (parents before children). */
export function walkSections(
  sections: readonly DocSection[],
  visit: (section: DocSection, depth: number) => void,
  depth = 0,
): void {
  for (const s of sections) {
    visit(s, depth)
    if (s.children.length) walkSections(s.children, visit, depth + 1)
  }
}

/** Every chunk of a section and its descendants. */
export function subtreeChunks(section: DocSection): WikiChunk[] {
  const out = [...section.chunks]
  for (const child of section.children) out.push(...subtreeChunks(child))
  return out
}

// ---- text-side outline detection (no PDF bookmarks available) -------------

const MD_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/
const NUM_HEADING = /^(\d+(?:\.\d+){0,4})[.、)．]?\s+(\S.{0,70})$/
const CN_CHAPTER = /^第\s*[一二三四五六七八九十百零〇0-9]{1,4}\s*[章节篇]\s*(.{0,60})$/

/** True when a raw text line looks like a heading (Markdown or numbered). */
export function looksLikeHeading(line: string): boolean {
  const t = String(line ?? '').trim()
  if (!t || t.length > 100) return false
  if (MD_HEADING.test(t)) return true
  if (CN_CHAPTER.test(t)) return true
  const num = NUM_HEADING.exec(t)
  if (!num) return false
  const title = num[2].trim()
  return title.length >= 2 && title.length <= 60 && !/[，。；：,;]$/.test(title)
}

/**
 * Best-effort outline for Markdown / plain text / stripped HTML: ATX headings
 * first, then numbered headings ("4.2.1 安全域"). Returns [] when the text does
 * not look structured, so callers keep the heuristic path.
 */
export function detectTextOutline(text: string): OutlineEntry[] {
  const src = String(text ?? '')
  if (!src.trim()) return []
  const out: OutlineEntry[] = []
  const lines = src.split('\n')
  let inFence = false
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (/^```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || !line || line.length > 100) continue
    const md = MD_HEADING.exec(line)
    if (md) {
      const title = cleanHeadingTitle(md[2])
      if (title.length >= 2) out.push({ level: md[1].length, title, page: 0 })
      continue
    }
    const num = NUM_HEADING.exec(line)
    if (num) {
      const title = cleanHeadingTitle(num[2])
      // Reject running text that merely starts with a number ("3 个接口…").
      if (title.length >= 2 && title.length <= 60 && !/[，。；：,;]$/.test(title)) {
        const level = 1 + (num[1].match(/\./g)?.length ?? 0)
        out.push({ level: Math.min(level, 4), title, page: 0 })
      }
      continue
    }
    const cn = CN_CHAPTER.exec(line)
    if (cn) {
      const title = cleanHeadingTitle(cn[1]) || cleanHeadingTitle(line)
      if (title.length >= 2) out.push({ level: 1, title, page: 0 })
    }
  }
  if (out.length < 3) return []
  // Markdown heading counts vary wildly (#### for sub-points); compress to at
  // most 4 levels so the rendered tree stays readable.
  if (out.some((e) => e.title.length)) {
    const maxLevel = out.reduce((m, e) => Math.max(m, e.level), 1)
    if (maxLevel > 4) {
      const scale = (l: number): number => Math.max(1, Math.min(4, Math.ceil((l / maxLevel) * 4)))
      return out.map((e) => ({ ...e, level: scale(e.level) }))
    }
  }
  return out
}
