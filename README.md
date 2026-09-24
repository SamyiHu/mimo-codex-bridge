# mimo-codex-bridge

让 **Codex** 通过本地桥接使用 **MiMo Desktop** 的模型能力。

```text
Codex ── bridge-secret ──▶ mimo-bridge (127.0.0.1:8788)
                              │
                              ├─ Responses ⇄ Chat Completions
                              ├─ 真实增量 SSE
                              ├─ 状态 / 指标 / 熔断
                              └─ MiMo token ──▶ MiMo Desktop Engine
```

当前版本：**2.5.0**。项目仅监听 `127.0.0.1`。MiMo Desktop 的内部接口不是稳定公开接口，客户端升级后可能需要再次适配。

## 两套凭据

升级后不再让 Codex 直接持有 MiMo 引擎令牌：

| 文件 | 用途 | 谁可以读取 |
| --- | --- | --- |
| `token.txt` | bridge 调用 MiMo 引擎 | 仅 bridge |
| `bridge-secret.txt` | Codex 调用本地 bridge | Codex 配置与 bridge |

```text
Codex ── bridge-secret ──▶ bridge ── token.txt ──▶ MiMo Engine
```

`mint-token.mjs` 会为两个文件设置本机用户权限。Windows 下还会通过 ACL 取消继承，并只授予当前用户完全控制。

不要把两个文件提交到 Git；它们都已被 `.gitignore` 排除。

## 2.1 基础升级

- Codex 与 MiMo 使用互相独立的凭据。
- 新增授权状态接口 `/status` 和指标接口 `/metrics`。
- 统计请求数量、状态码、模型、延迟、首个输出事件和真实 usage。
- 默认最多并发 8 个模型请求，可通过环境变量调整。
- 引擎连续失败 3 次后熔断 5 秒，并返回明确的 `503` 和 `Retry-After`。
- 可重试的 `408`、`429` 和 `5xx` 会先重新发现引擎再重试一次。
- 新增 `doctor.mjs`，自动检查 Node、bridge、MiMo 引擎、Codex 配置和实时请求。
- 新增统一管理入口 `mimo-bridge.ps1`。
- 新增可选的 Windows 登录自启动任务。
- 新增真实 Codex 工具调用测试。
- 指标里上游真实 usage 与本地估算值分开统计（2.4 起缺失 usage 由估算器补齐，见下）。

## 2.2 Responses 协议升级

- 实现临时 Responses 状态存储和 `previous_response_id`。
- 实现 `item_reference` 上下文引用与自动去重。
- 实现 `GET /v1/responses/{id}` 响应查询。
- 实现后台响应、取消和 `DELETE /v1/responses/{id}`。
- 实现 `store`、`metadata`、`service_tier`、`background`、`user`、`prompt_cache_key` 等字段映射。
- 实现 `text.format` JSON 结构化输出兼容；MiMo 不支持原生 `response_format` 时由 bridge 注入严格 JSON 约束并验证输出。
- 实现自定义工具 Responses ⇄ Chat 映射；MiMo 只接受 function tool 时由 bridge 做协议模拟。
- 完善图片、音频、文件输入，以及 refusal、annotations、usage details、finish reason 映射。
- 对 MiMo 无法执行的 hosted prompt/tool 返回明确协议错误，不再静默丢弃。

真实协议检查：

```powershell
npm run test:protocol-live
# 或
powershell -File .\mimo-bridge.ps1 protocol-live
```

检查 MiMo 是否在未来版本中原生支持 Responses：

```powershell
npm run probe:native
# 或
powershell -File .\mimo-bridge.ps1 native-probe
```

探测报告写入 `reports\mimo-native-responses.json`。

## 2.3 可靠性修复

- 修复流式输出中的中文乱码：SSE 解码改用 `StringDecoder`，UTF-8 字符不再被 chunk 边界切断。
- 修复「取消响应」只改状态不中断上游的问题：取消现在会真正断开上游连接，不再白跑完整个请求。
- 修复后台响应绕过并发上限的问题：`background` 请求现在同样受 `MIMO_BRIDGE_MAX_CONCURRENT` 约束。
- 修复并发额度把控制面一起挡掉的问题：取消、查询、删除、`/status`、`/metrics` 不再受数据面额度限制。
- 端口发现改为异步子进程：重新发现引擎时不再阻塞事件循环，在飞的流式响应不再出现约 260ms 的卡顿。
- 新增 Host 头校验，默认只接受 loopback 请求，缓解 DNS rebinding。
- bridge secret 比较改为常量时间比较。

