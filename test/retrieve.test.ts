// Unit test for the retrieval engine and the kb_* tool contracts.
//
// Run: pnpm test    (Node 22+ strips the types; the imports below are the same
// .ts sources the bundle is built from — no separate test build step)
//
// What it pins down:
//   * CJK bigram tokenisation — a multi-character term must survive as one token
//   * BM25 actually ranks the right chunk first, and ranks a title match above a
//     passing mention in body text
//   * natural-language queries find a section (this is the whole point: the old
//     helper only did substring matching, which fails on "怎么配置源 NAT")
//   * add/remove/clear keep the index consistent — no double-counting
//   * the tool definitions satisfy dsh-tools' contract (implicit property map,
//     output.render present, execute returns a string, empty-corpus message)

import { ChunkIndex, tokenize, chunkTokens, formatHits, snippetOf, DEFAULT_TOP_K } from '../src/retrieve.ts'
import { defineKbSearchTool, defineKbTools, KB_SEARCH_TOOL_NAME, KB_TOOL_NAMES } from '../src/kb-search-tool.ts'
import { toDocumentRow, readDocumentPage } from '../src/kb-docs.ts'
import { citedPassages } from '../src/kb-ask.ts'
import type { KnowledgeDoc, WikiChunk } from '../src/types.ts'

let checks = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: unknown): void {
  checks++
  if (!ok) failures.push(name + (detail === undefined ? '' : ` — ${JSON.stringify(detail)}`))
}
function countHits(text: string): number {
  return (text.match(/^\d+\. \*\*/gm) ?? []).length
}

function chunk(over: Partial<WikiChunk> & { text: string }): WikiChunk {
  return {
    id: over.id ?? 'd#0',
    index: over.index ?? 0,
    title: over.title ?? 'untitled',
    tokens: over.tokens ?? over.text.length,
    entities: over.entities ?? [],
    links: over.links ?? [],
    ...over,
  }
}
function doc(over: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return {
    id: over.id ?? 'd1',
    name: over.name ?? 'StoneOS-命令行手册-全系列-V5.5R12P3.pdf',
    originalName: over.originalName ?? 'StoneOS-命令行手册-全系列-V5.5R12P3.pdf',
    mime: over.mime ?? 'application/pdf',
    size: over.size ?? 1024,
    uploadedAt: over.uploadedAt ?? '2026-10-02T00:00:00.000Z',
    status: over.status ?? 'done',
    progress: over.progress ?? 100,
    chunkCount: over.chunkCount ?? 0,
    entityCount: over.entityCount ?? 0,
    ...over,
  } as KnowledgeDoc
}

// ---- fixtures: a small slice of the CLI manual ---------------------------
const chunks: WikiChunk[] = [
  chunk({
    id: 'd1#0', index: 0, page: 12, title: '3.2 网络地址转换（NAT）',
    sectionPath: ['3 网络服务', '3.2 网络地址转换（NAT）'],
    summary: 'NAT 把内网私有地址转换为公网地址，分为源 NAT 与目的 NAT 两种方向。',
    text: '源 NAT（SNAT）用于内网主机主动访问外网时修改源地址。目的 NAT（DNAT）用于外网访问内网服务时修改目的地址，常见于发布内部服务器。'.repeat(3),
    entities: ['源 NAT', '目的 NAT', '公网地址', '内网服务器'],
  }),
  chunk({
    id: 'd1#1', index: 1, page: 13, title: '3.2.1 源 NAT 配置步骤',
    sectionPath: ['3 网络服务', '3.2 网络地址转换（NAT）', '3.2.1 源 NAT 配置步骤'],
    summary: '创建 SNAT 策略，指定出接口、源地址池与目的地址段，并确认会话表项建立。',
    text: '第一步，在「安全策略」中新建 SNAT 策略，选择出接口为 WAN1，源地址池选择内网网段。第二步，目的地址段设置为 any。第三步，提交后使用 display nat session 确认会话建立。',
    entities: ['SNAT 策略', 'WAN1', '源地址池', 'display nat session'],
  }),
  chunk({
    id: 'd1#2', index: 2, page: 30, title: '5.1 入侵防御系统（IPS）',
    sectionPath: ['5 安全策略', '5.1 入侵防御系统（IPS）'],
    summary: 'IPS 按签名库匹配流量并执行动作，默认动作为丢弃，可放行或告警。',
    text: 'IPS 策略的默认动作是丢弃（drop）。若需放行特定流量，可在策略中将动作改为 permit，命中后记录告警日志。',
    entities: ['IPS 策略', '默认动作', 'drop', 'permit'],
  }),
  chunk({
    id: 'd1#3', index: 3, page: 31, title: '5.2 会话管理',
    sectionPath: ['5 安全策略', '5.2 会话管理'],
    summary: '会话表记录内网外层的连接状态，用于加速转发与状态检测。',
    text: '会话表项记录源地址、目的地址与协议。NAT 映射会写入会话表，未命中会话的报文按缺省包处理。',
    entities: ['会话表', 'NAT 映射', '缺省包'],
  }),
]

