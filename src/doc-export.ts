// Markdown + mind-map export for a parsed document.
//
// Every parsed document produces two artifacts under `<dataDir>/md/`:
//   <base>.md         — the full readable Markdown document (metadata, summary,
//                       every section with its entities / links / gist)
//   <base>.mindmap.md — a markmap-compatible outline (one `#` root, `##`
//                       branches, `-` leaves) that the client renders into the
//                       知识脑图 with markmap.
//
// Both are derived from the stored chunks, so they can be regenerated at any
// time (POST /kb-api/export/:id) — e.g. after enrichment settings changed —
// without re-running the parser. The outline is the *single source of truth*
// for the mind map: the client feeds this same text to markmap's Transformer,
// which keeps the file on disk and the picture in the UI consistent.
//
// Degradation contract: with LLM enrichment off there are no per-chunk
// summaries, so the map falls back to the document's own outline (headings +
// locally extracted entities + a text excerpt). It is always renderable.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { KnowledgeDoc, WikiChunk } from './types.ts'
import {
  MAX_MAP_SECTIONS,
  outlineShape,
  outlineToSections,
  subtreeChunks,
  type DocSection,
} from './outline.ts'

export const MD_SUBDIR = 'md'
/** Maximum rendered sections — re-exported from the outline module. */
export { MAX_MAP_SECTIONS }
/** Entities listed per section branch (and overall). */
export const MAX_SECTION_ENTITIES = 6
export const MAX_MAP_ENTITIES = 12
/** Leaf text caps, so one verbose paragraph cannot dominate the map. */
const CLIP_SUMMARY = 90
const CLIP_EXCERPT = 120
const CLIP_TITLE = 60

export interface DocExports {
  /** Base file name (no extension) shared by both artifacts. */
  base: string
  mdFile: string
  mindmapFile: string
  /** Full Markdown document. */
  md: string
  /** Markmap outline Markdown. */
  mindmap: string
}

// ---- naming -----------------------------------------------------------------

/** Turn an uploaded file name into a filesystem-safe base name (no extension). */
export function sanitizeBase(name: string): string {
  const noExt = (name || '').replace(/\.[A-Za-z0-9]{1,8}$/, '')
  let s = noExt
    // Windows forbids \ / : * ? " < > | and control characters; keep CJK.
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
  // A leading/trailing dot is legal for the fs but not for our URL contract.
  s = s.replace(/^\.+/, '').replace(/\.+$/, '').trim()
  if (s.length > CLIP_TITLE) s = s.slice(0, CLIP_TITLE).trim()
  return s
}

/**
 * Base name for a document's exports. `taken` is every file name already used
 * by *other* documents, so two uploads named the same never overwrite each
 * other's Markdown.
 */
export function exportBaseName(doc: KnowledgeDoc, taken: Iterable<string | undefined> = []): string {
  const base = sanitizeBase(doc.originalName || doc.name) || 'doc-' + doc.id.slice(0, 8)
  const used = new Set<string>()
  for (const t of taken) if (t) used.add(t)
  if (!used.has(base + '.md')) return base
  return `${base}-${doc.id.slice(0, 6)}`
}

export function mdDir(dataDir: string): string {
  return path.join(dataDir, MD_SUBDIR)
}

/**
 * Human title for the document headings — the upload name with its extension
 * stripped, so the H1 reads `防火墙配置指南` and not `防火墙配置指南.md`.
 */
export function docTitle(doc: KnowledgeDoc): string {
  const raw = doc.name || doc.originalName || doc.id
  const base = sanitizeBase(raw)
  return base || raw
}

// ---- markdown helpers -------------------------------------------------------

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n)
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

function clip(s: string, n: number): string {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= n) return flat
  return flat.slice(0, n - 1).trimEnd() + '…'
}

/** First sentence (or first `n` chars) of a paragraph — the no-LLM summary. */
function firstSentence(text: string, n = CLIP_SUMMARY): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const m = flat.match(/^[^。．.!！?？;；]{8,}[。．.!！?？]/)
  return clip(m ? m[0] : flat, n)
}

