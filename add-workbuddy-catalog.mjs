// add-workbuddy-catalog.mjs — 从 workbuddy2api 的 /v1/models 生成 Codex 模型目录，
// 让 Codex / cc-switch 的模型选择器能显示并选中全部 cn:* / global:* 模型。
//
// 用法：node add-workbuddy-catalog.mjs [--catalog <file>] [--url http://127.0.0.1:7863]
//                                       [--api-key-file workbuddy-api-key.txt]
// 目录默认写到 ~/.codex/workbuddy-models.json；记得在 Codex 配置里把
// model_catalog_json 指向它（cc-switch 供应商快照里也要同步改）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const repoDir = import.meta.dirname;
const catalogPath = path.isAbsolute(argOf("--catalog", ""))
  ? argOf("--catalog", "")
  : path.join(os.homedir(), ".codex", argOf("--catalog", "workbuddy-models.json"));
const baseUrl = argOf("--url", "http://127.0.0.1:7863").replace(/\/+$/, "");
const apiKeyFile = argOf("--api-key-file", path.join(repoDir, "workbuddy-api-key.txt"));

const apiKey = fs.readFileSync(apiKeyFile, "utf8").trim();
if (!apiKey) {
  console.error(`[catalog] 读不到 API key：${apiKeyFile}`);
  process.exit(2);
}

const response = await fetch(`${baseUrl}/v1/models`, {
  headers: { Authorization: "Bearer " + apiKey },
  signal: AbortSignal.timeout(15000),
});
if (!response.ok) {
  console.error(`[catalog] 网关返回 ${response.status}，先确认 workbuddy2api 在跑：${baseUrl}`);
  process.exit(2);
}
const payload = await response.json();
const models = Array.isArray(payload?.data) ? payload.data : [];

// 老条目（deepseek-r1-0528 等）没有任何能力元数据，选择器里会出现僵尸项，跳过。
const usable = models.filter(
  (m) => m && m.id && (m.supports_tool_call !== undefined || m.supports_reasoning !== undefined),
);
if (!usable.length) {
  console.error("[catalog] 网关没有返回任何带元数据的模型（账号还没登录？）");
  process.exit(2);
}

// 字段模板：优先复用 mimo-models.json 里已验证过的完整条目形状。
let template = null;
for (const candidate of [
  path.join(os.homedir(), ".codex", "mimo-models.json"),
  path.join(os.homedir(), ".codex", "cc-switch-model-catalog.json"),
]) {
  try {
    const catalog = JSON.parse(fs.readFileSync(candidate, "utf8"));
    template =
      catalog.models?.find((m) => String(m.slug || "").includes("mimo")) ??
      catalog.models?.[0] ??
      null;
    if (template) break;
  } catch {}
}
if (!template) {
  console.error("[catalog] 找不到模板目录（mimo-models.json / cc-switch-model-catalog.json）");
  process.exit(2);
}

const BASIC_LEVELS = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
];

const entries = usable.map((m, index) => {
  const entry = JSON.parse(JSON.stringify(template));
  const ctx = Number(m.context_length) || 200000;
  const reasons = m.supports_reasoning !== false;
  const credit = m.credits ? ` [${m.credits} credit]` : "";
  Object.assign(entry, {
    slug: m.id,
    display_name: m.name || m.id,
    description: `${String(m.description || m.name || m.id)}${credit} via WorkBuddy bridge`,
    priority: 2000 - index,
    context_window: ctx,
    max_context_window: ctx,
    effective_context_window_percent: 95,
    supported_reasoning_levels: reasons ? BASIC_LEVELS : [],
    default_reasoning_level: reasons ? "high" : null,
    supports_reasoning_summaries: reasons,
    supports_parallel_tool_calls: false,
    input_modalities: m.supports_images ? ["text", "image"] : ["text"],
    visibility: "list",
  });
  return entry;
});

let existing = { models: [] };
try {
  existing = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
} catch {}
// 保留非 workbuddy 条目（如有），workbuddy 条目整体重建。
const kept = (existing.models ?? []).filter(
  (m) => !/^(cn|global):/.test(String(m.slug || "")),
);
const next = { ...existing, models: [...kept, ...entries] };

if (fs.existsSync(catalogPath)) {
  const backup = `${catalogPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  fs.copyFileSync(catalogPath, backup);
}
fs.writeFileSync(catalogPath, JSON.stringify(next, null, 2), "utf8");
console.log(
  JSON.stringify(
    { catalogPath, models: entries.length, totalModels: next.models.length },
    null,
    2,
  ),
);