// ---- 1. tokenisation ------------------------------------------------------
{
  const t = tokenize('源 NAT')
  check('tokenize: latin lowercased', t.includes('nat'), t)
  check('tokenize: cjk unigram', t.includes('源'), t)
  // A single-character CJK run has no bigram, and a bigram must not be invented
  // across the space — that would index the phrase boundary as a term.
  check('tokenize: no bigram invented across a space', !t.some((x) => x.length === 2), t)

  const two = tokenize('源地址')
  check('tokenize: cjk run of two yields a bigram', two.includes('源地') && two.includes('源') && two.includes('地'), two)

  const ip = tokenize('802.1Q vlan10 Egress')
  check('tokenize: keeps vlan/dot tokens whole', ip.includes('802.1q') && ip.includes('vlan10') && ip.includes('egress'), ip)

  check('tokenize: empty input yields nothing', tokenize('  ，。； ').length === 0, tokenize('  ，。； '))
}

// ---- 2. field weighting ---------------------------------------------------
{
  const plain = chunkTokens(chunk({ text: 'x'.repeat(200), title: '会话管理' }))
  const rich = chunkTokens(chunk({
    text: 'x'.repeat(200), title: '会话管理',
    summary: '会话表记录内网外层的连接状态。',
  }))
  const titleCount = (list: string[]) => list.filter((t) => t === '会话').length
  check('chunkTokens: title is repeated', titleCount(plain) > 1, titleCount(plain))
  check('chunkTokens: summary adds weight', rich.length > plain.length, { rich: rich.length, plain: plain.length })
}

// ---- 3. ranking -----------------------------------------------------------
const index = new ChunkIndex()
index.add(doc(), chunks)

{
  const top = index.search('源 NAT 怎么配置')
  check('search: natural-language query returns hits', top.length > 0, top.length)
  check(
    'search: ranks the SNAT how-to chunk first',
    top[0]?.chunk.id === 'd1#1',
    top.map((h) => `${h.chunk.id}:${h.score.toFixed(3)}`),
  )
  check(
    'search: title/summary chunk outranks the passing mention',
    (() => {
      const ids = top.map((h) => h.chunk.id)
      return ids.indexOf('d1#1') < (ids.includes('d1#0') ? ids.indexOf('d1#0') : ids.length)
    })(),
    top.map((h) => h.chunk.id),
  )

  const ips = index.search('IPS 默认动作是什么')
  check('search: finds the IPS section for a Chinese question', ips[0]?.chunk.id === 'd1#2', ips.map((h) => h.chunk.id))

  const cmds = index.search('display nat session 确认会话')
  check('search: latin command tokens work', cmds.length > 0 && cmds[0].chunk.id === 'd1#1', cmds.map((h) => h.chunk.id))

  check('search: empty query returns nothing', index.search('   ').length === 0)
  check('search: unknown term returns nothing', index.search('kubernetes helm chart').length === 0)

  // A query of only single-CJK characters is a legitimate (if weak) query.
  const single = index.search('会话')
  check('search: single-CJK-char query still answers', single.length > 0, single.map((h) => h.chunk.id))
}

// ---- 4. options -----------------------------------------------------------
{
  const top1 = index.search('NAT', { topK: 1 })
  check('search: topK honoured', top1.length === 1, top1.length)
  const top99 = index.search('NAT', { topK: 99 })
  check('search: topK clamped to MAX_TOP_K', top99.length <= 12, top99.length)
  const scoped = index.search('会话', { docId: 'other-doc' })
  check('search: docId filter excludes other documents', scoped.length === 0, scoped.length)
  const own = index.search('会话', { docId: 'd1' })
  check('search: docId filter keeps the right document', own.length > 0 && own.every((h) => h.docId === 'd1'), own.map((h) => h.docId))
  check('search: matched terms are reported', own.every((h) => h.matchedTerms.length > 0), own[0]?.matchedTerms)
  check('search: scores are normalised 0..1', own.every((h) => h.score > 0 && h.score <= 1.0001), own.map((h) => h.score))
  check('search: default topK is DEFAULT_TOP_K', index.search('a NAT 源 会话 IPS 策略').length <= DEFAULT_TOP_K)
}

