#!/usr/bin/env node
// add-trae-provider.mjs — 往 cc-switch 的 Codex 应用下插入 trae 桥供应商，
// 结构对齐现有 workbuddy-bridge-codex 行（auth + Codex config TOML + 模型目录）。
//
// 模型目录直连 TRAE SOLO get_detail_param（拿 display_name / context window），
// 过滤 custom_model_* 占位与内部 subagent 条目。默认模型 glm-5.2（同 trae2api config）。
//
// 用法：node add-trae-provider.mjs [--dry-run]
// 幂等：已存在则整行替换（INSERT OR REPLACE）。建议先关 cc-switch 再跑，
// 跑完重开即可在 Codex 下看到 "Local AI Bridge (Trae)"。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dryRun = process.argv.includes("--dry-run");
const DB_PATH = path.join(os.homedir(), ".cc-switch", "cc-switch.db");
const SECRET = fs.readFileSync(path.join(import.meta.dirname, "bridge-secret.txt"), "utf8").trim();

// ── 拉模型目录（display_name / contextWindow 来自上游原始字段） ──
const authsDir = path.join(os.homedir(), ".trae2api", "auths");
const authFile = fs.readdirSync(authsDir).find((f) => f.startsWith("trae-") && f.endsWith(".json"));
if (!authFile) throw new Error("~/.trae2api/auths 里没有凭证，先登录 TRAE 账号");
const obj = JSON.parse(fs.readFileSync(path.join(authsDir, authFile), "utf8"));
const a = obj.auth ?? obj;

const r = await fetch("https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": "Trae/0.1.52",
    Authorization: `Cloud-IDE-JWT ${a.accessToken}`,
    "X-App-Id": "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
    "X-App-Version": "default",
    "X-Ide-Version": "0.1.52",
    "X-Ide-Version-Code": "20260811",
    "X-Ide-Version-Type": "stable",
    "X-Device-Type": "macos",
    "X-OS-Version": "macOS 15.7.4",
    "X-Device-Brand": "Apple",
    "Request-Traffic-Type": "prod",
    ...(a.machineId ? { "X-Machine-Id": a.machineId } : {}),
    ...(a.deviceId ? { "X-Device-Id": a.deviceId } : {}),
  },
  body: JSON.stringify({
    function: "solo_work_lite",
    config_names: null,
    need_prompt: false,
    current_config_info: null,
    poly_prompt: true,
    mode_type: null,
    agent_type: null,
  }),
  signal: AbortSignal.timeout(15000),
});
if (!r.ok) throw new Error(`get_detail_param HTTP ${r.status}`);
const catalogRaw = (await r.json()).config_info_list || [];

// custom_model_* 是用户自定义槽位，subagent 是内部条目，都不进选择器
const INTERNAL = new Set([
  "computer_use_subagent",
  "browser_use_subagent",
  "file_search_agent",
  "explore_sub_agent_v2",
  "summary",
]);
const models = catalogRaw
  .filter((e) => e.config_name && !e.config_name.startsWith("custom_model_") && !INTERNAL.has(e.config_name))
  .map((e) => ({
    model: e.config_name,
    displayName: e.display_config?.display_name || e.config_name,
    contextWindow: Number(e.context_window_tokens?.dev || 0) || undefined,
  }));

// 上游 get_detail_param 的 context_window_tokens 是过时的通道值：目录还写 200k，
// 但 2026-10-12 实测（glm-5.3 收 21.4 万 token、glm-5.3-flash 收 95 万 token 均
// HTTP 200）免费通道已放开到 1M。整齐的 200k/168k/32k 是通道级配置，统一覆写；
// Doubao 256k / aquila 272k / seed 233k 这类非整值疑似模型原生上限，保留不动。
for (const m of models) {
  if (m.contextWindow === 200000) m.contextWindow = 1000000;
  // 思考档位：实测（2026-10-12，glm-5.2 / glm-5.3-flash / DeepSeek-V4-Pro / kimi-k3）
  // low→max 五档全部 HTTP 200 且都输出 reasoning_content，但 low/max 的思考长度
  // 无单调关系——上游接受该参数但大概率忽略（思考常开）。目录里暴露全档位仅为
  // Codex 选择器兼容。
  m.reasoningLevels = ["low", "medium", "high", "xhigh", "max"];
}

