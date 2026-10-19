# Trae（trea）「上下文参数是假的」审计报告

- 审计人：teammate `dsh-consumer-auditor`（task-2），只读分析
- 日期：2026-10-19
- 工作区：`C:\Users\hu\Desktop\WorkSpace\brige`
- 用户原话：「我发现trea给的参数上下文是假的，这个是api的bug吗」

## 直接回答（lead 追问）

**用户看到的「上下文」数字有两个不同来源，必须分开说：**

| 问题 | 答案 |
| --- | --- |
| 会话计量条 `~X / ?` 的分母是什么 | **262144**（= 256×1024）。铁证：会话事件 `{"type":"request/context","seq":27,"data":{"provider":"trea","model":"deepseek-v4.1-flash","contextWindow":262144}}` |
| 它从哪来 | `dsh-llm-pi-ai\lib\index.js:693` `entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow`；trea 的 46 条模型配置（`cordis.yml:707` 起）**一条都没有 `contextWindow`**，trea 段也没有 `defaultContextWindow`，于是取 `:1150` `source.defaultContextWindow ?? 262144` / `:959` `DEFAULT_CONTEXT_WINDOW = 262144`。**它是 pi-ai 的默认回退值，与上游 TRAE 目录、与 `/v1/models` 都无关** |
| 它跟 `/v1/models` 的 `context_length: 0` 有关吗 | **无关**。`context_length` 只走模型发现链（`:2351` `capacity(...)` → `:2257` 只接受正整数 → 0 被丢弃成 `undefined`），只影响设置页 Fetch models 的回显（空白）；计量条分母走的是配置条目 `:693`，两条链互不相通（见 §4） |
| 那「假的」最可能是什么 | **Codex 侧 `C:\Users\hu\.codex\trae-models.json`（及 cc-switch DB）里的 `1000000`**：`add-trae-provider.mjs:80-81` 把上游目录真值 200000 一律改写为 1M（27 条里 21 条），而 Codex `[desktop] show-context-window-usage = true` 会把它显示出来 |
| 是 API bug 吗 | **不是上游 TRAE 的 bug**（目录值 200000 自洽）；是**中间层 trae2api 的解析缺陷**（`client.go:292-315` 从不解析 `context_window_tokens` + `handler.go:312-316` 类型不符的死兜底）**加上本地脚本的 1M 覆写**。DSH 侧的 262144 只是默认回退，不算 bug |

---

## 0. 结论速览

**不是单纯的上游 API bug，是三层叠加；用户看到的「假」数字最可能是 Codex 侧 `C:\Users\hu\.codex\trae-models.json` 里的 1M。**

| 展示面 | 显示的上限 | 上游 TRAE 目录真值 | 差距 | 性质 |
| --- | --- | --- | --- | --- |
| Codex 桌面端（trae-models.json / cc-switch DB） | **1000000**（27 条里 21 条） | **200000** | 5× 虚高 | **本地脚本硬覆写，最可能是用户说的「假」** |
| DSH（`~已用 / 窗口` 计量条） | **262144** | 200000 | 1.31× | pi-ai 的**默认回退值**，与上游无关 |
| trae2api `/v1/models` | **0** | 200000 | 丢字段 | **中间层解析 bug（确凿）** |
| bridge `/v1/models` | **0** | 200000 | 原样透传 | 无 bug，纯透传 |
| DSH 模型发现（Fetch models） | 空白 | 200000 | 丢字段 | 上游 0 被 `capacity()` 判为不可用而丢弃 |

三层根因：

