# dsh-llm-wiki-knowledge

[English](README.md) | **中文** | [开发笔记 / development notes](docs/development-notes.md)

把 PDF、Word、Markdown、HTML 和纯文本变成一个**本地可检索的知识库**，并同时给
助手注册四个工具，让它在正常对话里就能引用你导入的文档。

整个流水线是：

```
上传 → 本地抽取 → 按文档真实目录切块 → 实体与关联
     → （可选，你手动触发）LLM 增强 → 落盘并建立 BM25 索引
     → 导出 Markdown 与 markmap 知识脑图
```

**抽取和实体识别完全免费、离线。** LLM 增强是独立的一步，只有你点了按钮才会跑，
而且分批执行、批大小由你控制。

## 能力一览

- **侧边栏知识库** — 侧边栏面板列表里（排在「自动化任务」之后）出现一个「知识库」
  条目，点开是四个标签页：文档 / 知识脑图 / 知识图谱 / 设置。
- **上传** — 点击或拖拽：`txt`、`md`、`pdf`、`docx`、`html`、`csv`、`json`。
- **本地优先解析** — 文本抽取、按章节对齐切块、实体与交叉引用全部用启发式规则
  完成，**不需要任何 API key**。上传后几秒内文档就可浏览。
- **两阶段，只有第二阶段花钱** — 上传只做抽取。增强（每块的摘要、更丰富的实体和相关
  概念）必须显式触发，可以单篇也可以批量。不点「增强 / 批量增强」就不会产生费用。
- **自动分批增强** — 点一次即增强**整篇**文档。运行器按批推进（`每批增强片段数`，
  默认 400），直到每个块都带摘要，中途不需要再点「继续」。选块是**按章节感知**的，
  所以第一轮会给每章都安排上，而不是把前几章刷深。
- **解析可断点续跑** — 已完成的块每 ~20 秒落盘一次。宿主崩溃或被关闭最多损失一个落盘
  周期；下次启动时，所有仍处于 排队/抽取/解析/增强/索引 中 的文档会自动重新入队，
  而且只为**缺失的**摘要付费。
- **「停止」是真取消** — 停止按钮会真的 abort 排队中或运行中的解析/增强，已经完成的块
  和摘要全部保留（状态变为 `已停止`），之后点「增强」从这里接着跑。
- **按真实目录组织结构** — Markdown 导出和知识脑图跟随文档自己的目录，而不是按字符数
  硬切。优先用 PDF 书签（`getOutline()`），其次 Markdown 的 ATX 标题，最后是带编号的
  文本标题；完全找不到目录时，插件会明说并降级为「按标题行归并」，不会编造结构。
- **Markdown + 知识脑图导出** — 每篇文档另外写出 `<dataDir>/md/<name>.md`（可预览、
  可下载）和 `<name>.mindmap.md`，在「知识脑图」标签页里用 markmap 实时渲染，支持
  缩放 / 拖拽 / 折叠。
- **文件夹** — 文档可以放进最多 5 层的可嵌套文件夹树。支持新建、重命名、移动、删除，
  也可以把上传的文件直接丢进某个文件夹。文件夹只是元数据，**删文件夹绝不会删文档** ——
  其下文档会上移到被删文件夹的父级。
- **文档标签** — 每篇文档可加自由标签（`命令行`、`安全策略` 等）。从「标签」按钮
  分配，点标签过滤列表，或把 `tags` 传给 `kb_search` 让助手只回答某个主题。
- **知识图谱** — 文档 ↔ 实体的关系图，用内联 SVG 绘制（不依赖任何外部图库）。
- **实时进度** — 列表展示 排队 → 抽取 → 解析 → 待增强 → 增强 → 索引 → 完成，
  带进度条和分步状态。
- **设置标签页** — LLM 开关、provider 与模型、每批大小、并发数、API 端口，持久化到
  `<dataDir>/settings.json`，改完即时生效，不需要重启。

## 工具

插件会在宿主的工具注册表上注册四个工具，让助手自己检索你导入的文档，而不用你另开
终端跑脚本。每个工具都是独立的 effect，卸载插件时四个一起撤回，无需重启。

