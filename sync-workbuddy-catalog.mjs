#!/usr/bin/env node
// sync-workbuddy-catalog.mjs — 把 workbuddy2api 网关新出的模型同步进 cc-switch 的
// workbuddy 供应商目录（DB modelCatalog），并在 workbuddy 为当前供应商时同步改写
// Codex 实际读的 ~/.codex/cc-switch-model-catalog.json。
//
// 新模型的思考档位不猜：脚本会对每个缺失模型实测 low→max 五档（各发一条
// 16 token 的 ping），用实测接受集；全部被拒则不写档位（Codex 不显示选择器）。
//
// 用法：node sync-workbuddy-catalog.mjs [--dry-run]
// 幂等：已是最新则不做任何写操作。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dryRun = process.argv.includes("--dry-run");
const GW_URL = "http://127.0.0.1:7863";
const GW_CFG = path.join(os.homedir(), ".workbuddy2api", "config.json");
const DB_PATH = path.join(os.homedir(), ".cc-switch", "cc-switch.db");
const CATALOG_FILE = path.join(os.homedir(), ".codex", "cc-switch-model-catalog.json");
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const EFFORT_DESC = {
  low: "Fast responses with lighter reasoning",
  medium: "Balances speed and reasoning depth for everyday tasks",
  high: "Greater reasoning depth for complex problems",
  xhigh: "Extra high reasoning depth for complex problems",
  max: "Maximum reasoning depth for the hardest problems",
};

const apiKey = JSON.parse(fs.readFileSync(GW_CFG, "utf8")).api_key;
const auth = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

const r = await fetch(`${GW_URL}/v1/models`, { headers: auth, signal: AbortSignal.timeout(8000) });
if (!r.ok) throw new Error(`gateway /v1/models HTTP ${r.status}`);
const gwModels = (await r.json()).data || [];

const db = new DatabaseSync(DB_PATH);
const row = db
  .prepare("SELECT settings_config, is_current FROM providers WHERE id = 'workbuddy-bridge-codex'")
  .get();
if (!row) throw new Error("cc-switch 里没有 workbuddy-bridge-codex 行");
const settings = JSON.parse(row.settings_config);
settings.modelCatalog ??= { models: [] };
const catalog = settings.modelCatalog.models;

const missing = gwModels.filter((m) => !catalog.some((c) => c.model === m.id));
if (!missing.length) {
  console.log("[sync] 目录已与网关一致（" + catalog.length + " 个模型），无需同步。");
  process.exit(0);
}

async function probeEfforts(modelId) {
  const ok = [];
  for (const eff of EFFORTS) {
    try {
      const rr = await fetch(`${GW_URL}/v1/chat/completions`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          model: modelId,
          stream: false,
          max_tokens: 16,
          reasoning_effort: eff,
          messages: [{ role: "user", content: "Reply OK only." }],
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (rr.ok) ok.push(eff);
    } catch {
      /* 该档失败/超时视为不可用 */
    }
  }
  return ok;
}

const additions = [];
for (const m of missing) {
  const levels = await probeEfforts(m.id);
  console.log(`[sync] ${m.id} · ctx ${m.context_length || "?"} · 实测档位: ${levels.join(",") || "（全部被拒，不写档位）"}`);
  additions.push({
    model: m.id,
    displayName: m.name || m.id,
    contextWindow: Number(m.context_length) || undefined,
    ...(levels.length ? { reasoningLevels: levels } : {}),
  });
}

if (dryRun) {
  console.log("[sync] dry-run，将新增：" + additions.map((a) => a.model).join(", "));
  process.exit(0);
}

// 1) cc-switch DB：modelCatalog 追加
catalog.push(...additions);
db.prepare("UPDATE providers SET settings_config = ? WHERE id = 'workbuddy-bridge-codex'").run(
  JSON.stringify(settings),
);
console.log(`[sync] cc-switch 目录已更新：${catalog.length} 个模型`);

// 2) Codex 目录文件：仅当 workbuddy 是当前供应商时同步（否则等切换时 cc-switch 重写）
if (row.is_current === 1 && fs.existsSync(CATALOG_FILE)) {
  const file = JSON.parse(fs.readFileSync(CATALOG_FILE, "utf8"));
  const fileSlugs = new Set(file.models.map((m) => m.slug));
  const template =
    file.models.find((m) => String(m.slug).startsWith("cn:")) ?? file.models[file.models.length - 1];
  let maxPriority = Math.max(...file.models.map((m) => m.priority || 0));
  for (const a of additions) {
    if (fileSlugs.has(a.model)) continue;
    const entry = JSON.parse(JSON.stringify(template)); // 整条克隆保持字段完整
    entry.slug = a.model;
    entry.display_name = a.displayName;
    entry.description = a.displayName;
    if (a.contextWindow) {
      entry.context_window = a.contextWindow;
      entry.max_context_window = a.contextWindow;
    }
    entry.priority = ++maxPriority;
    entry.supported_reasoning_levels = (a.reasoningLevels || []).map((e) => ({
      effort: e,
      description: EFFORT_DESC[e] || "",
    }));
    file.models.push(entry);
  }
  fs.writeFileSync(CATALOG_FILE, JSON.stringify(file, null, 2));
  console.log(`[sync] Codex 目录文件已更新：${file.models.length} 个模型`);
  console.log("[sync] Codex 需新建对话/重启后生效。");
} else {
  console.log("[sync] workbuddy 非当前供应商，目录文件将在 cc-switch 下次切换时写入。");
}