1. **上游（不是 bug）**：TRAE `get_detail_param` 的目录值就是模型/通道的真实声明值（GLM/DeepSeek/kimi/mimo/minimax/step/qwen/sagitta = 200000；Doubao = 256000/232768；aquila = 272000）。2026-10-19 直连实测仍是 200000。
2. **中间层 trae2api（是真 bug）**：
   - `internal/upstream/client.go:292-315` 的 `FetchModels()` 只解 `config_name` / `display_config.display_name`，**从不解析 `context_window_tokens`**，于是 `ModelInfo.ContextWindow` 恒为 0（结构体 `client.go:263-269`）。
   - `internal/server/handler.go:312-316` 本想「0 就补 131072」，但 `entry["context_length"]` 的**动态类型是 int64**，而 `== 0` 的 0 是 **int**，Go 的接口比较先比动态类型 → **永远不相等，兜底是死代码**。这就是实测 46 条全是 `context_length: 0`、而静态表（`handler.go:247-280`，32 条全 131072）从未启用的原因。
3. **本地 brige 仓库（是"假"的直接来源）**：`add-trae-provider.mjs:80-81` 把读到的 200000 **一律改写为 1000000**，注释理由（`:76-79`）是 2026-10-12 的一次「大 prompt 收 HTTP 200」实测——这只证明通道**接受**了，不证明目录声明的上限被改；而且注释自己写着「目录还写 200k」，即上游至今没改口。改写结果落进 `C:\Users\hu\.codex\trae-models.json` 和 cc-switch 的 `trae-bridge-codex` provider。

**判定**：`trea` 侧「上下文是假的」成立，但责任不在 DSH；主责是本地 `add-trae-provider.mjs` 的 1M 覆写（对外展示虚高 5×），次责是 trae2api 的字段解析 + 死兜底（使任何客户端都无法从 `/v1/models` 得知真实上限）。

---

## 1. 证据 A：DSH 侧 trea 实际采用 262144（铁证）

会话文件 `C:\Users\hu\.dsh\sessions\--C-Users-hu-Desktop-WorkSpace-brige--\session-2964f10d-0928-4596-9782-49b488f06b21\session.v4.jsonl.zstd`（333 个 zstd 帧，逐帧解出 678 条 JSONL）内只有 2 条 `request/context` 记录：

```json
{"type":"request/context","seq":12,"data":{"provider":"workbuddy","model":"cn:deepseek-v4.1-flash","contextWindow":1000000}}
{"type":"request/context","seq":27,"data":{"provider":"trea","model":"deepseek-v4.1-flash","contextWindow":262144}}
```

全会话 `"contextWindow":<n>` 只出现这两个值（1000000 一次 = workbuddy，262144 一次 = trea）。
→ **DSH 对 trea/deepseek-v4.1-flash 实际按 262144 算窗口**，既不是上游的 200000，也不是 Codex 的 1000000。

## 2. 证据 B：协议 → 适配器（trea 只能由 pi-ai 服务）

- DSH provider 配置：`C:\Users\hu\.dsh\profiles\desktop\cordis.yml:702-706`
  ```yaml
  trea:
    displayName: Trea
    apiKeyEnv: TREA_API_KEY
    api: openai-completions
    baseURL: http://127.0.0.1:8788/v1
  ```
  同一份配置的镜像在 `cordis.patch.yml:1101-1105`。默认模型 `cordis.yml:52-57` → `provider: trea` / `model: deepseek-v4.1-flash` / `reasoningEffort: high`。
- 全库 1641 个 `.js` 中只有两处认得字符串 `"openai-completions"`：`dsh-llm-pi-ai\lib\index.js`（6 处）与 `dsh-client-ui-settings-models\lib\client.js`（2 处）。`dsh-llm-deepseek*` 完全不认 → trea 走 pi-ai。
- `dsh-llm-pi-ai\lib\index.js:834-838`：`const PROTOCOLS = { "openai-completions": openAICompletionsApi, ... }`；`:847` `supportedProtocols() = Object.keys(PROTOCOLS)`。
- `:926-938` `buildProvider(spec)`：`:927` 先查 catalog provider，`:928` catalog 存在且未改协议时复用，否则 `:929-937` `PROTOCOLS[spec.api]() → createProvider({... models, api})`；`:930` 未知协议抛 `PiAiCatalogError("... supported protocols are ...")`。trea 不在 pi-ai 内置 catalog（`catalogProvider("trea")` 为 undefined）→ 走 `createProvider` + `openAICompletionsApi`。
- 注册挂载：`dsh-llm-pi-ai\lib\index.js:2941-2956`，`:2952` `ctx.llm.registerAdapter(routes, adapter)`，`routes = [...profiles().keys()]`；`:2937-2940` `ctx.llm.registerModelDiscovery(settingsNs, ...discoverModels...)`。
- 宿主挂载点：`dsh-base\cordis.patch.yml:135-136`（`id: llm-pi-ai`，`:128-134` 注释说明它在 profile 给出 providers 前是 dormant）；`dsh-llm-deepseek-api-key\lib\index.js:36` `const PROVIDER = "deepseek-official"`、`:52` `registerConfigurableProviders(...)` → **llm-deepseek 只注册 `deepseek-official` 一条路由，trea 不经过它**。

