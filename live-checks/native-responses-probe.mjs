#!/usr/bin/env node
/**
 * 直接探测 MiMo 引擎是否暴露原生 Responses 路由。
 * 不依赖 bridge 的 Responses 兼容层，直接使用 token.txt 访问 MiMo。
 */
import fs from "node:fs";
import path from "node:path";

const projectDir = path.resolve(import.meta.dirname, "..");
const bridgePort = Number(process.env.MIMO_BRIDGE_PORT || 8788);
const bridgeBase = `http://127.0.0.1:${bridgePort}`;
const token = fs
  .readFileSync(path.join(projectDir, "token.txt"), "utf8")
  .trim();

const healthResponse = await fetch(`${bridgeBase}/health`, {
  signal: AbortSignal.timeout(5000),
});
const health = await healthResponse.json();
const engine = String(health.engine || "").replace(/\/+$/, "");
const directory = encodeURIComponent(health.instanceDir || "");

if (!engine) {
  console.error(JSON.stringify({ ok: false, error: "MiMo engine unavailable" }, null, 2));
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};
const responsesBody = JSON.stringify({
  model: "xiaomi/mimo-pro",
  input: "Reply with RESPONSES-NATIVE-OK only.",
  stream: false,
});
const chatBody = JSON.stringify({
  model: "xiaomi/mimo-pro",
  messages: [
    { role: "user", content: "Reply with CHAT-OK only." },
  ],
  stream: false,
});

function urlFor(route) {
  return `${engine}${route}?directory=${directory}`;
}

async function post(route, body) {
  try {
    const response = await fetch(urlFor(route), {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(30000),
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {}
    return {
      route,
      url: urlFor(route),
      status: response.status,
      object: payload?.object ?? null,
      body: text.slice(0, 500),
    };
  } catch (error) {
    return {
      route,
      url: urlFor(route),
      status: null,
      object: null,
      error: String(error?.message ?? error),
    };
  }
}

const probes = [];
for (const route of [
  "/v1",
  "/v1/",
  "/v1/responses",
  "/responses",
  "/v1/response",
]) {
  probes.push(await post(route, responsesBody));
}
const chatControl = await post("/v1/chat/completions", chatBody);
probes.push(chatControl);

const responsesProbe = probes.find((item) => item.route === "/v1/responses");
const nativeResponses =
  responsesProbe?.status === 200 &&
  responsesProbe?.object === "response";
const chatSupported =
  chatControl.status === 200 &&
  chatControl.object === "chat.completion";

const result = {
  checked_at: new Date().toISOString(),
  engine,
  native_responses: nativeResponses,
  active_recommended_mode: nativeResponses
    ? "native"
    : "chat_compatibility",
  chat_supported: chatSupported,
  conclusion: nativeResponses
    ? "MiMo exposes a native Responses response object."
    : "MiMo does not expose POST /v1/responses as a native Responses endpoint in this installation.",
  probes,
};

const reportDir = path.join(projectDir, "reports");
fs.mkdirSync(reportDir, { recursive: true });
const reportFile = path.join(reportDir, "mimo-native-responses.json");
fs.writeFileSync(reportFile, JSON.stringify(result, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ ...result, report: reportFile }, null, 2));

if (!chatSupported) process.exitCode = 1;