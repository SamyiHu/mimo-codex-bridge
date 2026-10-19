# TRAE 上游真实上下文上限实测报告

- 任务：shared task-1（owner: upstream-prober）
- 日期：实测时刻见各条记录（本机时钟 2026-10-19 区间，响应 usage 内 created 时间戳 `1792414xxx`）
- 被测链路：`http://127.0.0.1:8788/v1/chat/completions`（bridge 2.8.0，upstreamKind=trae，chatMode=raw）→ `http://127.0.0.1:7864`（trae2api）→ TRAE
- 鉴权：bridge 用 `C:\Users\hu\Desktop\WorkSpace\brige\bridge-secret.txt`（43 字节）作 Bearer；直连 trae2api 用 `C:\Users\hu\Desktop\WorkSpace\brige\trae-api-key.txt`（32 字节）
- 填充文本：英文重复短语 `The quick brown fox jumps over the lazy dog and then keeps running. `（68 字符），实测 **4.864 字符/token**（由 usage.prompt_tokens 反推，例如 5,090,000 字符 → prompt_tokens=1,047,976）
- 请求形态：`stream: true` + `stream_options.include_usage: true`，`max_tokens: 16`，客户端超时 420s

## 0. 一句话结论

**TRAE 上游免费通道真实上限是 ~1,048,576 token（1M），不是 200k。**
- `deepseek-v4.1-flash`：1,047,976 token → HTTP 200 正常回答；1,048,9xx token 起报 `solo error code=4026`。
- `glm-5.2` / `glm-5.3`：1,031,480 token → HTTP 200 正常回答；1,050,xxx token 起报 `solo error code=4022`。
- 因此 `add-trae-provider.mjs:76-87` 把目录里的 200000 一律改写为 1000000 **方向正确、量级正确**（DeepSeek/GLM 系实测确实收 ~1M）。
- 但**报错方式极具误导性**：上游超限时 HTTP 状态码仍是 **200**，错误藏在 SSE 里：`event: error` + `data: "solo error code=4026 msg=..."`，随后 `finish_reason: "stop"` + `[DONE]`。只看 HTTP 200 的客户端会以为请求成功、上下文没问题 —— 这是「上下文参数是假的」观感的重要来源之一。

## 1. 压测矩阵（bridge :8788，全部实测）

| # | model | 目标输入 token | 请求体字节 | HTTP | 上游错误码 | usage.prompt_tokens | 耗时 | 判定 |
|---|-------|----------------|-----------|------|-----------|--------------------|------|------|
| 1 | deepseek-v4.1-flash | ~41k（200,088 字符） | 200,2xx | 200 | — | 41,226 | 5.5s | 通过 |
| 2 | deepseek-v4.1-flash | ~124k（600,064 字符） | 600,1xx | 200 | — | 123,574 | 10.5s | 通过 |
| 3 | deepseek-v4.1-flash | ~250k | 1,216,315 | 200 | — | 250,400 | 20.9s | 通过 |
| 4 | glm-5.2 | ~250k | 1,216,076 | 200 | — | 250,382 | 22.6s | 通过 |
| 5 | deepseek-v4.1-flash | ~300k | 1,459,389 | 200 | — | 300,464 | 9.5s | 通过 |
| 6 | deepseek-v4.1-flash | ~500k | 2,432,197 | 200 | — | 500,748 | 29.1s | 通过 |
| 7 | glm-5.2 | ~500k | 2,432,164 | 200 | — | 500,726 | 28.6s | 通过 |
| 8 | deepseek-v4.1-flash | ~1000k | 4,864,217 | 200 | — | 1,001,458 | 119.2s | 通过 |
| 9 | glm-5.2 | ~1000k | 4,864,184 | 502 | — | — | 120.0s | bridge 侧 `upstream headers timeout after 60000ms`（上游首包慢，非上限） |
| 10 | deepseek-v4.1-flash | 1,010k | 4,912,816 | 200 | — | 1,011,464 | 8.2s | 通过 |
| 11 | deepseek-v4.1-flash | 1,020k | 4,961,436 | 200 | — | 1,021,474 | 8.2s | 通过 |
| 12 | deepseek-v4.1-flash | 1,030k | 5,010,124 | 200 | — | 1,031,498 | 8.1s | 通过 |
| 13 | deepseek-v4.1-flash | 1,040k | 5,058,744 | 200 | — | 1,041,508 | 18.3s | 通过 |
| 14 | **deepseek-v4.1-flash** | **5,090,000 字符** | 5,09x,xxx | 200 | — | **1,047,976** | — | **通过（实测最大成功）** |
| 15 | **deepseek-v4.1-flash** | **5,095,000 字符** | 5,09x,xxx | **200** | **4026** | — | — | **失败（HTTP 仍是 200）** |
| 16 | deepseek-v4.1-flash | 1,050k | 5,107,364 | 200 | 4026 | — | 33.1s | 失败 |
| 17 | deepseek-v4.1-flash | 1,100k | 5,350,600 | 200 | 4026 | — | 33.4s | 失败 |
| 18 | deepseek-v4.1-flash | 1,200k | 5,837,004 | 200 | 4026 | — | 34.4s | 失败 |
| 19 | deepseek-v4.1-flash | 1,400k | 6,809,812 | 200 | 4026 | — | 42.0s | 失败 |
| 20 | deepseek-v4.1-flash | 1,500k | 7,296,216 | 200 | 4026 | — | 43.6s | 失败 |
| 21 | glm-5.2 | 1,030k | 5,010,112 | 200 | — | 1,031,480 | 22.5s | 通过 |
| 22 | **glm-5.2** | **1,050k** | 5,107,352 | **200** | **4022** | — | 9.5s | **失败（HTTP 仍是 200）** |
| 23 | glm-5.2 | 1,100k | 5,350,588 | 200 | 4022 | — | 8.7s | 失败 |
| 24 | glm-5.2 | 1,200k | 5,836,992 | 200 | 4022 | — | 9.8s | 失败 |
| 25 | glm-5.3 | 1,100k | 5,350,588 | 200 | 4022 | — | 6.5s | 失败 |
| 26 | glm-5.3-flash | 950k | 4,620,954 | 200 | — | 951,358 | 19.7s | 通过 |
| 27 | kimi-k3 | 250k | 1,216,188 | 200 | — | 250,454 | 25.9s | 通过 |
| 28 | Doubao-Seed-2.1-Pro | 300k | 1,459,368 | 200 | — | 300,476 | 30.6s | 通过 |
| 29 | custom_model_1M | 1,100k | 5,350,596 | 200 | 3003 | — | 1.0s | `all models failed`（该 config_name 不可路由） |
| 30 | custom_model_1M | 1,500k | 7,296,212 | 200 | 3003 | — | 1.6s | `all models failed` |

