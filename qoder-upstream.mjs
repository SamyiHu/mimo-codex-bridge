/**
 * qoder-upstream.mjs — Qoder 推理上游（gateway.qoder.com.cn）请求构造 + SSE 信封拆解。
 *
 * 移植自 TraeWorkAssistant tasks/qoder_upstream.rs（蓝本 aimod-cc/agent2api）。
 *
 * 上游形态与 OpenAI 有两处结构性差异：
 *   1. 请求体是"agent 信封"（request_id / session_id / chat_task / chat_context / business…），
 *      不是标准 chat.completions body；messages/tools 原样塞进信封。
 *   2. 响应 SSE 再包一层：外层 {statusCodeValue, body}，body 是**内层 JSON 字符串**；
 *      业务错误不体现在 HTTP 码上（恒 200），在 statusCodeValue 里。
 * 本模块负责 ① 组信封 ② 把外层信封拆成标准 OpenAI chunk 行。
 */
import crypto from "node:crypto";
import { encodeBody, buildCosyHeaders } from "./qoder-cosy.mjs";

export const QODER_CHAT_URL =
  "https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation" +
  "?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
export const DEFAULT_MAX_OUTPUT_TOKENS = 32000;
const CLIENT_UA = "Qoder";
const CHAT_TASK = "agent_chat_generation";
const SESSION_TYPE = "agent";

/** 会话 id：同账号 + 同模型 + 同种子派生同一个（种子为空则一次性会话） */
export function sessionIdFor(userId, upstreamKey, seed) {
  const base = crypto.createHash("sha256")
    .update("qoder-session\0" + userId + "\0" + upstreamKey)
    .digest("hex")
    .slice(0, 16);
  return seed ? base + "-" + seed : base + "-" + crypto.randomUUID();
}

function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part.text === "string") return part.text;
      return "";
    }).join("");
  }
  return "";
}

/** 组装上游请求体（agent 信封） */
export function buildQoderChatBody({
  upstreamKey,
  messages = [],
  tools,
  maxTokens,
  thinking,
  userId,
  sessionSeed,
  modelConfig = {},
}) {
  const limit = Math.min(Number(maxTokens) > 0 ? Number(maxTokens) : DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS);
  let lastUserText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === "user") { lastUserText = contentToText(messages[i].content); break; }
  }
  const parameters = { max_tokens: limit };
  if (thinking && thinking.enable === true) {
    parameters.enable_thinking = true;
    if (thinking.effort) parameters.reasoning_effort = thinking.effort;
  } else if (thinking && thinking.enable === false) {
    parameters.enable_thinking = false;
  }
  const recordId = crypto.randomUUID();
  return {
    request_id: crypto.randomUUID(),
    request_set_id: recordId,
    chat_record_id: recordId,
    session_id: sessionIdFor(userId, upstreamKey, sessionSeed),
    stream: true,
    chat_task: CHAT_TASK,
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: SESSION_TYPE,
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    aliyun_user_type: "",
    system: "",
    messages,
    tools: tools || [],
    parameters,
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: {
        context: [],
        modelConfig: { key: upstreamKey, is_reasoning: Boolean(modelConfig.is_reasoning) },
        originalContent: lastUserText,
      },
      features: [],
      text: lastUserText,
    },
    model_config: slimModelConfig(modelConfig, upstreamKey),
    business: {
      product: "cli",
      version: "1.0.0",
      type: "agent",
      stage: "start",
      id: crypto.randomUUID(),
      name: lastUserText.slice(0, 30),
      begin_at: Date.now(),
    },
  };
}

/** 精简 model_config：必须剥掉 thinking_config，否则会覆盖 parameters.enable_thinking */
export function slimModelConfig(config, upstreamKey) {
  const out = { key: upstreamKey };
  for (const k of ["is_reasoning", "is_vl", "source", "format"]) {
    if (config && config[k] !== undefined && config[k] !== null) out[k] = config[k];
  }
  return out;
}

/** 发一次 Qoder 对话请求，返回 fetch Response（SSE） */
export async function openQoderStream({ account, body, signal, timeoutMs = 300000, modelKey = "", modelSource = "system" }) {
  const encoded = encodeBody(Buffer.from(JSON.stringify(body), "utf8"));
  const headers = buildCosyHeaders(encoded, QODER_CHAT_URL, {
    userId: account.uid,
    authToken: account.accessToken,
    name: account.nickname || "",
    email: account.email || "",
    machineId: account.machineId || crypto.randomUUID(),
  });
  const res = await fetch(QODER_CHAT_URL, {
    method: "POST",
    headers: Object.assign({}, headers, {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      "User-Agent": CLIENT_UA,
      // 上游按这两个头选模型：x-model-key 是目录里的内部 key（qmodel_38max），不是显示名
      ...(modelKey ? { "x-model-key": modelKey } : {}),
      "x-model-source": modelSource || "system",
    }),
    body: encoded,
    signal: signal || AbortSignal.timeout(timeoutMs),
  });
  return res;
}

/** 信封业务错误：statusCodeValue != 200 时取出错误文本 */
export function envelopeError(payload) {
  if (!payload || typeof payload !== "object") return null;
  const status = Number(payload.statusCodeValue);
  if (Number.isFinite(status) && status !== 0 && status !== 200) {
    const raw = typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body ?? "");
    return { status, text: raw.slice(0, 500) };
  }
  return null;
}

/**
 * 把一行外层 SSE（data: {"statusCodeValue":200,"body":"<inner>"}）拆成标准 OpenAI chunk。
 * 返回 { lines: string[], error?: {status,text} }
 */
export function translateEnvelopeLine(line) {
  const text = String(line || "").trim();
  if (!text.startsWith("data:")) return { lines: [] };
  const payloadText = text.slice(5).trim();
  if (!payloadText || payloadText === "[DONE]") return { lines: payloadText === "[DONE]" ? ["data: [DONE]"] : [] };
  let outer;
  try { outer = JSON.parse(payloadText); } catch { return { lines: [] }; }
  const err = envelopeError(outer);
  if (err) return { lines: [], error: err };
  let inner = outer && outer.body;
  if (typeof inner === "string") {
    try { inner = JSON.parse(inner); } catch { /* 内层可能已是文本 */ }
  }
  if (inner == null) return { lines: [] };
  if (typeof inner === "string") {
    if (inner.trim() === "[DONE]") return { lines: ["data: [DONE]"] };
    return { lines: ["data: " + JSON.stringify({ choices: [{ delta: { content: inner } }] })] };
  }
  return { lines: ["data: " + JSON.stringify(inner)] };
}

/** 异步迭代：把 fetch Response 的 SSE 流转成标准 OpenAI chunk 行 */
export async function* iterateQoderChunks(res, { signal } = {}) {
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error("Qoder HTTP " + res.status + "：" + text.slice(0, 300)), { status: res.status, body: text });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    if (signal && signal.aborted) break;
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      const out = translateEnvelopeLine(line);
      if (out.error) throw Object.assign(new Error("Qoder 业务错误 " + out.error.status + "：" + out.error.text), { status: out.error.status, body: out.error.text });
      for (const l of out.lines) yield l;
    }
  }
  if (buf.trim()) {
    const out = translateEnvelopeLine(buf);
    for (const l of out.lines) yield l;
  }
}