// ---- 5. index lifecycle ---------------------------------------------------
{
  check('index: size counts every chunk', index.size === chunks.length, index.size)

  const before = index.revision
  index.add(doc(), chunks)
  check('index: re-adding a doc does not double its chunks', index.size === chunks.length, index.size)
  check('index: revision advances on change', index.revision > before)

  // Re-adding must not inflate scores: the same corpus, queried twice, ranks
  // identically — this is what catches a double-insert in the posting lists.
  const first = index.search('源 NAT 怎么配置').map((h) => [h.chunk.id, h.score])
  index.add(doc(), chunks)
  const second = index.search('源 NAT 怎么配置').map((h) => [h.chunk.id, h.score])
  check('index: scores are stable across re-add', JSON.stringify(first) === JSON.stringify(second), { first, second })

  index.remove('d1')
  check('index: remove drops the document', index.size === 0, index.size)
  check('index: search after remove returns nothing', index.search('源 NAT').length === 0)

  index.add(doc(), chunks)
  check('index: add after remove restores the document', index.size === chunks.length, index.size)
  check('index: search after re-add works', index.search('源 NAT').length > 0)

  index.clear()
  check('index: clear empties everything', index.size === 0 && index.search('会话').length === 0)
  // Sections 7–8 below query the shared index, so restore it here.
  index.add(doc(), chunks)
}

// ---- 6. multi-document ----------------------------------------------------
{
  const multi = new ChunkIndex()
  multi.add(doc({ id: 'd2', name: 'WebUI手册.pdf' }), [
    chunk({ id: 'd2#0', index: 0, page: 4, title: '地址簿对象管理', text: '在 WebUI 中配置地址簿，添加内网网段对象。' }),
  ])
  multi.add(doc(), chunks)
  const hits = multi.search('地址簿')
  check('index: search spans documents', hits.some((h) => h.docId === 'd2'), hits.map((h) => h.docId))
  check('index: docName is reported for citation', hits.find((h) => h.docId === 'd2')?.docName === 'WebUI手册.pdf')
  multi.remove('d2')
  check(
    'index: removing one doc leaves the other searchable',
    multi.search('源 NAT').length > 0,
    { after: multi.size, hits: multi.search('源 NAT').length },
  )
  check(
    'index: the removed doc is gone',
    multi.search('地址簿').every((h) => h.docId !== 'd2'),
    // 地址簿 also tokenizes to 地址, which legitimately matches d1's 地址 text —
    // what must not survive is any hit attributed to the deleted document.
    multi.search('地址簿').map((h) => h.docId),
  )
}

// ---- 7. snippet + markdown ------------------------------------------------
{
  const long = chunk({
    id: 'd3#0', index: 0, title: '长章节',
    text: '前置内容。'.repeat(100) + '这里是关键结论：源 NAT 需要配置源地址池。' + '后续内容。'.repeat(100),
  })
  const snip = snippetOf(long, ['源 nat'])
  check('snippet: window centres on the matched term', snip.includes('关键结论'), snip.slice(0, 80))
  check('snippet: is bounded', snip.length <= 720, snip.length)
  check('snippet: short chunks are returned whole', snippetOf(chunk({ text: '短' }), []) === '短')

  const hits = index.search('源 NAT')
  const md = formatHits('源 NAT', hits)
  check('formatHits: reports the hit count', md.includes('命中'), md.slice(0, 40))
  check('formatHits: cites the document name', md.includes('StoneOS-命令行手册'), md.slice(0, 200))
  check('formatHits: includes the section path', md.includes('3.2.1'), md.slice(0, 300))
  check('formatHits: carries the summary', md.includes('摘要：'), md.slice(0, 300))
  check('formatHits: says so when nothing matched', formatHits('zzz', []).includes('没有找到'), formatHits('zzz', []))
}

