# LoreDock 本机资料与模型服务

从项目根目录运行：

```powershell
./.venv/Scripts/python.exe -m pip install -r backend/requirements.txt
./.venv/Scripts/python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

健康检查：`http://127.0.0.1:8000/api/health`；接口文档：`http://127.0.0.1:8000/api/docs`。
开发时前端通过 Vite `/api` 代理访问后端；这里不会自动加载 `.env` 文件。可在启动前设置 PowerShell 环境变量，例如 `$env:LOREDOCK_CONTEXT_CHARS = '24000'`。

## 能力与边界

- 保存多个自定义服务的名称、Base URL、默认模型与 API Key。Base URL 填完整公共前缀，例如 `https://example.com/v1`；后端追加 `models` 或 `chat/completions`。产品页面不提供具名品牌预设。
- 密钥经 Windows DPAPI 加密后写入项目 `data/settings.sqlite3`，仅保存时的 Windows 账户能够正常解密；浏览器只取得掩码。改地址未重填密钥时清除旧密钥。非 Windows 机器明确拒绝密钥持久化，不能静默改为明文保存。
- “读取模型”只调用 `GET /models`，不自动生成测试回答。某些服务没有该接口时，可手动填写支持 Chat Completions 的文本模型 ID。
- 问答与卡片生成均可选填 `reasoning_effort`，取值 `low`／`medium`／`high`／`xhigh`；前端对应“低／中／高／极高”。“模型默认”省略该字段，不发送 `default` 字符串。默认不会给原有兼容服务增加请求参数；显式选择时通过 Chat Completions 顶层字段透传，不发送 `temperature`。当前滑轨只提供这四档，不等于覆盖接口的所有可能取值。
- 本机资料保存在 `data/library.sqlite3`，包含空间名、文档元数据、版本、正文和 SQLite FTS5 分块索引；每个版本另有 `data/uploads/` 下的不可变 UTF-8 副本。正文按围栏外章节分块，每块最多 1600 字符，优先在换行处分开；标题路径与原文字符范围随引用返回。
- 关键词检索支持英文术语和中文双字词，使用 FTS5 排序并保守筛选相关结果，不调用外部模型、不下载 Embedding。普通检索最多 8 个片段、12000 字符；问答开启资料参考后同为最多 8 个片段，默认上下文上限 24000 字符。这是词法匹配，不提供语义置信度。
- 当前 UI 调用 `/api/chat` 时显式发送 `answer_mode: "assistant"`，默认 `retrieval_mode: "none"`。只发送问题、同范围／模式历史；无来源仍调用模型，允许一般知识回答。开启资料参考后才用下述 `indexed`／`snapshot`。兼容旧客户端的默认 `grounded` 严格模式仍保留。
- 相关知识卡片完全由前端本地匹配，仅作为回答下方的可点击入口；当前请求不发送 `cards`。后端兼容接收旧 `cards` 字段但忽略其内容，不向模型转发，不影响文档检索；兼容响应 `matched_cards` 为空。普通 AI 仍校验文档来源 ID。旧版卡片依据历史由新版上下文标识隔离，不继续送入模型历史。
- 开启文档参考时，独立空间问答先经 `/api/library/documents/{id}` 同步当前可读资料，再以 `retrieval_mode: "indexed"` 和 `document_versions` 提交版本白名单；`documents` 必须为空。后端在同一读取事务中校验版本、空间与可选文档范围，再检索有效版本。没有命中时，普通 AI 仍可直接回答。
- 阅读器显式开启“参考本文”时，先保存当前文档的本机副本，再用 `snapshot` 模式提交该文档正文：短文使用全文，长文按默认 24000 字符预算选片段。历史引用参考也使用 `snapshot`，但只提交历史摘录、不保存本机副本，因此不会把旧摘录覆盖到当前资料或索引。普通聊天不受文档保存状态阻塞。
- 阅读选文使用独立 `reading_selection`，在 `assistant` 模式下可与 `retrieval_mode: "none"` 共用，无需全文同步。字段为 `documentId`、`spaceId`、`version`、`title`、`heading`、`text`（最多 2000 字符）、`context`（最多 5000 字符）、`isDraft`、`isHistorical`、`truncated`；必须匹配本轮 `document_id` 与 `scope_ids`。选文及附近原文作为 JSON 编码的用户参考数据进入模型，不是系统命令、不代表读取全文、不生成虚构引用 ID。完整文档参考仍由原有开关控制。前端在用户历史消息中保存快照，追问按原有历史预算带入。
- 单份资料最多 20 MiB，请求体最多 24 MiB；单次版本白名单最多 500 份，问题最多 4000 字符。历史快照模式的全部正文总量也限 20 MiB。未设置超时时，模型生成总超时为默认／低／中 60 秒、高 180 秒、极高 300 秒；显式设置 `LOREDOCK_MODEL_TIMEOUT`（1–300 秒）后所有档位遵从该值。`LOREDOCK_CONTEXT_CHARS` 可调整上下文预算（3200–120000 字符）。
- 只把模型实际声明且属于本轮上下文的片段列为引用；保留原文版本和摘录。无效标识剔除后提示无法核验。标识有效仍不证明语义支持结论，需要人工对照。
- 模型调用不会执行资料中的工具或命令；HTTP 禁止跟随重定向，错误不回显上游响应或密钥。浏览器取消请求后尝试取消后端连接，但已由服务商受理的计算不保证停止计费。
- 编辑正文、未保存草稿、卡片和会话继续由浏览器 IndexedDB 管理；后端保存明确同步的正文版本。本机副本不是完整工作区备份，也没有实现恢复界面。
- 这是本机单用户服务，`session_id` 和空间过滤不是多租户身份授权；没有公网登录或账号隔离，不能直接暴露到公网。未实现其他原生模型协议、流式输出、Embedding／Chroma 或完整应用备份恢复。真实服务生成质量与大规模性能仍需独立验证。

