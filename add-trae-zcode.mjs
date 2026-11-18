#!/usr/bin/env node
// add-trae-zcode.mjs — 把 trae 桥的模型目录写进 ZCode 客户端的供应商配置
// (~/.zcode/v2/provider_config.json)，结构对齐现有 workbuddy-bridge 行。
//
// 与 add-trae-provider.mjs（cc-switch/Codex）同一套口径：
//   · 目录拉 trae2api (:7864) /v1/models，custom_model_* 自定义槽位与内部
//     subagent 条目不进客户端选择器；
//   · contextWindow / maxOutputTokens 一律如实透传上游声明值，不改写
//     （超限时上游仍回 HTTP 200，错误藏在 SSE event:error，不可据实测放大）。
//
// 桥是单实例单上游（8788）：用 trae 模型前先在面板把上游切到 trae，
// 切走后该供应商下的请求会 404 model not found——与 cc-switch 侧一致。
//
// 用法：node add-trae-zcode.mjs [--dry-run]
// 幂等：已存在 trae-bridge 供应商则整条替换（providerId 保持不变）。
// 写入前把 provider_config.json 备份为 .bak-<时间戳>。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const dryRun = process.argv.includes("--dry-run");
const DIR = import.meta.dirname;
const GW_URL = "http://127.0.0.1:7864";
const CFG_PATH = path.join(os.homedir(), ".zcode", "v2", "provider_config.json");
const PROVIDER_NAME = "trae-bridge";
const BRIDGE_BASE_URL = "http://127.0.0.1:8788/v1";

const gwKey = fs.readFileSync(path.join(DIR, "trae-api-key.txt"), "utf8").trim();
const bridgeSecret = fs.readFileSync(path.join(DIR, "bridge-secret.txt"), "utf8").trim();

// ── 拉模型目录（桥当前可能在别的上游，直接问 trae2api） ──
const r = await fetch(`${GW_URL}/v1/models`, {
  headers: { Authorization: `Bearer ${gwKey}` },
  signal: AbortSignal.timeout(10000),
});
if (!r.ok) throw new Error(`trae2api /v1/models HTTP ${r.status}（网关在 7864 没起来？面板切一次 trae 即可）`);
const gwModels = (await r.json()).data || [];

// custom_model_* 是用户自定义槽位，subagent 是内部条目，都不进选择器
const INTERNAL = new Set([
  "computer_use_subagent",
  "browser_use_subagent",
  "file_search_agent",
  "explore_sub_agent_v2",
  "summary",
]);
const models = gwModels
  .filter((m) => m.id && !m.id.startsWith("custom_model_") && !INTERNAL.has(m.id))
  .map((m) => ({
    id: m.id,
    contextWindow: Number(m.context_length) || undefined,
    maxOutputTokens: Number(m.max_output_tokens) || undefined,
  }));

if (!models.length) throw new Error("过滤后模型为空，目录结构与预期不符，中止");

// ── 组装 provider 规则（镜像 workbuddy-bridge 行的形态） ──
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
const rules = cfg.config.providerConfigRules.providerRules;
const existing = rules.find((x) => x.providerName === PROVIDER_NAME);
const providerId = existing?.providerId || randomUUID();

const providerRule = {
  providerId,
  providerName: PROVIDER_NAME,
  enabled: true,
  config: {
    group: "standard-personal",
    access: { type: "api-key", apiKey: bridgeSecret },
    api: { type: "openai-chat-completions", baseUrl: BRIDGE_BASE_URL },
    personalModelIds: models.map((m) => m.id),
    modelOrder: models.map((m) => m.id),
  },
};

// per-model 规则：contextWindow / maxOutputTokens 全部用上游声明值
const modelRules = models.map((m) => ({
  providerId,
  modelId: m.id,
  config: {
    properties: m.contextWindow ? { contextWindow: m.contextWindow } : {},
    ...(m.maxOutputTokens ? { optionSpecs: { maxOutputTokens: { max: m.maxOutputTokens } } } : {}),
  },
}));

console.log(`[trae-zcode] 目录 ${models.length} 个（custom_model_* 与内部条目已过滤，声明值未改写）：`);
for (const m of models) {
  console.log(`  ${m.id} · ctx ${m.contextWindow ? Math.round(m.contextWindow / 1000) + "k" : "?"} · max_out ${m.maxOutputTokens ?? "?"}`);
}
if (dryRun) {
  console.log(`[trae-zcode] dry-run，未写入。providerId=${providerId}${existing ? "（替换现有行）" : "（新增）"}`);
  process.exit(0);
}

// ── 写入：先备份，再替换/追加 provider 行，再合并 per-model 规则 ──
const backup = `${CFG_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
fs.copyFileSync(CFG_PATH, backup);

if (existing) {
  rules[rules.indexOf(existing)] = providerRule;
} else {
  rules.push(providerRule);
}
const order = cfg.config.providerOrder.filter((id) => id !== providerId);
order.push(providerId);
cfg.config.providerOrder = order;

const mRules = cfg.config.modelConfigRules.providerModelRules;
const kept = mRules.filter((x) => x.providerId !== providerId);
kept.push(...modelRules);
cfg.config.modelConfigRules.providerModelRules = kept;

fs.writeFileSync(CFG_PATH, JSON.stringify(cfg, null, 2));

// 回读验证：JSON 可解析、关键字段落位
const back = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
const check = back.config.providerConfigRules.providerRules.find((x) => x.providerName === PROVIDER_NAME);
if (!check || check.config.personalModelIds.length !== models.length) throw new Error("回读校验失败");
console.log(`[trae-zcode] 已写入 ${CFG_PATH}`);
console.log(`[trae-zcode] 备份：${path.basename(backup)}`);
console.log(`[trae-zcode] 供应商 ${check.providerName} · ${check.config.personalModelIds.length} 模型 · ${back.config.modelConfigRules.providerModelRules.filter((x) => x.providerId === providerId).length} 条 per-model 规则`);
console.log("[trae-zcode] 重启 ZCode 后在模型选择器可见；使用前先把面板上游切到 trae（8788 单上游）。");