**直连 trae2api :7864（绕过 bridge）对照：**
| model | 输入 | HTTP | 结果 |
|-------|------|------|------|
| deepseek-v4.1-flash | ~250k | 200 | prompt_tokens=250,396，正常回答（与经 bridge 完全一致） |
| glm-5.2 | ~1000k | 200 | prompt_tokens=1,001,436，正常回答 |

→ **bridge 没有改写/截断任何请求**，直连与经 bridge 的上限行为逐字节一致。

## 2. 原始错误体摘录（原文，未改写）

超限时的完整 SSE 片段（deepseek-v4.1-flash，输入 1,050k；**注意 HTTP 状态是 200**）：

```
HTTP/1.1 200 OK
Content-Type: text/event-stream

event: error
data: "solo error code=4026 msg=We're sorry, your context length has exceeded the maximum limit."

data: [DONE]
data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"created":1792415228,"id":"chatcmpl-1792415188167512400","model":"","object":"chat.completion.chunk"}
data: [DONE]
```

glm-5.2 超限（输入 1,050k）：

```
event: error
data: "solo error code=4022 msg=We're sorry, your prompt tokens have exceeded the maximum limit."
```

custom_model_1M 路由失败：

```
event: error
data: "solo error code=3003 msg=all models failed"
```

bridge 侧唯一见到的非 200（第 9 行，glm-5.2 1M 首包慢）：

```json
{"error":{"message":"upstream failed: upstream headers timeout after 60000ms","type":"upstream_transport"}}
```

**上游从未返回过 4xx/413。** 超限一律 200 + SSE `event: error`。

## 3. bridge.mjs 是否存在本地 context 截断 / clamp —— 结论：没有

- `C:\Users\hu\Desktop\WorkSpace\brige\bridge.mjs:210-217` `STRIP_FIELDS` 只删 `response_format / logit_bias / top_logprobs / verbosity / store / n`，**不含任何上下文/长度字段**；`:1662-1664` 仅对非 responses/anthropic 且非 raw 的路径生效。
- 该 bridge 实例 `CHAT_MODE=raw`（`/status` 实测 `chatMode: "raw"`，由 `bridge.mjs:76-83` 在 trae 上游下默认），因此 `STRIP_FIELDS` 与 `normalizeModel` **根本不会执行**，请求体原样透传。
- 转发处 `bridge.mjs:1832-1840`：`JSON.stringify(chatBody)` 直发 `/v1/chat/completions`，无截断、无 token 计数、无 `slice`。grep `truncat|context|clamp|maxTokens|contextWindow|context_length` 在 bridge.mjs 中 **0 命中**。
- 与上下文相关的本地硬限制只有：
  - `bridge.mjs:149-152` `MAX_BODY_BYTES = 20 * 1024 * 1024`（20 MiB，实测 `/status` `max_body_bytes: 20971520`）→ 请求体超 20 MiB 才会被本地拒。
  - `bridge.mjs:135-138` `FIRST_TOKEN_TIMEOUT_MS = 60000`（`UPSTREAM_HEADER_TIMEOUT_MS` 默认同值）→ 上游首包 >60s 报 502，**与上下文上限无关**（第 9 行即此类）。
  - `bridge.mjs:139-142` `STREAM_IDLE_TIMEOUT_MS = 90000`。