// ---- 8. tool contract -----------------------------------------------------
{
  const catalog: { tag: string; count: number }[] = [
    { tag: '命令行', count: 1 },
    { tag: '安全策略', count: 2 },
  ]
  const tool = defineKbSearchTool({
    search: (q, o) => index.search(q, { topK: o.topK, docId: o.docId, tags: o.tags }),
    stats: () => ({ docs: 1, chunks: index.size }),
    tagCatalog: () => catalog,
  })

  check('tool: name is kb_search', tool.name === KB_SEARCH_TOOL_NAME && tool.name === 'kb_search')
  check('tool: description is non-empty and multiline', tool.description.length > 40 && tool.description.includes('\n'))
  check('tool: parameters is an implicit property map', !('type' in tool.parameters) && !('properties' in tool.parameters), Object.keys(tool.parameters))
  check('tool: query is required', tool.parameters.query.required === true && tool.parameters.query.type === 'string')
  check('tool: topK is optional with bounds', tool.parameters.topK.required === undefined && tool.parameters.topK.minimum === 1)
  check('tool: every parameter carries a description', Object.values(tool.parameters).every((p) => !!p.description))
  check('tool: output.render exists', typeof tool.output.render === 'function')
  check('tool: output.render wraps text', tool.output.render({}, 'hello')[0]?.type === 'text')
  check('tool: isConcurrencySafe is a function', typeof tool.isConcurrencySafe === 'function' && tool.isConcurrencySafe() === true)

  const ok = await tool.execute({ query: '源 NAT 怎么配置' })
  check('tool: returns a non-empty string', typeof ok === 'string' && ok.includes('源 NAT'), ok.slice(0, 60))
  check('tool: output is the same markdown formatHits produces', ok.includes('知识库检索'), ok.slice(0, 40))

  const empty = await tool.execute({})
  check('tool: empty query is rejected in-band', empty.includes('非空'), empty)
  const none = await tool.execute({ query: 'kubernetes' })
  check('tool: no hit explains the corpus size', none.includes('没有检索到') && none.includes('片段'), none)
  check('tool: an aborted signal short-circuits', (await tool.execute({ query: 'NAT' }, { signal: AbortSignal.abort() })).includes('取消'))
  check('tool: honours topK', countHits(await tool.execute({ query: 'NAT', topK: 2 })) <= 2, countHits(await tool.execute({ query: 'NAT', topK: 2 })))
  // A junk topK must fall back to the default, not crash or return nothing. The
  // default (5) is larger than the corpus, so the observable result is "all
  // matches" — which is exactly what a valid default topK yields too.
  const defaultHits = countHits(await tool.execute({ query: 'NAT' }))
  const badTopK = await tool.execute({ query: 'NAT', topK: 'x' })
  check('tool: a bad topK falls back to the default', countHits(badTopK) === defaultHits, { badTopK: countHits(badTopK), defaultHits })
  check('tool: topK=0 falls back to the default', countHits(await tool.execute({ query: 'NAT', topK: 0 })) === defaultHits, countHits(await tool.execute({ query: 'NAT', topK: 0 })))
  check('tool: topK is clamped at the engine', countHits(await tool.execute({ query: 'NAT', topK: 9999 })) <= 12, countHits(await tool.execute({ query: 'NAT', topK: 9999 })))
  check('tool: a whitespace query is rejected in-band', (await tool.execute({ query: '   ' })).includes('非空'))

  const emptyIndex = defineKbSearchTool({
    search: () => [],
    stats: () => ({ docs: 0, chunks: 0 }),
    tagCatalog: () => [],
  })
  check('tool: empty corpus points the user at the import flow', (await emptyIndex.execute({ query: 'x' })).includes('导入文档'))

  // Tag narrowing. An unknown label is the common mistake (the model invents a
  // plausible one), so it must be reported rather than silently ignored.
  // `index` holds the untagged d1 corpus, so the positive case is covered in
  // group 10 against a tagged index; here the filter is expected to come back
  // empty, and the reply must name the label it filtered on.
  check('tool: tags is an optional array of strings', tool.parameters.tags.type === 'array' && tool.parameters.tags.items?.type === 'string' && tool.parameters.tags.required === undefined, tool.parameters.tags)
  check('tool: description mentions tags', tool.description.includes('tags') || tool.description.includes('标签'), tool.description)
  const byTag = await tool.execute({ query: 'NAT', tags: ['命令行'] })
  check('tool: a tag with no matching document reports it as the scope', byTag.includes('带标签') && byTag.includes('命令行'), byTag)
  const unknownTag = await tool.execute({ query: 'NAT', tags: ['并不存在的标签'] })
  check('tool: an unknown tag is reported, not ignored', unknownTag.includes('没有标签为') && unknownTag.includes('并不存在的标签'), unknownTag)
  check('tool: the unknown-tag reply lists what is available', unknownTag.includes('命令行'), unknownTag)
  const noTags = await tool.execute({ query: 'NAT', tags: [] })
  check('tool: an empty tags array searches everything', countHits(noTags) === defaultHits, { got: countHits(noTags), want: defaultHits })
}