## 3. 证据 C：262144 从哪来（resolveEntry 链）

- `dsh-llm-pi-ai\lib\index.js:959` `const DEFAULT_CONTEXT_WINDOW = 262144;`；`:961` `DEFAULT_MAX_TOKENS = 32768`。
- `:1057` profile schema `defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW)`。
- `:1117-1152` `resolveProfiles()`：`:1150` `defaultContextWindow: source.defaultContextWindow ?? 262144`（用户 cordis.yml 的 trea 段没写 `defaultContextWindow` → 用 262144）。
- `:656` `resolveRouteModels()` → `:683` `resolveEntry(entry)` → **`:693` `const contextWindow = entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow;`** → `:694` 非正整数才报错。
  trea 的 46 条模型（`cordis.yml:707` 起，逐条只有 `id/name/reasoningEfforts/compat/input`，**无 `contextWindow`**；`contextWindow`/`maxTokens` 在 trea 段内的唯一命中是 `:1553` 属于 llm-deepseek 的 `maxTokens: 384000`，不在 trea 段）→ 全部落到 `request.defaultContextWindow = 262144`。
- 回传链：`:1911-1926` `modelInfo()` → `:1921` `context: { contextWindow: resolvedModel.contextWindow }`；`dsh-llm\lib\index.js:2111-2141` `resolveModelInfo/normalizeModelInfo`，`:2123` 校验正整数，`:2137` 回传。
- **上游 0 被丢弃**：`:2257-2259` `function capacity(...candidates)` 只接受 `typeof number && Number.isInteger && >0`；`:2351` `const contextWindow = capacity(entry?.contextWindow, entry?.context_window, entry?.context_length, entry?.max_input_tokens, entry?.limit?.context)`；`:2356` `...contextWindow === void 0 ? {} : { contextWindow }`。→ `/v1/models` 的 `context_length: 0` 在模型发现里变成 `undefined`（UI 显示空白），**不影响** `:693` 已配置路由的 262144。
- **llm-deepseek 的 1e6 不会误用**：`dsh-llm-deepseek\lib\index.js:19` `const DEFAULT_CONTEXT_WINDOW = 1e6`、`:43-53` catalog 里 deepseek-flash/deepseek-v4-pro = 1e6、`:328` schema default 1e6；但该适配器只服务 `deepseek-official`（用户配置 `cordis.yml:1544-1554` 只给了 `baseURL: https://api.deepseek.com` + `models: [deepseek-flash]`）。trea 路由不经过它 → 1e6 无泄漏路径。