| 工具 | 回答什么 | 参数 |
|------|----------|------|
| `kb_list_documents` | 「知识库里有哪些资料」 | `nameLike?`、`tag?`、`limit?`（1–100，默认 20） |
| `kb_search` | 「这句话在哪」 | `query`（必填）、`topK?`（1–12，默认 5）、`docId?`、`tags?` |
| `kb_read_document` | 「这段前后文是什么」 | `docId`（必填）、`page?`、`pageSize?`（1–40，默认 8） |
| `kb_ask` | 「帮我综合成一段话」 | `query`（必填）、`docId?`、`tags?`、`topK?`（1–24，默认 12） |

- **`kb_search`** 跑的是内存索引上的 BM25 —— 不用嵌入模型，也不做逐查询模型调用，
  所以完全离线、每次查询零成本，且是并发安全的。每条命中都带文档名、`docId`、章节
  路径、页码、有则附 LLM 摘要、实体、标签和一段定窗摘录，模型因此能引用「哪本书的
  哪一章第几页」，而不是甩一句孤零零的原文。
- **`kb_read_document`** 按阅读顺序把文档的块重新拼到各自的章节标题和页码之下，且
  切分只发生在块边界上，所以分页永远不会把一段话拦腰截断。第一页先列出该文档的
  章节标题，于是 2000 块的手册不用读到末尾就能定位。
- **`kb_ask`** 先检索、再用一次 LLM 调用基于检索到的段落作答并给出引用。它**刻意
  不是**并发安全的，而且它自己的描述里就写明：只要 `kb_search` 能拿到确切依据，就
  优先用 `kb_search`。宿主没有注册 LLM 服务时，它会就地降级说明。
- 工具**无法完成时用文字回答，而不是抛异常** —— 传输错误教不会模型任何东西，而
  「改用 `kb_search`」能告诉它下一步该做什么。
- 读起来像文档名的查询（例如 `WebUI手册`）会**同时匹配文档名**并把该文档追加到结果
  末尾；而疑问句和带空格的中文会否决这一分支，所以 `IPS 的默认动作是什么` 会被当成
  提问，而不是标题。
- **不认识的标签会被明确报出来，而不是被忽略** —— 模型很容易编出看起来合理的标签，
  静默退化成「搜全部」会让人误以为过滤生效了。

> **提示。** 工具描述里已经要求模型在回答已导入文档的问题前先检索。但如果你的宿主
> 自己拼装 system prompt，可以再加一句来强化：
> *「涉及已导入文档内容时，先调用 `kb_search` 取得原文依据再作答，并注明文档名与章节。」*

## 检索

`kb_search` 与 `POST /kb-api/search` 共用同一套 BM25 排序（`k1=1.2`、`b=0.75`），
作用在这样一份词流上：

- **CJK 感知分词** —— 一串汉字同时产出单字和相邻二元组，所以 `源NAT` 能匹配 `源 NAT`，
  不需要任何词典。拉丁词（`vlan10`、`802.1q`、`egress`）保持完整。
- **字段加权** —— 标题 ×3、LLM 摘要 ×2、正文最多取 400 个 token、实体 24 个，
  因此命中标题的结果排在埋在正文里的结果前面。
- **索引生命周期** —— 启动时从持久化索引建一次；某篇文档的块**写完时**才刷新该文档
  （不是在每个中间 tick 上刷新，这样解析过程不会卡住事件循环）；文档被删除则立即
  移除，所以工具调用绝不会引用到你已经删掉的内容。
- **收窄** —— `docId` 限定单篇文档，`tags` 限定带这些标签的文档。

同一个接口也可以直接给脚本用：

```sh
curl -s -X POST http://127.0.0.1:18771/kb-api/search \
  -H 'content-type: application/json' \
  -d '{"query":"源 NAT 怎么配置","topK":5}'
```

响应：`{ok, query, count, indexedDocs, indexedChunks, hits, markdown}` ——
`hits` 供程序使用，`markdown` 就是模型看到的内容。

## 环境要求

