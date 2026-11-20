/**
 * qoder-cosy.mjs — Qoder 推理网关（gateway.qoder.com.cn/algo/...）的 COSY 自签名请求层。
 *
 * 移植自 TraeWorkAssistant src-tauri/src/tasks/qoder_sign.rs（其蓝本为 aimod-cc/agent2api cosy.rs）。
 * 上游不认普通 Bearer，鉴权链路是：
 *   1. 手写身份 JSON（uid/security_oauth_token/name/aid/email，键序固定）；
 *   2. 一次性 16 字符 AES 密钥把它 AES-128-CBC(IV=key) 加密成 info；
 *   3. 用内置 RSA 公钥（PKCS#1 v1.5）把该 AES 密钥加密成 Cosy-Key；
 *   4. {version,requestId,info,cosyVersion,ideVersion} 序列化后 base64 得 payload；
 *   5. MD5(payload \n key \n 时间戳 \n 请求体 \n 签名路径) 得签名；
 *   6. Authorization: Bearer COSY.<payload>.<签名> + 19 个 Cosy-* 头。
 *
 * 顺序硬约束：先 encodeBody() 再 buildCosyHeaders()，签名覆盖编码后的字节。
 */
import crypto from "node:crypto";

export const GATEWAY_COSY_VERSION = "1.1.38";
export const CLIENT_TYPE = "5";
export const DATA_POLICY = "disagree";
export const LOGIN_VERSION = "v2";
const MACHINE_TYPE = "5";
const CLIENT_IP = "127.0.0.1";

/** 客户端内置 RSA 公钥模数（1024 位，hex），只用于加密一次性 AES 密钥 */
const RSA_MODULUS_HEX =
  "c0f22307e5cd362e296bb04470f6de8fbf935ce24e8fcf511a0e2701329769c4" +
  "a76e499bb938036a52af1eaf818cf79a2600620e3ce87e371d2ca6d85803606a" +
  "1b3fa5e874643c9ed2db7e85673ef7227fca56e2e7c08f0927609bb896a9f24b" +
  "e1782099a66016a5bfdc3f1ff756bfc9e88d7b5dc5be30bf45a0223a00ebcecf";
const RSA_EXPONENT = 65537;

const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// ── DER 小工具：把裸模数/指数包成 SPKI PEM，交给 node:crypto 做 PKCS#1 v1.5 ──
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function derTlv(tag, body) { return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]); }
function derInt(buf) {
  let b = buf;
  while (b.length > 1 && b[0] === 0 && (b[1] & 0x80) === 0) b = b.slice(1);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return derTlv(0x02, b);
}

let cachedPem = null;
export function rsaPublicKeyPem() {
  if (cachedPem) return cachedPem;
  const n = Buffer.from(RSA_MODULUS_HEX, "hex");
  const e = Buffer.from([0x01, 0x00, 0x01]);
  const rsaPublicKey = derTlv(0x30, Buffer.concat([derInt(n), derInt(e)]));
  const algorithm = derTlv(0x30, Buffer.concat([
    derTlv(0x06, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01])),
    Buffer.from([0x05, 0x00]),
  ]));
  const spki = derTlv(0x30, Buffer.concat([algorithm, derTlv(0x03, Buffer.concat([Buffer.from([0]), rsaPublicKey]))]));
  const b64 = spki.toString("base64").match(/.{1,64}/g).join("\n");
  cachedPem = "-----BEGIN PUBLIC KEY-----\n" + b64 + "\n-----END PUBLIC KEY-----\n";
  return cachedPem;
}

/** 一次性 AES 密钥：uuid v4 去连字符后取前 16 个 ASCII 字符 */
export function randomAesKey16() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/** AES-128-CBC + PKCS#7，IV 与 key 取同一段 16 字节（上游实现如此，不是我们选的） */
export function aes128CbcBase64(key16, plaintext) {
  const key = Buffer.from(String(key16), "ascii");
  if (key.length !== 16) throw new Error("Qoder 签名密钥长度无效");
  const cipher = crypto.createCipheriv("aes-128-cbc", key, key);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64");
}