- **两条链的优先级关系（关键，直接回答「/v1/models 上报的 context_length 与目录条目 contextWindow 谁优先」）**：
  - 链①「已配置路由」（决定计量条分母）：`dsh-llm-pi-ai\lib\index.js:656` `resolveRouteModels` → `:683` `resolveEntry` → `:693` `entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow`。**它只读用户配置里的 models 条目**（`cordis.yml:707` 起 trea 46 条逐条无 `contextWindow`）→ 落到 `request.defaultContextWindow` = 262144。**`/v1/models` 的 `context_length` 根本不在这条表达式里**，所以上游报 0 还是 200000，对分母毫无影响。
  - 链②「模型发现」（只决定设置页 Fetch models 的回显）：`dsh-llm-pi-ai\lib\index.js:2385` `discoverModels` → `:2435` `return readListing(body)` → `:2351` `const contextWindow = capacity(entry?.contextWindow, entry?.context_window, entry?.context_length, entry?.max_input_tokens, entry?.limit?.context)` → `:2257-2259` `capacity` 只接受 `typeof number && Number.isInteger && >0` → 上游 `0` 被判「无值」丢弃 → `:2356` `...contextWindow === void 0 ? {} : { contextWindow }` 不写键 → `dsh-llm\lib\index.js:2005-2014` 合并时 `...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow }` 同样跳过 → UI `adopt()`（`dsh-client-ui-settings-models\lib\client.js:862-869`）再跳过 → **该行输入框留空**（placeholder 仍显示 `256K`）。
  - 结论：**把 trae2api 修好让 `/v1/models` 报 200000，并不会改变 DSH 计量条的分母**（除非同时给 `cordis.yml` 的 trea 段写 `contextWindow: 200000` 或段级 `defaultContextWindow: 200000`）；反过来，给 `cordis.yml` 写 200000 也不会让 `/v1/models` 不再报 0。两条链目前是**互不相通**的。
## 4. 证据 D：用户看到的数字来自 UI 哪一处

- 真正显示容量的是会话计量条：`dsh-client-ui-conversation\lib\client.js:18437-18451` `contextOccupancy(pressure)` = `usedTokens / pressure.contextWindow`；`:18637` 渲染 `~{已用} / {窗口}`。trea 会话下分母即 **262144**。
- 这个分母的**完整来源链**（自下而上）：
  1. `dsh-llm-pi-ai\lib\index.js:693` `entry.contextWindow ?? base?.contextWindow ?? request.defaultContextWindow` → 262144（见 §3）；
  2. `:1911-1926` `modelInfo()` → `:1921` `context: { contextWindow: resolvedModel.contextWindow }`；`dsh-llm\lib\index.js:2111-2141` `normalizeModelInfo` 校验并回传；
  3. `dsh-agent-loop\lib\index.js:1262` `const contextWindow = preparedCall?.context?.contextWindow;` → `:1264-1269` 组装 `requestContext`（provider/model/contextWindow）→ `:1270-1271` 与 `session.requestContext()` 比较，变了才 append **`request/context`** 事件（这就是会话文件里的那条记录）；
  4. `dsh-token-meter\lib\index.js:448-495` `contextPressureProjectionDefinition`（key `contextPressure`, stateVersion 5）：`:456-465` 只认 `event.type === "request/context"` 的 `event.data.contextWindow`，`:487-493` `wire.view` 暴露 `{ contextWindow, pressureTokens, projectedTokens }`；
  5. `dsh-client-ui-conversation\lib\client.js:18443-18451` `contextOccupancy` 取 `pressure.projectedTokens ?? pressure.pressureTokens` 作分子、`pressure.contextWindow` 作分母。
  → **用户看到的 `~X / 262144` 的分母，就是 pi-ai 的默认回退 262144，全程没有任何上游数字参与**。
