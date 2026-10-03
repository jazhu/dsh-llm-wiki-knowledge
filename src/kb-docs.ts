// Whole-document reads for `kb_read_document`.
//
// `kb_search` returns fragments, and a fragment of a configuration chapter is
// usually a command line with none of the conditions around it. This module
// exists so a model that has found the right place can pull the surrounding text
// back, in the order a human would read it.
//
// Two decisions shape the output:
//
//   * **Chunks are labelled with their section.** A reassembled page reads like
//     a manual only if you can see where one chapter ends and the next begins;
//     without the headings, `kb_read_document` is a wall of text and the model
//     cannot tell a caveat from a command.
//   * **The first page carries the document's own summary and outline count,**
//     so a 2534-chunk manual can be judged from page 1 instead of paged blindly
//     to find out what it holds.

import type { KnowledgeDoc, WikiChunk } from './types.ts'
import type { KbDocumentRow, KbDocumentPage } from './kb-search-tool.ts'

/** Hard ceiling on one page's text. Beyond this the model is reading a file. */
export const MAX_PAGE_CHARS = 12_000

/** Project a stored document into the shape the tools report. */
export function toDocumentRow(doc: KnowledgeDoc): KbDocumentRow {
  return {
    id: doc.id,
    name: doc.name,
    progress: Math.max(0, Math.min(100, Math.round(doc.progress ?? 0))),
    status: doc.status,
    chunkCount: doc.chunkCount,
    enhancedChunks: doc.enhancedChunks ?? 0,
    tags: doc.tags ?? [],
    outlineEntries: doc.outline?.length ?? 0,
    summary: doc.summary ?? '',
  }
}

/** Human label for a chunk: its section path when it has one, else its title. */
function sectionOf(c: WikiChunk): string {
  return c.sectionPath?.length ? c.sectionPath.join(' / ') : c.title
}

/**
 * Group consecutive chunks under one heading so a page reads like the document
 * rather than like a chunk dump. Consecutive chunks sharing a section are merged
 * into one block; a new heading starts a new one.
 */
interface SectionBlock {
  heading: string
  /** 1-based page of the first chunk in the block. */
  page?: number
  text: string
}

function toBlocks(chunks: WikiChunk[]): SectionBlock[] {
  const blocks: SectionBlock[] = []
  for (const c of chunks) {
    const heading = sectionOf(c)
    const last = blocks[blocks.length - 1]
    if (last && last.heading === heading) {
      // Keep the marker only when the chunk's own text starts with a real
      // heading line; re-printing the same heading for every chunk would triple
      // the page's characters without adding information.
      last.text += `\n${c.text.trim()}`
    } else {
      blocks.push({ heading, page: c.page, text: c.text.trim() })
    }
  }
  return blocks
}

/** Distinct section headings covered by a page, for the page header. */
function sectionTitles(blocks: SectionBlock[]): string[] {
  const out: string[] = []
  for (const b of blocks) {
    const t = b.heading.trim()
    if (t && !out.includes(t)) out.push(t)
  }
  return out.slice(0, 8)
}

/**
 * One page of a document's chunks, in storage order.
 *
 * The page is cut on *chunks*, not characters, so a page boundary never lands
 * inside a passage; the character budget is then applied to the assembled text
 * and reported through `truncated` rather than applied silently. Ordering is by
 * chunk index, which is document order by construction (`materializeChunks`
 * numbers them as it walks the pages).
 */
export function readDocumentPage(
  doc: KnowledgeDoc,
  chunks: WikiChunk[],
  page: number,
  pageSize: number,
): KbDocumentPage {
  const ordered = [...chunks].sort((a, b) => a.index - b.index)
  const total = ordered.length
  const start = (page - 1) * pageSize
  const slice = total === 0 ? [] : ordered.slice(start, start + pageSize)
  const blocks = toBlocks(slice)
  let content = blocks
    .map((b) => {
      const where = b.page ? `（第 ${b.page} 页）` : ''
      return `## ${b.heading}${where}\n\n${b.text}`
    })
    .join('\n\n')
  let truncated = false
  if (content.length > MAX_PAGE_CHARS) {
    content = `${content.slice(0, MAX_PAGE_CHARS).trimEnd()}\n…`
    truncated = true
  }
  return {
    doc: toDocumentRow(doc),
    page,
    pageSize,
    total,
    hasMore: start + pageSize < total,
    sectionTitles: sectionTitles(blocks),
    content,
    truncated,
  }
}