/** Escape text for markmap (which parses the outline as HTML). */
function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Drop the chunk's own heading line so a body / excerpt never repeats the
 * section title. Only a line that *is* the title (optionally `##`-prefixed) is
 * removed — never a mid-line prefix, so a paragraph that merely starts with the
 * title text keeps every character.
 */
function bodyOf(c: WikiChunk): string {
  const text = String(c.text ?? '')
  const title = String(c.title ?? '').trim()
  if (!title) return text.trim()
  const lines = text.split('\n')
  const bare = (lines[0] ?? '').trim().replace(/^#{1,6}\s*/, '').trim()
  if (bare && bare === title) return lines.slice(1).join('\n').trim()
  return text.trim()
}

// ---- document structure -----------------------------------------------------

export interface OutlineSection {
  title: string
  chunks: WikiChunk[]
}

/** A title looks like a heading when it is short and not a sentence. */
export function looksLikeHeading(title: string): boolean {
  const t = (title ?? '').trim()
  if (!t || t.length > 40) return false
  if (/[。．.；;，,：:！!？?、…]$/.test(t)) return false
  return true
}

/**
 * Group chunks into document sections: a heading-ish chunk opens a new section,
 * everything after it belongs to that section. Documents whose chunk titles are
 * all running text degrade to one section per chunk.
 */
export function groupSections(chunks: WikiChunk[]): OutlineSection[] {
  const sections: OutlineSection[] = []
  let current: OutlineSection | undefined
  chunks.forEach((c, i) => {
    const heading = c.heading ?? looksLikeHeading(c.title)
    if (heading || !current) {
      current = { title: clip(c.title, CLIP_TITLE) || `片段 ${i + 1}`, chunks: [c] }
      sections.push(current)
    } else {
      current.chunks.push(c)
    }
  })
  return sections
}

/** Entity frequency across a set of chunks — each chunk counts once per entity. */
function rankEntities(chunks: WikiChunk[], max: number): { label: string; count: number }[] {
  const freq = new Map<string, number>()
  for (const c of chunks) {
    for (const e of new Set(c.entities ?? [])) {
      if (!e) continue
      freq.set(e, (freq.get(e) ?? 0) + 1)
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([label, count]) => ({ label, count }))
}

/** Unified section node: both artifacts render this same tree. */
interface SectionNode {
  title: string
  /** Chunks that physically live under this node (not its children's). */
  own: WikiChunk[]
  /** Chunks of this node and its whole subtree. */
  all: WikiChunk[]
  /** Outline descendants too deep to render here, shown as a `子节` leaf. */
  folded: string[]
  foldedCount: number
  children: SectionNode[]
}

const SOURCE_LABEL: Record<string, string> = {
  'pdf-bookmarks': 'PDF 目录（书签）',
  'markdown-headings': 'Markdown 标题',
  'text-headings': '文本标题',
}

interface SectionTree {
  roots: SectionNode[]
  /** Real outline was used (vs. the title heuristic). */
  fromOutline: boolean
  /** Outline entries that had to be dropped to keep the map bounded. */
  truncated: boolean
  total: number
}

/** Comparable form of a title: CJK + alphanumerics only, lower-cased. */
function titleKey(s: string): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^0-9a-z\u4e00-\u9fff]+/g, '')
}

/** Does an outline entry's title just repeat the document's own name? */
function repeatsDocName(title: string, doc: KnowledgeDoc): boolean {
  const a = titleKey(title)
  const b = titleKey(docTitle(doc))
  if (a.length < 4 || b.length < 4) return false
  return a === b || a.includes(b) || b.includes(a)
}

/**
 * Every chunk has to be rendered somewhere: the outline can leave chunks
 * unowned (cover / table-of-contents pages before the first chapter, or a gap
 * between two entries). Collect them into one explicit node instead of silently
 * dropping text from the Markdown artifact.
 */
function orphanNode(chunks: WikiChunk[], owned: Set<string>): SectionNode | undefined {
  const rest = chunks.filter((c) => !owned.has(c.id) && bodyOf(c))
  if (!rest.length) return undefined
  return { title: '未归入目录的内容', own: rest, all: rest, folded: [], foldedCount: 0, children: [] }
}

