# trae2api /v1/models context_length 修复报告（P1，task-3）

- 执行者：teammate `go-upstream-patcher`
- 任务：shared task-3 — 解析上游 `context_window_tokens.dev` 并修死代码兜底
- 目标仓库：`C:\Users\hu\.trae2api`（module `trae2api`，Go 1.22）
- 结论：**补丁正确、已编译通过、已端到端 A/B 验证通过**；**运行中的 trae2api.exe 未被替换**（由 lead/用户决定何时执行替换）

---

## 1. 基线（改动前）

```
$ git -C /c/Users/hu/.trae2api status --porcelain
?? trae2api.exe
?? trae2api.pid

$ git -C /c/Users/hu/.trae2api log --oneline -3
ec20c08 docs: README 借鉴声明措辞对齐

$ git -C /c/Users/hu/.trae2api branch --show-current
main
```

工作树实际干净（仅两个未跟踪的运行产物）。**没有覆盖任何已有改动。**
live 进程：`C:\Users\hu\.trae2api\trae2api.pid` = `23884`，监听 `0.0.0.0:7864`（`api_key=true`，callback server on `:18080`）；bridge PID 11816 监听 `127.0.0.1:8788`。二者全程未动。

### 沙箱限制（为什么用补丁而不是直接改文件）
`C:\Users\hu\.trae2api` 在工作区之外。本会话策略为 `workspace-write`，所有工作区外写入被拒：

```
[sandbox: file access denied under workspace-write mode]
error.code = POLICY_DENIED, phase = preflight,
permission.required = danger-full-access,
operation = 'replace outside the workspace or DSH temporary areas',
workspaceRoot = C:\Users\hu\Desktop\WorkSpace\brige
```

且本会话审批提示被禁用、委派子代理权限不可扩大，故**未做提权**。改为：把源码树复制进工作区 → 打补丁 → 产出可 `git apply` 的统一 diff。因此**目标仓库当前仍是未修改状态**，需要 lead/用户执行第 5 节的 apply 命令。

---

## 2. 精确改动（两处，最小化）

### 2.1 `internal/upstream/client.go` — 解析 `context_window_tokens.dev`
- `FetchModels()` 解码结构体里（`ModelDetailList` 之后）新增：
  ```go
  ContextWindowTokens struct {
      Dev int64 `json:"dev"`
  } `json:"context_window_tokens"`
  ```
- 组装 `ModelInfo` 时补上 `ContextWindow`：
  ```go
  out = append(out, ModelInfo{
      ID:            cfg.ConfigName,
      Name:          cfg.DisplayConfig.DisplayName,
      ContextWindow: cfg.ContextWindowTokens.Dev,
  })
  ```
- 修前只赋 `ID`/`Name`，所以 `ContextWindow` 恒为 0。
- **`MaxTokens` 语义未改动**：上游 `get_detail_param` 不返回输出上限字段，保持 0 是正确的。已 grep 全仓，无别处依赖 `MaxTokens` 的特定非零语义。

### 2.2 `internal/server/handler.go` — 修恒假兜底
```diff
-			if entry["context_length"] == 0 {
+			if mi.ContextWindow <= 0 {
 				entry["context_length"] = 131072
 			}
```
旧写法恒为假：`entry` 是 `map[string]any`，值为 `int64`，字面量 `0` 是 `int`，Go 接口相等比较先比动态类型 → `int64(0) != int(0)`。新写法直接判 `mi.ContextWindow`，`<= 0` 才落 131072。
`staticModels` 里的 131072 兜底表**未动**。

### 2.3 最终补丁
- 路径：`C:\Users\hu\Desktop\WorkSpace\brige\reports\trae-context-p1.patch`
- 大小：**1021 字节**，3 个 hunk，**无删除 BOM 的 hunk**（`client.go` 的 UTF-8 BOM 已保留；此前第一版曾误删首行 BOM，已修复）。