## 粘贴内容及阅读片段生成卡片

`POST /api/cards/generate` 复用已配置服务的 Chat Completions 文本协议和加密密钥，基于显式提交的粘贴内容或阅读片段生成普通卡片草稿，不检索资料库、不读取会话、不保存卡片或建立索引。阅读整篇时由前端将完整快照逐章节分批（每批最多 12000 字符）提交，保留所有原文。

```json
{
  "session_id": "card-dialog-session",
  "request_id": "unique-generation-request",
  "provider_id": "your-saved-provider-id",
  "model": "your-model-id",
  "text": "json.loads 解析 JSON 字符串；json.load 读取文件对象。",
  "count": 2,
  "instructions": "比较区别"
}
```

`text` 非空且最多 24,000 字符，`count` 为 1–8 的整数、默认 3，`instructions` 选填且最多 500 字符。完整粘贴内容按 1600 字符划成 P1、P2 等片段传给模型，不静默截断。服务默认发送基础 `model`、`messages`、`stream: false`，显式选择思考档位时另发 `reasoning_effort`；通过提示要求 JSON，不假定所有兼容服务支持结构化输出参数。

返回相同的会话／请求 ID、服务名、模型 ID、本轮 `reasoning_effort`（默认时为 `null`），以及 `cards` 和 `usage`。每张卡片含 `id/title/summary/body/tags/sources`，来源 ID 必须属于本次粘贴内容，摘录由后端取自原文；格式、数量或来源校验失败返回 502，不返回半批卡片。来源 ID 合法不代表内容一定准确，前端保留草稿标记供人工核对。`usage` 只包含上游实际返回的非负整数 token 字段，缺失则为 `null`；不推算账户余额或金额。

同一进程中以会话＋请求 ID 防重复：进行中重复提交返回 409，已完成的成功／失败结果在最多 128 条、15 分钟的内存缓存内复用，改变同 ID 的内容会被拒绝；缓存过期、淘汰或进程重启后不保证去重。因此前端不自动重试生成，新一轮生成必须使用新 ID。超时沿用 `LOREDOCK_MODEL_TIMEOUT`；取消只能尝试断开请求，不保证上游停止计费。手动核对和保存由浏览器专用事务完成，不再请求模型。

## 阅读草稿对话修改

`POST /api/cards/revise` 接收 `session_id/request_id/provider_id/model/reasoning_effort`、`revision`、`instructions` 和 1–8 张 `drafts`。每张包含稳定 `id`、当前显示序号 `ordinal`、`title/summary/body/tags/sources`；来源可带文章 ID、空间、标题、章节、版本、字符范围及快照标记。总正文最多 64000 字符、总来源摘录最多 48000 字符，超限拒绝而不截断。

返回 `revision` 和 `operations`：每项 `target_ids` 指定现有草稿，`card` 保留第一个目标标识。只允许已有、互不重复的目标，合并时由服务端合并原来源；模型不能增加来源或发明草稿 ID。未被提及的草稿由前端保留。前端还校验请求、会话及草稿修订号，停止或切换后的迟到结果不能覆盖新内容。两类卡片请求共用有界重放缓存，但命名空间隔离；`finish_reason` 为 `length/content_filter` 时拒绝结果，不接受半成品。保存仍完全独立于模型。

阅读卡片的独立 UI 模拟入口为 `python -m backend.tests.card_workshop_preview`（端口 8004），准备页 `/__test__/seed`，只读检查 `/__test__/inspect`。测试进程的 `/__test__/control` 接受 `{"fail_next":true}` 或 `{"slow_next":true}` 以验证失败／停止；不会读取正式数据库或密钥。详细用法见 [使用指南](../docs/USER_GUIDE.md)。

## 思考档位兼容边界