// ---- 9. two-doc scoring sanity -------------------------------------------
{
  // Documents that share a term must not let the larger document monopolise
  // the IDF: a term rare in the corpus should still win.
  const mixed = new ChunkIndex()
  for (let i = 0; i < 30; i++) {
    mixed.add(doc({ id: `bulk${i}`, name: `bulk${i}.md` }), [
      chunk({ id: `bulk${i}#0`, index: 0, title: `批量文档 ${i}`, text: '路由 交换 端口 配置 常见问题 与其他章节内容。' }),
    ])
  }
  mixed.add(doc({ id: 'rare', name: 'rare.md' }), [
    chunk({ id: 'rare#0', index: 0, title: 'BGP 路由反射', text: '路由反射器用于 iBGP 场景，避免全连接。' }),
  ])
  const hits = mixed.search('路由反射器怎么配')
  check('bm25: a rare precise term beats 30 documents that merely share a word', hits[0]?.chunk.id === 'rare#0', hits.slice(0, 3).map((h) => h.chunk.id))
}

// ---- 10. tags: storage shape, filtering, catalog --------------------------
{
  const tagged = new ChunkIndex()
  const cli = doc({ id: 'cli', name: 'StoneOS-命令行手册.pdf', tags: ['命令行', '安全策略'] })
  const webui = doc({ id: 'webui', name: 'StoneOS-WebUI手册.pdf', tags: ['webui'] })
  const untagged = doc({ id: 'plain', name: 'notes.md' })
  tagged.add(cli, [chunk({ id: 'cli#0', index: 0, title: 'NAT 源地址转换', text: '源 NAT 需要配置源地址池。' })])
  tagged.add(webui, [chunk({ id: 'webui#0', index: 0, title: '地址簿', text: '地址簿在 WebUI 中的配置步骤。' })])
  tagged.add(untagged, [chunk({ id: 'plain#0', index: 0, title: '随笔', text: '源 NAT 的另一种写法。' })])

  check('tags: a hit carries the document tags', tagged.search('源 NAT')[0]?.docTags.includes('命令行') === true, tagged.search('源 NAT').map((h) => h.docTags))
  check('tags: an untagged document reports an empty list', tagged.search('随笔')[0]?.docTags.length === 0, tagged.search('随笔').map((h) => h.docTags))
  check('tags: filtering keeps only labelled documents', tagged.search('源 NAT', { tags: ['命令行'] }).every((h) => h.docId === 'cli'), tagged.search('源 NAT', { tags: ['命令行'] }).map((h) => h.docId))
  check('tags: filtering excludes the untagged document', !tagged.search('源 NAT', { tags: ['命令行'] }).some((h) => h.docId === 'plain'))
  check('tags: any-of semantics across several labels', tagged.search('地址簿', { tags: ['命令行', 'webui'] }).some((h) => h.docId === 'webui'), tagged.search('地址簿', { tags: ['命令行', 'webui'] }).map((h) => h.docId))
  check('tags: a label nobody uses returns nothing', tagged.search('源 NAT', { tags: ['不存在'] }).length === 0)
  check('tags: docId and tags combine', tagged.search('源 NAT', { docId: 'cli', tags: ['命令行'] }).length > 0 && tagged.search('源 NAT', { docId: 'webui', tags: ['命令行'] }).length === 0)
  check('tags: the label filter does not change an unfiltered query', tagged.search('源 NAT').length === 2, tagged.search('源 NAT').map((h) => h.docId))
  check('tags: formatHits shows the label', formatHits('源 NAT', tagged.search('源 NAT', { tags: ['命令行'] })).includes('标签：命令行'))

  // Re-tagging a document replaces the label the index cached with it.
  tagged.add(doc({ id: 'cli', name: 'StoneOS-命令行手册.pdf', tags: ['架构'] }), [chunk({ id: 'cli#0', index: 0, title: 'NAT 源地址转换', text: '源 NAT 需要配置源地址池。' })])
  check('tags: a re-tag takes effect immediately', tagged.search('源 NAT', { tags: ['命令行'] }).length === 0 && tagged.search('源 NAT', { tags: ['架构'] }).length === 1)
  check('tags: re-tagging does not duplicate postings', tagged.size === 3, tagged.size)
}