```diff
--- a/internal/upstream/client.go
+++ b/internal/upstream/client.go
@@ -298,6 +298,9 @@
 			ModelDetailList []struct {
 				ModelName string `json:"model_name"`
 			} `json:"model_detail_list"`
+			ContextWindowTokens struct {
+				Dev int64 `json:"dev"`
+			} `json:"context_window_tokens"`
 		} `json:"config_info_list"`
 	}
 	if err := json.Unmarshal(data, &resp); err != nil {
@@ -309,8 +312,9 @@
 			continue
 		}
 		out = append(out, ModelInfo{
-			ID:   cfg.ConfigName,
-			Name: cfg.DisplayConfig.DisplayName,
+			ID:            cfg.ConfigName,
+			Name:          cfg.DisplayConfig.DisplayName,
+			ContextWindow: cfg.ContextWindowTokens.Dev,
 		})
 	}
 	if len(out) == 0 {
--- a/internal/server/handler.go
+++ b/internal/server/handler.go
@@ -311,7 +311,7 @@
 				"owned_by":       "trae-solo",
 				"context_length": mi.ContextWindow,
 			}
-			if entry["context_length"] == 0 {
+			if mi.ContextWindow <= 0 {
 				entry["context_length"] = 131072
 			}
 			out = append(out, entry)
```

---

## 3. 构建与静态检查（全部成功）

工具链：`C:\Users\hu\Desktop\WorkSpace\brige\.tmp-go\go\bin\go.exe` → `go version go1.22.12 windows/amd64`（下载自 mirrors.aliyun.com，**只装在工作区内，未进系统目录**）。

> 注意：`go build` 必须用 `stdio: 'inherit'` 从 Node 直接 spawn，不能在 bash 里跑——本沙箱禁止程序打开命名管道，捕获子进程管道 stdio 会 `EPERM`（`error obtaining VCS status: pipe: Access is denied` / `error obtaining buildID ... pipe: Access is denied`）。`-buildvcs=false` 也需要。

```bash
# 在工作区内 Node 进程里 spawn（stdio inherit）
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 GOFLAGS=-mod=mod \
  go build -buildvcs=false -o C:\Users\hu\Desktop\WorkSpace\brige\.tmp-go\trae2api.new.exe ./cmd/server
```

| 检查 | 结果 |
| --- | --- |
| `go build -buildvcs=false -o .tmp-go\trae2api.new.exe ./cmd/server` | **exit 0** |
| `go vet -buildvcs=false ./internal/upstream ./internal/server` | **exit 0**（clean） |
| `go test -buildvcs=false -count=1 ./...` | **exit 0**，6 个包全 ok（auth / pool / scheduler / server / upstream / cmd-server） |

产物：`C:\Users\hu\Desktop\WorkSpace\brige\.tmp-go\trae2api.new.exe`，**8,816,640 字节（8.41 MB）**，MZ 头已确认。
**未覆盖** `C:\Users\hu\.trae2api\trae2api.exe`（PID 23884 持有该文件，全程未被替换）。SHA256 前缀：live 旧版 `2d929fae8825285f`，新构建 `553a5e0f42359aad`。

### 3.1 补丁可应用性验证
在纯净副本 `.patchverify`（从真实仓库复制 `go.mod`/`internal`/`cmd`）上：
```
$ git apply --check -v reports/trae-context-p1.patch   → APPLY_CHECK_OK
$ git apply reports/trae-context-p1.patch              → APPLIED_OK
$ diff -r --brief 与已打补丁副本比对                     → 无差异
```
应用后位置核对：`client.go:301` `ContextWindowTokens struct {`；`client.go:317` `ContextWindow: cfg.ContextWindowTokens.Dev,`；`handler.go:314` `if mi.ContextWindow <= 0 {`。

---

## 4. 端到端验收（A/B 实测，最强证据）

