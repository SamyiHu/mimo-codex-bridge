# 底层机制：从 magpie 借什么，怎么落到 brige 上

参考对象：[yetone/magpie](https://github.com/yetone/magpie)（Go，本地模型网关，~38k stars）。
本文只谈机制，不谈 UI（UI 那份在 `docs/ui-magpie-reference.md`）。

所有 magpie 侧的结论都来自它的源码文档：`docs/reference.md`（Routing groups、How magpie picks an account）、`docs/subsystems/gateway-routing.md`、`docs/subsystems/providers-accounts.md`、`docs/subsystems/gateway-sessions.md`、`docs/subsystems/plugin-runtime.md`。
所有 brige 侧的结论都标了行号，来自 `bridge.mjs` / `protocol-state.mjs` / `panel.mjs`。

---

## 0. 一句话

**你现在写的是"管道"，magpie 写的是"调度 + 账本"。**

```
brige 现在：
  Codex ──▶ bridge :8788 ──▶ 一个上游（进程启动时钉死 UPSTREAM_KIND）
                              └─ mimo 端口扫描 或 workbuddy2api:7863 或 trae2api:7864

magpie：
  Agent ──▶ gateway :3425 ──▶ routing group ──▶ provider ──▶ accounts[] ──▶ keys[]
                                 ↑ 每次请求重新算一次
```

差别不在"支不支持多上游"，而在**决定谁来回这个请求的那件事，发生在什么时刻**。
你是启动时（`bridge.mjs:65` 的 `UPSTREAM_KIND` 是 `const`），它是每次请求。

---

## 1. 机制对照

| # | 机制 | magpie | brige 现状（锚点） | 差距 |
| --- | --- | --- | --- | --- |
| 1 | 上游选择 | 每次请求在注册表上路由 | `UPSTREAM_KIND` 常量，切换 = 重启进程（`bridge.mjs:65`，面板 footer 也写着"切换上游会重启 bridge"） | **架构级** |
| 2 | 凭据模型 | provider → accounts[] → keys[]，每个账号独立 token / 代理 / 并发 | 一个模块级 `TOKEN`（`bridge.mjs:277`），`fetchUpstream` 里硬编码 `Bearer TOKEN`（`:894`） | **架构级** |
| 3 | 排序算法 | 六步判定 + 七种 routing（smart/order/rotate/usage/pace/weight/fast） | 无（只有一个 engine） | 已补：`router.mjs` |
| 4 | 额度账本 | 每账号多窗口（5h/日/周/月）、share + resetsAt、90%/98% 两道门槛 | 无。额度数据长在面板插件里（`workbuddy-credits.mjs` 读 billing/checkin、`trae-accounts.mjs` 读账号池） | 新能力 |
| 5 | 会话粘性 | `stays=auto/session/turn/off/strict`，auto 还看 prompt cache ≥1024 token / 5 分钟 | 无粘性：重启或换上游就漂 | 新能力 |
| 6 | 故障处理 | resting（失败就休息，永不剔除）+ 429 沉底，粒度是账号 | 全局熔断 3 次 / 5 秒（`bridge.mjs:195-202`）+ 一次重发现重试 | 粒度不对 |
| 7 | 协议面 | OpenAI Chat / OpenAI Responses / Anthropic / Gemini 四入口互转 | Responses / Chat / Anthropic 三入口（已经很强），缺 Gemini | 小 |
| 8 | 会话状态 | 会话聚合（读各 agent 自己的会话文件） | `ResponseStore`：`previous_response_id` / `item_reference` / 后台响应，内存 TTL（`protocol-state.mjs`） | **你更强**，但要补一个字段 |
| 9 | 扩展点 | 五类：observer / router strategy / middleware / tool / budget（Bun） | 无请求链路钩子；`panel-plugins` 只是面板卡片 | 中期 |
| 10 | 配置回写 | 原子写 + 保注释 + profiles + 可回滚 | 只写自己的 `panel-settings.json`；cc-switch 要手动/重启 | 中期 |
| 11 | 打码 | 本地占位符，回包还原 | 无 | 低（单机，但上游是云端） |
| 12 | 账号发现 | 读 Claude Code / Codex 登录态、Keychain | 读 `token.txt` / `bridge-secret.txt` | **不抄**：边界本来就对 |

结论：**1、2、4、5、6 是同一件事的五个面**——把"谁答"从启动参数变成请求时的决策，并给这个决策配一本账。
3 已经把算法部分落地了（见 §6），剩下的是把它接到请求链路上。

---

## 2. 机制一：上游注册表 + 每请求路由

### 为什么它是根

- 切上游要重启进程 → 面板的"切换"必然是一个破坏性动作（会打断正在跑的对话），所以你只能在 UI 上把它做成"大卡片 + 确认感"，做不出 magpie 那种"点一下换模型，下一次请求生效"。
- 一次只能挂一个上游 → mimo / workbuddy / trae 三家的模型不能同时出现在一个模型列表里，也没法"贵的模型走 A，便宜的走 B"。
- `UPSTREAM_KIND === "mimo"` 这类判断散在请求构造、模型列表、reasoning 归一化里（§5 详述），每加一家都要动 5 个函数。

### magpie 怎么做

provider 是配置里的一条，account 是 provider 下的一个凭据，group 是"几个模型当一个用"（`group/<id>`）。
请求进来只做三件事：解析出目标（裸 id / `provider/model` / `group/id`）→ 让路由层按 §3 的六步排序 → 拿第一个可用目标的 base + key 发出去。

### 你该怎么做

新增 `upstreams.json`（和 `panel-settings.json` 放一起，面板负责编辑）：

```json
{
  "upstreams": [
    { "id": "mimo", "kind": "mimo", "base": "", "tokenFile": "token.txt",
      "capabilities": { "needsDiscovery": true, "modelPrefix": "mimo-desktop" } },
    { "id": "wb", "kind": "openai", "base": "http://127.0.0.1:7863", "tokenFile": "workbuddy-api-key.txt",
      "capabilities": { "chatMode": "raw", "modelPassthrough": true } },
    { "id": "trae", "kind": "openai", "base": "http://127.0.0.1:7864", "tokenFile": "trae-api-key.txt",
      "capabilities": { "chatMode": "raw", "modelPassthrough": true, "enrichModels": "trae" } }
  ],
  "groups": [
    { "id": "daily", "models": ["mimo/mimo-desktop/mimo-v2.6-pro", "wb/cn:glm-4.6", "trae/glm-4.6"],
      "routing": "smart", "stays": "auto" }
  ]
}
```

改造点，都在这三个函数里：

1. `resolveUpstream(entry)` → `{ base, token }`：mimo 走现有的 `discoverEngine()`（`bridge.mjs:444`，端口扫描 + PID 缓存），openai 型直接读 `base`。token 按文件 mtime 缓存，别每个请求读盘。
2. `fetchUpstream(target, init, ...)`（`:870`）现在自己拼 `Authorization: Bearer TOKEN`；改成接受 `token` 参数（或 `target.auth`）。
3. `handleApiRequest`（`:1654`）在解析出 model 之后调 `pickRoute(...)` 选一次，把结果里的 `upstreamId` 带进后续所有调用。

面板那边：`doSwitch()` 从"写配置 + 重启 bridge"变成"写 `activeGroup`"，重启按钮保留（用于引擎换了、端口变了这种真需要重启的情况）。

> 这一步做完，你才真正拥有"多上游"；在此之前加任何路由都是纸上谈兵。

---

## 3. 机制二：额度账本（比路由算法更值钱）

### magpie 的模型

一个账号有多个**窗口**（5 小时、日、周、月），每个窗口有 `usedPct` 和 `resetsAt`。
判定只看**最满的那个窗口**：

- ≥ 90% → 新对话排到别人后面（但已经在它上面的对话不动，直到 98%）
- ≥ 98% → 视为满，只服务已经粘在它上面的会话
- = 100% → 不试（Strict 除外）
- 重置时间**按小时比较**（13:55 和 14:05 不同小时，14:05 和 14:55 同小时）
- `pace` = 剩余比例 ÷ 距重置的小时数，越大越优先——这样一周的额度不会在重置前白白作废

### 你现在有什么

数据不在 bridge 里，在面板插件里：

- `panel-plugins/workbuddy-credits.mjs`：读 `/healthz` + `codebuddy.cn/v2/billing/meter/daily-checkin`，能算出签到额度
- `panel-plugins/trae-accounts.mjs`：读 trae2api 的账号池 + 每个账号状态
- `workbuddy-tasks.mjs`：定时任务（顺带证明这些接口是可轮询的）

问题是：**bridge 看不见这些**，所以它做不了任何"因为额度不够所以换一家"的判断。

### 建议

抽一个 `quota-source.mjs`，bridge 和面板共用：

```js
// 返回形状与 router.mjs 的 candidate.quota 对齐
{ upstreamId, accountId, share, resetsAt, stale, readAt }
```

规则：

- **TTL 60 秒**，额度接口不该每个请求都打；
- 读失败**保留旧值**并标 `stale: true`（router 照用，但面板显示"数据 3 分钟前"）；
- 不知道就返回 `null`，**不要返回 0**——"不知道"和"没用过"在排序里是两种位置（magpie 也是这么分的）。

拿到 share/resetsAt 之后，`router.mjs` 不用改一行，它已经按 90/98 和 pace 排好了。

---

## 4. 机制三：会话粘性，和它必须对齐的那个字段

### magpie 的规则（可以砍到三档）

- `strict`：这条对话钉死在它的账号上，休息、满额、报错都不换
- `auto`：默认。同一轮内粘住；跨轮还要看"上次请求读了 vendor 的缓存且写了 ≥1024 token，并且 5 分钟内答过"
- `off` / `turn` / `session`：不粘 / 每轮换 / 每条会话一个账号

### 你必须先解决的那个坑

`ResponseStore`（`protocol-state.mjs`）现在只记协议状态。一旦引入多上游，**`previous_response_id` 的续写必须回到原来那个上游**——因为上游的会话缓存不共享，换个上游去续写等于把上下文丢了，模型还不一定认这个 id。

所以：`rememberResponse()` 存的记录里加两个字段 `upstreamId`、`model`；后续请求带 `previous_response_id` 时，路由层**先查这个绑定**，再谈排序（等价于 magpie 的 `stays=strict`，但原因不同：你是协议要求，它是缓存优化）。

> 这是"路由"和"协议状态"两个子系统唯一必须对齐的地方。先做这一个字段，比先做十种 routing 模式有用。

---

## 5. 机制四：能力表替代 if 链

现在上游差异是散在代码里的：

| 位置 | 判断 | 在管什么 |
| --- | --- | --- |
| `bridge.mjs:487` | `UPSTREAM_KIND === "mimo"` | 端口发现 |
| `:694` | `=== "mimo"` | 模型列表兜底 |
| `:732` | `!=="workbuddy" || id.includes(":")` | 模型 id 前缀 |
| `:1512` / `:1551` / `:1573` | `=== "mimo"` / `=== "trae"` / `!== "trae"` | 模型列表装饰 |
| `:1953` | `=== "mimo"` | `mapThinkingToReasoning` |
| `:1965` / `:1968` / `:2001` | `=== "mimo"` | thinking budget / reasoning 开关归一化 |

一共 10 处 `UPSTREAM_KIND ===/!==` + 13 处 `PASSTHROUGH_UPSTREAM` + 6 处 `RAW_CHAT`。
加第四家上游时，你得把这 29 处都读一遍才知道要改哪里——这就是它一年多能在 100 个 agent 上活下来的原因：**它是数据驱动，不是 if 驱动**。

建议的能力表（挂在 registry 的每条上游上）：

```js
{
  needsDiscovery: false,        // 要不要扫端口（mimo）
  chatMode: "raw" | "compatible",
  nativeResponses: false,       // 上游原生 Responses 吗（决定转不转 Chat）
  modelPrefix: "off" | "mimo-desktop",
  modelPassthrough: true,       // 模型 id 原样透传
  enrichModels: null | "trae",  // 模型列表装饰器
  reasoningEffort: "normalize" | "strip" | "pass",
  thinkingBudget: "map" | "pass",
  toolCallGuard: true,          // 需要"只说不做"时补一次工具调用（你已有 shouldGuardToolCall）
}
```

好处不只是好维护：新增一家上游 = 加一段 JSON + 可能一个 `enrichModels` 函数，**不动请求路径**。

---

## 6. 机制五：请求钩子（最小版，别学它的 Bun 运行时）

magpie 有五个扩展点（observer / router strategy / middleware / tool / budget），跑在 Bun 里。你没这个需求，但**一个钩子点**是有用的：

```js
// hooks/before-request.mjs
export default function (ctx) {
  // ctx: { upstreamId, model, body, headers, requestId, sessionId }
  // 返回新 ctx 或 undefined（不改）
}
```

用途（都是你已经在做的临时活）：注入 `prompt_cache_key`、给 trae 裁上下文（你 `reports/` 里那几份 trae-context 报告做的手工活）、按模型统计真实花费。

规则照它抄：**钩子抛异常只记日志，绝不能挡住请求**；钩子有超时（比如 200ms），超时就跳过。

---

## 7. 明确不抄

| 不抄 | 原因 |
| --- | --- |
| 100+ agent 的配置回写、profiles | 你只有 Codex 一家，cc-switch 已经在做；这是它的护城河，不是你的刚需 |
| 订阅登录态发现（Keychain / plist） | 你的上游是本地网关，凭据本来就是你自己的文件——这个边界是对的，别退化 |
| Bun 插件运行时、插件市场 | 你的 `panel-plugins` 是 3 个本地 .mjs，够用 |
| Docker / Termux / 四语 / 菜单栏 | 单机 Windows 工具 |
| 完整的 5h/日/周/月窗口建模 | 没有真实窗口数据之前，先建账本就是给自己找 bug；先用 share + resetsAt 两个数 |

---

## 8. 不变量（改这些时不能破）

1. **流已经开始写就不能换上游**。可重试窗口只到"还没写出第一个字节"。你的 `proxyResponsesStream` / `proxyAnthropicStream` 在写第一段 SSE 之前是唯一合法的换手点；写之后只能报错，不能重放。
2. **`previous_response_id` 绑定 upstreamId + model**（见 §4）。跨上游续写 = 丢上下文。
3. **并发上限按上游分桶**。`MAX_CONCURRENT_REQUESTS`（`:185`）现在是全局的；多上游之后别让它变成 N 倍，也别让一个上游把全局槽位吃满。
4. **熔断从全局变每上游**（`:195-202` 现在是 3 次/5 秒全局），但保留一个全局急停。
5. **秘密处理不动**：常量时间比较（`:642`）、Host 白名单（`:226`）、`bridge-secret` 与上游 token 分离——这三条你比 magpie 单机版更讲究，别为了路由把上游 token 拼进日志。
6. **面板的"切换上游"交互保留**：新路径（改选择，瞬间生效）默认，老路径（重启）留作兜底。

---

## 9. 四步落地（每步可独立回滚）

| 步 | 内容 | 验收 | 成本 |
| --- | --- | --- | --- |
| **0（已完成）** | `router.mjs`（排序）+ `upstream-registry.mjs`（注册表解析 / 模型解析 / 摊候选）+ 23 条单测 | `npm test` 全绿；bridge 一行没动，行为零变化 | 已做 |
| 1 | `upstreams.json` 落地（照 `upstreams.example.json`）+ `resolveUpstream()` + `fetchUpstream` 收 per-upstream token | 仍只注册一个上游；`/health` 字段不变；抓一次请求确认 Authorization 来自该上游的 token 文件 | 0.5–1 天 |
| 2 | `handleApiRequest` 里选一次 target；`/status` 列出所有上游健康；面板切换不重启 | `curl :8788/v1/models` 能同时看到三家模型；切换后第一次请求即生效，且旧对话（带 previous_response_id）仍回原上游 | 1–2 天 |
| 3 | `quota-source.mjs` + 账本 + 面板配额卡；router 用真实 share/resetsAt | 面板显示每家"已用 x% · y 后重置"；把一家手动标成 95% 后新对话不再选它 | 2 天 |
| 4 | 会话粘性（ResponseStore 加 upstreamId）+ 首字节前重试 + 能力表重构 if 链 | 造一次上游 500：首字节前自动换家；首字节后只报错不重放；29 处 if 降到 0 | 2 天 |

---

## 10. 已落地的第 0 步：`router.mjs`

纯函数，无 I/O，无依赖。签名：

```js
import { chooseRoute, pickRoute } from "./router.mjs";

const r = pickRoute({
  now: Date.now(),
  routing: "smart",              // smart|order|rotate|usage|pace|weight|fast
  stays: "auto",                 // auto|session|turn|off|strict
  sink: true,                    // 429 沉底
  session: { lastAnsweredId: "wb-A" },
  turn: 3,                       // rotate 用
  weights: {},                   // weight 模式的游标，把返回的 nextWeights 存起来
  candidates: [
    { id: "wb-A", quota: { share: 0.25, resetsAt: Date.now() + 7200_000 } },
    { id: "trae-B", quota: { share: 0.95, resetsAt: Date.now() + 3600_000 } },
    { id: "mimo-C", quota: null },                       // 额度未知：排在健康的之后、≥90% 的之前
    { id: "fb", kind: "fallback" },                      // 兜底模型：排在账号之后
  ],
});

r.chosen;      // "wb-A"
r.order;       // [{ id, reason }] —— reason 直接给面板显示
r.dropped;     // 被剔除的（暂停 / 不服务该模型 / 已满额）及原因
r.notes;       // 这次排序用到的规则说明，给日志
```

它实现的就是 magpie 的六步，减去两样东西：窗口语义（由调用方把最满窗口算成 `share/resetsAt`）、以及订阅额度抓取（那是 `quota-source.mjs` 的事）。

测试覆盖：smart 的重置优先与 90/98 门槛、满额剔除、全不可用、usage、pace、order、rotate、weight 3:1 平滑、429 沉底、fallback 后置、resting 沉底不剔除、会话粘性、Strict 满额也钉住、阈值常量。

---

## 11. 已落地的第 0.5 步：`upstream-registry.mjs`

路由算法之外，另一半是"模型 ID 到底该问谁"。这部分也是纯函数：

```js
import { parseRegistry, resolveModel, candidatesFor } from "./upstream-registry.mjs";
import { chooseRoute } from "./router.mjs";

const { upstreams, groups, errors } = parseRegistry(JSON.parse(readFileSync("upstreams.json", "utf8")));
if (errors.length) throw new Error(errors.join("\n"));

// "group/daily" / "wb/cn:glm-4.6" / "mimo-desktop/mimo-v2.6-pro" / 裸 ID
const { ok, candidates, group } = candidatesFor(registry, body.model, quotas, health, { catalog });

const route = chooseRoute({
  routing: group?.routing ?? "smart",
  stays: group?.stays ?? "auto",
  candidates,
  session: { lastAnsweredId: responseStore.lastUpstream(req) },
});
```

它管四件事：

1. **校验**：id 重复、kind 不认识、openai 型没 base、路由组成员没写成 `provider/model`、routing/stays 拼错 —— 一次报全，不静默吞。
2. **模型解析**：`group/<id>` → 路由组；`<upstream>/<model>` → 指定上游；裸 ID → 先查各家的模型目录（`/v1/models` 的结果），目录里只有一家有就是它，多家有就报 ambiguous 让你写成 `provider/model`；只有一家上游时直接给它。
3. **候选摊平**：路由组的成员按配置顺序摊成 candidates，各自带上该上游的额度快照；单上游把自己的兜底模型挂在后面（`kind: "fallback"`，id 不撞）。
4. **能力表**：`needsDiscovery / chatMode / modelPrefix / modelPassthrough / enrichModels / reasoningEffort / thinkingBudget / toolCallGuard / fallbackModel` —— §5 那 29 处 if 的替代品。

**一个刻意的设计**：`modelPassthrough` 只表示"模型 ID 原样透传"，**不表示**"我能服务任何模型"。早期版本让它参与裸 ID 解析，结果三家上游都声称能服务 `glm-4.6`，永远 ambiguous。真正的归属由模型目录决定——这也是 magpie 的做法（模型列表来自 vendor，不是猜的）。

---

## 12. 落地记录（2.9）

四步是分批做的，最后都落在这一版里。默认关闭：**没有 `upstreams.json` 时走原单上游路径**，行为与 2.8 一致。

| 步 | 落成的东西 | 验证 |
| --- | --- | --- |
| 0 | `router.mjs`、`upstream-registry.mjs` + 23 条单测 | 已跑通 |
| 1 | `bridge.mjs`：`resolveUpstream`（mimo 端口发现 / openai 固定 base）+ `readUpstreamToken`（按 mtime 缓存）+ `fetchUpstream` 收 per-upstream token | 语法闸门 + 单测（路由层） |
| 2 | `handleApiRequest` 每请求选一次 target；`/v1/models` 合并多上游；`/status.routing`；面板"路由"卡 | 同上 |
| 3 | `quota-source.mjs`（TTL 60s / 失败保旧值标 stale / 未知=null）、`quota.json`、面板额度条 | 5 条单测 |
| 4 | `stays` 会话粘性（`prompt_cache_key` 亲和一个上游）、`previous_response_id` 钉上游（`ResponseStore.meta`）、能力表 `UPSTREAM_KIND` if 全清、`hooks.mjs` before-request 钩子 | 单测 + 语法闸门 |

**为什么"能力表"这步看起来只是一次字符串替换**：`UPSTREAM_KIND === "mimo"` 的 8 处判断被换成 `isMimoUpstream()`，而这个函数在有路由时读当前请求选中的上游能力、没路由时读启动参数。所以旧路径语义不变，新路径按上游走。

**补的一条**：跨上游 failover 落地时才发现"换家要换模型 ID"——路由组的成员本来就是不同模型，所以 `fetchUpstreamWithFailover` 每一跳都用 routeKey（客户端要的 `group/x`）重新选，再用选中的成员模型重新序列化请求体。第一版拿成员模型去重选，直接掉进 "multiple upstreams can serve x" 的歧义里，E2E 当场抓住。

**没做的一条**（故意）：没有替你生成 `upstreams.json`。多上游一开就会改变模型 ID 的形状（`provider/model`），在没有跑过真实请求之前切换默认行为是不负责任的。复制示例、重启、`curl /v1/models` 看一遍，再决定要不要保留。
