// mint-token.mjs — 生成或复用本机 token，并写入 MiMo 引擎的 token 存储。
//
// token 与实例目录绑定；tokens.json 必须为 UTF-8 无 BOM。
// 用法：node mint-token.mjs [--rotate-bridge-secret] [--dir ~/.mimo-bridge]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const bridgeDir = argOf(
  "--dir",
  process.env.MIMO_BRIDGE_DIR || path.join(os.homedir(), ".mimo-bridge"),
);
const tokenFile = argOf(
  "--token-file",
  path.join(import.meta.dirname, "token.txt"),
);
const bridgeSecretFile = argOf(
  "--bridge-secret-file",
  path.join(import.meta.dirname, "bridge-secret.txt"),
);
const rotateBridgeSecret = args.includes("--rotate-bridge-secret");
const stateRoots =
  process.platform === "win32"
    ? [
        path.join(
          process.env.APPDATA ||
            path.join(os.homedir(), "AppData", "Roaming"),
          "Xiaomi MiMo",
          "mimocode",
        ),
      ]
    : [path.join(os.homedir(), ".local", "state", "mimocode")];

fs.mkdirSync(bridgeDir, { recursive: true });
fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
fs.mkdirSync(path.dirname(bridgeSecretFile), { recursive: true });

function secureCredentialFile(file) {
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
  if (process.platform === "win32") {
    try {
      const user = os.userInfo().username;
      execFileSync(
        "icacls",
        [file, "/inheritance:r", "/grant:r", `${user}:F`],
        { stdio: "ignore" },
      );
    } catch (error) {
      console.warn(`[mint] 无法设置 ${file} 的 ACL：${error.message}`);
    }
  }
}

let token = fs.existsSync(tokenFile)
  ? fs.readFileSync(tokenFile, "utf8").trim()
  : "";

if (!token) {
  token = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(tokenFile, token, { encoding: "utf8", mode: 0o600 });
  console.log(`[mint] 已生成新 MiMo token -> ${tokenFile}`);
} else {
  console.log(`[mint] 复用已有 MiMo token -> ${tokenFile}`);
}
secureCredentialFile(tokenFile);

let bridgeSecret = "";
if (!rotateBridgeSecret && fs.existsSync(bridgeSecretFile)) {
  bridgeSecret = fs.readFileSync(bridgeSecretFile, "utf8").trim();
}
if (!bridgeSecret) {
  bridgeSecret = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(bridgeSecretFile, bridgeSecret, {
    encoding: "utf8",
    mode: 0o600,
  });
  console.log(
    `[mint] 已${rotateBridgeSecret ? "轮换" : "生成"} bridge secret -> ${bridgeSecretFile}`,
  );
} else {
  console.log(`[mint] 复用已有 bridge secret -> ${bridgeSecretFile}`);
}
secureCredentialFile(bridgeSecretFile);

const hash = crypto.createHash("sha256").update(token).digest("hex");
const realInstanceDir = fs.realpathSync.native(path.resolve(bridgeDir));
const bucketName = crypto
  .createHash("sha1")
  .update(realInstanceDir)
  .digest("hex");
const record = {
  id: "llmk_" + crypto.randomUUID().replaceAll("-", "").slice(0, 16),
  hash,
  label: "codex-bridge",
  models: [],
  created: Date.now(),
};

function writeTokenStore(file, store) {
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2), "utf8");
  try {
    fs.renameSync(temporary, file);
  } catch {
    // Windows 上目标文件存在时 rename 可能失败；退回复制，临时文件随后清理。
    fs.copyFileSync(temporary, file);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch {}
  }
}

let written = 0;
for (const root of stateRoots) {
  const bucket = path.join(root, "llm-server", bucketName);
  const file = path.join(bucket, "tokens.json");

  try {
    fs.mkdirSync(bucket, { recursive: true });
    let store = { version: 1, tokens: [] };

    if (fs.existsSync(file)) {
      try {
        const current = JSON.parse(
          fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""),
        );
        if (!current || !Array.isArray(current.tokens)) {
          throw new Error("tokens 字段不是数组");
        }
        store = {
          version: 1,
          tokens: current.tokens.filter(
            (item) => item?.label !== "codex-bridge",
          ),
        };
      } catch (error) {
        // 不覆盖无法解析的文件，避免破坏 MiMo 自己签发的 token。
        console.error(
          `[mint] 无法解析 ${file}，为保护原文件已跳过：${error.message}`,
        );
        continue;
      }
    }

    store.tokens.push(record);
    writeTokenStore(file, store);
    written += 1;
    console.log(`[mint] 已写入 ${file}`);
  } catch (error) {
    console.error(`[mint] 写入失败 ${root}：${error.message}`);
  }
}

const maskedToken = `${token.slice(0, 6)}…${token.slice(-4)}`;
const maskedSecret = `${bridgeSecret.slice(0, 6)}…${bridgeSecret.slice(-4)}`;
console.log(`[mint] 实例目录：${realInstanceDir}`);
console.log(`[mint] MiMo token：${maskedToken}`);
console.log(`[mint] bridge secret：${maskedSecret}`);
console.log(`[mint] 凭据文件：${tokenFile} / ${bridgeSecretFile}`);

if (!written) {
  console.error("[mint] 没有成功写入任何 MiMo token 存储。");
  process.exitCode = 1;
} else {
  console.log(
  "[mint] 下一步：powershell -File ./apply-mimo-provider.ps1，然后重启 bridge",
);
}