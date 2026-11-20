/**
 * secret-vault.mjs — 本地凭证加密存储（Windows DPAPI 保护主密钥 + AES-256-GCM 数据）。
 *
 * 背景：现在 bridge-secret.txt / 各家 api key / 账号 token 都是明文落盘，任何本地进程可读。
 * 做法（对齐 TraeWorkAssistant 用 Stronghold+DPAPI 的思路，不引第三方库）：
 *   1. 首次运行生成 32 字节主密钥，用 Windows DPAPI（CurrentUser 作用域）加密后存 vault.key；
 *   2. 业务机密整体 AES-256-GCM 加密进 secrets.vault.json；
 *   3. 非 Windows 或 DPAPI 不可用时退化为 scrypt(用户+主机名) 派生密钥，并在文件里标注 protection 级别。
 *
 * 读接口对旧明文文件透明：get(name) 找不到密文时会回落到 <dir>/<name>.txt。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const KEY_FILE = "vault.key";
const DATA_FILE = "secrets.vault.json";

function dpapiProtect(buf) {
  const b64 = buf.toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$bytes=[Convert]::FromBase64String('" + b64 + "')",
    "$p=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,'CurrentUser')",
    "[Convert]::ToBase64String($p)",
  ].join("; ");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 20000 });
  if (r.status !== 0) throw new Error((r.stderr || "DPAPI Protect 失败").trim());
  return r.stdout.trim();
}

function dpapiUnprotect(b64) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    "$bytes=[Convert]::FromBase64String('" + b64 + "')",
    "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,'CurrentUser')",
    "[Convert]::ToBase64String($p)",
  ].join("; ");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 20000 });
  if (r.status !== 0) throw new Error((r.stderr || "DPAPI Unprotect 失败").trim());
  return Buffer.from(r.stdout.trim(), "base64");
}

export class SecretVault {
  constructor(dir, { logger = console } = {}) {
    this.dir = dir;
    this.logger = logger;
    this.data = {};
    this.meta = { protection: "none" };
    fs.mkdirSync(dir, { recursive: true });
    this.key = this.loadOrCreateKey();
    this.loadData();
  }

  loadOrCreateKey() {
    const keyPath = path.join(this.dir, KEY_FILE);
    if (fs.existsSync(keyPath)) {
      const raw = JSON.parse(fs.readFileSync(keyPath, "utf8"));
      if (raw.protection === "dpapi" && process.platform === "win32") {
        this.meta = { protection: "dpapi" };
        return dpapiUnprotect(raw.blob);
      }
      this.meta = { protection: "passphrase" };
      return this.deriveFallbackKey();
    }
    const key = crypto.randomBytes(32);
    if (process.platform === "win32") {
      try {
        fs.writeFileSync(keyPath, JSON.stringify({ version: 1, protection: "dpapi", blob: dpapiProtect(key) }, null, 2), "utf8");
        this.meta = { protection: "dpapi" };
        return key;
      } catch (e) {
        this.logger.warn && this.logger.warn("[vault] DPAPI 不可用，退化为口令派生：" + e.message);
      }
    }
    fs.writeFileSync(keyPath, JSON.stringify({ version: 1, protection: "passphrase" }, null, 2), "utf8");
    this.meta = { protection: "passphrase" };
    return this.deriveFallbackKey();
  }

  deriveFallbackKey() {
    const seed = os.userInfo().username + "@" + os.hostname() + "|mimo-bridge";
    return crypto.scryptSync(seed, "mimo-bridge-vault-v1", 32);
  }

  loadData() {
    const file = path.join(this.dir, DATA_FILE);
    if (!fs.existsSync(file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const iv = Buffer.from(raw.iv, "base64");
      const tag = Buffer.from(raw.tag, "base64");
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(Buffer.from(raw.data, "base64")), decipher.final()]);
      this.data = JSON.parse(plain.toString("utf8"));
    } catch (e) {
      this.logger.error && this.logger.error("[vault] 读不出密文（可能换了机器/用户）：" + e.message);
      this.data = {};
    }
  }

  save() {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(this.data), "utf8")), cipher.final()]);
    const out = {
      version: 1,
      protection: this.meta.protection,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: body.toString("base64"),
    };
    fs.writeFileSync(path.join(this.dir, DATA_FILE), JSON.stringify(out, null, 2), "utf8");
  }

  get(name) {
    if (Object.prototype.hasOwnProperty.call(this.data, name)) return this.data[name];
    for (const ext of [".txt", ""]) {
      const legacy = path.join(this.dir, name + ext);
      if (fs.existsSync(legacy)) {
        try { return fs.readFileSync(legacy, "utf8").trim(); } catch { /* ignore */ }
      }
    }
    return null;
  }

  set(name, value) {
    this.data[name] = String(value);
    this.save();
    return this.get(name);
  }

  delete(name) {
    const ok = Object.prototype.hasOwnProperty.call(this.data, name);
    if (ok) { delete this.data[name]; this.save(); }
    return ok;
  }

  list() {
    return Object.keys(this.data).sort();
  }

  /** 把明文 <name>.txt 迁移进 vault，成功后删除明文 */
  migrateLegacy(names = []) {
    const moved = [];
    for (const name of names) {
      const file = path.join(this.dir, name + ".txt");
      if (!fs.existsSync(file)) continue;
      const value = fs.readFileSync(file, "utf8").trim();
      if (!value) continue;
      this.data[name] = value;
      this.save();
      fs.unlinkSync(file);
      moved.push(name);
    }
    return moved;
  }
}
