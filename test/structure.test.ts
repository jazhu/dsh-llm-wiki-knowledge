// Unit test for the outline-driven map: section-aligned chunking (parser.ts)
// and the section tree / artifacts (doc-export.ts) — no Cordis host, no LLM.
//
// Run: pnpm test    (Node 22+ strips the types, so this imports the same .ts
// sources the bundle is built from — no separate test build step)
//
// It pins the two behaviours the "no logic" mind map was missing:
//   1. every chunk title is a real outline heading (never a 900-char slice),
//   2. the map's spine is the document outline (chapters -> sections), with
//      exact chunk ownership and an explicit node for unowned front matter.

import { buildChunksFromPages } from '../src/parser.ts'
import { buildMarkdown, buildMindMapMarkdown, buildSectionTree } from '../src/doc-export.ts'
import type { KnowledgeDoc, OutlineEntry, WikiChunk } from '../src/types.ts'

let checks = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures.push(`${name}${detail ? ' — ' + detail : ''}`)
}

const par = (n: number): string =>
  `第${n}段说明配置项的作用范围、依赖关系与回滚方式，配置前请确认设备版本与手册一致。`.repeat(10)

const DOC_NAME = '命令参考手册.pdf'
const CHAPTERS = 4
const SECTIONS = 3
const chapterTitle = (c: number): string => `章节${'一二三四五六七八'[c - 1]}`
const sectionTitle = (c: number, s: number): string => `小节${c}-${s}`

/**
 * A realistic page-aware document: a title-only cover page followed by a
 * bookmark whose first entry is the manual title itself (level 1), then 4
 * chapters (level 2) of 3 sections each (level 3). Every page carries well over
 * SECTION_MIN_CHARS of text, so each section is (and must stay) exactly one
 * chunk.
 */
function pagesFixture(): { pages: string[]; outline: OutlineEntry[] } {
  const pages: string[] = [DOC_NAME]
  const outline: OutlineEntry[] = [{ level: 1, title: DOC_NAME.replace(/\.pdf$/, ''), page: 1 }]
  let page = 1
  for (let c = 1; c <= CHAPTERS; c++) {
    page++
    outline.push({ level: 2, title: chapterTitle(c), page })
    pages.push(`${chapterTitle(c)}\n${par(c * 10)}`)
    for (let s = 1; s <= SECTIONS; s++) {
      page++
      outline.push({ level: 3, title: sectionTitle(c, s), page, path: [chapterTitle(c)] })
      pages.push(`${sectionTitle(c, s)}\n${par(c * 100 + s)}`)
    }
  }
  return { pages, outline }
}

function docOf(over: Partial<KnowledgeDoc>): KnowledgeDoc {
  return {
    id: 'doc-1',
    name: DOC_NAME,
    originalName: DOC_NAME,
    mime: 'application/pdf',
    size: 1024,
    uploadedAt: '2026-10-02T00:00:00.000Z',
    status: 'done',
    chunkCount: 0,
    ...over,
  } as KnowledgeDoc
}

// ---- 1. section-aligned chunking -------------------------------------------
const { pages, outline } = pagesFixture()
const chunks = buildChunksFromPages('doc-1', pages, outline)
const titles = chunks.map((c) => String(c.title))
check(
  'each chapter and section gets exactly one chunk (the cover merges into chapter 1)',
  chunks.length === CHAPTERS * (1 + SECTIONS),
  `chunks=${chunks.length} titles=${titles.join(' | ')}`,
)
check(
  'every chunk title is an outline heading, never a text slice',
  chunks.every((c) => outline.some((e) => e.title === c.title)),
  titles.join(' | '),
)
check(
  'no chunk starts mid-sentence',
  chunks.every((c) => !/段说明配置项/.test(String(c.text).split('\n')[0])),
  '',
)
check(
  'all chunks are section-opening chunks',
  chunks.every((c) => c.heading === true),
  `heading=${chunks.filter((c) => c.heading).length}/${chunks.length}`,
)
check(
  'a chunk starts with the heading it is named after',
  chunks.every((c) => String(c.text).split('\n')[0].includes(String(c.title))),
  chunks.map((c) => String(c.text).split('\n')[0].slice(0, 18)).join(' | '),
)
check(
  'chunks carry their page and section path',
  chunks[1].page === 3 && JSON.stringify(chunks[1].sectionPath) === JSON.stringify([chapterTitle(1), sectionTitle(1, 1)]),
  `page=${chunks[1].page} path=${JSON.stringify(chunks[1].sectionPath)}`,
)
check(
  'a short section does not leak into the next chapter',
  chunks.filter((c) => c.sectionPath?.[0] === chapterTitle(2)).every((c) => c.page >= 6),
  chunks.filter((c) => c.sectionPath?.[0] === chapterTitle(2)).map((c) => `${c.page}:${c.title}`).join(' | '),
)