在隔离目录内跑两份 exe，**都不碰 live 的 state/data**：
- `.tmp-go\verify\config.json`：`listen :7865`、`auth_dir "C:\\Users\\hu\\.trae2api\\auths"`（绝对路径）、`state_file "./state-verify.json"`、`work_mode "disabled"`、`callback_port "0"`
- `.tmp-go\verify-old\config.json`：同配置但 `listen :7866`（跑**未打补丁的原版 exe** 作对照）

两者都启动成功（日志：`trae2api listening on :7865/:7866 (api_key=false)`），各 46 个模型。

### 修复前（原版 exe，:7866）— 全部为 0
```json
{"context_length":0,"created":1753600000,"id":"Doubao-Seed-2.1-Turbo","object":"model","owned_by":"trae-solo"}
{"context_length":0,"created":1753600000,"id":"seed-code-pro-0430","object":"model","owned_by":"trae-solo"}
{"context_length":0,"created":1753600000,"id":"Doubao-Seed-2.1-Pro","object":"model","owned_by":"trae-solo"}
```
`models=46`，`context_length` 分布：**`{"0":46}`**（DeepSeek-V4-Flash=0、glm-5.2=0、glm-5=0、kimi-k3=0、Doubao-Seed-2.1-Pro=0、custom_model_1M=0）

### 修复后（新 exe，:7865）— 真实值
```json
{"context_length":256000,"created":1753600000,"id":"Doubao-Seed-2.1-Turbo","object":"model","owned_by":"trae-solo"}
{"context_length":232768,"created":1753600000,"id":"seed-code-pro-0430","object":"model","owned_by":"trae-solo"}
{"context_length":256000,"created":1753600000,"id":"Doubao-Seed-2.1-Pro","object":"model","owned_by":"trae-solo"}
```
`models=46`，`context_length` 分布：**`{"53192":1,"120192":1,"128000":2,"160768":1,"184000":2,"200000":23,"232768":2,"256000":6,"272000":3,"300000":1,"816000":1,"1000000":3}`**
关键样本：`DeepSeek-V4-Flash=200000`、`glm-5.2=200000`、`glm-5=200000`、`kimi-k3=200000`、`Doubao-Seed-2.1-Pro=256000`、`custom_model_1M=1000000`。
（分布与 lead/upstream-prober 的实测基线一致；计数略有出入是因 46 条中每条的 `dev` 值本身不同，非异常。）

### 对照：live 服务未被影响
`http://127.0.0.1:7864/healthz` → **200 ok**（PID 23884 全程在跑）。
验收用的两个实例（:7865 / :7866）验完已停止，**确认无残留进程、端口已释放**；`7864`/`8788` 监听者未受任何影响。

### 4.1 定点单元测试（red/green）
临时测试文件只放在工作区的构建副本里，**未进补丁、未进真实仓库**（`internal/upstream/zz_contextwindow_test.go`、`internal/server/zz_contextwindow_test.go`）：

| 用例 | 打补丁后 | 未打补丁 |
| --- | --- | --- |
| `TestFetchModelsParsesContextWindow`（样本 JSON 解码 dev=256000/200000，缺字段=0） | **PASS** | **FAIL**：`Doubao context=0 want 256000`、`DeepSeek context=0 want 200000` |
| `TestModelListUsesUpstreamContextWindow`（200000/256000 原样透出） | **PASS** | PASS（该值本就走 `mi.ContextWindow`） |
| `TestModelListFallsBackOnlyWhenNonPositive`（0 与 -1 落 131072；272000 不被覆盖） | **PASS** | **FAIL**：`zero-ctx=0 want 131072`、`neg-ctx=-1 want 131072` |

红/绿完全对得上两个缺陷：解码恒 0 + 兜底恒假。测试**未真调上游**（用固定 JSON 样本 + 预置缓存）。

---

## 5. 应用 / 回滚 / 替换命令（**需 lead 或用户执行**）

