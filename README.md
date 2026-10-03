# dsh-llm-wiki-knowledge

**English** | [中文](README.zh.md) | [开发笔记 / development notes](docs/development-notes.md)

A DeepSeek Harness (DSH) plugin that turns PDF, Word, Markdown, HTML and text
files into a searchable local knowledge base — and gives the assistant four tools
so it can cite those documents in normal conversation.

The pipeline is:

```
upload → extract locally → split on the document's real outline → entities & links
       → (optional, you start it) LLM enrichment → persist + build a BM25 index
       → export Markdown and a markmap mind map
```

Extraction and entity extraction are **free and offline**. LLM enrichment is a
separate job that only runs when you press a button, in batches you control.

## What it does

- **Sidebar knowledge base** — a "知识库" entry is added to the sidebar panel list
  (right after 自动化任务) and opens a panel with four tabs:
  文档 / 知识脑图 / 知识图谱 / 设置.
- **Upload** — click or drop files: `txt`, `md`, `pdf`, `docx`, `html`, `csv`,
  `json`.
- **Local-first parsing** — text is extracted, split into section-aligned chunks,
  and entities plus cross-links are detected with heuristics that need **no API
  key**. The document is browsable within seconds of upload.
- **Two phases, only one of which costs money** — uploading runs extraction only.
  Enhancement (a summary, richer entities and related concepts per chunk) is
  started explicitly, per document or in bulk. Nothing is billed until you press
  增强 / 批量增强.
- **Auto-batched enrichment** — one click enriches the *whole* document. The
  runner walks chunks in batches (`每批增强片段数`, default 400) until every chunk
  carries a summary; there is no "continue" click half-way. Batch selection is
  *section-aware*, so the first pass gives every chapter one enriched chunk
  instead of deepening the first few chapters.
- **Resumable parsing** — finished chunks are flushed to disk every ~20 s. A host
  crash or a quit costs at most one flush interval, and any document still marked
  queued/extracting/parsing/enriching/indexing is re-queued automatically on the
  next start. Only the *missing* summaries are paid for.
- **停止 is a real cancel** — the stop button aborts a queued or running parse or
  enhancement, keeps every chunk and summary that already finished (status
  becomes `已停止`), and 增强 picks up from there.
- **Outline-driven structure** — the Markdown export and the mind map follow the
  document's real table of contents, not arbitrary character slices. PDF bookmarks
  (`getOutline()`) are used when present, otherwise Markdown ATX headings, else
  numbered text headings; with no outline at all the plugin says so and falls back
  to merging by heading lines.
- **Markdown + mind map export** — every parsed document also writes
  `<dataDir>/md/<name>.md` (previewable, downloadable) and `<name>.mindmap.md`,
  rendered live as a 知识脑图 (markmap) with zoom / pan / collapse.
- **Folders** — documents are filed in a nestable folder tree (up to 5 levels).
  Create, rename, move and delete folders; drop an upload straight into a folder.
  Folders are metadata only, and **deleting a folder never deletes a document** —
  its documents move up to the deleted folder's parent.
- **Document tags** — free-form labels (`命令行`, `安全策略`, …) per document.
  Assign from the 标签 button, filter the list by clicking a label, or pass `tags`
  to `kb_search` so the assistant answers about one subject only.
- **Knowledge graph** — a document ↔ entity relation graph drawn as inline SVG
  (no external graph library).
- **Live progress** — the list shows queue → extract → parse → 待增强 → enrich →
  index → done, with a progress bar and per-step status.
- **Settings tab** — LLM on/off, provider + model, per-batch size, concurrency and
  API port, persisted to `<dataDir>/settings.json` and applied without a restart.

## Tools

The plugin registers four tools on the host tool registry, so the assistant can
search your imported documents itself instead of you running a helper script in a
terminal. Each is registered as its own effect, so unloading the plugin withdraws
all four without a restart.

