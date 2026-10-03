# dsh-llm-wiki-knowledge — development notes

> [← Back to README](../README.md) · [中文 README](../README.zh.md)
>
> This is the original working document, kept for the reasoning behind the
> current code. For install, configuration and API reference, use the
> [main README](../README.md).

**DSH LLM Wiki 知识库** —— DeepSeek Harness 插件：把 PDF / Word / Markdown / HTML
/ 文本等文档解析成可检索的知识库，并让助手在对话中直接引用这些资料。

解析链路是「取文 → 按文档真实目录切分片段 → 抽取实体与关联 →（可选、你手动启动）
LLM 增强 → 落盘并建立 BM25 检索索引 → 导出 Markdown 与知识脑图」。前端是一个
左侧边栏的「📚 知识库」入口（带文件夹侧栏），后端在宿主注册 `kb_list_documents` /
`kb_search` / `kb_read_document` / `kb_ask` 四个工具。

> 工作区目录与数据目录仍叫 `dsh-knowledge-base`（未随包名一起改）：数据目录是
> 所有已导入文档的存放路径，改名会让它们「消失」。详见
> [Notes](#notes) 里的改名说明。

- **Left sidebar entry** — a "📚 知识库" button is added to the sidebar footer.
- **Document upload** — click or drag-and-drop; supports `txt / md / pdf / docx /
  html / csv / json`.
- **Local-first parsing** — text is extracted, split into wiki sections, and
  entities + cross-links are detected with heuristics that need **no API key**.
- **Two phases, and only one of them costs money** — uploading runs *extraction
  only*: it is local, free and finishes in seconds. LLM *enhancement* (a summary,
  better entities and related concepts per chunk) is a separate job that you
  start yourself, per document with 增强 or in bulk with 批量增强. Nothing is
  billed until you press one of those.
- **Auto-batched enhancement** — one click enriches the *whole* document: the
  runner walks the chunks in batches (`每批增强片段数`, default 400) until every
  one carries a summary, with no "continue" click in the middle. Stop it at any
  time and press 增强 again — it resumes exactly where it stopped. See
  [Enrichment](#enrichment-when-and-how-much-llm-you-buy).
- **Folders** — documents are filed in a nestable folder tree (up to 5 levels).
  Create, rename, move and delete folders from the sidebar, drop an upload
  straight into a folder, and move a document between folders from its card.
  Folders are metadata only: they hold no document bytes, and deleting a folder
  never deletes a document — its documents move up to the deleted folder's parent.
  See [Folders](#folders).
- **Filter by enhancement state** — the toolbar splits the list into 全部 /
  未增强 N / 已增强, and 批量增强 only ever buys summaries for the documents
  currently in that view, so a filter can never cause a silent charge on
  something you cannot see.
- **Live progress** — the document list shows queue → extract → parse → 待增强 →
  enrich → index → done, with a progress bar and per-step status.
- **Result viewer** — open any document to read its parsed wiki chunks, entities,
  and cross-links.
- **Markdown + mind map export** — every parsed document also writes
  `<dataDir>/md/<name>.md` (previewable/downloadable) and `<name>.mindmap.md`,
  rendered live as a 知识脑图 (markmap) with zoom/pan/collapse.
- **Outline-driven structure** — the 脑图 and Markdown tree follow the document's
  real table of contents, not arbitrary chunk slices: PDF bookmarks
  (`getOutline()`), Markdown ATX headings, or numbered text headings. The doc
  list shows `目录 N 条` and a `结构：PDF 目录（书签）` (etc.) hint when an
  outline is present; fading to `未找到文档目录，已按标题行归并` otherwise.
- **设置 tab** — LLM on/off, provider + model, per-batch size and concurrency,
  persisted to `<dataDir>/settings.json` and applied without a restart.
- **Resumable parsing** — a long parse survives a host restart: finished chunks
  are flushed to disk every ~20 s, and any document still marked
  queued/extracting/parsing/enriching/indexing is re-queued automatically on the
  next start. Only the missing calls are paid for.
- **停止解析** — the 停止 button aborts a queued or running parse *or*
  enhancement, keeps every chunk and summary that already finished (status
  becomes `已停止`), and 增强 picks up from there.
- **Four `kb_*` tools** — the knowledge base is reachable from the conversation:
  the plugin registers `kb_list_documents`, `kb_search`, `kb_read_document` and
  `kb_ask` on the host tool registry, so the assistant can search imported
  documents itself instead of the user running a helper script in a terminal.
  See [Tools](#tools).
- **Document tags** — every document carries free-form labels (`命令行`,
  `安全策略`, …). Assign them from the 标签 button, filter the list by clicking a
  label in the toolbar, or pass `tags` to `kb_search` / `POST /kb-api/search` to
  ask the assistant a question about one subject only. See
  [Tags](#tags).
- **Knowledge graph** — a derived graph of document ↔ entity relations, drawn as
  an inline SVG canvas (no external graph library). See
  [Knowledge graph](#knowledge-graph).

## Retrieval

`kb_search` (and `POST /kb-api/search`) answers questions over every indexed
chunk with a **BM25 ranking over a token stream** — no embedding model, no
per-query model call, so it works offline and costs nothing per query.

- **Tokenisation is CJK-aware**: a run of Han characters contributes both
  unigrams and adjacent bigrams, so `源NAT` matches `源 NAT` without a
  tokenizer dictionary. Latin runs (`vlan10`, `802.1q`, `egress`) stay whole.
- **Field weighting**: title ×3, LLM summary ×2, body capped at 400 tokens,
  entities 24 — a hit in a heading outranks one buried in prose.
- **Index lifetime**: built once from the persisted index at startup, then
  refreshed per document when its chunks are written (not on every intermediate
  tick, so parsing never stalls the event loop). A deleted document is dropped
  from it immediately, so a tool call can never cite a document you removed.
- **Answer format**: each hit carries document name, section path, page, summary,
  entities, the document's tags, and a windowed snippet; the rendered text tells
  the model to cite sources and to say so plainly when nothing matched.
- **Narrowing**: `docId` restricts to one document, `tags` to the documents
  carrying any of the given labels (see [Tags](#tags)).

The same endpoint is available for scripts:

```sh
curl -s -X POST http://127.0.0.1:18771/kb-api/search \
  -H 'content-type: application/json' \
  -d '{"query":"源 NAT 怎么配置","topK":5}'
```

Response: `{ok, query, count, indexedDocs, indexedChunks, hits:[...], markdown}` —
`hits` for programmatic use, `markdown` is exactly what the model sees.

## Tools

The plugin registers four tools, split along what answering a question from a
corpus actually needs. Each is separately registered, so a host that can only
provide search still gets a working toolset (the missing capability degrades
in-band instead of failing).

| Tool | Answers | Notes |
| --- | --- | --- |
| `kb_list_documents` | 「知识库里有哪些资料」 | name, parse progress, chunk count, tag list, outline size, id. The only way to turn a title into the `docId` the other two take. |
| `kb_search` | 「这句话在哪」 | BM25 over the same index as `POST /kb-api/search`. Returns passages, never a model call. |
| `kb_read_document` | 「这段前后文是什么」 | Reassembles a document's chunks in reading order under their section headings, paged. |
| `kb_ask` | 「帮我综合成一段话」 | Retrieval followed by one LLM call that cites the passages it used. |

Design notes, all of them load-bearing:

- **Name matches are an enrichment, never a substitute.** A query that reads
  like a document title (`WebUI手册`) is matched against document *names* as
  well as passages, and a named document is appended to the result — the
  passages are still returned. It is also the *only* answer when the body
  contains none of those words, because "no results" would send the model
  hunting for a document that is sitting right there.
- **A question is never a title.** `IPS 的默认动作是什么` must not degrade into a
  document-name match, so interrogatives and space-separated CJK veto the
  branch.
- **A page reads like a manual, not a chunk dump.** `kb_read_document` prints
  each section heading once (`## 3.2 网络地址转换（NAT）（第 12 页）`) and merges
  that section's consecutive chunks under it. Paging cuts on *chunks*, so a page
  boundary never lands inside a passage; the 12 000-character ceiling is
  reported through `truncated` rather than applied silently.
- **An unknown tag is reported, not ignored.** Models invent plausible labels;
  silently searching everything would look like the filter worked.
- **"No documents" and "nothing matched the filter" are different answers.**
  Conflating them sends a user off to import files they already have.
- **`kb_ask` is not concurrency-safe** (it is an LLM call) and its description
  tells the model to prefer `kb_search` whenever a search can produce the exact
  evidence — it is faster and leaves the judgement to the caller. It declines
  in-band when the corpus is too small or no LLM service is registered, and
  every answer it returns lists its passages with `docId` and section so the
  model can go read them.

## Tags

Labels are document-level metadata: cheap to add, and they are what makes a
two-thousand-chunk corpus navigable.

- **Assign** — the 标签 button on any document row opens an inline editor: type a
  new label and press Enter, or click an existing one to toggle it. The list
  shows every label in use with how many documents carry it.
- **Normalisation is the host's job, and it is deliberately one-way.** Tags are
  trimmed, internal whitespace is collapsed, and the result is **lower-cased** and
  de-duplicated, capped at 20 labels of 32 characters per document. Lower-casing
  is what lets a filter, a `?tags=` query and a model's invented spelling all
  compare with plain equality instead of a fuzzy match.
- **Filter** — click a label in the toolbar above the list to restrict it;
  several labels are combined with **OR** (labels narrow by subject, so a file
  tagged both `命令行` and `安全策略` should appear for either). A 清除筛选 button
  appears once something is selected.
- **Search** — `kb_search` takes an optional `tags` array, and
  `POST /kb-api/search` takes `{"tags":["命令行"]}`. The filter is resolved to a
  document-id set *before* scoring, so a label actually removes documents instead
  of merely re-ranking them. An unknown label is reported rather than ignored —
  the model often invents a plausible one, and silently searching everything is
  the worst possible answer to that.
- **Lifetime** — labels live on the document record, so they survive a re-parse
  (chunks change, metadata does not). Saving tags refreshes that document's
  retrieval-index entry, so the next `kb_search` sees them immediately. Clearing
  every label removes the field entirely, keeping an untagged document identical
  to one that never had any.

## Architecture

Pure plugin, no fork of the harness core. Two halves:

| Half | File | Responsibility |
|------|------|----------------|
| Host (Node) | `dist/index.mjs` ← `src/index.ts` | Mounts same-origin `/kb-api/*` routes, runs the parse pipeline, persists a JSON store, builds the graph. |
| Client (browser) | `dist/client.js` ← `src/client.tsx` | Sidebar footer button + slide-in drawer; talks to `/kb-api` via `fetch`. |

The browser half is **same-origin** with the host half, so no CORS is needed.
The route handler applies the same Host-header loopback fence the dsh `/api`
gateway uses (DNS-rebinding defense).

```
upload ─▶ host stores raw bytes ─▶ ParseRunner.enqueue ─▶ runOne        (free)
                                       ├─ extractText (by mime)
                                       ├─ chunkText  (wiki sections)
                                       └─ extractEntities (local NLP)
                                                     └─▶ JSON store, done@100

增强 / 批量增强 ─▶ ParseRunner.enrich ─▶ runEnrich                        (paid)
                                       ├─ selectEnrichTargets (section-aware batch)
                                       └─ enrichChunk × batchSize, loop until done
                                    ┌──────────────────────────────────────┘
                                    ├─▶ JSON store (docs + chunks + folders),
                                    │   flushed every ~20 s while running
                                    ├─▶ BM25 retrieval index (src/retrieve.ts)
                                    └─▶ graph ─▶ md + mindmap exports
```

Extraction and enrichment are separate queue items (`{docId, phase}`), which is
what lets a resume tell them apart: no chunks on disk means extraction was
interrupted, chunks on disk means enrichment was.

### Files

| File | Responsibility |
|------|----------------|
| `src/index.ts` | Activation, config, HTTP routes, tool registration, index lifecycle. |
| `src/parse-runner.ts` | The two-phase pipeline: `runOne` extracts and chunks, `runEnrich` buys LLM summaries batch by batch, `finishDocument` is the shared tail. Progress, cancellation, and incremental persistence live here. |
| `src/parser.ts` | Text extraction + section-aligned chunking. |
| `src/outline.ts` | PDF-bookmark / heading outline → section tree for the 脑图. |
| `src/pdf-extract.ts` | pdfjs text + bookmark extraction. |
| `src/retrieve.ts` | BM25 retrieval index and hit formatting. |
| `src/kb-search-tool.ts` | The four `kb_*` tool definitions and their renderers. |
| `src/kb-docs.ts` | Document projection for the tools: list rows, chunk→section reassembly, paging. |
| `src/kb-ask.ts` | `kb_ask` — passage construction, the citation prompt, answer shaping. |
| `src/doc-export.ts` | Markdown + mind-map rendering. |
| `src/store.ts` | JSON store (`docs` / `chunks` / `folders`), atomic writes, the folder tree, `pendingEnhance` accounting, graph derivation. |
| `src/dsh-llm.ts` | Host `llm` service adapter. |
| `src/deepseek.ts` | DeepSeek API-key adapter. |

## Build

```sh
pnpm install
pnpm run build      # esbuild dual-bundle -> dist/index.mjs + dist/client.js
```

## Install into a profile

```sh
dsh plugin --profile web add .
```

Then **restart the Web Harness**. A "📚 知识库" button appears in the left
sidebar footer. The first upload creates the data directory
`<profile data dir>/kb` (override with `dataDir` below).

## Configuration

Edit the plugin row in `~/.dsh/profiles/web/cordis.patch.yml` (the row id is the
**package name**, so it follows any rename of this plugin):

```yaml
- id: dsh-llm-wiki-knowledge
  config:
    dataDir: ''                  # empty -> <profile data>/kb
    apiPort: 18771               # loopback port the plugin self-hosts
    llmBackend: auto             # auto | dsh | api-key
    llmProvider: workbuddy       # provider route inside the host llm service
    llmModel: glm-5.3-flash      # model id for that route
    maxConcurrent: 2             # documents parsed or enriched at the same time
    maxEnrichChunks: 400         # chunks per enrichment BATCH (not a cap; 0 = one batch)
    enrichConcurrency: 4         # concurrent enrichment requests per batch (1-8)
    deepseekApiKey: ''           # api-key backend / fallback
    deepseekBaseUrl: 'https://api.deepseek.com'
    deepseekModel: 'deepseek-chat'
```

> dsh patch rows replace config wholesale — restate every key you care about.
> Values saved from the 设置 tab land in `<dataDir>/settings.json` and take
> precedence over this config from then on.

Setting `deepseekApiKey` enables LLM enhancement (summaries + richer entities +
cross-concept links). Without it, parsing still works fully offline. With
`llmBackend: auto` (default) the plugin prefers the host's own `llm` service
(pick provider + model in 设置), and only falls back to the API-key path.

## Enrichment: when and how much LLM you buy

Every chunk gets a local outline, entities and links for free; the LLM summary is
the expensive part (~9 s per call). Uploading never buys one: extraction is local
and finishes in seconds, and the document then sits at `待增强` with
`pendingEnhance` = its chunk count. Enhancement is a job you start.

Press **增强** on one document, or **批量增强** for everything in the current
view. Either way the runner covers the **whole document in one go** — it keeps
looping until no chunk lacks a summary, so there is no "continue" click
half-way. What you are actually dialling is the *pace*:

- **每批增强片段数** (`maxEnrichChunks`, default `400`) is the per-batch size, not
  a cap. A 2500-chunk manual runs 7 batches of 400 back to back. A larger value
  spends a bigger slice of work if you hit 停止; a smaller one resumes more often,
  more safely.
- **并发数** (`enrichConcurrency`, 1–8) is the throughput dial, shared with the
  parse queue so a bulk run cannot open 50 provider streams at once.
- Selection is *section-aware*: a batch first takes the first chunk of every
  section, so the exported Markdown and the mind map fill in evenly instead of
  deepening the first few chapters.
- **Re-running is incremental by construction** — the loop only ever looks at
  chunks that lack a summary, so 增强 on a finished document costs nothing, and a
  second click while the run is queued is refused rather than billed twice.
- The document list shows `LLM 增强 N/M` and the card carries an **增强 N** button
  with the exact number of chunks left to buy.
- If a whole batch comes back empty — provider down, key rejected — the run stops
  with `第 N 批 LLM 增强全部失败，仍有 x 个片段未增强` instead of retrying the
  same doomed batch forever.
- With the LLM toggle off, 增强 still accepts the request and writes a readable
  reason onto the document, rather than failing silently.

## Folders

A document belongs to at most one folder, and folders nest up to **5** levels.
The tree lives in the left sidebar; the document list on the right always shows
the subtree you selected, so picking 手册 also shows 手册/命令行.

- **新建** makes a child of the current selection, **✎** renames, **⇧** hoists to
  the root, **↕** moves, **✕** deletes.
- Dropping a file on the upload box files it in the selected folder; every card
  has its own folder selector, so an existing document can be refiled.
- Folders are **metadata only** — `index.json` records a `{id, name, parentId}`
  row per folder and documents carry a `folderId`. No document bytes move, so
  renaming or moving a folder holding a 24 MB manual is instantaneous and
  survives a restart.
- **Deleting a folder never deletes a document.** The subtree is removed and its
  documents are hoisted to the deleted folder's parent (the root, if it was a
  top-level folder); the response reports how many were moved.
- A cyclic move (into itself or into its own descendant) and a 6th level are
  refused with a 400, as is an empty or over-60-character name.
- Uploading with a `folderId` that no longer exists **degrades to the root** and
  says so in the response (`folderFallback`) — a stale selection is not a reason
  to lose a 24 MB upload.

A 2500-chunk manual takes ~6 hours of LLM calls at 9 s each, so the pipeline
is built to be interrupted and resumed:

- **Nothing is held only in memory.** Each enriched chunk is written into the
  store and flushed at most every 20 s (`PERSIST_MIN_INTERVAL_MS`). A host crash
  costs one interval of work, not the whole document.
- **Resume is automatic, and it knows which phase it was in.** On startup every
  document still marked `queued`/`extracting`/`parsing`/`enriching`/`indexing`
  is re-queued (`ParseRunner.resumeInterrupted`), and the phase is decided from
  disk: no chunks on disk means extraction, chunks on disk means enrichment.
  Because summaries already on disk are matched back onto the chunks, a resume
  only pays for what is missing — `/status` reports which ids were picked up.
- **停止 is a real cancel.** Both phases hold an `AbortController`; 停止 aborts
  it, in-flight calls are abandoned, and the document is stored as `已停止` with
  everything that finished intact. `POST /kb-api/cancel/:id` does the same from a
  script.
- **增强 resumes, it does not restart.** It is available for any document that
  still has chunks without a summary, and only ever enqueues those chunks.

## Knowledge graph

`GET /kb-api/graph` returns a derived document ↔ entity graph, capped server-side
at 600 nodes and 4,000 edges, where an entity pair's weight is simply how often
the two are co-mentioned in the same chunk. Rendering that whole payload at once
is a solid green disc — a 5,000-entity manual drew 600 nodes into a single ring,
about 3 px of circumference each. The canvas therefore draws a **readable
slice** and says out loud what it left out.

- **Deterministic layout** — a fixed 1000×720 logical space (documents on an
  inner circle, entities filling four inside-out rings with a half-slot offset on
  alternating rings), fitted to the container and then freely zoomable/pannable.
  Nothing is random, so the same corpus always draws the same picture.
- **Ranked slice, not a sample** — entities are sorted by weighted degree with a
  label tie-break and the top `60 / 150 / 236` are kept (the 实体 button in the
  legend cycles the three; 236 is what the four rings can physically hold, so the
  limit is never advertised above the layout's capacity). A focused entity outside
  the slice is promoted in, evicting the weakest node kept — focusing something
  invisible would otherwise look like a broken button.
- **An adaptive edge budget** — `edgeCap = max(120, round(800 * entLimit / 236))`,
  so the chord density stays roughly constant as the slice grows (203 edges at
  60 entities instead of 800). Edges need both endpoints in the slice; the
  strongest by weight win.
- **Labels are rationed** — every document is named, entities are named for the
  top 40 by degree plus whichever node is active, and anything over 14 characters
  is ellipsised. At 60 entities this is the difference between a diagram and a
  smudge.
- **Truncation is disclosed, never silent** — the corner reads
  `显示 61/600 节点 · 203/4000 关系`, and when anything is dropped a second line
  names the exact rule: `按度数取前 60 实体（隐藏 539），边按权重取前 203`.
- **Interaction** — hover or a focused entity highlights it and its one-hop
  neighbours and dims the rest; clicking a document opens it, clicking an entity
  focuses it (the document list's 实体 bar routes to the same state).

## API routes

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/kb-api/docs` | Document list (`outline` stripped to `outlineEntries`), plus `folders` and `pendingEnrich` so the sidebar tree and the list can never disagree. |
| GET | `/kb-api/doc/:id` | One document plus its chunks. |
| GET | `/kb-api/doc/:id/read` | One page of reassembled text (`?page=&pageSize=`) — what `kb_read_document` returns. |
| GET | `/kb-api/doc/:id/md`, `/mindmap` | Rendered Markdown, rebuilt on demand. |
| GET | `/kb-api/folders` | Every folder with its `path` and live `docCount`, plus `rootDocCount` — the whole tree in one payload. |
| GET | `/kb-api/graph` | Document ↔ entity graph (server-capped at 600 nodes / 4,000 edges; the canvas draws a ranked slice and discloses it) — see [Knowledge graph](#knowledge-graph). |
| GET | `/kb-api/status` | Queue depth, backend, `indexedDocs`/`indexedChunks`, `resumedDocs`. |
| GET | `/kb-api/settings` | Settings, providers, models, backend. |
| POST | `/kb-api/upload` | `multipart/form-data` upload; an optional `folderId` field files the document, and an unknown one degrades to the root with `folderFallback` in the reply. Queues **extraction only** — no LLM call. |
| POST | `/kb-api/parse/:id` | (Re)queue **extraction** — free, local, and it keeps every summary already on disk. |
| POST | `/kb-api/enrich/:id` | Start LLM enhancement for one document: it auto-batches until every chunk has a summary. Re-posting is refused (`queued:false`) rather than billed twice. |
| POST | `/kb-api/enrich-all` | Batch enhancement. Optional body `{docIds:[…]}` restricts it to the documents the caller is looking at; no body means the whole library. |
| POST | `/kb-api/cancel/:id` | Stop a queued/running extraction or enhancement, keeping finished work. |
| POST | `/kb-api/folder` | Create a folder (`{name, parentId?, id?}`). |
| POST | `/kb-api/folder/:id` | Rename and/or move (`{name?, parentId?}`; `parentId: ''` means the root, omitted means unchanged). |
| POST | `/kb-api/doc/:id/folder` | File a document into a folder (`{folderId}`, `''` = root). |
| POST | `/kb-api/search` | BM25 retrieval — see [Retrieval](#retrieval). |
| POST | `/kb-api/tags/:id` | Replace a document's labels — see [Tags](#tags). |
| POST | `/kb-api/export/:id` | Rewrite the `.md` / `.mindmap.md` files. |
| POST | `/kb-api/settings` | Persist and hot-apply settings. |
| DELETE | `/kb-api/doc/:id` | Delete document, exports, and its index entries. |
| DELETE | `/kb-api/folder/:id` | Delete a folder and its subtree; its documents are hoisted to the parent (never deleted) and the reply reports `removed` / `movedDocs`. |

## Notes

- The plugin is additive: it uses the `sidebar.footer.action` and `shell.overlay`
  slots, so it never shadows the shipped sidebar UI.
- `react`, `react-dom`, and `react/jsx-runtime` are provided by the harness at
  runtime; the bundle declares no runtime dependencies.
- PDF/DOCX are salvaged with best-effort text extraction (a warning is shown).
- Host services (`llm`, `tools`) are acquired through `ctx.inject`, never by a
  bare read — under the cordis context proxy a bare read of a service that is not
  in the fiber's inject set throws `cannot get property "llm" without inject`.
  `export const inject` stays empty so the plugin still loads in headless
  profiles that have no agent runtime.
- The `kb_*` tools are defined locally rather than imported from
  `@deepseek-ai/dsh-tools`: in the host that package's `defineTool` is the
  identity function (all validation happens in `ToolRuntime.register`), and it
  ships no type declarations. Every tool is registered as its own effect, so
  unloading the plugin withdraws all four without a restart.
- A tool that cannot serve a call **answers in prose instead of throwing** —
  a transport error teaches the model nothing, while "kb_read_document is
  unavailable on this host, use kb_search" tells it what to do next. The
  `listDocuments` / `readDocument` / `ask` dependencies are optional for exactly
  that reason: a host that wires up only search still registers all four names.
- Bad arguments degrade to defaults (`topK: "x"` → the default) rather than
  failing the call; only a missing required argument is reported, and it is
  reported in the tool's own text, naming the parameter.
- The store writes `index.json` via a temp file + rename. On Windows a rename
  over a file another process has open can fail with `EPERM`, so the write
  falls back to a direct write; a lost index costs summaries, not documents.
- **`pendingEnhance` is derived, never hand-written.** The store recomputes it in
  `stampPending` on the only two entry points that touch a chunk array
  (`setChunks` / `saveChunkPatch`) and *deletes* the field when it reaches 0, so
  a never-enhanced document's JSON stays byte-identical to what older builds
  wrote. `folderId` is the opposite case: absent means the root, and nothing
  back-fills it.
- Tag comparison is plain equality on the lower-cased form, everywhere. A fuzzy
  match would make "命令行" and "命令行手册" interchangeable in a filter while
  the stored values stayed different, which is the kind of inconsistency that
  shows up as "the filter shows nothing" weeks later.
- **`'extracted'` is deliberately a still state, not a half-done job.** It is
  excluded from the resumable set: the extraction phase ends by writing
  `extracted / 40%` and *then* calling `finishDocument`, so a crash in between
  still reads as in-flight, which is exactly what lets `resumeInterrupted` pick
  the right phase. Folding it into the resumable set would make every
  never-enhanced document restart its own extraction on every boot.
- **A batch that comes back with zero successes trips the breaker** and writes
  `第 N 批 LLM 增强全部失败`. Without it a dead provider would be asked for the
  same doomed batch forever, and the document would sit at 2% claiming to be
  working.
- **The package was renamed to `dsh-llm-wiki-knowledge`, the data directory was
  not.** Everything the host keys on follows the package name — the
  `cordis.patch.yml` `id`, the bundle entry in the profile `package.json`, the
  `node_modules` junction, `export const name` in both halves, the sidebar
  `PANEL_ID` and the client module id in `build.mjs` — so a rename is a
  host-visible change that needs a full restart. The data directory keeps the
  old name on purpose: it is where every imported document lives, and pointing a
  renamed plugin at a fresh directory makes an existing corpus look deleted.
  Renaming the *folder* on disk is safe to do separately and changes nothing the
  host resolves.

## License

MIT