### 5.1 应用补丁到真实仓库
```bash
cd /c/Users/hu/.trae2api
git apply --check /c/Users/hu/Desktop/WorkSpace/brige/reports/trae-context-p1.patch   # 先验证
git apply         /c/Users/hu/Desktop/WorkSpace/brige/reports/trae-context-p1.patch   # 应用
git diff --stat                                                                        # 应只有 client.go + handler.go
```

### 5.2 回滚
```bash
cd /c/Users/hu/.trae2api
git apply -R /c/Users/hu/Desktop/WorkSpace/brige/reports/trae-context-p1.patch
```

### 5.3 替换 + 重启（**不要现在自动执行**）
现有 `trae2api.exe`（PID 23884）**文件被占用**，必须先停进程再换二进制。重启方式与 bridge 脚本 `start-bridge.ps1` 中 `-Upstream trae` 分支一致（`Start-Process -WorkingDirectory $traeDir -ArgumentList "-config","config.json"`，日志写 `data\server.err.log`，PID 写 `trae2api.pid`），key 从 `brige\trae-api-key.txt` 读入 `TW2A_API_KEY`：

```powershell
# 1) 停旧进程（PID 以 trae2api.pid 为准；请先确认是 23884）
$old = [int](Get-Content 'C:\Users\hu\.trae2api\trae2api.pid')
Stop-Process -Id $old -Force
Start-Sleep -Seconds 2

# 2) 备份旧二进制 + 换入新构建
Copy-Item 'C:\Users\hu\.trae2api\trae2api.exe' 'C:\Users\hu\.trae2api\trae2api.exe.bak-p1' -Force
Copy-Item 'C:\Users\hu\Desktop\WorkSpace\brige\.tmp-go\trae2api.new.exe' 'C:\Users\hu\.trae2api\trae2api.exe' -Force

# 3) 重启（保留 api_key 鉴权；key 文件与 bridge 同源）
if (-not $env:TW2A_API_KEY) { $env:TW2A_API_KEY = (Get-Content 'C:\Users\hu\Desktop\WorkSpace\brige\trae-api-key.txt' -Raw).Trim() }
$p = Start-Process -FilePath 'C:\Users\hu\.trae2api\trae2api.exe' -ArgumentList '-config','config.json' `
     -WorkingDirectory 'C:\Users\hu\.trae2api' -WindowStyle Hidden -PassThru `
     -RedirectStandardOutput 'C:\Users\hu\.trae2api\data\server.out.log' `
     -RedirectStandardError  'C:\Users\hu\.trae2api\data\server.err.log'
[System.IO.File]::WriteAllText('C:\Users\hu\.trae2api\trae2api.pid', [string]$p.Id)

# 4) 验收
Invoke-WebRequest -Uri 'http://127.0.0.1:7864/healthz' -UseBasicParsing | Select-Object -ExpandProperty Content
# 带 key 取模型表，确认 context_length 不再是 0
$h = @{ Authorization = "Bearer $env:TW2A_API_KEY" }
(Invoke-RestMethod -Uri 'http://127.0.0.1:7864/v1/models' -Headers $h).data |
  Select-Object -First 5 id,context_length | Format-Table -AutoSize