- 设置页那个 `256K` **只是占位提示、不是实际值**，而且 trea 这一屏走的正是硬编码 hint 的分支：
  - 编辑器家族由**命名空间**决定，不由 provider 名决定：`dsh-client-ui-settings-models\lib\client.js:1840-1844` `layoutOf(ns)` → `ns === "llm-deepseek"` → `"deepseek"`；`ns === "llm-pi-ai"` → `"pi-ai"`；否则 `"unknown"`。trea 的 provider 段写在 llm-pi-ai 的 settings 里 → layout = `"pi-ai"` → 走 `family !== "deepseek"` 分支（`:2149-2162`）渲染 **`ModelListEditor`**（`:876`），不是 `DeepSeekModelsEditor`（`:667`）。
  - `ModelListEditor` 的 ModelRow 硬编码：`:1055-1078` `contextWindow: { value: capacityText(model, index, "contextWindow"), placeholder: CAPACITY_HINT.contextWindow, ... }`、`maxTokens.placeholder = CAPACITY_HINT.maxTokens`。`CAPACITY_HINT` 定义 `:847-850` = `{ contextWindow: "256K", maxTokens: "32K" }`，注释 `:836-845` 自认「只是 hint 不是镜像：本页把 K 当 1000，所以输入 256K 存 256000，而留空则保留适配器的 262144。A deployment that overrides those defaults is not reflected here — nothing on this page can read them.」
  - 用**真实** fallback 数值格式化的是**另一条**路径：`capacityInput(model, index, field, fallback)`（`:731-741`，`fallback === void 0` 时才退回 `contextWindowPlaceholder` 文案），调用点 `:777-778` 在 `DeepSeekModelsEditor` 内。所以 `defaultContextWindow` 只传给 DeepSeek 编辑器（`:2151`），**没有**传给 `ModelListEditor`（`:2153-2162` 的 props 里没有它）→ trea 的输入框 placeholder 恒为字面量 `256K`。
  - 文案 `:3291-3292` `contextWindowPlaceholder: "Uses the provider default"`（中文 `:3428-3429`「使用提供商默认值」）只在那条带 fallback 的路径出现。
  - → trea 屏上的 `256K` 与真实生效的 `262144` **既不同源也不同值**，把它读成「这个模型的窗口是 256K」是误读；它是 UI 的硬编码提示（本身也是「假数字」的一个来源，但与上游 200000 无关）。
- `C:\Users\hu\.dsh\llm-deepseek\files-v3.json`（217713 B，keys: `formatVersion`/`records`）里没有 `trea`/`contextWindow`/`context_length`/262144/1000000 → 该文件不含上下文元数据。

## 5. 证据 E：bridge 只透传，未改写

- `bridge.mjs:1611-1617` 支持集含 `requestPath === "/v1/models" && req.method === "GET"`；`:1797-1799` 只对 responses/anthropic 改写路径为 `/v1/chat/completions`；`:1381-1410` `proxyPassThrough()` 逐字节转发上游 body，**不解析、不补 `context_length`**（调用点 `:2121`）。
- 唯一读上游 models 的地方 `:643-663` `fetchKnownModels()` 只取 `payload?.data[].id` 做模型兜底，从不读 context 字段。
- 实测（2026-10-19，带 Bearer）：
  ```
  http://127.0.0.1:8788/v1/models → n=46, distinct context_length = 0
  http://127.0.0.1:7864/v1/models → n=46, distinct context_length = 0
  ```
  两者 body 头部逐字节一致 → bridge 没有二次加工，**8788 的 0 就是 trae2api 的原始值**。

## 6. 证据 F：trae2api 的解析缺口 + 死兜底（确凿 bug）

- `C:\Users\hu\.trae2api\internal\upstream\client.go:263-269` `ModelInfo{ID, Name, ContextWindow int64, MaxTokens int64}`，注释 `ContextWindow // = maxInputTokens`。
- `client.go:292-302` `FetchModels()` 的解码结构体只有 `config_name` / `display_config.display_name` / `model_detail_list[].model_name`；`:306-315` 组装时**只赋 `ID` 和 `Name`**，`ContextWindow`/`MaxTokens` 保持零值。
- `internal/server/handler.go:312-316`：
  ```go
  "context_length": mi.ContextWindow,
  }
  if entry["context_length"] == 0 {
      entry["context_length"] = 131072
  }
  ```
  `entry` 是 `map[string]any`，其值动态类型为 **int64**；字面量 `0` 的默认类型是 **int**。Go 的接口比较先要求动态类型相同 → `int64(0) == 0` **恒为 false**，兜底永不执行。