- Node 22+（宿主运行时）。
- 一个 DeepSeek Harness profile（web / desktop / headless 均可）。插件由 profile 的
  `cordis.patch.yml` 加载；`llm` 与 `tools` 两个宿主服务是**可选的** —— 没有它们时
  插件照样能解析、导出并提供服务，依赖 LLM 的部分会带说明地降级，而不是直接失败。

## 安装

```sh
git clone <this-repo> dsh-llm-wiki-knowledge
cd dsh-llm-wiki-knowledge
pnpm install
pnpm run build          # esbuild 双产物 -> dist/index.mjs + dist/client.js
```

然后把构建好的目录加进某个 profile。如果你的 DSH CLI 支持插件管理：

```sh
dsh plugin --profile web add .
```

也可以手改 `~/.dsh/profiles/web/cordis.patch.yml`（Windows 上是
`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`），写成顶层数组元素
（各 profile 的文件格式一致，是 patch 行而非 `plugins:` 键）：

```yaml
- id: dsh-llm-wiki-knowledge
  disabled: false
  config:
    dataDir: ''
    apiPort: 18771
    llmBackend: auto
```

最后**彻底退出并重启 Web Harness** —— 宿主会缓存 ES 模块，重新构建出来的 `dist/`
只有在新进程里才会生效。之后侧边栏面板列表里就会出现「知识库」。第一次上传会创建数据
目录 `<profile data dir>/kb`（可用 `dataDir` 覆盖）。