前端按“服务 ID＋完整模型 ID”分别保存档位，兼容旧偏好和工作区备份；请求发出后固定档位，后续调整只影响下一次请求。已核实原始 `gpt-5` 与 `gpt-5-2025-08-07` 不支持 `xhigh`，其滑轨只展示低／中／高。其他自定义 ID 可能是别名，实际支持以服务为准；不根据前缀推断全部模型能力。若上游 400／422 明确提及思考参数，返回固定中文提示；不回显上游原文、不自动降档或重试。卡片生成缓存标识包含档位，同一请求 ID 改档位会被拒绝。

2026-11-13 核对的官方依据：[思考强度说明](https://developers.openai.com/api/docs/guides/reasoning#reasoning-effort)、[Chat Completions 参数](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[原始模型范围](https://developers.openai.com/api/docs/models/gpt-5)。已验证模拟请求、错误与超时配置，未消费真实模型额度验证回答质量或计费。

## 本机资料接口


资料库展开“筛选”后点击“检索正文”。页面会先保存当前空间的可读资料，再发起搜索；“保存本机副本”可独立执行。这里不需要模型配置，所有请求仅访问本机后端。

| 接口 | 用途 |
| --- | --- |
| `GET /api/library/status` | 当前有效资料、片段、空间及删除标记数量，模式为 `keyword-index` |
| `GET /api/library/documents` | 列出当前有效资料元数据，不返回正文或磁盘路径 |
| `GET /api/library/documents/{id}` | 读取当前有效版本的元数据与正文 |
| `PUT /api/library/documents/{id}` | 保存或更新版本，校验正文并完整建立分块索引 |
| `POST /api/library/search` | 按空间、文档及版本白名单检索，返回引用片段 |
| `POST /api/library/retire` | 记录删除意图并撤下检索，阻止迟到上传复活同一 ID |

保存资料的 JSON 示例（路径 ID 必须与正文 `id` 一致）：

```json
{
  "id": "practice-note",
  "space_id": "practice",
  "space_name": "练习空间",
  "title": "事务练习",
  "file_name": "transaction.md",
  "type": "md",
  "body": "# 事务练习\n\n事务中的操作应共同提交或回滚。",
  "version": 1
}
```

检索请求：

```json
{
  "question": "事务",
  "scope_ids": ["practice"],
  "document_versions": {"practice-note": 1}
}
```

同 ID、同版本、同内容重复保存不会新增片段；同版本不同内容、降版或改变所属空间返回 `409`。新版本先完成原文写入和全部分块，再原子切换有效版本；失败时保留此前可检索版本。检索遇到缺失、已删除或不匹配的版本同样返回 `409`，不会静默换成另一版。空白名单返回空结果，不检索后端残留的其他副本。

退索引请求形如 `{"document_ids":["practice-note"]}`。即使资料尚未上传，也保存删除标记，以阻止较晚到达的保存请求；后续复用该 ID 返回 `409`。已退索引资料的详情返回 `404`，不参与新检索。响应中的 `retrievable: false` 与 `purge_pending: true` 分别表示已撤下检索、历史文件尚未物理清理，不能报告全部删除完成。前端等待该操作成功后，再用 IndexedDB 专用事务移除本地条目并记录删除标记；失败会保留页面资料并允许重试。

数据根目录可通过 `LOREDOCK_DATA_DIR` 指定，默认项目 `data/`。原文件名和 ID 不直接拼入磁盘路径，上传副本以哈希命名并检查目录边界；原 ZIP 和已准备的阅读版不会被覆盖。暂不提供物理清理、完整备份或恢复接口。

## 测试

```powershell
./.venv/Scripts/python.exe -m pytest backend/tests -q
```

资料测试使用临时目录，覆盖持久化重开、同版幂等、失败保留旧版、中文英文检索、空间与版本白名单、退索引防复活及 HTTP 边界。索引问答用 `httpx.MockTransport` 核对上下文范围、严格资料模式零命中不调用模型、引用 ID 校验及错误恢复；DPAPI round trip 在 Windows 中使用测试字符串验证真实加解密。测试不请求真实模型、不花费 API 额度；覆盖范围与演示方法见 [测试说明](../docs/TESTING.md)。

卡片生成测试在 `tests/test_card_generation.py`，另有浏览器验收夹具：先构建前端，执行 `./.venv/Scripts/python.exe -m backend.tests.card_preview`，访问 `http://127.0.0.1:8001/`。它使用临时数据库、明确标注的模拟服务和 MockTransport；不会请求真实模型。“整理侧重点”填 `模拟额度不足` 可观察 429，填 `模拟慢响应` 可验证取消；测试接口 `/__test__/stats` 返回调用次数，用于核对保存不会再次请求上游。仅用于开发验收，不由正式启动入口加载。

## 协议依据

使用 OpenAI Docs 核验了 [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) 的 `model`、`messages` 与 `choices[].message.content`，以及 [Models List](https://developers.openai.com/api/reference/resources/models/methods/list)。选 Chat Completions 是为了兼容多个服务商；未假定所有模型都支持相同附加参数，因此本轮只发送基础文本字段，不强行加入温度、JSON 模式或采样参数。