// ---- 2. the section tree ---------------------------------------------------
const doc = docOf({ outline, outlineSource: 'pdf-bookmarks', chunkCount: chunks.length })
const tree = buildSectionTree(doc, chunks)
check('the outline was used as the spine', tree.fromOutline, `fromOutline=${tree.fromOutline}`)
check(
  'the document-title wrapper was unwrapped',
  tree.roots.length === CHAPTERS && tree.roots[0].title === chapterTitle(1),
  tree.roots.map((r) => r.title).join(' | '),
)
check(
  'every chapter owns its three sections',
  tree.roots.every((r) => r.children.length === SECTIONS),
  tree.roots.map((r) => `${r.title}:${r.children.length}`).join(' '),
)
const owned = new Set<string>()
let duplicate = false
const walk = (nodes: typeof tree.roots): void => {
  for (const n of nodes) {
    for (const c of n.own) {
      if (owned.has(c.id)) duplicate = true
      owned.add(c.id)
    }
    walk(n.children)
  }
}
walk(tree.roots)
check('every chunk is owned exactly once, none dropped', !duplicate && owned.size === chunks.length,
  `owned=${owned.size}/${chunks.length}${duplicate ? ' DUPLICATE' : ''}`)
check('no orphan node when the outline covers the document',
  !tree.roots.some((r) => r.title === '未归入目录的内容'),
  tree.roots.map((r) => r.title).join(' | '))

// Front matter: the outline only starts on page 5 (cover + table of contents
// before it), so those chunks must show up as an explicit node, not vanish.
const gapDoc = docOf({ outline: outline.filter((e) => e.page >= 5) })
const gapTree = buildSectionTree(gapDoc, chunks)
check(
  'unowned front matter becomes its own node, first',
  gapTree.roots[0]?.title === '未归入目录的内容' && gapTree.roots[0].own.length > 0,
  gapTree.roots.map((r) => `${r.title}(${r.own.length})`).join(' '),
)
check('the gap does not drop any chunk',
  (() => {
    const seen = new Set<string>()
    const walkGap = (nodes: typeof gapTree.roots): void => {
      for (const n of nodes) {
        for (const c of n.own) seen.add(c.id)
        walkGap(n.children)
      }
    }
    walkGap(gapTree.roots)
    return seen.size === chunks.length
  })(),
  '')
check('the chapters after the gap are still rendered as chapters',
  gapTree.roots.some((r) => r.title === chapterTitle(CHAPTERS)),
  gapTree.roots.map((r) => r.title).join(' | '))

// ---- 3. the artifacts ------------------------------------------------------
const md = buildMarkdown(doc, chunks)
const mm = buildMindMapMarkdown(doc, chunks)
const headings = (text: string): string => text.split('\n').filter((l) => /^#/.test(l)).slice(0, 6).join(' | ')
check('markdown uses the outline as its spine',
  /^## 1\. 章节一$/m.test(md) && /^### 1\.1\. 小节1-1$/m.test(md), headings(md))
check('markdown body does not repeat its own heading line',
  !md.split('\n').some((l) => /^小节1-1$/.test(l.trim())), '')
check('markdown renders every section title',
  Array.from({ length: CHAPTERS }, (_, i) => chapterTitle(i + 1)).every((t) => md.includes(t)) &&
    Array.from({ length: CHAPTERS * SECTIONS }, (_, i) =>
      sectionTitle(Math.floor(i / SECTIONS) + 1, (i % SECTIONS) + 1)).every((t) => md.includes(t)),
  '')
const bodyLines = chunks.flatMap((c) => String(c.text).split('\n').slice(1).filter((l) => l.trim()))
check('markdown keeps every body line of the document',
  bodyLines.every((l) => md.includes(l)),
  `${bodyLines.filter((l) => !md.includes(l)).length} of ${bodyLines.length} lines missing`)
check('mind map has 概览 + the chapter spine',
  /^## 概览$/m.test(mm) && /^## 1\. 章节一$/m.test(mm), headings(mm))
check('mind map reports the outline source', /结构：PDF 目录（书签）/.test(mm), '')
check('mind map carries page ranges', /- 位置：第 \d+ 页/.test(mm), '')
check('the old flat 内容大纲 wrapper is gone', !mm.includes('内容大纲'), '')

console.log(JSON.stringify({
  checks,
  failed: failures.length,
  failures,
  chunkTitles: titles,
  roots: tree.roots.map((r) => ({
    title: r.title,
    own: r.own.length,
    kids: r.children.map((k) => `${k.title}(${k.own.length})`),
  })),
}, null, 1))
process.exit(failures.length === 0 ? 0 : 1)