> 这里的 `id` 就是包名，所以会跟着插件改名一起变。包内的 `cordis.patch.yml` 只声明了
> 一部分配置键，完整列表见 [配置](#配置)。

## 配置

下面每个键都是插件 `Config` 接口里的真实字段。改 profile 的 `cordis.patch.yml` 中
属于本插件的那一行：

```yaml
- id: dsh-llm-wiki-knowledge
  config:
    dataDir: ''                  # 留空 -> <profile data dir>/kb
    apiPort: 18771               # 插件自托管 /kb-api 的回环端口
    llmBackend: auto             # auto | dsh | api-key
    llmProvider: workbuddy       # 宿主 llm 服务内部的 provider 路由
    llmModel: glm-5.3-flash      # 该路由下的模型 id
    maxConcurrent: 2             # 同时解析/增强的文档数
    maxEnrichChunks: 400         # 每批增强的块数（不是上限；0 = 一批跑完）
    enrichConcurrency: 4         # 每批并发的增强请求数（1-8）
    apiTokenEnabled: true        # 每个 /kb-api 路由都要带 X-KB-Token
    deepseekApiKey: ''           # api-key 后端 / 兜底
    deepseekBaseUrl: 'https://api.deepseek.com'
    deepseekModel: 'deepseek-chat'
```

- `dataDir` 解析顺序：显式配置 → `DSH_KB_DATA_DIR` 环境变量 → `<profile data dir>/kb`
  → `~/.dsh/dsh-knowledge-base`。
- `llmBackend: auto` 优先用宿主自己的 `llm` 服务（于是增强和你聊天用的是同一个模型，
  不需要 API key），不可用时才回落到 API key 通道。
- `maxEnrichChunks` 是**每批大小，不是总量上限**：2500 块的手册会连着跑 7 批 400。
  这个值越大，一旦点「停止」已经花掉的钱越多；越小则续跑更频繁、也更稳。
- `enrichConcurrency` 是吞吐旋钮，与解析队列共用，因此批量增强不会一次性打开几十条
  provider 流。
- **dsh 的 patch 行是整体替换 config 的** —— 你在意的每个键都要重写一遍。设置标签页
  保存的值会写进 `<dataDir>/settings.json`，从那以后优先于这里的配置。
- 重复点「增强」在实现上就是**增量的**：循环只把没有摘要的块入队，所以给一篇已完成的
  文档再点一次不花钱；运行中再点第二次会被直接拒绝，不会重复计费。
- 如果某一批全部返回失败（provider 挂了、key 被拒），运行会停下并写入
  `第 N 批 LLM 增强全部失败…`，而不是把同一批 doomed 的任务无限重试。

### 访问令牌

回环 API 虽然跑在你自己的机器上，但**你访问的任何一个网页**都能从浏览器里
`127.0.0.1:18771`。所以插件不用「地址是本机就信」，而是加了一层令牌：

- **默认开启。** 第一次启动时自动生成一个 192 位令牌，以明文存在
  `<dataDir>/settings.json` 里，和你其它设置放在一起。
- **所有功能性 `/kb-api` 路由都要带它** —— 文档、文件夹、检索、图谱、状态、设置、
  上传、增强、删除。请求头写 `X-KB-Token: <token>`，缺失或不符返回
  `401 缺少或无效的知识库访问令牌（X-KB-Token）`。
- **只有两个路由故意不设防**：`OPTIONS`（浏览器预检必须先通，才能发带令牌的请求）
  和 `GET /kb-api/_session`（面板自己用来取令牌的引导接口）。
- **`_session` 不会把令牌交给随便一个网站。** 只有请求来自本机时才返回令牌 ——
  没有 `Origin` 头，或者 `Origin` 是回环地址（`localhost` / `127.0.0.1` / `::1` /
  `*.localhost`）。来自 `https://随便什么.example` 的请求只会拿到
  `{"ok":true,"enabled":true,"token":"","local":false}`：足够知道「有防护」，
  但不够闯进去。从非回环地址提供的面板因此需要你手动粘贴令牌，而不是默默信任来源。
- **设置标签页有「访问令牌」卡片**：开关防护、显示/复制令牌、重新生成。重新生成
  会立刻作废旧令牌；还开着的面板会自己重新读取并连上。
- **手动粘贴的令牌优先**于引导拿到的，并且以 `dsh-kb-token` 为键存在 `localStorage`，
  这样局域网访问的面板也能继续用。
- **Agent 工具不受影响。** `kb_search`、`kb_ask`、`kb_list_documents`、
  `kb_read_document` 是在进程内直接访问存储，不走 HTTP，因此不需要令牌。
- **下载链接带 `?token=`。** 浏览器不允许给普通链接或 `<img src>` 附加自定义头，
  所以 Markdown 和脑图的导出/下载链接把令牌放进查询串。它会出现在浏览器历史和
  本地日志里 —— 对一个回环令牌来说可以接受，这也正是它属于「每台机器自己生成、
  随时可以轮换」的私密值。

## HTTP API

插件在 `apiPort` 上自托管一个回环 HTTP API（绑定 `127.0.0.1`，开启 CORS），
同时在宿主提供 `webServer` 服务时把 `/kb-api` 前缀也注册进去，因此两条路都通向
同一个 handler。

认证：除 `OPTIONS` 和 `GET /_session` 外，下表每条路由在「访问令牌」开启时都需要
`X-KB-Token`（链接用 `?token=`），见[访问令牌](#访问令牌)。

| 方法 | 路由 | 用途 |
|------|------|------|
| GET | `/kb-api/docs` | 文档列表（`outline` 被裁成 `outlineEntries`），附带 `folders` 与 `pendingEnhance`。 |
| GET | `/kb-api/doc/:id` | 单篇文档及其全部块。 |
| GET | `/kb-api/doc/:id/read` | 重新拼接后的正文一页（`?page=&pageSize=`）—— 即 `kb_read_document` 的返回。 |
| GET | `/kb-api/doc/:id/md`、`/mindmap` | 按需重新渲染的 Markdown / 知识脑图。 |
| GET | `/kb-api/folders` | 所有文件夹，带 `path` 和实时 `docCount`，外加 `rootDocCount`。 |
| GET | `/kb-api/graph` | 文档 ↔ 实体关系图（有上限）。 |
| GET | `/kb-api/status` | 队列深度、后端、`indexedDocs`/`indexedChunks`、`resumedDocs`。 |
| GET | `/kb-api/settings` | 设置、provider、模型、后端。 |
| GET | `/kb-api/_session` | 面板的免鉴权引导接口：`{enabled, token, local}`，`token` 只发给本机调用方。 |
| POST | `/kb-api/upload` | `multipart/form-data` 上传，可选 `folderId`。**只入队抽取。** |
| POST | `/kb-api/parse/:id` | （重新）入队抽取 —— 免费、本地，磁盘上的摘要全部保留。 |
| POST | `/kb-api/enrich/:id` | 对单篇文档开始 LLM 增强，自动分批直到完成；重复提交会被拒绝。 |
| POST | `/kb-api/enrich-all` | 批量增强，可选 `{docIds:[…]}` 限定范围。 |
| POST | `/kb-api/cancel/:id` | 停止排队中/运行中的解析或增强，保留已完成的工作。 |
| POST | `/kb-api/folder` | 新建文件夹（`{name, parentId?, id?}`）。 |
| POST | `/kb-api/folder/:id` | 重命名和/或移动文件夹。 |
| POST | `/kb-api/doc/:id/folder` | 把文档归档到某个文件夹（`{folderId}`；`''` 表示根）。 |
| POST | `/kb-api/search` | BM25 检索，见 [检索](#检索)。 |
| POST | `/kb-api/tags/:id` | 整体替换某篇文档的标签。 |
| POST | `/kb-api/export/:id` | 重写 `.md` / `.mindmap.md` 文件。 |
| POST | `/kb-api/settings` | 持久化设置并热生效。 |
| DELETE | `/kb-api/doc/:id` | 删除文档、导出文件及其索引条目。 |
| DELETE | `/kb-api/folder/:id` | 删除文件夹及其子树；其中的文档上移到父级（**绝不删除**）。 |

## 知识图谱

「知识图谱」标签页用纯内联 SVG 画文档 ↔ 实体的关系图 —— 没有图库、没有布局引擎、
没有力导向。这是刻意的选择：`src/store.ts` 里的推导把语料上限压在 600 节点 / 4000 条边，
而 StoneOS 级别的知识库确实会撞到这个天花板。

在这个规模下，天真的力导向布局就是一团实心绿饼 —— 600 个节点挤在一个圆环上间距
约 3 像素，标签互相压盖，4000 条弦填满所有空隙。所以画布画的是一份**可读的切片**，
并且明说它切了多少：

- **逻辑画布固定** 1000 × 720，再按实测容器缩放（`min(w/LW, h/LH) * 0.92`，
  resize 时重算），图不会塌成空白，也不会溢出容器。
- **文档在内圈**；**实体填同心环**（`RING_MIN = 0.22 · min(LW,LH)`、
  `RING_MAX = 0.46 · min(LW,LH)`、`RING_GAP = 26`、4 环，奇数环偏移半个槽位，
  免得辐条对齐）。环容量是**物理**算出来的：`floor(2πr / RING_GAP)`，
  即 38 + 52 + 66 + 80 = **236** —— 这是能诚实画下的最大实体数。
- **实体档位就是环容量，不是拍脑袋**：图例按钮循环 60 → 150 → 236。
  以前 300/600 那两档根本放不下，只会悄悄丢节点。
- **实体按加权度数排名**（降序，同度数时以名称稳定排序）。如果聚焦的实体不在当前
  档位里，它会顶替掉已选中最弱的那个，保证点搜索结果不会指向一个没画出来的节点。
- **边数按实体档位等比给预算**：`edgeCap = max(120, round(800 · entLimit / 236))`
  —— 60 实体约 203 条边，236 实体 800 条 —— 这样弦密度大致恒定，而不是把 4000 条
  全倒进一个小视图。优先保留权重最大的边。
- **标签**只画度数前 40 的实体加上当前激活的那个；实体名超过 14 字截断。
  文档始终带标签。
- **截断一定会被说明，不靠暗示。** 角落提示报出「已画 / 总数」，例如
  `显示 61/600 节点 · 203/4000 关系`；只要藏了东西，就补上隐藏规则：
  `按度数取前 60 实体（隐藏 539），边按权重取前 203`。
- **交互**：悬停或选中会高亮该节点及其一跳邻域、其余变暗；点文档打开它，点实体聚焦
  它；滚轮以光标为中心缩放（限制 0.2–6），拖拽平移；「适配」重算缩放，
  「刷新」重新推导整张图。

## 架构

纯插件，不 fork 宿主核心。分两半：

| 半边 | 产物 | 职责 |
|------|------|------|
| 宿主（Node） | `dist/index.mjs` ← `src/index.ts` | 挂载 `/kb-api/*` 路由、跑解析流水线、持久化 JSON 存储、持有检索索引、注册工具。 |
| 客户端（浏览器） | `dist/client.js` ← `src/client.tsx` | `sidebar.panellist` 图标 + `main` 面板；通过 `fetch` 访问 `/kb-api`。 |

浏览器那一半通过上面那个回环 API 与宿主通信（该 API 开启了 CORS），所以无论宿主是否
提供 `webServer` 服务插件都能工作。`react`、`react-dom`、`react/jsx-runtime` 由宿主在
运行时提供；发布产物除内联的 `pdfjs-dist`、`markmap-lib`、`markmap-view` 外没有其它
运行时依赖。

```
上传 ─▶ 宿主存原始字节 ─▶ ParseRunner.enqueue ─▶ runOne        （免费）
                                       ├─ extractText（按 mime / 内容嗅探）
                                       ├─ 按章节对齐切块
                                       └─ extractEntities（本地启发式）
                                                     └─▶ JSON 存储，done@100

增强 / 批量增强 ─▶ ParseRunner.enrich ─▶ runEnrich            （付费）
                                       ├─ selectEnrichTargets（按章节选批）
                                       └─ enrichChunk × 批大小，循环直到完成
                                    ┌──────────────────────────────────┐
                                    ├─▶ JSON 存储（docs + chunks + folders），
                                    │   运行期间每 ~20 秒落盘一次
                                    ├─▶ BM25 检索索引（src/retrieve.ts）
                                    └─▶ 关系图 ─▶ md + mindmap 导出
```

抽取与增强是两个独立的队列项，这正是续跑时能区分二者的原因：磁盘上没有块，说明抽取
被打断；有块，说明是增强被打断。

### 文件

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 激活、配置、HTTP 路由、工具注册、索引生命周期。 |
| `src/types.ts` | 共享类型：`KnowledgeDoc`、`WikiChunk`、`DocStatus`、`OutlineEntry` 等。 |
| `src/parse-runner.ts` | 两阶段流水线（`runOne` 负责抽取，`runEnrich` 分批购买 LLM 摘要）。进度、取消和增量落盘都在这里。 |
| `src/parser.ts` | 文本抽取 + 按章节对齐切块。 |
| `src/outline.ts` | PDF 书签 / 标题目录 → 知识脑图用的章节树。 |
| `src/pdf-extract.ts` | pdfjs 文本与书签抽取。 |
| `src/retrieve.ts` | BM25 检索索引与命中格式化。 |
| `src/kb-search-tool.ts` | 四个 `kb_*` 工具定义及其渲染函数。 |
| `src/kb-docs.ts` | 给工具用的文档投影：列表行、块→章节重组、分页。 |
| `src/kb-ask.ts` | `kb_ask` —— 段落构造、带引用的提示词、答案整形。 |
| `src/doc-export.ts` | Markdown 与知识脑图渲染。 |
| `src/store.ts` | JSON 存储（`docs` / `chunks` / `folders`）、原子写入、文件夹树、`pendingEnhance` 记账、关系图推导。 |
| `src/dsh-llm.ts` | 宿主 `llm` 服务适配器。 |
| `src/deepseek.ts` | DeepSeek API key 适配器。 |

### 数据目录

```
<dataDir>/
  index.json          — { docs, chunks, folders }
  docs/<id>.bin       — 原始上传字节（保留以便重解析 / 预览）
  md/<name>.md        — 导出的 Markdown
  md/<name>.mindmap.md — 导出的知识脑图
  settings.json       — 设置标签页保存的配置（含 apiToken）
```

存储层通过「临时文件 + rename」写 `index.json`。在 Windows 上，当目标文件被别的进程
打开时 rename 可能报 `EPERM`，此时会退化为直接写入；最坏情况丢的是摘要，不是文档。

## 故障排除

- **侧边栏没有出现「知识库」。** 客户端那一半要由 profile 通过 `cordis.patch.yml`
  加载，宿主那一半必须已构建（`pnpm run build`）。彻底退出并重启 Harness —— 宿主
  会缓存 ES 模块，重新构建的产物只在新进程里生效。
- **模型那边看不到这些工具。** 工具是通过 `ctx.inject(['tools'], …)` 响应式获取的；
  没有工具注册表的宿主自然不会提供它们。先用 `GET /kb-api/status` 确认插件在服务，
  再确认上次构建之后宿主确实重启过。
- **助手没检索就回答了。** 工具*描述*里要求模型先检索，但自组 system prompt 的宿主
  可能把这当成可选项。在你自己的 system prompt 里加一句（见
  [工具](#工具) 下的提示），或者直接要求助手显式调用 `kb_search`。
- **某篇文档没有脑图 / 显示 `未找到文档目录`。** 说明该 PDF 没有书签，也没找到带编号的
  标题行。插件会明说而不是编造结构；换一份带目录的 PDF 就能拿到完整树。
- **长文档解析停在 2%。** 某一批全部失败会触发熔断，写入 `第 N 批 LLM 增强全部失败`。
  等 provider 恢复后再点一次「增强」即可 —— 它会从磁盘上已有的摘要接着跑。
- **上传的 PDF 中文乱码。** 插件用内联的 pdfjs-dist 抽取 PDF 文本，不去刮原始 PDF 流，
  正常不应出现；万一出现请重新上传 —— 抽取时产生过 `warning` 的文档会在详情里标出。
- **你没在这里开的页面上冒出 `401 缺少或无效的知识库访问令牌`。** 面板的令牌是从
  `/_session` 引导的，而它只向本机调用方披露。从别的地址提供的面板（局域网上的手机、
  远程桌面主机）必须手动粘贴令牌，否则页面会被挡在门外，直到你在设置里
  「重新生成」。见[访问令牌](#访问令牌)。
- **面板能用，但下载 401 了。** `<a download>` 和 `<img src>` 没法带 `X-KB-Token`，
  所以导出链接改用 `?token=`。如果令牌在渲染和点击之间被轮换过，去设置里点一次
  「重新生成」，或者刷新页面让链接取到新令牌。
- **`index.json` 变得很大。** 2500 块的手册会产生数 MB 的索引；检索索引在内存里，
  启动时重建即可。这是预期行为，不是泄漏。

## 设计说明

- 插件是**增量式**的：使用 `sidebar.panellist` 与 `main` 两个槽位，不会覆盖宿主自带的
  侧边栏 UI。
- 宿主服务（`llm`、`tools`）一律通过 `ctx.inject` 获取，绝不裸读 —— 在 cordis 的
  context proxy 下，裸读不在本 fiber inject 集合里的服务会抛
  `cannot get property "llm" without inject`。`export const inject` 保持为空数组，
  这样在没有任何 agent 运行时的 headless profile 里插件也能加载。
- `kb_*` 工具是本地定义的，而不是从 `@deepseek-ai/dsh-tools` 导入：在宿主里那个包的
  `defineTool` 本身是恒等函数（所有校验都发生在注册表里），而且不提供类型声明。非法
  参数会退化为默认值（`topK: "x"` → 用默认值）而不是让调用失败；只有缺失必填参数才会
  报错，而且是在工具自己的输出文字里报错，并点名是哪个参数。
- **包名改成了 `dsh-llm-wiki-knowledge`，但数据目录没有改。** 宿主认的一切都跟着包名走
  （`cordis.patch.yml` 的 id、bundle 条目、两半的 `export const name`、客户端的
  `PANEL_ID`），所以改名是宿主可见的变更，必须完整重启。而数据目录故意保留旧名：
  那里装着你导入的所有文档，把改名后的插件指向一个全新目录会让已有语料「看起来像被
  删了」。
- `pendingEnhance` 是推导出来的，从不手写：存储层只在真正改动块数组的两个入口上重算
  它，并在归零时**删除**该字段，因此从未增强过的文档，其 JSON 与旧版本写下的完全一致。

## License

MIT