// ---- 11. the four-tool surface --------------------------------------------
// The toolset is split along what a retrieval answer actually needs: what is in
// the library, the passages, the surrounding document, and a composed answer.
// Each split has to earn its place, so this group pins the behaviour that makes
// them worth registering separately rather than as one blob.
{
  const cli = doc({ id: 'cli', name: 'StoneOS-命令行手册.pdf', chunkCount: 2, enhancedChunks: 2, tags: ['命令行'] })
  cli.outline = Array.from({ length: 5613 }, (_, i) => ({ level: 1, title: `章节 ${i}`, page: i + 1 }))
  const webui = doc({ id: 'webui', name: 'StoneOS-WebUI手册.pdf', chunkCount: 1, status: 'enriching', progress: 60, tags: ['webui'] })
  // Two uploaded-but-unparsed manuals that contain words from the passage, but
  // whose names no realistic query would match. They matter for two different
  // reasons: a name match is the only way the model can discover an unparsed
  // document, so the rendered block must not claim it has passages; and because
  // `documentsNamedBy` deliberately skips documents already represented by a
  // passage, a name match can only ever show up alongside hits from a
  // *different* document.
  const faq = doc({ id: 'faq', name: '地址簿常见问题.pdf', chunkCount: 0, status: 'queued', progress: 0 })
  // Its name shares no bigram with any passage below, which is what makes it the
  // clean "name match with zero hits" case.
  const rack = doc({ id: 'rack', name: '设备上架作业规范.pdf', chunkCount: 0, status: 'queued', progress: 0 })
  const cliChunks: WikiChunk[] = [
    chunk({ id: 'cli#0', index: 0, page: 12, title: '3.2 网络地址转换（NAT）', sectionPath: ['3.2 网络地址转换（NAT）'], text: '源 NAT 需要配置源地址池。', summary: '配置源 NAT 的步骤', entities: ['源 NAT'] }),
    chunk({ id: 'cli#1', index: 1, page: 13, title: '3.2 网络地址转换（NAT）', sectionPath: ['3.2 网络地址转换（NAT）'], text: '回滚方式：删除源地址池即可。', summary: '回滚配置', entities: ['源地址池'] }),
  ]
  const webuiChunks: WikiChunk[] = [
    chunk({ id: 'webui#0', index: 0, page: 5, title: '地址簿', sectionPath: ['4 地址簿'], text: '地址簿在 WebUI 中的配置步骤。' }),
  ]
  const idx = new ChunkIndex()
  idx.add(cli, cliChunks)
  idx.add(webui, webuiChunks)

  const askCalls: { query: string; docId?: string; tags?: string[]; topK?: number }[] = []
  const deps = {
    search: (q: string, o: { topK?: number; docId?: string; tags?: string[] }) => idx.search(q, { topK: o.topK, docId: o.docId, tags: o.tags }),
    stats: () => ({ docs: 4, chunks: idx.size }),
    tagCatalog: () => [
      { tag: '命令行', count: 1 },
      { tag: 'webui', count: 1 },
    ],
    listDocuments: () => [toDocumentRow(cli), toDocumentRow(webui), toDocumentRow(faq), toDocumentRow(rack)],
    readDocument: (id: string, page: number, pageSize: number) => {
      const d = id === 'cli' ? cli : id === 'webui' ? webui : undefined
      return d ? readDocumentPage(d, id === 'cli' ? cliChunks : webuiChunks, page, pageSize) : undefined
    },
    ask: (query: string, o: { docId?: string; tags?: string[]; topK?: number }) => {
      askCalls.push({ query, docId: o.docId, tags: o.tags, topK: o.topK })
      return Promise.resolve({
        answer: '源 NAT 需要先配置源地址池 [1]，回滚时删除该地址池 [2]。',
        references: [
          { docId: 'cli', docName: cli.name, passage: 1, section: '3.2 网络地址转换（NAT）', page: 12 },
          { docId: 'cli', docName: cli.name, passage: 2, section: '3.2 网络地址转换（NAT）', page: 13 },
        ],
        model: 'workbuddy / glm-5.3-flash',
      })
    },
  }
  const tools = defineKbTools(deps)
  const byName = new Map(tools.map((t) => [t.name, t]))
  check('tools: exactly the four are registered', tools.length === 4 && KB_TOOL_NAMES.every((n) => byName.has(n)), tools.map((t) => t.name))
  check('tools: every description names another tool so the model can chain', KB_TOOL_NAMES.filter((n) => n !== 'kb_list_documents').every((n) => byName.get(n)!.description.includes('kb_')), KB_TOOL_NAMES.map((n) => byName.get(n)!.description.includes('kb_')))
  check('tools: every required argument is declared required', ['kb_search', 'kb_read_document', 'kb_ask'].every((n) => byName.get(n)!.parameters.query?.required === true || byName.get(n)!.parameters.docId?.required === true), Object.fromEntries(tools.map((t) => [t.name, Object.entries(t.parameters).filter(([, p]) => p.required).map(([k]) => k)])))
  check('tools: the three read tools are concurrency-safe, kb_ask is not', byName.get('kb_search')!.isConcurrencySafe() === true && byName.get('kb_ask')!.isConcurrencySafe() === false)

  // kb_list_documents
  const list = await byName.get('kb_list_documents')!.execute({})
  check('list: names every document with its id', list.includes('StoneOS-命令行手册.pdf') && list.includes('id: cli') && list.includes('id: webui'), list)
  check('list: reports partial parses honestly', list.includes('60%') && list.includes('enriching'), list)
  check('list: shows the outline size, which is the document\'s real structure', list.includes('目录 5613 条'), list)
  check('list: shows tags, so a user can see what exists to filter on', list.includes('标签：命令行'), list)
  const byTag = await byName.get('kb_list_documents')!.execute({ tag: 'WEBUI' })
  check('list: filters by tag case-insensitively', byTag.includes('webui') && !byTag.includes('StoneOS-命令行手册.pdf'), byTag)
  const byNameLike = await byName.get('kb_list_documents')!.execute({ nameLike: 'WebUI' })
  check('list: filters by name fragment', byNameLike.includes('StoneOS-WebUI手册.pdf') && !byNameLike.includes('id: cli'), byNameLike)
  const unmatched = await byName.get('kb_list_documents')!.execute({ nameLike: 'zzz' })
  check('list: a filtered miss is not mistaken for an empty library', unmatched.includes('没有文档匹配这个过滤条件') && unmatched.includes('去掉 nameLike / tag'), unmatched)
  check('list: an unfiltered empty library still says so', (await defineKbTools({ ...deps, listDocuments: () => [] }).find((t) => t.name === 'kb_list_documents')!.execute({})).includes('还没有已解析的文档'))

  // kb_search — the "the query named a document" enrichment
  const search = await byName.get('kb_search')!.execute({ query: '源 NAT 怎么配置' })
  check('search: a question-shaped query is not treated as a title', !search.includes('还匹配到以下文档'), search.slice(-120))
  const byTitle = await byName.get('kb_search')!.execute({ query: '地址簿' })
  check('search: a title-shaped query lists the document it names', byTitle.includes('还匹配到以下文档') && byTitle.includes('地址簿常见问题.pdf'), byTitle.slice(-200))
  check('search: the named block carries the docId so the model can read it', byTitle.includes('docId: faq'), byTitle.slice(-200))
  check('search: the passages are still returned alongside the name match', countHits(byTitle) > 0, countHits(byTitle))
  // A document whose body never uses the words in its name is the case the
  // whole name-match branch exists for: there are no passages to return, and
  // "no results" would send the model hunting for a file that is right there.
  const nameless = new ChunkIndex()
  nameless.add(cli, cliChunks)
  const bodyBlind = defineKbTools({ ...deps, search: (q: string, o: { topK?: number; docId?: string; tags?: string[] }) => nameless.search(q, { topK: o.topK, docId: o.docId, tags: o.tags }) })
  const nameOnly = await bodyBlind.find((t) => t.name === 'kb_search')!.execute({ query: '设备上架作业规范' })
  check('search: a name-only match is reported even with zero passages', nameOnly.includes('还匹配到以下文档') && nameOnly.includes('设备上架作业规范.pdf') && nameOnly.includes('没有检索到'), nameOnly)
  check('search: a name match does not claim an unparsed document has passages', !nameOnly.includes('设备上架作业规范.pdf（docId: rack · '), nameOnly.slice(-160))
  const question = await bodyBlind.find((t) => t.name === 'kb_search')!.execute({ query: '命令行手册怎么用' })
  check('search: a question never degrades into a name match', !question.includes('还匹配到以下文档'), question.slice(-160))

  // kb_read_document
  const read = await byName.get('kb_read_document')!.execute({ docId: 'cli' })
  check('read: names the document and its id', read.includes('文档：StoneOS-命令行手册.pdf') && read.includes('id: cli'), read.slice(0, 160))
  check('read: reports the chunk window so a long manual is paged knowingly', read.includes('共 2'), read.slice(0, 200))
  check('read: labels the section, so reassembled text is not a wall', read.includes('## 3.2 网络地址转换（NAT）') && read.includes('（第 12 页）'), read)
  check('read: merges chunks of one section under a single heading', (read.match(/^## /gm) ?? []).length === 1, (read.match(/^## /gm) ?? []).length)
  check('read: a single page covers the whole document, so no next-page hint', !read.includes('还有更多片段'), read.slice(-120))
  const readPaged = await byName.get('kb_read_document')!.execute({ docId: 'cli', pageSize: 1 })
  check('read: paging splits one section across pages and says so', readPaged.includes('可用 page: 2 继续读取'), readPaged.slice(-160))
  check('read: page 2 picks up where page 1 stopped', (await byName.get('kb_read_document')!.execute({ docId: 'cli', page: 2, pageSize: 1 })).includes('回滚方式'), 'page 2')
  check('read: an unknown id points the model at the list tool', (await byName.get('kb_read_document')!.execute({ docId: 'nope' })).includes('kb_list_documents'))
  check('read: a missing docId is rejected in-band', (await byName.get('kb_read_document')!.execute({})).includes('非空'))

  // kb_ask
  const asked = await byName.get('kb_ask')!.execute({ query: '源 NAT 怎么配置和回滚' })
  check('ask: returns the composed answer', asked.includes('源地址池'), asked.slice(0, 200))
  check('ask: lists the passages it leaned on, with docId and section', asked.includes('[1]') && asked.includes('docId: cli') && asked.includes('3.2 网络地址转换'), asked)
  check('ask: names the model that answered', asked.includes('workbuddy / glm-5.3-flash'), asked.slice(-160))
  check('ask: tells the model the answer is another model\'s to be checked', asked.includes('kb_search'), asked.slice(-160))
  check('ask: the scope reaches the retrieval engine', askCalls.length === 1 && askCalls[0].query === '源 NAT 怎么配置和回滚', askCalls)
  const askedScoped = await byName.get('kb_ask')!.execute({ query: '地址簿', tags: ['webui'], topK: 3 })
  check('ask: a tag scope is forwarded', askedScoped.length > 0 && askCalls[1].tags?.includes('webui') && askCalls[1].topK === 3, askCalls[1])
  check('ask: an unknown tag is reported, not silently ignored', (await byName.get('kb_ask')!.execute({ query: 'x', tags: ['不存在'] })).includes('没有标签为'))
  const noAsk = defineKbTools({ ...deps, ask: undefined }).find((t) => t.name === 'kb_ask')!
  check('ask: without an LLM service it says so and names the fallback', (await noAsk.execute({ query: 'x' })).includes('没有登记 LLM 服务') && (await noAsk.execute({ query: 'x' })).includes('kb_search'))

  // Degraded hosts: the tool set must still answer when only search is wired up.
  const searchOnly = defineKbTools({ search: deps.search, stats: deps.stats, tagCatalog: deps.tagCatalog })
  check('tools: a search-only host still registers all four names', searchOnly.length === 4 && searchOnly.every((t) => typeof t.execute === 'function'))
  check('tools: the absent read path degrades in-band', (await searchOnly.find((t) => t.name === 'kb_read_document')!.execute({ docId: 'cli' })).includes('不可用'))
  check('tools: the absent list path degrades in-band', (await searchOnly.find((t) => t.name === 'kb_list_documents')!.execute({})).includes('不可用'))
  check('tools: search still works on such a host', countHits(await searchOnly.find((t) => t.name === 'kb_search')!.execute({ query: '源 NAT' })) > 0)

  // citedPassages is what keeps a reference list honest.
  check('ask: citation markers are parsed and bounded', JSON.stringify(citedPassages('见 [1] 与 [2]。', 3)) === '[1,2]' && JSON.stringify(citedPassages('见 [9]。', 3)) === '[]', citedPassages('见 [1] 与 [2]。', 3))
}

console.log(JSON.stringify({ checks, failed: failures.length, failures }, null, 2))
if (failures.length) process.exit(1)