/**
 * Build the section tree. The document's own outline wins whenever we have one
 * (it carries real chapter/section titles and page ranges); otherwise we fall
 * back to grouping by heading-looking chunk titles.
 */
export function buildSectionTree(doc: KnowledgeDoc, chunks: WikiChunk[]): SectionTree {
  const outline = doc.outline ?? []
  if (outline.length) {
    const res = outlineToSections(chunks, outline)
    if (res.sections.length) {
      const toNode = (s: DocSection): SectionNode => ({
        title: s.title,
        own: s.chunks,
        all: subtreeChunks(s),
        folded: s.folded,
        foldedCount: s.foldedCount,
        children: s.children.map(toNode),
      })
      let roots = res.sections.map(toNode)
      // Some outlines start with a single root entry for the document title
      // itself (`# 手册名`) — for a Markdown file that is its H1. It is a
      // wrapper, not a chapter: unwrap it so the real chapters become top
      // level, and hand it back the text it owned so nothing is lost.
      while (roots.length === 1 && roots[0].children.length > 0 && repeatsDocName(roots[0].title, doc)) {
        const wrap = roots[0]
        const kids = wrap.children
        if (wrap.own.length) {
          kids[0] = {
            ...kids[0],
            own: [...wrap.own, ...kids[0].own],
            all: [...wrap.own, ...kids[0].all],
          }
        }
        roots = kids
      }
      const owned = new Set<string>()
      const collect = (nodes: SectionNode[]): void => {
        for (const n of nodes) {
          for (const c of n.own) owned.add(c.id)
          collect(n.children)
        }
      }
      collect(roots)
      const orphan = orphanNode(chunks, owned)
      if (orphan) roots = [orphan, ...roots]
      return { roots, fromOutline: true, truncated: res.truncated, total: countNodes(roots) }
    }
  }
  const sections = groupSections(chunks)
  const roots: SectionNode[] = sections.map((s) => ({
    title: s.title,
    own: s.chunks,
    all: s.chunks,
    folded: [],
    foldedCount: 0,
    children: [],
  }))
  return { roots, fromOutline: false, truncated: false, total: roots.length }
}

function countNodes(nodes: SectionNode[]): number {
  let n = 0
  for (const node of nodes) n += 1 + countNodes(node.children)
  return n
}

/** Titles that already carry their own numbering must not be renumbered. */
function isNumbered(title: string): boolean {
  return /^\s*(?:\d+(?:\.\d+)*|第\s*[一二三四五六七八九十百零〇0-9]{1,4}\s*[章节篇])/.test(title)
}

function sectionLabel(title: string, prefix: string): string {
  return isNumbered(title) ? title : `${prefix}. ${title}`
}

function nodeSummary(node: SectionNode): string | undefined {
  return node.own.find((c) => c.summary)?.summary ?? node.all.find((c) => c.summary)?.summary
}

function nodeExcerpt(node: SectionNode): string {
  const first = node.own[0] ?? node.all[0]
  return first ? firstSentence(bodyOf(first), CLIP_EXCERPT) : ''
}

function nodeEntities(node: SectionNode): string[] {
  return rankEntities(node.all.length ? node.all : node.own, MAX_SECTION_ENTITIES).map((e) => e.label)
}

function nodeLinks(node: SectionNode, max: number): string[] {
  return [...new Set(node.all.flatMap((c) => c.links ?? []))].slice(0, max)
}

/** `第 12-30 页` / `第 12 页` for page-aware documents. */
function pageRange(chunks: WikiChunk[]): string {
  const pages = chunks.map((c) => c.page ?? 0).filter((p) => p > 0)
  if (!pages.length) return ''
  const lo = Math.min(...pages)
  const hi = Math.max(...pages)
  return lo === hi ? `第 ${lo} 页` : `第 ${lo}-${hi} 页`
}

// ---- artifacts --------------------------------------------------------------