```

> 替换时若文件仍被占用，说明旧进程未完全退出；`Stop-Process` 后等 1–2 秒再 `Copy-Item`。
> 若要一键回到旧版：停进程 → 把 `trae2api.exe.bak-p1` 复制回 `trae2api.exe` → 按上面第 3 步重启。

---

## 6. 未验证项与风险

1. **未在真实仓库上构建**：编译/测试/端到端都在工作区副本上完成（`.patchbuild\trae2api` 与 `.tmp-go\verify*`）。补丁已通过 `git apply --check` 与逐字节副本比对，应用后源码与已验证源码一致，故风险很低；但严格意义上"真实仓库 in-place 构建"未执行。
2. **未替换运行进程**：`C:\Users\hu\.trae2api\trae2api.exe` 仍是修复前版本（PID 23884）。所以**当前 `/v1/models` 仍返回全 0**，属预期——需用户执行第 5.3 节后才生效。
3. **`custom_model_*` 仍不可路由**：`context_length` 会正确显示 1000000，但调用这些模型仍会返回上游 `3003 "all models failed"`。本补丁只修元数据，不解决路由可用性。
4. **`MaxTokens` 保持 0**：上游无输出上限字段，未编造；若有下游消费者期望非零值，需另立任务。
5. **`go build` 的沙箱约束**：必须从 Node 以 `stdio:'inherit'` 调用并带 `-buildvcs=false`，在 bash 里直接跑会 `EPERM`。这是环境限制，非代码问题。
6. **无 git commit/push**：全程未提交；目标仓库 `git status` 仍为 `?? trae2api.exe` / `?? trae2api.pid`，工作树与基线一致（未被本任务改动）。

## 7. 关键产物清单

| 产物 | 路径 | 说明 |
| --- | --- | --- |
| 补丁 | `C:\Users\hu\Desktop\WorkSpace\brige\reports\trae-context-p1.patch` | 1021 B，3 hunk，可直接 `git apply` |
| 新二进制 | `C:\Users\hu\Desktop\WorkSpace\brige\.tmp-go\trae2api.new.exe` | 8,816,640 B，已验证 |
| 修复后模型表 | `C:\Users\hu\Desktop\WorkSpace\brige\.tmp-go\verify\models-NEW-7865.json` | 46 条，真实 context_length |
| 修复前模型表 | `C:\Users\hu\Desktop\WorkSpace\brige\.tmp-go\verify-old\models-OLD-7866.json` | 46 条，全 0（对照） |
| 构建源副本 | `C:\Users\hu\Desktop\WorkSpace\brige\.patchbuild\trae2api` | 已打补丁的源码树 |
| 工具链 | `C:\Users\hu\Desktop\WorkSpace\brige\.tmp-go\go` | go1.22.12 windows/amd64（工作区内） |

---

## 8. Lead 复核（2026-10-19，独立验证）

- **补丁已由 Lead 应用到真实仓库**（teammate 因会话审批禁用无法写工作区外，故由其交付补丁、Lead 执行）：
  ```
  cd /c/Users/hu/.trae2api
  git apply --check reports/trae-context-p1.patch   → CHECK_OK
  git apply         reports/trae-context-p1.patch   → APPLIED
  git diff --stat → internal/server/handler.go | 2 +- ; internal/upstream/client.go | 8 ++++++--  (2 files, 7 insertions, 3 deletions)
  ```
  落点核对：`internal/upstream/client.go:301` `ContextWindowTokens struct {`；`:317` `ContextWindow: cfg.ContextWindowTokens.Dev,`；`internal/server/handler.go:314` `if mi.ContextWindow <= 0 {`。`git status` 仍只有 `?? trae2api.exe` / `?? trae2api.pid`（未提交，符合要求）。
- **Lead 独立复核 A/B 证据**（直接解析 teammate 留存的 JSON，未采信转述）：
  - `.tmp-go\verify-old\models-OLD-7866.json`（未打补丁）：46 条，`context_length` 分布 `{"0":46}`。
  - `.tmp-go\verify\models-NEW-7865.json`（打补丁）：46 条，分布 `{"53192":1,"120192":1,"128000":2,"160768":1,"184000":2,"200000":23,"232768":2,"256000":6,"272000":3,"300000":1,"816000":1,"1000000":3}`。
  - live `http://127.0.0.1:7864/v1/models`（旧二进制，PID 23884）：46 条**仍全为 0** —— 与「元数据修复需替换二进制才生效」一致。
- **仍待用户执行**：替换二进制并重启（§5.3）。源码侧 P1 已完成；运行态未生效属预期。

> §6 第 1、2、6 条在 Lead 应用补丁后部分过期：真实仓库源码已含该补丁（未构建）；目标仓库现在是 `M internal/server/handler.go` + `M internal/upstream/client.go`，不再是"工作树与基线一致"。

