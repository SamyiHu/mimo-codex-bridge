# P0 落地报告：撤销 trae catalog 的 200000 → 1000000 覆写

日期：2026-10-19（本机时区） · 执行人：lead · 关联：task-4 · 触发：用户 m00431 点选 P0

## 1. 改动（源码）

`add-trae-provider.mjs`（仓库 `C:\Users\hu\Desktop\WorkSpace\brige`）

| 位置 | 改前 | 改后 |
| --- | --- | --- |
| :76-81 | 注释断言「免费通道已放开到 1M」+ `if (m.contextWindow === 200000) m.contextWindow = 1000000;` | 注释改为「context_window 一律如实透传上游 `context_window_tokens.dev`，不做任何改写；超限时上游仍返回 HTTP 200，错误藏在 SSE `event:error`（4026/4022），catalog 值必须等于上游声明值」+ `const OBSERVED_CONTEXT_WINDOW_HINT = 1048576;`（**仅日志附注，不参与写入**） |
| :145-152 | 日志「模型目录 N 个」 | 「模型目录 N 个（context_window 为上游声明值，未改写）」+ 新增附注行打印实测值 |

:68-74 的取数保持 `contextWindow: Number(e.context_window_tokens?.dev || 0) || undefined`（本就正确，未动）。`node --check add-trae-provider.mjs` 通过；`--dry-run` 通过。

## 2. dry-run 结果（27 条，无一条 1M）

```
Doubao-Seed-2.1-Turbo 256k   seed-code-pro-0430 233k      Doubao-Seed-2.1-Pro 256k
Doubao-Seed-Evolving 256k    Doubao-Seed-2.0-Code 233k   glm-5.3-flash 200k
glm-5.3-flashx 200k          glm-5.3 200k                 glm-5.2 200k
glm-5-turbo 200k             glm-5 200k                   deepseek-v4.1-flash 200k
DeepSeek-V4-Flash-Official 200k  DeepSeek-V4-Flash 200k  DeepSeek-V4-Pro-Official 200k
DeepSeek-V4-Pro 200k         kimi-k3 200k                 kimi-k2.7-code 200k
kimi-k2.6 200k               mimo-v2.6-flash 200k         mimo-v2.6-pro 200k
minimax-m3 200k              step-5-preview 200k          qwen3.8-max 200k
qwen-3.7-plus 200k           sagitta 200k                 aquila 272k
附注：2026-10-19 实测通道可接受约 1049k token，但 catalog 只写上游声明值（超限时上游仍返回 HTTP 200 + SSE error 4026，不可据此放大窗口）。
```

分布 = `{200000:21, 232768:2, 256000:3, 272000:1}`，与上游 `get_detail_param`（2026-10-19，HTTP 200，46 条）逐条一致。

## 3. 三处落盘已刷新为真值

| 落点 | 改前分布 | 改后分布 | 备份 |
| --- | --- | --- | --- |
| `C:\Users\hu\.cc-switch\cc-switch.db` providers.id='trae-bridge-codex' 的 `settings_config.modelCatalog.models[].contextWindow` | {1000000:21, 256000:3, 232768:2, 272000:1} | {200000:21, 232768:2, 256000:3, 272000:1} | `C:\Users\hu\.cc-switch\cc-switch.db.bak-before-p0-ctx`（2924544B） |
| `C:\Users\hu\.codex\trae-models.json`（`context_window` 与 `max_context_window` 同步改） | 同左 | 同左 | `C:\Users\hu\.codex\trae-models.json.bak-before-p0-ctx` |
| `C:\Users\hu\.codex\cc-switch-model-catalog.json` | 同左 | 同左 | `C:\Users\hu\.codex\cc-switch-model-catalog.json.bak-before-p0-ctx` |

DB 行其余字段（`is_current=0`、`sort_index=1`、`name`、`config` TOML）保持不变；DB 与 codex JSON 的 27 条模型名集合完全一致，无缺失/多余。

## 4. 已知残留

- `add-trae-provider.mjs` **正常模式**（非 dry-run）会 `INSERT OR REPLACE` 整行：`created_at=Date.now()`、`sort_index=MAX+1`（下次运行会变成 2）、`is_current=0`，并**丢掉当前 live 的 `model` / `model_reasoning_effort`**（现在 live 是 `model = "mimo-v2.6-pro"`，脚本模板写死 `model = "glm-5.2"`）。本次**没有**跑正常模式，DB 是原地 UPDATE，所以 live 配置未被破坏。若以后要重跑脚本，先确认这一点。
- `~/.codex/config.toml` 当前指向 **workbuddy** 供应商（`model_provider="workbuddy"`、`model_catalog_json="workbuddy-models.json"`），所以本次改的两个 trae 目录 JSON 眼下不被 Codex 读取；它们会在 cc-switch 切到 Trae 时被写回/生效。
- `add-model-catalog.mjs:111-113` 的 MiMo 硬编码 1M 是**同类问题**，本次未动（不在 P0 范围）。
- 本机无 Go 工具链，P1 的 `trae2api` 编译/替换由 teammate `go-upstream-patcher` 在 task-3 处理。

## 5. 复核方法

```bash
cd C:\Users\hu\Desktop\WorkSpace\brige && node add-trae-provider.mjs --dry-run
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.USERPROFILE+'\\.cc-switch\\cc-switch.db');const s=JSON.parse(db.prepare(\"SELECT settings_config FROM providers WHERE id='trae-bridge-codex'\").get().settings_config);const d={};for(const m of s.modelCatalog.models)d[m.contextWindow]=(d[m.contextWindow]||0)+1;console.log(d)"
```