/** Full readable Markdown document (the `.md` artifact). */
export function buildMarkdown(doc: KnowledgeDoc, chunks: WikiChunk[]): string {
  const enhanced = chunks.some((c) => !!c.summary)
  const out: string[] = []
  out.push(`# ${docTitle(doc)}`)
  out.push('')
  out.push(
    `> 来源文件：\`${doc.originalName}\` · 类型 \`${doc.mime || 'unknown'}\` · 大小 ${fmtBytes(doc.size)}`,
  )
  out.push(`> 上传时间：${doc.uploadedAt} · 导出时间：${new Date().toISOString()}`)
  out.push(`> 片段 **${chunks.length}** · 实体 **${new Set(chunks.flatMap((c) => c.entities ?? [])).size}** · LLM 增强：**${enhanced ? '已开启' : '未开启'}**`)
  if (doc.warning) out.push(`> ⚠ ${doc.warning}`)
  out.push('')
  if (doc.summary) {
    out.push('## 摘要')
    out.push('')
    out.push(doc.summary)
    out.push('')
  }
  out.push('---')
  out.push('')

  const tree = buildSectionTree(doc, chunks)
  const emit = (nodes: SectionNode[], prefix: string): void => {
    nodes.forEach((node, i) => {
      const path = `${prefix}${i + 1}`
      const depth = path.split('.').length
      out.push(`${'#'.repeat(Math.min(6, depth + 1))} ${sectionLabel(node.title, path)}`)
      out.push('')
      const meta: string[] = []
      const range = pageRange(node.own)
      if (range) meta.push(range)
      meta.push(`${node.own.length} 个片段`)
      out.push(`> ${meta.join(' · ')}`)
      out.push('')
      const summary = nodeSummary(node)
      if (summary) {
        out.push(`**小结：** ${summary}`)
        out.push('')
      }
      if (node.children.length >= 2) {
        out.push(`**子节：** ${node.children.map((c) => c.title).join('、')}`)
        out.push('')
      }
      if (node.foldedCount) {
        out.push(`**更深子节：** ${node.folded.join('、')}${node.foldedCount > node.folded.length ? ` 等 ${node.foldedCount} 节` : ''}`)
        out.push('')
      }
      for (const c of node.own) {
        const body = bodyOf(c)
        if (!body) continue
        out.push(body)
        out.push('')
      }
      const ents = nodeEntities(node)
      if (ents.length) out.push(`**实体：** ${ents.join('、')}`)
      const links = nodeLinks(node, 8)
      if (links.length) out.push(`**关联：** ${links.join('、')}`)
      out.push('')
      if (node.children.length) emit(node.children, `${path}.`)
    })
  }
  emit(tree.roots, '')

  out.push('---')
  out.push('')
  out.push('_由 DSH 知识库插件自动生成。_')
  out.push('')
  return out.join('\n')
}

/**
 * Markmap outline Markdown (the mind-map source). The map mirrors the
 * document's real outline: chapters are `##` branches, their sections `###`,
 * deeper levels `####`, and every node carries its gist / entities / links.
 */
