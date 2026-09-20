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

当前版本：**2.3.0**。项目仅监听 `127.0.0.1`，不依赖第三方 npm 包。MiMo Desktop 的内部接口不是稳定公开接口，客户端升级后可能需要再次适配。

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
- 所有指标只记录上游真实返回的数据；上游没有 usage 时保持为 0，不伪造 token 数。

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

## 前置条件

- MiMo Desktop 已安装并登录
- Windows（端口发现使用 `netstat` 和 `tasklist`）
- Node.js ≥ 18；当前已在 Node.js 24 上验证
- Windows PowerShell 或 PowerShell 7

## 快速开始

```powershell
# 1) 生成或复用 MiMo token 和 bridge secret
node mint-token.mjs

# 2) 把 bridge-secret 写入 Codex 配置
powershell -File .\apply-mimo-provider.ps1

# 3) 启动 bridge
powershell -File .\mimo-bridge.ps1 start

# 4) 检查完整状态
powershell -File .\mimo-bridge.ps1 doctor
```

需要切换 Codex 默认模型时：

```powershell
powershell -File .\apply-mimo-provider.ps1 -MakeDefault
```

不修改默认配置、临时调用一次：

```powershell
codex exec `
  -c model_provider=mimo `
  -c model=xiaomi/mimo-x-pro-preview `
  "say hi"
```

常用模型：

- `xiaomi/mimo-x-pro-preview`
- `xiaomi/mimo-pro`
- `xiaomi/mimo-flash`
- `xiaomi/mimo-auto`

## 管理命令

统一入口为 `mimo-bridge.ps1`：

```powershell
# 查看完整状态
powershell -File .\mimo-bridge.ps1 status

# 只看运行指标
powershell -File .\mimo-bridge.ps1 metrics

# 启动、停止、重启
powershell -File .\mimo-bridge.ps1 start
powershell -File .\mimo-bridge.ps1 stop
powershell -File .\mimo-bridge.ps1 restart

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
- 上游真实提供的 usage

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
| `MIMO_BRIDGE_RESPONSE_TTL_MS` | `1800000` | Responses 状态保留时间 |
| `MIMO_BRIDGE_RESPONSE_STATE_MAX` | `200` | 内存中最多保存的 Responses 数量 |
| `MIMO_BRIDGE_ALLOWED_HOSTS` | 空 | 额外允许的 `Host` 头，逗号分隔 |
| `MIMO_BRIDGE_ALLOW_ANY_HOST` | `0` | 设为 `1` 关闭 Host 校验（不推荐） |
| `BRIDGE_DEBUG` | `0` | 写入脱敏请求元数据 |
| `BRIDGE_DEBUG_INCLUDE_BODY` | `0` | 显式开启后才记录请求体 |

## 使用 cc-switch（可选）

在 cc-switch 中添加供应商：

- 名称：`Xiaomi MiMo (Desktop)`
- Base URL：`http://127.0.0.1:8788/v1`
- Key：`bridge-secret.txt` 中的值
- 配置：粘贴 `cc-switch-provider.toml`

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `bridge.mjs` | 协议桥接、认证、端口发现、流式代理、熔断 |
| `responses.mjs` | Responses ⇄ Chat Completions 转换与 SSE 解析 |
| `protocol-state.mjs` | Responses 状态、TTL、取消和淘汰管理 |
| `runtime.mjs` | 指标、并发限制、错误分类与熔断器 |
| `mint-token.mjs` | 生成凭据、写入 MiMo token 存储、设置 ACL |
| `doctor.mjs` | bridge、MiMo 与 Codex 配置诊断 |
| `mimo-bridge.ps1` | 统一管理、诊断、轮换与自启动入口 |
| `apply-mimo-provider.ps1` | 更新 Codex provider 配置 |
| `test/` | 不依赖真实模型的自动测试 |
| `live-checks/codex-tool.mjs` | 可选的真实 Codex 工具调用测试 |
| `live-checks/protocol-live.mjs` | 真实 MiMo Responses 协议能力测试 |

## 当前限制

- 端口自动发现目前只支持 Windows。
- Responses 状态是 bridge 进程内的临时状态；重启 bridge 后旧 `previous_response_id` 会失效。
- MiMo 不返回原生 token logprobs 时，bridge 会接受并兼容该请求，但不会伪造日志概率数据。
- MiMo 不提供 OpenAI hosted tools、prompt registry 或完整内部 reasoning 状态；这些能力会返回明确的协议错误。
- reasoning 会转换成 Responses summary，但不会还原 MiMo 的完整内部推理状态。
- 上游没有返回 usage 时，指标和 Codex 可能显示 `tokens used 0`。
- 多模态内容会尽可能保留并交给上游，实际支持情况取决于 MiMo 模型版本。
- 不要把 bridge 监听地址改成 `0.0.0.0`，否则本地凭据和模型请求会暴露到网络。
- bridge 默认校验 `Host` 头，只接受 `127.0.0.1` / `localhost` / `[::1]`。若经反向代理访问，请用 `MIMO_BRIDGE_ALLOWED_HOSTS` 放行对应 Host。

## 免责声明

非官方本机互操作实验项目，与小米 / MiMo 或 OpenAI 无关。内部接口与订阅能力可能随客户端版本变化，使用风险由使用者自行判断。