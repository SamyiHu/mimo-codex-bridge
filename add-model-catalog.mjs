// add-model-catalog.mjs — 往 Codex 的模型目录里补 MiMo 条目，让 Codex(含桌面端选择器) 能显示并选中它们。
//
// 背景：config.toml 里的 model_catalog_json 指向的目录只有别的供应商的模型，
// 所以选择器里看不到 mimo-desktop/*；Codex 还会警告 "Model metadata not found"。
// 档位来自实测（26.922）：mimo-desktop/* 对话模型都接受 reasoning_effort
// （low/medium/high）。引擎列表里的 xiaomi/* 走云端、需要小米 API Key，
// 桌面订阅 token 调不通，因此不收录。
//
// 用法：node add-model-catalog.mjs [--config <config.toml>] [--dry-run]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const dryRun = args.includes("--dry-run");
const configPath = argOf("--config", path.join(os.homedir(), ".codex", "config.toml"));
// cc-switch 会在切换供应商时重写 cc-switch-model-catalog.json，
// 所以允许用 --catalog 直接指定要改的目录文件，不必依赖当前 config.toml。
const catalogOverride = argOf("--catalog", "");

if (!fs.existsSync(configPath)) {
  console.error(`[catalog] 找不到 ${configPath}`);
  process.exit(2);
}
const configText = fs.readFileSync(configPath, "utf8");
let catalogPath;
if (catalogOverride) {
  catalogPath = path.isAbsolute(catalogOverride)
    ? catalogOverride
    : path.join(path.dirname(configPath), catalogOverride);
} else {
  const rel = /^\s*model_catalog_json\s*=\s*"([^"]+)"/m.exec(configText)?.[1];
  if (!rel) {
    console.error("[catalog] config.toml 里没有 model_catalog_json，无需处理");
    process.exit(2);
  }
  catalogPath = path.isAbsolute(rel) ? rel : path.join(path.dirname(configPath), rel);
}
if (!fs.existsSync(catalogPath)) {
  console.error(`[catalog] 找不到目录文件：${catalogPath}`);
  process.exit(2);
}
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const template =
  catalog.models.find(
    (m) => m.slug && String(m.slug).indexOf("mimo-desktop/") !== 0,
  ) ?? catalog.models[0];

const level = (effort, description) => ({ effort, description });
const BASIC_LEVELS = [
  level("low", "Fast responses with lighter reasoning"),
  level("medium", "Balances speed and reasoning depth"),
  level("high", "Greater reasoning depth for complex problems"),
];

const definitions = [
  {
    slug: "mimo-desktop/mimo-pro",
    display_name: "MiMo Pro",
    description: "Xiaomi MiMo Pro via MiMo Desktop bridge",
    priority: 1010,
    reasoning: BASIC_LEVELS,
  },
  {
    slug: "mimo-desktop/mimo-v2.6-pro",
    display_name: "MiMo v2.6 Pro",
    description: "Xiaomi MiMo v2.6 Pro via MiMo Desktop bridge",
    priority: 1009,
    reasoning: BASIC_LEVELS,
  },
  {
    slug: "mimo-desktop/mimo-v2.6-flash",
    display_name: "MiMo v2.6 Flash",
    description: "Xiaomi MiMo v2.6 Flash via MiMo Desktop bridge",
    priority: 1008,
    reasoning: BASIC_LEVELS,
  },
  {
    slug: "mimo-desktop/mimo-flash",
    display_name: "MiMo Flash",
    description: "Xiaomi MiMo Flash via MiMo Desktop bridge",
    priority: 1007,
    reasoning: BASIC_LEVELS,
  },
  {
    slug: "mimo-desktop/mimo-auto",
    display_name: "MiMo Auto",
    description: "Xiaomi MiMo Auto via MiMo Desktop bridge",
    priority: 1006,
    reasoning: BASIC_LEVELS,
  },
];

const added = [];
const updated = [];
for (const def of definitions) {
  const entry = JSON.parse(JSON.stringify(template));
  Object.assign(entry, {
    slug: def.slug,
    display_name: def.display_name,
    description: def.description,
    priority: def.priority,
    context_window: 1000000,
    max_context_window: 1000000,
    effective_context_window_percent: 95,
    supported_reasoning_levels: def.reasoning,
    default_reasoning_level: def.reasoning.length ? "high" : template.default_reasoning_level,
    supports_reasoning_summaries: def.reasoning.length > 0,
    supports_parallel_tool_calls: false,
    input_modalities: ["text"],
    visibility: "list",
  });
  const index = catalog.models.findIndex((m) => m.slug === def.slug);
  if (index >= 0) { catalog.models[index] = entry; updated.push(def.slug); }
  else { catalog.models.push(entry); added.push(def.slug); }
}

if (dryRun) {
  console.log(JSON.stringify({ catalogPath, added, updated, dryRun: true }, null, 2));
  process.exit(0);
}

const backupPath = `${catalogPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
try {
  fs.copyFileSync(catalogPath, backupPath);
} catch (error) {
  // 目录不允许建新文件时不能因此中断：先告警，继续写目录本身。
  console.error(`[catalog] 无法创建备份 ${backupPath}：${error?.code ?? error}`);
}
fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2), "utf8");
console.log(JSON.stringify({ catalogPath, added, updated, totalModels: catalog.models.length }, null, 2));