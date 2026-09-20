# mimo-codex-bridge

用 **MiMo Desktop 的订阅套餐**驱动 **Codex** —— 本地桥接，**不需要官方 API key**。

```
Codex ──/v1/responses──► mimo-bridge (127.0.0.1:8788)
                              │  1. Responses ⇄ Chat Completions 翻译
                              │  2. 注入本地自签 token + ?directory=<实例目录>
                              │  3. 自动发现引擎端口（每次桌面端重启都会变）
                              └──/v1/chat/completions──► MiMo Desktop 内嵌引擎 ──► 你的套餐
```

## 为什么要桥接

MiMo Desktop 的订阅额度没有暴露 API key，但它的进程里内嵌了一个 MiMoCode 引擎：

- 在某个随机回环端口上提供 **OpenAI 兼容** 的 `/v1/chat/completions`（模型 id 形如 `xiaomi/mimo-x-pro-preview`）；
- `/v1` 的鉴权是引擎自己签发的 **本地 token**，校验方式是「对提交值现算 sha256 与 `tokens.json` 里的记录比对」——所以本地自签一个即可；
- token 与「实例目录」绑定，存储位置 `<state>/llm-server/<sha1(realpath(实例目录))>/tokens.json`，Windows 上 `<state>` 通常是 `%APPDATA%\Xiaomi MiMo\mimocode`；
- 该文件**必须是 UTF-8 无 BOM**，否则引擎 `JSON.parse` 失败，等于整个文件作废；
- 新版 Codex 只支持 `wire_api = "responses"`（`"chat"` 已被移除），所以桥接里带了 Responses ⇄ Chat 的翻译层。

## 前置条件

- MiMo Desktop 已安装并**登录**（引擎随它启动、随它退出）
- Node.js ≥ 18（用到全局 fetch / AbortSignal.timeout）；本仓库在 Node 26 上验证过
- Windows（端口发现用了 `netstat` / `tasklist`；macOS/Linux 需要另写发现逻辑）

## 快速开始

```powershell
# 1) 生成/复用 token，并写进引擎的 token 存储（会自动建 ~/.mimo-bridge）
node mint-token.mjs

# 2) 启动桥接（默认 127.0.0.1:8788，只监听回环）
node bridge.mjs
#   或后台启动： pwsh -File .\start-bridge.ps1

# 3) 看状态
curl http://127.0.0.1:8788/health
#   {"ok":true,"engine":"http://127.0.0.1:64765","instanceDir":"C:\\Users\\<you>\\.mimo-bridge"}

# 4) 让 Codex 用它
pwsh -File .\apply-mimo-provider.ps1 -ApiKey (Get-Content .\token.txt -Raw).Trim() -MakeDefault
```

`apply-mimo-provider.ps1` 会先备份 `~/.codex/config.toml`，再写入：

```toml
model_provider = "mimo"
model = "xiaomi/mimo-x-pro-preview"
model_reasoning_effort = "high"

[model_providers.mimo]
name = "mimo"
base_url = "http://127.0.0.1:8788/v1"
wire_api = "responses"
requires_openai_auth = false
experimental_bearer_token = "<token.txt 的内容>"
```

不加 `-MakeDefault` 就只加 provider、不改默认；临时调用可以：

```powershell
codex exec -c model_provider=mimo -c model=xiaomi/mimo-x-pro-preview "say hi"
```

可用模型：`xiaomi/mimo-x-pro-preview`、`xiaomi/mimo-pro`、`xiaomi/mimo-flash`、`xiaomi/mimo-auto`。

## 用 cc-switch 管理（可选）

cc-switch 切换供应商时会**整份重写** `~/.codex/config.toml`（供应商片段 + 公共配置合并），所以手改配置会在下次切换时被覆盖。

在 cc-switch 里「添加供应商」：名称 `Xiaomi MiMo (Desktop)`、Base URL `http://127.0.0.1:8788/v1`、密钥填 `token.txt`，
配置框粘贴 [`cc-switch-provider.toml`](./cc-switch-provider.toml) 的内容即可。

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `/health` 显示 `"ok": false` | 桌面端没开，或 token 没写进实例目录对应的桶 | 先开桌面端，再 `node mint-token.mjs` |
| `401 invalid_api_key` | 同上；或 `tokens.json` 被写成带 BOM | 重跑 `mint-token.mjs`（Node 写出的文件无 BOM） |
| `400` 提示某字段不支持 | 引擎对不支持的字段是拒绝而不是忽略 | 把该字段加进 `bridge.mjs` 的 `STRIP_FIELDS` |
| `404 model_not_found` | 模型名少了 provider 前缀 | 用 `xiaomi/...` 全名 |
| 端口发现失败 | 桌面端换了端口且探测超时 | 打开 `MIMO_BRIDGE_DEBUG=1` 看日志；`/health` 会重新发现 |
| Codex 提示 `Model metadata ... not found` | 模型目录里没有对应条目 | 只是警告，不影响使用 |

## 安全与合规

- `token.txt` 是本机凭据，**已被 `.gitignore` 排除**；它只对你这台机器上的引擎有效（按实例目录绑定）。
- 桥接只监听 `127.0.0.1`，不对外暴露；不要把它改成 `0.0.0.0`。
- 走的是客户端内部接口，**未公开**：桌面端升级后可能失效。
- 用订阅套餐做程序化调用通常不符合服务条款，账号风控自负。

## 卸载

```powershell
# 1) 恢复 Codex 配置（apply 脚本生成的备份）
Copy-Item "$env:USERPROFILE\.codex\config.toml.bak-<时间戳>" "$env:USERPROFILE\.codex\config.toml" -Force

# 2) 删掉自签的 token 桶（先看清桶名，再删）；或用 cleanup-buckets.mjs 自动清理
node cleanup-buckets.mjs

# 3) 删掉实例目录与 token
Remove-Item -Recurse -Force "$env:USERPROFILE\.mimo-bridge", ".\token.txt"
```

## 文件

| 文件 | 作用 |
| --- | --- |
| `bridge.mjs` | 桥接服务：Responses ⇄ Chat 翻译、端口发现、SSE 透传 |
| `responses.mjs` | Responses API 与 Chat Completions 的双向转换 |
| `mint-token.mjs` | 生成/复用 token 并写进引擎的 token 存储 |
| `cleanup-buckets.mjs` | 清理自签留下的空桶（保留 MiMo 自己的 token） |
| `apply-mimo-provider.ps1` | 写入 `~/.codex/config.toml`（自动备份、幂等、可 `-MakeDefault`） |
| `start-bridge.ps1` / `stop-bridge.ps1` | 后台启停 |
| `cc-switch-provider.toml` | cc-switch 供应商配置模板 |

## 免责声明

非官方项目，与小米 / MiMo 无关，仅供本机互操作实验。使用风险自负。