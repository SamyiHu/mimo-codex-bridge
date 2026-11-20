import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecretVault } from "../secret-vault.mjs";

const quiet = { log() {}, warn() {}, error() {} };

test("set/get 往返，密文里看不到明文", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  const v = new SecretVault(dir, { logger: quiet });
  v.set("bridge-secret", "super-secret-value");
  assert.equal(v.get("bridge-secret"), "super-secret-value");
  const raw = fs.readFileSync(path.join(dir, "secrets.vault.json"), "utf8");
  assert.ok(!raw.includes("super-secret-value"), "密文不应包含明文");
});

test("重开同一目录能解出（主密钥持久化）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  const a = new SecretVault(dir, { logger: quiet });
  a.set("k", "v1");
  const b = new SecretVault(dir, { logger: quiet });
  assert.equal(b.get("k"), "v1");
});

test("旧明文 <name>.txt 可回落读取，并可迁移删除", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  fs.writeFileSync(path.join(dir, "token.txt"), "legacy-token\n", "utf8");
  const v = new SecretVault(dir, { logger: quiet });
  assert.equal(v.get("token"), "legacy-token");
  const moved = v.migrateLegacy(["token"]);
  assert.deepEqual(moved, ["token"]);
  assert.equal(fs.existsSync(path.join(dir, "token.txt")), false);
  assert.equal(new SecretVault(dir, { logger: quiet }).get("token"), "legacy-token");
});

test("list / delete", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"));
  const v = new SecretVault(dir, { logger: quiet });
  v.set("a", "1"); v.set("b", "2");
  assert.deepEqual(v.list(), ["a", "b"]);
  assert.equal(v.delete("a"), true);
  assert.deepEqual(v.list(), ["b"]);
});