// ── 组装 settings_config：以 workbuddy 行为模板做三处替换 ──
const db = new DatabaseSync(DB_PATH);
const wb = db
  .prepare("SELECT * FROM providers WHERE id = 'workbuddy-bridge-codex' AND app_type = 'codex'")
  .get();
if (!wb) throw new Error("cc-switch 里没有 workbuddy-bridge-codex 行，没法对齐模板");

const wbSettings = JSON.parse(wb.settings_config);
let toml = String(wbSettings.config || "");
// 值无关替换：模板行的具体值会被 cc-switch 随 live 配置回写（model 换过几次了），
// 只按行的形态定位，不依赖旧值。
const swaps = [
  [/^model_provider = ".*"$/m, 'model_provider = "trae"'],
  [/^model = ".*"$/m, 'model = "glm-5.2"'],
  [/\[model_providers\.workbuddy\]\nname = ".*"/, '[model_providers.trae]\nname = "trae"'],
];
for (const [re, to] of swaps) {
  if (!re.test(toml)) throw new Error(`模板 TOML 里找不到 ${re}`);
  toml = toml.replace(re, to);
}
if (!/\[model_providers\.trae\]/.test(toml)) {
  // 模板里连 workbuddy 节都没有（被改写掉了）就补一个
  toml += `\n[model_providers.trae]\nname = "trae"\nbase_url = "http://127.0.0.1:8788/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nexperimental_bearer_token = "${SECRET}"\n`;
}
// 密钥以当前 bridge-secret.txt 为准（模板里的可能是旧值）
toml = toml.replaceAll(String(wbSettings.auth?.OPENAI_API_KEY || ""), SECRET);

const settingsConfig = JSON.stringify({
  auth: { OPENAI_API_KEY: SECRET },
  config: toml,
  modelCatalog: { models },
});

const sortIndex =
  db.prepare("SELECT COALESCE(MAX(sort_index), 0) + 1 AS n FROM providers WHERE app_type = 'codex'").get().n;

const row = {
  id: "trae-bridge-codex",
  app_type: "codex",
  name: "Local AI Bridge (Trae)",
  settings_config: settingsConfig,
  website_url: "https://www.trae.cn",
  category: "custom",
  created_at: Date.now(),
  sort_index: sortIndex,
  notes: "Trae upstream bridge; switch the panel to the trae upstream first, then pick a model in cc-switch.",
  icon: null,
  icon_color: null,
  meta: '{"commonConfigEnabled":false,"endpointAutoSelect":false,"apiFormat":"openai_responses"}',
  is_current: 0,
  in_failover_queue: 0,
  cost_multiplier: "1.0",
};

console.log(`[trae-provider] 模型目录 ${models.length} 个：`);
for (const m of models) console.log(`  ${m.model}${m.contextWindow ? ` (${Math.round(m.contextWindow / 1000)}k)` : ""}`);

if (dryRun) {
  console.log("[trae-provider] dry-run，未写入。settings_config 长度 " + settingsConfig.length);
  process.exit(0);
}

db.prepare(
  `INSERT OR REPLACE INTO providers
   (id, app_type, name, settings_config, website_url, category, created_at, sort_index,
    notes, icon, icon_color, meta, is_current, in_failover_queue, cost_multiplier,
    limit_daily_usd, limit_monthly_usd, provider_type)
   VALUES (@id, @app_type, @name, @settings_config, @website_url, @category, @created_at, @sort_index,
    @notes, @icon, @icon_color, @meta, @is_current, @in_failover_queue, @cost_multiplier,
    NULL, NULL, NULL)`,
).run(row);

const check = db
  .prepare("SELECT id, name, sort_index, is_current FROM providers WHERE app_type='codex'")
  .all();
console.log("[trae-provider] 已写入。Codex 供应商列表：");
for (const c of check) console.log(`  ${c.id} · ${c.name} · sort=${c.sort_index} · current=${c.is_current}`);
console.log("[trae-provider] 重启 cc-switch 后在 Codex 下即可看到。");