- 旁证：`handler.go:247-280` 的 `staticModels` 32 条**全部** `context_length: 131072`，但 `modelList()`（`:303-321`）只在 `fetchDynamicModels()` 返回空时才用它；实测返回 46 条 → 走动态分支 → 全 0。
- 该缺陷自 2026-09-08 就存在：`git blame -L 306,320 internal/server/handler.go` 全部指向 `ec20c08 (Jeff 2026-09-08)`；`trae2api.exe` 的 Go buildinfo 为 `vcs.revision=ec20c088a375bc5a2989d43aa5b561b06a4382e7` / `vcs.time=2026-09-08T03:35:49Z` / `vcs.modified=false` → **二进制与源码一致，0 是代码缺陷，不是版本错配**。
- 上游确实提供了可用字段：`brige\add-trae-provider.mjs:73` 读 `e.context_window_tokens?.dev`（2026-10-19 实测 GLM 系 = 200000）→ trae2api 只是没解这个字段。

## 7. 证据 G：brige 仓库声明 vs 上游真值

- `add-trae-provider.mjs:68-74`：`contextWindow: Number(e.context_window_tokens?.dev || 0) || undefined`（先读到 200000）。
- `add-trae-provider.mjs:76-79` 注释断言「上游 `context_window_tokens` 是过时的通道值：目录还写 200k，但 2026-10-12 实测（glm-5.3 收 21.4 万、glm-5.3-flash 收 95 万均 HTTP 200）免费通道已放开到 1M」——这是**把"接受"当成"声明上限"**，且注释自己承认目录仍写 200k。
- `add-trae-provider.mjs:80-81`：`if (m.contextWindow === 200000) m.contextWindow = 1000000;` —— 对 21 条模型（GLM 全系 8、DeepSeek 全系 5、kimi 3、mimo 2、minimax 1、step 1、qwen 2、sagitta 1，按 DB 实测）统一 5× 虚高。
- 产物实测：
  - `C:\Users\hu\.codex\trae-models.json`（46192 B，mtime 2026-10-12T13:17:27Z，27 条）：`context_window` 分布 `{1000000:21, 256000:3, 232768:2, 272000:1}`，且每条 `max_context_window` 与 `context_window` 相等、`effective_context_window_percent: 95`。例：`glm-5.3` → `context_window: 1000000`（上游 200000）。
  - `C:\Users\hu\.cc-switch\cc-switch.db` 的 `trae-bridge-codex` provider（27 条）分布完全相同。
  - `C:\Users\hu\.codex\cc-switch-model-catalog.json`（27 条）分布相同。