/** RSA 公钥加密（PKCS#1 v1.5），返回 base64（1024 位 → 128 字节） */
export function rsaEncryptBase64(plaintext) {
  const out = crypto.publicEncrypt(
    { key: rsaPublicKeyPem(), padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(String(plaintext), "utf8"),
  );
  return out.toString("base64");
}

/** 身份 JSON：键序 uid / security_oauth_token / name / aid / email（逐字节对齐上游实现） */
export function identityJson(identity) {
  const q = (v) => JSON.stringify(String(v == null ? "" : v));
  return (
    '{"uid":' + q(identity.userId) +
    ',"security_oauth_token":' + q(identity.authToken) +
    ',"name":' + q(identity.name) +
    ',"aid":""' +
    ',"email":' + q(identity.email) + "}"
  );
}

/** 参与签名的路径：去掉 /algo 前缀、不含查询串 */
export function signaturePath(requestUrl) {
  const url = new URL(requestUrl);
  const p = url.pathname || "/";
  return p.startsWith("/algo") ? p.slice(5) || "/" : p;
}

/**
 * 请求体编码（上游 Encode=1）：标准 base64 → 尾/中/首三段轮转 → 逐字符换表（'=' 换 '$'）。
 * 签名算在编码之后的字节上。
 */
export function encodeBody(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const standard = buf.toString("base64");
  const bytes = Buffer.from(standard, "ascii");
  const length = bytes.length;
  const third = Math.floor(length / 3);
  const table = Buffer.alloc(256);
  for (let i = 0; i < 256; i++) table[i] = i;
  for (let i = 0; i < STD_ALPHABET.length; i++) table[STD_ALPHABET.charCodeAt(i)] = CUSTOM_ALPHABET.charCodeAt(i);
  table["=".charCodeAt(0)] = "$".charCodeAt(0);
  const out = Buffer.alloc(length);
  let k = 0;
  for (let i = length - third; i < length; i++) out[k++] = table[bytes[i]];
  for (let i = third; i < length - third; i++) out[k++] = table[bytes[i]];
  for (let i = 0; i < third; i++) out[k++] = table[bytes[i]];
  return out;
}

function machineOs() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const platform = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "darwin" : "linux";
  return arch + "_" + platform;
}

/**
 * 构造一次请求的全部 COSY 头（19 个）。
 * @param {Buffer|null} body 已 encodeBody 的请求体（GET 传 null）
 * @param {string} requestUrl 完整请求 URL
 * @param {{userId:string,authToken:string,name?:string,email?:string,machineId:string}} identity
 */
export function buildCosyHeaders(body, requestUrl, identity) {
  if (!identity.userId) throw new Error("Qoder 账号缺少用户标识，无法签名");
  if (!identity.authToken) throw new Error("Qoder 账号缺少访问令牌，请重新登录");

  const aesKey = randomAesKey16();
  const info = aes128CbcBase64(aesKey, Buffer.from(identityJson(identity), "utf8"));
  const cosyKey = rsaEncryptBase64(aesKey);
  const requestId = crypto.randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));

  const payloadSrc =
    '{"version":"v1","requestId":"' + requestId + '","info":"' + info +
    '","cosyVersion":"' + GATEWAY_COSY_VERSION + '","ideVersion":""}';
  const payload = Buffer.from(payloadSrc, "utf8").toString("base64");

  const sigPath = signaturePath(requestUrl);
  const bodyBytes = body || Buffer.alloc(0);
  const signature = crypto
    .createHash("md5")
    .update(Buffer.from(payload, "ascii"))
    .update("\n")
    .update(Buffer.from(cosyKey, "ascii"))
    .update("\n")
    .update(Buffer.from(timestamp, "ascii"))
    .update("\n")
    .update(bodyBytes)
    .update("\n")
    .update(Buffer.from(sigPath, "utf8"))
    .digest("hex");
  const bodyHash = crypto.createHash("md5").update(bodyBytes).digest("hex");

  return {
    Authorization: "Bearer COSY." + payload + "." + signature,
    "Cosy-Key": cosyKey,
    "Cosy-User": identity.userId,
    "Cosy-Date": timestamp,
    "Cosy-Version": GATEWAY_COSY_VERSION,
    "Cosy-Machineid": identity.machineId,
    "Cosy-Machinetoken": identity.machineId,
    "Cosy-Machinetype": MACHINE_TYPE,
    "Cosy-Machineos": machineOs(),
    "Cosy-Clienttype": CLIENT_TYPE,
    "Cosy-Clientip": CLIENT_IP,
    "Cosy-Bodyhash": bodyHash,
    "Cosy-Bodylength": String(bodyBytes.length),
    "Cosy-Sigpath": sigPath,
    "Cosy-Data-Policy": DATA_POLICY,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": LOGIN_VERSION,
    "X-Request-Id": requestId,
  };
}
