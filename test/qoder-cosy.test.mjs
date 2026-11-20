import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  encodeBody, signaturePath, aes128CbcBase64, rsaEncryptBase64,
  buildCosyHeaders, identityJson, rsaPublicKeyPem, randomAesKey16,
} from "../qoder-cosy.mjs";

test("encodeBody 与上游参考实现逐字节一致（hi → $HzP）", () => {
  assert.equal(encodeBody(Buffer.from("hi")).toString(), "$HzP");
  assert.equal(encodeBody(Buffer.from("")).length, 0);
});

test("encodeBody 可逆（三段轮转 + 换表自洽）", () => {
  const payload = Buffer.from('{"messages":[{"role":"user","content":"你好 world!@#"}]}');
  const encoded = encodeBody(payload);
  assert.equal(encoded.length, payload.toString("base64").length);
  // 逆变换：旧表换回 + 分段还原
  const CUSTOM = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
  const STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const table = new Map();
  for (let i = 0; i < CUSTOM.length; i++) table.set(CUSTOM[i], STD[i]);
  table.set("$", "=");
  const remapped = Buffer.from([...encoded.toString("ascii")].map((c) => table.get(c) || c).join(""), "ascii");
  const len = remapped.length, third = Math.floor(len / 3), mid = len - 2 * third;
  const restored = Buffer.concat([remapped.subarray(len - third), remapped.subarray(third, third + mid), remapped.subarray(0, third)]);
  assert.equal(restored.toString("ascii"), payload.toString("base64"));
});

test("signaturePath 去掉 /algo 前缀与查询串", () => {
  assert.equal(
    signaturePath("https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_result"),
    "/api/v2/service/pro/sse/agent_chat_generation",
  );
  assert.equal(signaturePath("https://gateway.qoder.com.cn/api/x"), "/api/x");
});

test("AES-128-CBC：IV 与 key 同为 16 字节，可解回", () => {
  const key = randomAesKey16();
  assert.equal(key.length, 16);
  const plain = Buffer.from(identityJson({ userId: "u1", authToken: "tok", name: "", email: "" }), "utf8");
  const b64 = aes128CbcBase64(key, plain);
  const dec = crypto.createDecipheriv("aes-128-cbc", Buffer.from(key), Buffer.from(key));
  const out = Buffer.concat([dec.update(Buffer.from(b64, "base64")), dec.final()]);
  assert.deepEqual(out, plain);
});

test("RSA 公钥可解析且密文为 128 字节、随机填充（两次不同）", () => {
  assert.match(rsaPublicKeyPem(), /BEGIN PUBLIC KEY/);
  const a = Buffer.from(rsaEncryptBase64("0123456789abcdef"), "base64");
  const b = Buffer.from(rsaEncryptBase64("0123456789abcdef"), "base64");
  assert.equal(a.length, 128);
  assert.notDeepEqual(a, b);
});

test("buildCosyHeaders：19 个头、签名与 bodyhash 自洽", () => {
  const url = "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1";
  const body = encodeBody(Buffer.from('{"a":1}'));
  const headers = buildCosyHeaders(body, url, { userId: "u1", authToken: "tok", name: "n", email: "", machineId: "m1" });
  const keys = Object.keys(headers);
  assert.equal(keys.length, 19);
  assert.match(headers.Authorization, /^Bearer COSY\..+\.[0-9a-f]{32}$/);
  assert.equal(headers["Cosy-Sigpath"], "/api/v2/service/pro/sse/agent_chat_generation");
  assert.equal(headers["Cosy-Bodylength"], String(body.length));
  assert.equal(headers["Cosy-Bodyhash"], crypto.createHash("md5").update(body).digest("hex"));
  assert.equal(headers["Cosy-User"], "u1");
});

test("缺凭证时直接报错，不发请求", () => {
  assert.throws(() => buildCosyHeaders(null, "https://x/algo/a", { userId: "", authToken: "t", machineId: "m" }));
  assert.throws(() => buildCosyHeaders(null, "https://x/algo/a", { userId: "u", authToken: "", machineId: "m" }));
});
