#!/usr/bin/env node
/**
 * sync-aliases.mjs — 把各个上游目录里的模型全量写进 upstreams.json 的 aliases，
 * 保证"旧模型名（cn:xxx / glm-x.x）"在多上游模式下继续可用。
 *
 * 用法：node sync-aliases.mjs            # 读当前 upstreams.json，重算 aliases 并写回
 * 说明：只改 aliases 字段，其余（upstreams/groups）原样保留；写前会备份 upstreams.json.bak。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REG = path.join(DIR, "upstreams.json");
const readToken = (file) => {
  try { return fs.readFileSync(path.resolve(DIR, file), "utf8").trim(); } catch { return ""; }
};

if (!fs.existsSync(REG)) {
  console.error("没有 upstreams.json，先复制 upstreams.example.json 并配好上游");
  process.exit(1);
}
const doc = JSON.parse(fs.readFileSync(REG, "utf8"));
const aliases = {};
for (const up of doc.upstreams || []) {
  const base = typeof up.base === "string" ? up.base.trim() : "";
  if (!base) continue;
  const token = readToken(up.tokenFile || "");
  try {
    const r = await fetch(base + "/v1/models", {
      headers: token ? { Authorization: "Bearer " + token } : {},
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json();
    for (const m of j.data || []) {
      const id = String(m.id || "");
      if (id) aliases[id] = up.id + "/" + id;
    }
    console.log(up.id, "→", (j.data || []).length, "个模型");
  } catch (e) {
    console.warn(up.id, "拉模型失败：", e.message);
  }
}
const old = doc.aliases || {};
for (const [from, to] of Object.entries(old)) {
  if (!(from in aliases)) aliases[from] = to; // 保留手动别名
}
doc.aliases = aliases;
fs.copyFileSync(REG, REG + ".bak");
fs.writeFileSync(REG, JSON.stringify(doc, null, 2), "utf8");
console.log("已写入", Object.keys(aliases).length, "条别名（备份 upstreams.json.bak）");
