// cleanup-buckets.mjs — 清理自签 token 时误建的空桶。
// 只会删除「内容全部是 codex-bridge 记录」的桶目录；MiMo 自己签发的 token（label=mimo-desktop-capability）不会被碰。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const roots =
  process.platform === "win32"
    ? [path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Xiaomi MiMo", "mimocode", "llm-server")]
    : [path.join(os.homedir(), ".local", "state", "mimocode", "llm-server")];

const whitelist = roots.map((r) => path.resolve(r));
const insideWhitelist = (p) => {
  const r = path.resolve(p);
  return whitelist.some((w) => r === w || r.startsWith(w + path.sep));
};

let deleted = 0;
let kept = 0;
let debomed = 0;

for (const root of whitelist) {
  if (!fs.existsSync(root)) continue;
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const file = path.join(dir, "tokens.json");
    if (!fs.existsSync(file)) { kept++; continue; }

    let labels;
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
      labels = Array.isArray(j.tokens) ? j.tokens.map((t) => t.label) : [];
    } catch { kept++; continue; }

    const onlyOurs = labels.length > 0 && labels.every((l) => l === "codex-bridge");
    if (onlyOurs) {
      if (insideWhitelist(dir)) { fs.rmSync(dir, { recursive: true, force: true }); deleted++; }
      continue;
    }

    // 别人的桶：如果被写坏了 BOM，修掉并移除我们追加的记录
    const raw = fs.readFileSync(file, "utf8");
    if (raw.charCodeAt(0) === 0xfeff) {
      const j = JSON.parse(raw.replace(/^\uFEFF/, ""));
      j.tokens = j.tokens.filter((t) => t.label !== "codex-bridge");
      fs.writeFileSync(file, JSON.stringify(j, null, 2), "utf8");
      debomed++;
    }
    kept++;
  }
}

console.log(JSON.stringify({ roots: whitelist, deleted, kept, debomed }, null, 2));