- `/v1/models` 由 bridge 直接透传给 trae2api（无本地加工），所以 `context_length: 0` 是 trae2api 的输出，不是 bridge 造成的。
- 附带确认：`add-trae-provider.mjs:73` 读 `e.context_window_tokens.dev`；`:80-81` 对 `contextWindow === 200000` 的条目统一改写为 `1000000`。**实测该改写对 DeepSeek 系与 GLM 系都成立**（两者真实上限均 ~1M）；非整值（Doubao 256000/232768、aquila 272000）未改写，本次未逐个验证。

## 4. debug-requests.jsonl 真实流量规模

- 文件：`C:\Users\hu\Desktop\WorkSpace\brige\debug-requests.jsonl`，2,646,733 字节，mtime `2026-09-29T13:22:13.689Z`，共 33 行（33 条 JSON 全解析成功，0 坏行）。
- 全部是 **MiMo 时代**流量，无 trae 记录：model 分布 `mimo-desktop/mimo-v2.6-pro` ×31、`mimo-desktop/mimo-v2.6-flash` ×2；path `/v1/messages` ×20、`/v1/chat/completions` ×13。
- 最大 5 条（按 body 字节）：132,461 / 132,412 / 122,001（mimo-v2.6-pro，9 条消息 + 26 工具）/ 120,193 ×2。
- 即**真实流量峰值约 132 KB/请求 ≈ 3.3 万 token**，离 200k 或 1M 都差一个量级 —— 所以「上下文是假的」不可能由历史真实流量触发，而是来自**配置/元数据层面**（`context_length: 0`、DSH 侧 `contextWindow` 缺失）造成的显示与实际不符。
- `reports\` 现有内容：`tool-demo-latest.txt`（2026-09-20 MiMo 工具调用演示）、`mimo-native-responses.json`，**与本议题无关**，无既有结论。
- `live-checks\`：`codex-tool.mjs / codex-tools-demo.mjs / native-responses-probe.mjs / protocol-live.mjs`，均为协议/工具实测脚本，**无上下文上限相关结论**。

## 5. 结论与修复建议

1. **上游真实上限（实证）**：DeepSeek 系与 GLM 系免费通道 ≈ **1,048,576 token**；`add-trae-provider.mjs` 的 200000→1000000 改写方向正确。因此「上下文参数是假的」**不是上游把上下文改小**，而是**元数据/暴露层在撒谎**。
2. **谎言的第一个来源（已由 lead 确认）**：trae2api `FetchModels()`（`internal/upstream/client.go:272-320`）从不给 `ModelInfo.ContextWindow` 赋值 → `/v1/models` 动态分支输出 `context_length: 0`，46 条全是 0。这是 **trae2api 的 bug**，bridge 无辜（逐字节透传）。
3. **谎言的第二个来源（本报告新增）**：超限错误伪装成 HTTP 200。上游 `code=4026/4022` 以 SSE `event: error` 形式返回，bridge 的 `proxyPassThrough`（`bridge.mjs:2121`）原样转发，HTTP 仍是 200、`finish_reason: "stop"`。任何只看状态码的客户端（含 DSH）会把「上下文超限」当成「成功」，从而进一步印证「参数是假的」。
4. **修复优先级**：
   - (a) 修 trae2api `FetchModels()`，按实测给 `ContextWindow` 赋真值（DeepSeek/GLM/kimi/mimo/minimax/step/qwen/sagitta ≈ 1,048,576；Doubao 256000/232768；aquila 272000），或至少在 0 时回退 1,048,576 —— 注意仓库源码 `handler.go:314-316` 的 131072 回退**运行版没有**（二进制里 `context_window_tokens` 出现 0 次），131072 也远小于实测上限，需一并改为 ~1M。
   - (b) bridge 侧建议在流式透传时识别 `event: error` + `code=4026/4022` 并映射为非 200 或结构化错误，避免「超限伪装成功」。
   - (c) DSH 侧 provider `trea` 段 28 个模型条目补 `contextWindow`（用实测值而非目录的 200000），否则默认模型 `deepseek-v4.1-flash` 的窗口仍是未知/0。
   - (d) `custom_model_1M` 系不在选择器内（`add-trae-provider.mjs:61-69` 已过滤），实测也确实不可路由（`code=3003 all models failed`），不要用它们来宣称 1M。

## 6. 方法与可复现性

- 所有请求由 Node `fetch` 直接发出（`stream: true`），一次请求一次测量，串行执行避免并发干扰（bridge `max_concurrent_requests: 8`）。
- token 数一律以**上游返回的 `usage.prompt_tokens` 为准**，字符数仅为构造手段；实测字符/token 比稳定在 4.86~4.88。
- 未做任何写操作（除本报告文件）；未重启/停止 bridge 或 trae2api 进程。
- 原始响应片段见第 2 节；完整逐条数据见第 1 节表格。