| Tool | Answers | Arguments |
|------|---------|-----------|
| `kb_list_documents` | 「知识库里有哪些资料」 | `nameLike?`, `tag?`, `limit?` (1–100, default 20) |
| `kb_search` | 「这句话在哪」 | `query` (required), `topK?` (1–12, default 5), `docId?`, `tags?` |
| `kb_read_document` | 「这段前后文是什么」 | `docId` (required), `page?`, `pageSize?` (1–40, default 8) |
| `kb_ask` | 「帮我综合成一段话」 | `query` (required), `docId?`, `tags?`, `topK?` (1–24, default 12) |

- **`kb_search`** is BM25 over an in-memory index — no embedding model, no
  per-query model call, so it works offline and costs nothing per query. It is
  concurrency-safe. Each hit carries the document name, `docId`, section path,
  page, the LLM summary when present, entities, tags and a windowed snippet, so
  the model can cite a page and a section instead of a bare quote.
- **`kb_read_document`** reassembles a document's chunks in reading order under
  their section headings and pages on chunk boundaries, so a page boundary never
  lands inside a passage. The first page lists the document's section titles, so a
  2000-chunk manual can be opened without reading to the end.
- **`kb_ask`** runs retrieval and then one LLM call that cites the passages it
  used. It is deliberately *not* concurrency-safe, and its own description tells
  the model to prefer `kb_search` whenever a search can produce the exact
  evidence. It declines in-band when no LLM service is registered.
- A tool that cannot serve a call **answers in prose instead of throwing** — a
  transport error teaches the model nothing, while "use `kb_search` instead" tells
  it what to do next.
- A query that reads like a document title (`WebUI手册`) is matched against
  document *names* as well as passages, and the named document is appended to the
  result. Interrogatives and space-separated CJK veto that branch, so
  `IPS 的默认动作是什么` is treated as a question, not a title.
- An **unknown tag is reported, not ignored** — models invent plausible labels,
  and silently searching everything would look like the filter worked.

> **Tip.** The tool descriptions ask the model to search before answering
> questions about imported documents. If your host composes its own system
> prompt, you can reinforce that with a line like
> *"涉及已导入文档内容时，先调用 `kb_search` 取得原文依据再作答，并注明文档名与章节。"*

## Retrieval

`kb_search` and `POST /kb-api/search` share one BM25 ranking (`k1=1.2`,
`b=0.75`) over a token stream:

- **CJK-aware tokenisation** — a run of Han characters contributes both unigrams
  and adjacent bigrams, so `源NAT` matches `源 NAT` with no tokenizer dictionary.
  Latin runs (`vlan10`, `802.1q`, `egress`) stay whole.
- **Field weighting** — title ×3, LLM summary ×2, body capped at 400 tokens,
  entities 24 — so a hit in a heading outranks one buried in prose.
- **Index lifetime** — built once from the persisted index at startup, refreshed
  per document when its chunks are written (not on every intermediate tick, so
  parsing never stalls the event loop), and a deleted document is dropped
  immediately, so a tool call can never cite a document you removed.
- **Narrowing** — `docId` restricts to one document, `tags` to the documents
  carrying any of the given labels.

The same endpoint is available for scripts:

```sh
curl -s -X POST http://127.0.0.1:18771/kb-api/search \
  -H 'content-type: application/json' \
  -d '{"query":"源 NAT 怎么配置","topK":5}'
```

Response: `{ok, query, count, indexedDocs, indexedChunks, hits, markdown}` —
`hits` for programmatic use, `markdown` is exactly what the model sees.

## Requirements

- Node 22+ (the host runtime).
- A DeepSeek Harness profile (web, desktop or headless). The plugin is loaded by
  the profile's `cordis.patch.yml`; the `llm` and `tools` host services are
  optional — without them the plugin still parses, exports and serves its API, and
  the LLM-dependent parts degrade with an explanation rather than failing.

## Install

```sh
git clone <this-repo> dsh-llm-wiki-knowledge
cd dsh-llm-wiki-knowledge
pnpm install
pnpm run build          # esbuild dual bundle -> dist/index.mjs + dist/client.js
```

Then add the built directory to a profile. With a DSH CLI that supports plugin
management:

```sh
dsh plugin --profile web add .
```