## 2.4 Token 估算与 26.922 适配

- 适配 MiMo Desktop 26.922：模型 ID 统一为 `mimo-desktop/*`（引擎列表里的 `xiaomi/*` 需要云端 API Key）；后台响应路径补上模型兜底。

## 2.5 启动、配置边界与上下文修复

- 唯一推荐启动入口是 `启动 MiMo 桥.bat`；它只初始化 bridge 凭据并启动服务，不修改 Codex 的 model 或模型目录。
- cc-switch 是一等配置路径。bridge 只提供 `model_providers.mimo` 连接能力，模型继续由 cc-switch / 用户管理。
- 新增可选 `configure-codex`：直接写 Codex provider，但默认仍不改 `model`、`model_catalog_json`；`restore-codex` 可恢复原配置。
- 流式请求会向 MiMo 要求最终 usage chunk，Codex 的上下文统计优先使用上游真实 `prompt/completion/total_tokens`。
- 上游缺失 usage 时才使用本地估算：文本采用 tokenx 多语言规则，图片按尺寸和 512px 分块计数，不再忽略图片。
- `ImageView` 等工具返回的图片会作为多模态附件继续交给模型，不再序列化成大段 Base64 工具文本。
- `store=true` 的 Responses 状态会持久化到 `~/.mimo-bridge/responses-state.json`，重启 bridge 后仍可续接；活动响应不会被 TTL 或容量淘汰中断。
- `/status` 的 `metrics.usage` 只统计上游真实 usage，`metrics.usage.estimated` 单独统计估算值，不互相混计。
- `MIMO_BRIDGE_TOKEN_ESTIMATE=off` 可关闭估算。

## 前置条件

- MiMo Desktop 已安装并登录
- Windows（端口发现使用 `netstat` 和 `tasklist`）
- Node.js ≥ 18；当前已在 Node.js 24 上验证
- Windows PowerShell 或 PowerShell 7

## 快速开始

双击 `启动 MiMo 桥.bat`。它只做三件事：生成/复用凭据、启动 bridge、显示状态。

```powershell
powershell -File .\mimo-bridge.ps1 setup
```

然后在 **cc-switch 或 Codex 配置里自行选择模型**。bridge 不会写入默认模型，也不会接管模型目录。

若不想使用 cc-switch，可显式写入 provider 连接段；该命令仍不修改 model / model_catalog_json：

```powershell
powershell -File .\mimo-bridge.ps1 configure-codex
powershell -File .\mimo-bridge.ps1 restore-codex
```

无参数双击 `mimo-bridge.ps1` 时：bridge 在跑则显示 status；没跑则自动 start，窗口会停住显示结果，不会红窗一闪就关。

## 启动不起来 / 红窗一闪就关

按这个顺序排查：

1. **卡巴斯基 / 杀软误杀**  
   本仓库的 `node.exe` 子进程、`start-bridge.ps1`、`bridge.mjs`、`schtasks` 创建自启任务都可能被拦截，表现为：双击启动红字一闪、`spawn EPERM`、`Access is denied`、Codex 一直 `error sending request`。  
   请在卡巴斯基里为以下路径加**排除/信任**（或暂时退出防护再启动）：
   - 本仓库目录（`...\mimo-codex-bridge`）
   - `C:\Program Files\nodejs\node.exe`
   - 用户 Startup 目录下的 `MiMo-Codex-Bridge.bat`
   - `%USERPROFILE%\.mimo-bridge`
2. **PowerShell 脚本编码**  
   Windows PowerShell 5.1 要求 `.ps1` 使用 **UTF-8 with BOM**。若你改过脚本后中文注释处解析失败，先给文件补 BOM。
3. **权限**  
   `mimo-bridge.ps1 install-startup` 需要能创建计划任务；无管理员权限时用 Startup 文件夹方案：
   `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\MiMo-Codex-Bridge.bat`
4. **前置条件**  
   MiMo Desktop 已登录并运行；已执行 `node mint-token.mjs`；`token.txt` 与 `bridge-secret.txt` 存在。

启动日志：
- `bridge-start.log` — 启动脚本过程
- `bridge-runtime.log` / `bridge-runtime.log.err` — node 进程 stdout/stderr

确需让脚本切换默认模型时，必须显式使用底层命令：

```powershell
powershell -File .\apply-mimo-provider.ps1 -MakeDefault
```

不修改默认配置、临时调用一次：

```powershell
codex exec `
  -c model_provider=mimo `
  -c model=mimo-desktop/mimo-pro `
  "say hi"