- 对照：Codex 的 workbuddy 目录 `workbuddy-models.json`（44 条）保留了真实差异 `{31000:1, 96000:5, 112000:1, 128000:3, 168000:1, 192000:4, 200000:7, 256000:5, 300000:3, 512000:1, 960000:3, 1000000:10}`，且 `add-workbuddy-catalog.mjs:79` 是 `Number(m.context_length) || 200000`（读上游、缺省 200000，**不做 1M 覆写**）→ 同一仓库里 workbuddy 走「如实透传」，trae 走「一律抬到 1M」，**不一致的正是 trae 这条路**。
- `add-model-catalog.mjs:111-113` 另有硬编码 `context_window: 1000000, max_context_window: 1000000, effective_context_window_percent: 95`（MiMo 条目），与本次问题同型。
- `README.md:269-294`（Trae 唯一章节）只说「模型 ID 原样透传、chat mode 固定 raw」，**没有任何 1M/上下文声明** → README 不与上游矛盾，矛盾集中在 `add-trae-provider.mjs:76-81` 及其产物。
- `reports\` 下没有关于 trae 上下文的报告（仅有 `mimo-native-responses.json`、`tool-demo-latest.txt`，均无 context 声明）。

## 8. 「假的」最可能指哪一处（排序）

1. **Codex 桌面端（最可能）**：`C:\Users\hu\.codex\config.toml` 的 `[desktop] show-context-window-usage = true`，Codex 选择器与用量条直接读 `trae-models.json` 的 `context_window: 1000000`；而上游目录写 200000 → 用户看到 1M 是"假的"。27 条里 21 条属于此列。
2. **DSH 会话计量条**：`~x / 262144`，与上游 200000 也不一致，但那是 pi-ai 的默认回退（`dsh-llm-pi-ai\lib\index.js:1150`），**不是上游给的数**，性质是"没数据时的默认"，不宜称 bug。
3. **DSH 设置页 placeholder「256K」**：纯提示且页内注释自认不是实际值（`:836-845`）——可读性陷阱，非数据错误。
4. **trae2api `/v1/models` 的 0**：使任何客户端（含 DSH 的 Fetch models）都拿不到真实上限 → 是让 1、2 长期存在的**根因之一**。

## 9. 修复方案

### P0 — 去掉 1M 覆写（直接消除用户看到的"假"）
- 文件 `C:\Users\hu\Desktop\WorkSpace\brige\add-trae-provider.mjs:80-81`：删除 `if (m.contextWindow === 200000) m.contextWindow = 1000000;`，改为如实使用 `e.context_window_tokens?.dev`；若确实要标注"实测可接受更长"，应新增独立字段（例如 `observed_context_window`）而不是改写 `context_window`。
- 同步修正 `:76-79` 注释：把"通道已放开到 1M"降级为"实测 X 万 token 的请求被接受（HTTP 200），不代表目录上限"。
- 重跑 `add-trae-provider.mjs` 后，`C:\Users\hu\.codex\trae-models.json` 与 cc-switch DB 的 21 条会回到 200000（Doubao/aquila 不变）。
- 顺带：`add-model-catalog.mjs:111-113` 的 MiMo 硬编码 1M 建议同样改为读上游或显式标注为本地假设。

### P1 — 修 trae2api（让所有客户端拿到真值）
- `internal\upstream\client.go:292-302`：解码结构体加 `ContextWindowTokens struct{ Dev int64 \`json:"dev"\` } \`json:"context_window_tokens"\``（必要时同时解 `max_input_tokens` / `max_output_tokens`），并在 `:311-314` 赋 `ContextWindow: cfg.ContextWindowTokens.Dev`、`MaxTokens` 同理。
- `internal\server\handler.go:314-316`：把接口比较改为数值比较，例如 `if mi.ContextWindow <= 0 { entry["context_length"] = 131072 }`（或先 `if v, ok := entry["context_length"].(int64); ok && v == 0`）——修掉 Go「int64 vs int 接口比较」死分支。
- 可选：把 `staticModels`（`handler.go:247-280`，32 条恒 131072）的 131072 一并改为与动态表同源的常量，避免回退时又给出另一个假值。

### P2 — DSH 侧补齐（可选，收益是"准确"而非"修 bug"）
- `C:\Users\hu\.dsh\profiles\desktop\cordis.yml:702` 起的 trea 段（及 `cordis.patch.yml:1101`）给 46 条模型补 `contextWindow`（按上游真值：GLM/DeepSeek/kimi/mimo/minimax/step/qwen/sagitta=200000，Doubao=256000/232768，aquila=272000），或在 trea 段加 `defaultContextWindow: 200000`。这样 `dsh-llm-pi-ai\lib\index.js:693` 会取到显式值而不是 262144。
- 注意：trea 的 `deepseek-v4.1-flash` 上游=200000，而 DSH 默认模型就是它 → 改后计量条会从 262144 变为 200000。

### 复现/验证命令
```powershell
# 上游真实目录（直连 TRAE，只读）
# 见 brige\add-trae-provider.mjs:27-56 的 POST body；实测 2026-10-19 各 config_name 的 context_window_tokens.dev
# 本地两层端点（需 Bearer）
$t=@{Authorization='Bearer <trae-api-key.txt>'}; $h=@{Authorization='Bearer <bridge-secret.txt>'}
(Invoke-WebRequest 'http://127.0.0.1:7864/v1/models' -Headers $t).Content.Substring(0,300)
(Invoke-WebRequest 'http://127.0.0.1:8788/v1/models' -Headers $h).Content.Substring(0,300)
# 两处应都返回 context_length: 0
```

## 10. 证据文件/行号索引

| 位置 | 关键行 |
| --- | --- |
| `C:\Users\hu\.dsh\profiles\desktop\cordis.yml` | `:52-57` 默认模型；`:702-706` trea provider；`:707` 起 46 条模型（无 contextWindow）；`:1544-1554` llm-deepseek 仅 deepseek-official |
| `cordis.patch.yml` | `:1101-1105` trea 段镜像 |
| `dsh-llm-pi-ai\lib\index.js` | `:693` 解析；`:959` 262144；`:1057` schema；`:1150` 回退；`:834-838` PROTOCOLS；`:926-938` buildProvider；`:2257-2356` capacity/readListing；`:1911-1926` modelInfo；`:2941-2956` registerAdapter |
| `dsh-llm\lib\index.js` | `:2111-2141` resolveModelInfo/normalizeModelInfo |
| `dsh-llm-deepseek\lib\index.js` | `:19` 1e6；`:43-53` catalog；`:328` schema default |
| `dsh-llm-deepseek-api-key\lib\index.js` | `:36` PROVIDER="deepseek-official"；`:52` registerConfigurableProviders |
| `dsh-client-ui-settings-models\lib\client.js` | `:836-850` CAPACITY_HINT 与自认注释；`:1065-1078` placeholder；`:731-741` capacityInput fallback；`:3291-3292`/`:3428-3429` 文案 |
| `dsh-client-ui-conversation\lib\client.js` | `:18437-18451` contextOccupancy；`:18637` 计量条渲染 |
| `bridge.mjs` | `:643-663` fetchKnownModels（只读 id）；`:1381-1410` proxyPassThrough；`:1611-1617` supported；`:1797-1799` upstreamPath；`:2121` 调用点 |
| `add-trae-provider.mjs` | `:27-56` 上游请求；`:68-74` 读 `context_window_tokens.dev`；`:76-87` 1M 覆写与理由；`:153-161` 写 DB |
| `add-model-catalog.mjs` | `:111-113` MiMo 硬编码 1M |
| `add-workbuddy-catalog.mjs` | `:79` `Number(m.context_length) || 200000`（对照：不覆写） |
| `README.md` | `:269-294` Trae 章节（无 1M 声明） |
| `C:\Users\hu\.trae2api\internal\upstream\client.go` | `:263-269` ModelInfo；`:292-302` 解码结构体；`:306-315` 只赋 ID/Name |
| `C:\Users\hu\.trae2api\internal\server\handler.go` | `:247-280` staticModels（32×131072）；`:303-321` modelList；`:312-316` 死兜底；`:97` 路由 |
| `C:\Users\hu\.codex\trae-models.json` | 27 条，`context_window` 分布 `{1000000:21,256000:3,232768:2,272000:1}` |
| `C:\Users\hu\.codex\config.toml` | `[desktop] show-context-window-usage = true` |
| `C:\Users\hu\.cc-switch\cc-switch.db` | provider `trae-bridge-codex` 27 条，分布同上 |

## 11. 限制与未决

- 未重新直连上游 `get_detail_param` 复核 200000（任务描述已给 2026-10-19 实测；本报告引用该值）。若需独立复核，可用 `add-trae-provider.mjs:27-56` 的请求体只读调用。
- 本机无 Go 工具链（`go version` 不存在），未能重新编译 trae2api 验证 P1 修复；P1 结论由源码行号 + `trae2api.exe` 内嵌 buildinfo（`vcs.revision=ec20c088…`、`vcs.modified=false`）支撑。
- 未区分「200000 是模型原生上限还是 TRAE 通道配额」——这决定 P2 该不该把 200000 写进 DSH 配置；建议以"上游目录口径"为准先对齐。
- `reports\_tmp_session_2964.txt`（2.2 MB）是本次审计从会话 zstd 解出的临时转储，属我的中间产物，任务结束后可删除。