or by hand, in `~/.dsh/profiles/web/cordis.patch.yml` (on Windows,
`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`), as a top-level array entry
(the file's format — patch rows, not a `plugins:` key — is the same in every
profile):

```yaml
- id: dsh-llm-wiki-knowledge
  disabled: false
  config:
    dataDir: ''
    apiPort: 18771
    llmBackend: auto
```

Finally **fully quit and restart the Web Harness** — the host caches ES modules, so
a rebuilt `dist/` is only picked up on a fresh process. A "知识库" button then
appears in the sidebar panel list. The first upload creates the data directory
`<profile data dir>/kb` (override with `dataDir`).

> The `id` is the package name, so it follows any rename of this plugin. The
> `cordis.patch.yml` shipped *inside* the package declares only a subset of the
> keys; see [Configuration](#configuration) for the full set.

## Configuration

Every key below is a real field of the plugin's `Config` interface. Edit the
plugin row in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-llm-wiki-knowledge
  config:
    dataDir: ''                  # empty -> <profile data dir>/kb
    apiPort: 18771               # loopback port the plugin self-hosts /kb-api
    llmBackend: auto             # auto | dsh | api-key
    llmProvider: workbuddy       # provider route inside the host llm service
    llmModel: glm-5.3-flash      # model id for that route
    maxConcurrent: 2             # documents parsed or enriched at once
    maxEnrichChunks: 400         # chunks per enrichment BATCH (not a cap; 0 = one batch)
    enrichConcurrency: 4         # concurrent enrichment requests per batch (1-8)
    deepseekApiKey: ''           # api-key backend / fallback
    deepseekBaseUrl: 'https://api.deepseek.com'
    deepseekModel: 'deepseek-chat'
```

- `dataDir` resolution order: explicit config → `DSH_KB_DATA_DIR` env var →
  `<profile data dir>/kb` → `~/.dsh/dsh-knowledge-base`.
- `llmBackend: auto` prefers the host's own `llm` service (so enrichment uses the
  same model as your chat, no API key needed) and falls back to the API-key path.
- `maxEnrichChunks` is the **per-batch size, not a cap**: a 2500-chunk manual runs
  7 batches of 400 back to back. A larger value spends a bigger slice of work if
  you hit 停止; a smaller one resumes more often, more safely.
- `enrichConcurrency` is the throughput dial, shared with the parse queue so a
  bulk run cannot open dozens of provider streams at once.
- **dsh patch rows replace config wholesale** — restate every key you care about.
  Values saved from the 设置 tab land in `<dataDir>/settings.json` and take
  precedence over this config from then on.
- Re-running 增强 is incremental *by construction*: the loop only enqueues chunks
  that lack a summary, so enhancing a finished document costs nothing, and a
  second click while the run is queued is refused rather than billed twice.
- If a whole batch comes back with zero successes (provider down, key rejected),
  the run stops with `第 N 批 LLM 增强全部失败…` instead of retrying the same
  doomed batch forever.

## API

The plugin self-hosts a loopback HTTP API on `apiPort` (bound to `127.0.0.1`,
CORS enabled) and additionally registers its `/kb-api` prefix with the host
`webServer` service when that service exists. Both halves of the plugin therefore
reach the same handler.

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/kb-api/docs` | Document list (`outline` stripped to `outlineEntries`), plus `folders` and `pendingEnrich`. |
| GET | `/kb-api/doc/:id` | One document plus its chunks. |
| GET | `/kb-api/doc/:id/read` | One page of reassembled text (`?page=&pageSize=`) — what `kb_read_document` returns. |
| GET | `/kb-api/doc/:id/md`, `/mindmap` | Rendered Markdown / mind map, rebuilt on demand. |
| GET | `/kb-api/folders` | Every folder with its `path` and live `docCount`, plus `rootDocCount`. |
| GET | `/kb-api/graph` | Document ↔ entity graph (capped). |
| GET | `/kb-api/status` | Queue depth, backend, `indexedDocs`/`indexedChunks`, `resumedDocs`. |
| GET | `/kb-api/settings` | Settings, providers, models, backend. |
| POST | `/kb-api/upload` | `multipart/form-data` upload; optional `folderId`. Queues **extraction only**. |
| POST | `/kb-api/parse/:id` | (Re)queue extraction — free, local, keeps every summary on disk. |
| POST | `/kb-api/enrich/:id` | Start LLM enhancement for one document; auto-batches until done. Re-posting is refused. |
| POST | `/kb-api/enrich-all` | Batch enhancement; optional `{docIds:[…]}` restricts the scope. |
| POST | `/kb-api/cancel/:id` | Stop a queued/running parse or enhancement, keeping finished work. |
| POST | `/kb-api/folder` | Create a folder (`{name, parentId?, id?}`). |
| POST | `/kb-api/folder/:id` | Rename and/or move a folder. |
| POST | `/kb-api/doc/:id/folder` | File a document into a folder (`{folderId}`; `''` = root). |
| POST | `/kb-api/search` | BM25 retrieval — see [Retrieval](#retrieval). |
| POST | `/kb-api/tags/:id` | Replace a document's labels. |
| POST | `/kb-api/export/:id` | Rewrite the `.md` / `.mindmap.md` files. |
| POST | `/kb-api/settings` | Persist and hot-apply settings. |
| DELETE | `/kb-api/doc/:id` | Delete document, exports, and its index entries. |
| DELETE | `/kb-api/folder/:id` | Delete a folder and its subtree; its documents are hoisted to the parent (never deleted). |

## Architecture

Pure plugin, no fork of the harness core. Two halves:

| Half | File | Responsibility |
|------|------|----------------|
| Host (Node) | `dist/index.mjs` ← `src/index.ts` | Mounts `/kb-api/*` routes, runs the parse pipeline, persists a JSON store, owns the retrieval index, registers the tools. |
| Client (browser) | `dist/client.js` ← `src/client.tsx` | `sidebar.panellist` icon + `main` panel; talks to `/kb-api` via `fetch`. |

The browser half talks to the host half over that loopback API (CORS is enabled
there), so the plugin works whether or not the host exposes a `webServer` service.
`react`, `react-dom` and `react/jsx-runtime` are provided by the harness at
runtime; the shipped bundle has no runtime dependencies beyond the `pdfjs-dist`,
`markmap-lib` and `markmap-view` packages bundled into it.

```
upload ─▶ host stores raw bytes ─▶ ParseRunner.enqueue ─▶ runOne        (free)
                                       ├─ extractText (by mime / content sniffing)
                                       ├─ section-aligned chunking
                                       └─ extractEntities (local heuristics)
                                                     └─▶ JSON store, done@100

增强 / 批量增强 ─▶ ParseRunner.enrich ─▶ runEnrich                        (paid)
                                       ├─ selectEnrichTargets (section-aware batch)
                                       └─ enrichChunk × batchSize, loop until done
                                    ┌─────────────────────────────────────┘
                                    ├─▶ JSON store (docs + chunks + folders),
                                    │   flushed every ~20 s while running
                                    ├─▶ BM25 retrieval index (src/retrieve.ts)
                                    └─▶ graph ─▶ md + mindmap exports
```

Extraction and enrichment are separate queue items, which is what lets a resume
tell them apart: no chunks on disk means extraction was interrupted, chunks on
disk means enrichment was.

### Files

| File | Responsibility |
|------|----------------|
| `src/index.ts` | Activation, config, HTTP routes, tool registration, index lifecycle. |
| `src/parse-runner.ts` | The two-phase pipeline (`runOne` extracts, `runEnrich` buys LLM summaries batch by batch). Progress, cancellation and incremental persistence live here. |
| `src/parser.ts` | Text extraction + section-aligned chunking. |
| `src/outline.ts` | PDF-bookmark / heading outline → section tree for the mind map. |
| `src/pdf-extract.ts` | pdfjs text + bookmark extraction. |
| `src/retrieve.ts` | BM25 retrieval index and hit formatting. |
| `src/kb-search-tool.ts` | The four `kb_*` tool definitions and their renderers. |
| `src/kb-docs.ts` | Document projection for the tools: list rows, chunk→section reassembly, paging. |
| `src/kb-ask.ts` | `kb_ask` — passage construction, the citation prompt, answer shaping. |
| `src/doc-export.ts` | Markdown + mind-map rendering. |
| `src/store.ts` | JSON store (`docs` / `chunks` / `folders`), atomic writes, the folder tree, `pendingEnhance` accounting, graph derivation. |
| `src/dsh-llm.ts` | Host `llm` service adapter. |
| `src/deepseek.ts` | DeepSeek API-key adapter. |

### Data directory

```
<dataDir>/
  index.json          — { docs, chunks, folders }
  docs/<id>.bin       — original uploaded bytes (kept for re-parse / preview)
  md/<name>.md        — exported Markdown
  md/<name>.mindmap.md — exported mind map
  settings.json       — settings saved from the 设置 tab
```

The store writes `index.json` via a temp file + rename. On Windows a rename over a
file another process has open can fail with `EPERM`, so the write falls back to a
direct write; a lost index costs summaries, not documents.

## Troubleshooting

- **The 知识库 entry does not appear.** The client half is loaded by the profile
  via `cordis.patch.yml` and the host half must have been built (`pnpm run build`).
  Fully quit and restart the harness — the host caches ES modules, so a rebuilt
  bundle is only picked up on a fresh process.
- **The tools are not offered to the model.** The tools are acquired reactively
  through `ctx.inject(['tools'], …)`; a host without a tool registry simply never
  provides them. Check `GET /kb-api/status` that the plugin is serving, and
  confirm the harness was restarted after the last build.
- **The assistant answered without searching.** Tool *descriptions* ask the model
  to search first, but a host that composes its own system prompt may override
  that. Add an explicit line to your system prompt (see the tip under
  [Tools](#tools)) or ask the assistant to `kb_search` explicitly.
- **A document shows no mind map / `未找到文档目录`.** The PDF carries no
  bookmarks and no numbered heading lines were found. The plugin says so rather
  than inventing a structure; re-upload a PDF with an outline for a full tree.
- **A long parse stopped at 2%.** A batch that returns zero successes trips a
  breaker and writes `第 N 批 LLM 增强全部失败`. Press 增强 again once the provider
  is back — it resumes from the summaries already on disk.
- **Chinese text in an uploaded PDF came out garbled.** The plugin bundles
  pdfjs-dist for PDF text and does not scrape raw PDF streams, so this should not
  happen; if it does, re-upload — a document whose extraction produced `warning`
  is flagged in the document detail view.
- **`index.json` grows large.** A 2500-chunk manual produces a multi-megabyte
  index; the retrieval index is in memory and rebuilt at startup. This is
  expected, not a leak.

## Notes

- The plugin is additive: it uses the `sidebar.panellist` and `main` slots, so it
  never shadows the shipped sidebar UI.
- Host services (`llm`, `tools`) are acquired through `ctx.inject`, never by a
  bare read — under the cordis context proxy a bare read of a service that is not
  in the fiber's inject set throws `cannot get property "llm" without inject`.
  `export const inject` stays empty so the plugin still loads in headless profiles
  that have no agent runtime.
- The `kb_*` tools are defined locally rather than imported from
  `@deepseek-ai/dsh-tools`: in the host that package's `defineTool` is the
  identity function (all validation happens in the registry) and it ships no type
  declarations. Bad arguments degrade to defaults (`topK: "x"` → the default)
  rather than failing the call; only a missing required argument is reported, and
  it is reported in the tool's own text, naming the parameter.
- **The package was renamed to `dsh-llm-wiki-knowledge`, the data directory was
  not.** Everything the host keys on follows the package name (the
  `cordis.patch.yml` id, the bundle entry, `export const name` in both halves,
  the client `PANEL_ID`) so a rename is a host-visible change needing a full
  restart. The data directory keeps the old name on purpose: it is where every
  imported document lives, and pointing a renamed plugin at a fresh directory
  makes an existing corpus look deleted.
- `pendingEnhance` is derived, never hand-written: the store recomputes it on the
  only two entry points that touch a chunk array and *deletes* the field when it
  reaches 0, so a never-enhanced document's JSON stays byte-identical to what
  older builds wrote.

## License

MIT