```

常用模型（26.922 / 2.6 实测；`xiaomi/*` 走云端、需要小米 API Key，桌面订阅调不通，用 `mimo-desktop/*`）：

- `mimo-desktop/mimo-v2.6-pro`
- `mimo-desktop/mimo-v2.6-flash`
- `mimo-desktop/mimo-pro`（当前代 Pro 别名）
- `mimo-desktop/mimo-flash`
- `mimo-desktop/mimo-auto`

## 管理命令

统一入口为 `mimo-bridge.ps1`：

```powershell
# 初始化凭据并启动（推荐）
powershell -File .\mimo-bridge.ps1 setup

# 查看完整状态
powershell -File .\mimo-bridge.ps1 status

# 只看运行指标
powershell -File .\mimo-bridge.ps1 metrics

# 启动、停止、重启
powershell -File .\mimo-bridge.ps1 start
powershell -File .\mimo-bridge.ps1 stop
powershell -File .\mimo-bridge.ps1 restart

# 可选：只写 Codex provider；不改 model / 模型目录
powershell -File .\mimo-bridge.ps1 configure-codex
powershell -File .\mimo-bridge.ps1 restore-codex

# 自动诊断
powershell -File .\mimo-bridge.ps1 doctor

# 查看最近的脱敏调试日志
powershell -File .\mimo-bridge.ps1 logs

# 轮换 bridge secret，并自动更新 Codex 配置
powershell -File .\mimo-bridge.ps1 rotate-secret

# 运行真实 Codex 工具调用测试
powershell -File .\mimo-bridge.ps1 live-test
```

轮换 bridge secret 不会更换 MiMo token，因此不会重建引擎令牌；只会更新 Codex ↔ bridge 之间的认证凭据。

## 状态与指标

`/health` 不要求凭据，适合快速探测：

```powershell
curl.exe http://127.0.0.1:8788/health
```

`/status` 和 `/metrics` 要求 bridge secret：

```powershell
powershell -File .\mimo-bridge.ps1 status
powershell -File .\mimo-bridge.ps1 metrics
```

状态接口包含：

- bridge PID、版本、Node 版本
- MiMo 引擎地址和发现状态
- 当前认证模式
- 请求体、超时和并发限制
- 按状态码、模型、错误类型统计的请求
- 请求、上游响应头和首个输出事件延迟
- 重试次数、熔断状态和引擎端口变化
- 上游真实 usage 与本地估算 usage（分开统计）

示例：

```json
{
  "ok": true,
  "version": "2.1.0",
  "authMode": "bridge_secret",
  "engine": "http://127.0.0.1:55461",
  "limits": {
    "max_concurrent_requests": 8,
    "upstream_timeout_ms": 600000
  },
  "metrics": {
    "requests": {
      "total": 0,
      "active": 0
    },
    "upstream": {
      "breaker": {
        "state": "closed"
      }
    }
  }
}
```

## 自动诊断

```powershell
npm run doctor
# 或
node doctor.mjs --port 8788
```

诊断内容：

- Node.js 是否满足最低版本
- `/health` 是否正常
- `/status` 是否接受 bridge secret
- MiMo token 是否能读取模型列表
- 是否检测到 `xiaomi/` 模型
- Codex 配置是否指向正确的 provider、URL、wire API 和 secret
- bridge 进程是否仍然存在
- 可选的真实模型请求是否返回内容

只检查基础设施、不调用模型时：

```powershell
node doctor.mjs --port 8788 --no-live-request
```

## 测试

### 自动测试

```powershell
npm run check
npm test
```

自动测试不依赖真实 MiMo Desktop，覆盖：

- Responses 与 Chat Completions 协议转换
- 工具调用、`tool_choice` 和多模态内容
- 真实增量 SSE 转换
- SSE 分片解析
- bridge secret 与 MiMo token 分离
- 状态与 usage 指标
- 并发统计和熔断器
- 错误分类与重试状态

### 真实 Responses 协议测试

```powershell
npm run test:protocol-live
# 或
powershell -File .\mimo-bridge.ps1 protocol-live
```

该测试使用真实 MiMo 上游验证结构化输出、`previous_response_id`、响应查询、后台响应、响应删除、自定义工具和 logprobs 能力。

原生 Responses 探测：

```powershell
npm run probe:native
# 或
powershell -File .\mimo-bridge.ps1 native-probe
```

### 真实 Codex 工具测试

```powershell
npm run test:live
```

需要查看 Codex 实际调用了哪个自己的工具时：

```powershell
powershell -File .\mimo-bridge.ps1 live-test -ShowCommands
```

详细模式读取 Codex 的 JSONL 事件，显示 `command_execution`、`function_call`、文件修改等结构化工具事件。输出会自动遮蔽 token、bridge secret、Authorization 和当前用户名目录。

如果要连续观察多个 Codex 自己的工具调用：

```powershell
powershell -File .\mimo-bridge.ps1 tools-demo -OpenReport
# 或
npm run demo:tools -- --open-report
```

每次演示都会把脱敏后的实际工具命令、命令输出和退出状态写入 `reports\tool-demo-latest.txt`。`-OpenReport` 会在结束后自动用记事本打开，因此不依赖 Codex 桌面 UI 是否显示工具结果。

多工具演示会要求 Codex 分别创建两个文件、分别读取，再生成汇总文件，并打印每次结构化工具事件、实际命令和退出状态。

该测试会：

1. 通过当前 Codex 配置调用 `xiaomi/mimo-pro`。
2. 要求 Codex 使用工具创建 `.bridge-live-tool-output.txt`。
3. 验证文件内容必须为 `bridge-tool-ok`。
4. 无论成功或失败都删除临时文件。

## Windows 登录自启动

```powershell
# 创建登录自启动任务
powershell -File .\mimo-bridge.ps1 install-startup

# 删除任务
powershell -File .\mimo-bridge.ps1 remove-startup
```

任务名称为 `MiMo Codex Bridge`。即使 MiMo Desktop 启动得稍慢，bridge 也会继续运行，并在 `/health` 或下一次请求时重新发现引擎。

## 运行配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MIMO_BRIDGE_PORT` | `8788` | bridge 端口 |
| `MIMO_BRIDGE_DIR` | `~/.mimo-bridge` | token 绑定的实例目录 |
| `MIMO_BRIDGE_PROCESS` | `Xiaomi MiMo.exe` | 用于端口发现的进程名 |
| `MIMO_BRIDGE_ENGINE_URL` | 空 | 固定引擎 URL，跳过端口发现 |
| `MIMO_BRIDGE_SECRET` | 空 | 显式指定 bridge secret，优先于文件 |
| `MIMO_BRIDGE_UPSTREAM_TIMEOUT_MS` | `600000` | 上游请求总超时 |
| `MIMO_BRIDGE_MAX_BODY_BYTES` | `20971520` | 请求体上限 |
| `MIMO_BRIDGE_MAX_CONCURRENT` | `8` | 模型请求最大并发数 |
| `MIMO_BRIDGE_BREAKER_FAILURES` | `3` | 触发熔断的连续失败次数 |
| `MIMO_BRIDGE_BREAKER_COOLDOWN_MS` | `5000` | 熔断冷却时间 |
| `MIMO_BRIDGE_MODEL_FALLBACK` | `mimo-desktop/mimo-v2.6-pro` | 请求了引擎上不存在的模型时的兜底模型；`off` 关闭兜底 |
| `MIMO_BRIDGE_TOKEN_ESTIMATE` | `1` | 上游缺失 usage 时是否本地估算补齐；`off` 关闭 |
| `MIMO_BRIDGE_RESPONSE_TTL_MS` | `1800000` | `store=false` 的闲置状态保留时间 |
| `MIMO_BRIDGE_RESPONSE_STATE_MAX` | `5000` | Responses 状态上限；活动和 `store=true` 不会被淘汰 |
| `MIMO_BRIDGE_ALLOWED_HOSTS` | 空 | 额外允许的 `Host` 头，逗号分隔 |
| `MIMO_BRIDGE_ALLOW_ANY_HOST` | `0` | 设为 `1` 关闭 Host 校验（不推荐） |
| `BRIDGE_DEBUG` | `0` | 写入脱敏请求元数据 |
| `BRIDGE_DEBUG_INCLUDE_BODY` | `0` | 显式开启后才记录请求体 |

## 使用 cc-switch（推荐）

在 cc-switch 中添加供应商：

- 名称：`Xiaomi MiMo (Desktop)`
- Base URL：`http://127.0.0.1:8788/v1`
- Key：`bridge-secret.txt` 中的值
- 配置：粘贴 `cc-switch-provider.toml`
- 模型：由用户在 cc-switch / Codex 中自行选择

bridge 模板只负责连接：

1. `web_search = "disabled"`
   Codex 默认会在 Responses 请求的 tools 里带上 web_search，MiMo 引擎没有这个能力。
   bridge 现在会丢弃这类 hosted 工具而不是报错，但显式关掉更干净，也少一次无效请求。
2. `model_providers.mimo`
   Base URL、wire API 和 bridge secret 必须正确。

`model`、`model_catalog_json` 不写在模板里，避免 bridge 与 cc-switch 争抢模型配置。
如果你的模型目录缺少 MiMo 条目，可以自行选择是否运行：

   ```powershell
   node add-model-catalog.mjs --catalog mimo-models.json
   ```

   脚本会自动备份，并把 MiMo 模型标为 `text + image`。这是可选工具，不会被启动脚本自动执行。

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `bridge.mjs` | 协议桥接、认证、端口发现、流式代理、熔断 |
| `responses.mjs` | Responses ⇄ Chat Completions 转换与 SSE 解析 |
| `protocol-state.mjs` | Responses 状态持久化、TTL、取消和淘汰管理 |
| `runtime.mjs` | 指标、并发限制、错误分类与熔断器 |
| `token-estimate.mjs` | 上游缺失 usage 时的本地 token 估算器 |
| `mint-token.mjs` | 生成凭据、写入 MiMo token 存储、设置 ACL |
| `doctor.mjs` | bridge、MiMo 与 Codex 配置诊断 |
| `mimo-bridge.ps1` | 统一管理、诊断、可选配置与自启动入口 |
| `启动 MiMo 桥.bat` | 唯一推荐的双击入口；只搭桥，不选模型 |
| `apply-mimo-provider.ps1` | 可选的 Codex provider 直写 / 恢复工具 |
| `cc-switch-provider.toml` | cc-switch 连接模板；模型由用户配置 |
| `test/` | 不依赖真实模型的自动测试 |
| `live-checks/codex-tool.mjs` | 可选的真实 Codex 工具调用测试 |
| `live-checks/protocol-live.mjs` | 真实 MiMo Responses 协议能力测试 |

## 当前限制

- bridge 管理的是 Responses 请求，不管理 Codex Desktop 的会话生命周期。
  本地日志里观察到的 `turn_aborted` 均为 `reason=interrupted`；若在模型仍输出时继续发消息，
  `followUpQueueMode = "steer"` 会打断当前轮并开启新轮，这与 bridge 的响应失败不同。
- MiMo Desktop 升级会改模型 ID：26.922 起 `xiaomi/mimo-*` 旧 ID 全部下线，
  引擎列表里的 `xiaomi/*` 新 ID（v2.5/v2.6）走云端、需要小米 API Key，桌面订阅调不通；
  可用的是 `mimo-desktop/*`。桥的兜底逻辑（前台与后台响应都会走）会自动在引擎现有
  模型里挑一个可用的，但也建议同步更新配置和目录里的模型名。
  用 node live-checks/native-responses-probe.mjs 或直接看 http://127.0.0.1:8788/v1/models 可以确认当前 ID。
- 端口自动发现目前只支持 Windows。
- `store=true` 的 Responses 状态已持久化；`store=false` 只在 TTL 内保留。
- MiMo 不返回原生 token logprobs 时，bridge 会接受并兼容该请求，但不会伪造日志概率数据。
- MiMo 不提供 OpenAI hosted tools、prompt registry 或完整内部 reasoning 状态；这些能力会返回明确的协议错误。
- reasoning 会转换成 Responses summary，但不会还原 MiMo 的完整内部推理状态。
- 流式上下文统计优先使用 MiMo 真实 usage。只有上游没有 usage 时才使用 tokenx + 图片尺寸估算，仍是近似值。
- 图片 token 无法在本地精确复现 MiMo 的视觉编码器；估算按 512px 分块保守计数，真实 usage 返回后会覆盖估算。
- Codex 默认下发的 hosted 工具（web_search / file_search / code_interpreter 等）会被 bridge 丢弃而不是报错，因为 MiMo 引擎没有对应能力；真正未知的工具类型仍然返回明确的协议错误。
- 不要把 bridge 监听地址改成 `0.0.0.0`，否则本地凭据和模型请求会暴露到网络。
- bridge 默认校验 `Host` 头，只接受 `127.0.0.1` / `localhost` / `[::1]`。若经反向代理访问，请用 `MIMO_BRIDGE_ALLOWED_HOSTS` 放行对应 Host。

## 免责声明

非官方本机互操作实验项目，与小米 / MiMo 或 OpenAI 无关。内部接口与订阅能力可能随客户端版本变化，使用风险由使用者自行判断。
