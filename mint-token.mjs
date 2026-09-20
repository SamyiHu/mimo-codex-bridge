// mint-token.mjs — 生成（或复用）本地 token，并写进 MiMo 引擎的 token 存储。
//
// 原理：MiMo Desktop 内嵌引擎的 /v1 只认它自己签发的 token，校验方式是「对提交值现算 sha256，
// 与 tokens.json 里的记录比对」。所以本地自签一个即可，不需要官方 API key。
//
// 用法：node mint-token.mjs [--dir ~/.mimo-bridge] [--token-file ./token.txt]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const args = process.argv.slice(2);
const argOf = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const bridgeDir = argOf("--dir", process.env.MIMO_BRIDGE_DIR || path.join(os.homedir(), ".mimo-bridge"));
const tokenFile = argOf("--token-file", path.join(import.meta.dirname, "token.txt"));

const stateRoots =
  process.platform === "win32"
    ? [path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Xiaomi MiMo", "mimocode")]
    : [path.join(os.homedir(), ".local", "state", "mimocode")];

fs.mkdirSync(bridgeDir, { recursive: true });
let token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
if (!token) {
  token = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(tokenFile, token, "utf8");
  console.log(`[mint] 已生成新 token -> ${tokenFile}`);
} else {
  console.log(`[mint] 复用已有 token -> ${tokenFile}`);
}

const hash = crypto.createHash("sha256").update(token).digest("hex");
const real = fs.realpathSync.native(path.resolve(bridgeDir));
const bucketName = crypto.createHash("sha1").update(real).digest("hex");
const record = {
  id: "llmk_" + crypto.randomUUID().replaceAll("-", "").slice(0, 16),
  hash,
  label: "codex-bridge",
  models: [],
  created: Date.now(),
};

for (const root of stateRoots) {
  const bucket = path.join(root, "llm-server", bucketName);
  try {
    fs.mkdirSync(bucket, { recursive: true });
    const file = path.join(bucket, "tokens.json");
    let store = { version: 1, tokens: [] };
    if (fs.existsSync(file)) {
      try {
        const cur = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
        if (cur && Array.isArray(cur.tokens)) {
          store = { version: 1, tokens: cur.tokens.filter((t) => t.label !== "codex-bridge") };
        }
      } catch {}
    }
    store.tokens.push(record);
    // 注意：必须 UTF-8 无 BOM —— 引擎用 JSON.parse，带 BOM 会解析失败，整个文件作废
    fs.writeFileSync(file, JSON.stringify(store, null, 2), "utf8");
    console.log(`[mint] 写入 ${file}`);
  } catch (e) {
    console.log(`[mint] 跳过 ${root}：${e.message}`);
  }
}

console.log(`[mint] 实例目录：${bridgeDir}`);
console.log(`[mint] token：${token}`);
console.log(`[mint] 下一步：node bridge.mjs`);