export function buildMindMapMarkdown(doc: KnowledgeDoc, chunks: WikiChunk[]): string {
  const enhanced = chunks.some((c) => !!c.summary)
  const entityTotal = new Set(chunks.flatMap((c) => c.entities ?? [])).size
  const tree = buildSectionTree(doc, chunks)
  const shape = doc.outline?.length ? outlineShape(doc.outline, doc.outlineSource) : undefined
  const out: string[] = []
  out.push(`# ${esc(docTitle(doc))}`)
  out.push('')
  out.push('## 概览')
  out.push('')
  out.push(`- 文件：${esc(clip(doc.originalName, 70))}`)
  out.push(`- 规模：${fmtBytes(doc.size)} · ${chunks.length} 个片段 · ${entityTotal} 个实体`)
  if (shape) {
    out.push(
      `- 结构：${SOURCE_LABEL[shape.source ?? ''] ?? '文档目录'} · ${shape.entries} 个条目 · 最深 ${shape.maxLevel} 级`,
    )
  } else {
    out.push(`- 结构：未找到文档目录，已按标题行归并 ${tree.total} 个章节`)
  }
  if (tree.truncated) out.push(`- 提示：目录条目过多，已展开前 ${MAX_MAP_SECTIONS} 个章节`)
  out.push(`- LLM 增强：${enhanced ? '已开启' : '未开启'}`)
  out.push('')
  if (doc.summary) {
    out.push('## 摘要')
    out.push('')
    out.push(`- ${esc(clip(doc.summary, 300))}`)
    out.push('')
  }

  let used = 0
  let skipped = 0
  const emit = (nodes: SectionNode[], prefix: string): void => {
    nodes.forEach((node, i) => {
      const path = `${prefix}${i + 1}`
      const depth = path.split('.').length
      if (used >= MAX_MAP_SECTIONS) {
        skipped += 1 + countNodes(node.children)
        return
      }
      used++
      out.push(`${'#'.repeat(Math.min(6, depth + 1))} ${esc(sectionLabel(node.title, path))}`)
      out.push('')
      const range = pageRange(node.own)
      const summary = nodeSummary(node)
      if (summary) out.push(`- 小结：${esc(clip(summary, CLIP_SUMMARY))}`)
      if (range) out.push(`- 位置：${range} · ${node.own.length} 个片段`)
      const ents = nodeEntities(node)
      if (ents.length) out.push(`- 实体：${esc(ents.join('、'))}`)
      const links = nodeLinks(node, 5)
      if (links.length) out.push(`- 关联：${esc(links.join('、'))}`)
      if (node.foldedCount) {
        out.push(
          `- 子节：${esc(node.folded.join('、'))}${node.foldedCount > node.folded.length ? ` 等 ${node.foldedCount} 节` : ''}`,
        )
      }
      if (!summary) {
        const excerpt = nodeExcerpt(node)
        if (excerpt) out.push(`- 摘录：${esc(excerpt)}`)
      }
      out.push('')
      if (node.children.length) emit(node.children, `${path}.`)
    })
  }
  emit(tree.roots, '')
  if (skipped) {
    out.push(`## 其余 ${skipped} 个章节已省略`)
    out.push('')
    out.push('- 完整内容见导出的 Markdown 文档')
    out.push('')
  }

  const top = rankEntities(chunks, MAX_MAP_ENTITIES)
  if (top.length) {
    out.push('## 关键实体')
    out.push('')
    for (const e of top) out.push(`- ${esc(clip(e.label, 60))}（${e.count}）`)
    out.push('')
  }
  return out.join('\n')
}

/** Build both artifacts in memory. */
export function buildDocExports(
  doc: KnowledgeDoc,
  chunks: WikiChunk[],
  taken: Iterable<string | undefined> = [],
): DocExports {
  const base = exportBaseName(doc, taken)
  return {
    base,
    mdFile: base + '.md',
    mindmapFile: base + '.mindmap.md',
    md: buildMarkdown(doc, chunks),
    mindmap: buildMindMapMarkdown(doc, chunks),
  }
}

// ---- disk I/O ---------------------------------------------------------------

/** Write both artifacts under `<dataDir>/md/`, returning their names + bodies. */
export async function writeDocExports(
  dataDir: string,
  doc: KnowledgeDoc,
  chunks: WikiChunk[],
  taken: Iterable<string | undefined> = [],
): Promise<DocExports> {
  const ex = buildDocExports(doc, chunks, taken)
  const dir = mdDir(dataDir)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, ex.mdFile), ex.md, 'utf-8')
  await fs.writeFile(path.join(dir, ex.mindmapFile), ex.mindmap, 'utf-8')
  return ex
}

/** Read a previously written export; `undefined` when it is missing. */
export async function readDocExport(dataDir: string, file: string | undefined): Promise<string | undefined> {
  if (!file) return undefined
  // Never let a stored name escape the md/ directory.
  if (file.includes('/') || file.includes('\\') || file.startsWith('.')) return undefined
  try {
    return await fs.readFile(path.join(mdDir(dataDir), file), 'utf-8')
  } catch {
    return undefined
  }
}

/** Best-effort removal of a document's exports. */
export async function removeDocExports(
  dataDir: string,
  files: Iterable<string | undefined>,
): Promise<void> {
  for (const f of files) {
    if (!f || f.includes('/') || f.includes('\\') || f.startsWith('.')) continue
    try {
      await fs.rm(path.join(mdDir(dataDir), f), { force: true })
    } catch {
      /* ignore */
    }
  }
}
