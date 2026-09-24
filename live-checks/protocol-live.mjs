#!/usr/bin/env node
/**
 * 真实 MiMo 上游的 Responses 协议能力测试。
 * 核心状态能力失败时退出非零；上游明确不支持的高级能力会作为 capability 记录。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const projectDir = path.resolve(import.meta.dirname, "..");
const secretFile = path.join(projectDir, "bridge-secret.txt");
const port = Number(process.env.MIMO_BRIDGE_PORT || 8788);
const base = `http://127.0.0.1:${port}`;
const secret = fs.readFileSync(secretFile, "utf8").trim();
const headers = {
  Authorization: `Bearer ${secret}`,
  "Content-Type": "application/json",
};

async function request(url, options = {}, timeoutMs = 60000) {
  const response = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

function outputText(response) {
  return (response?.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text ?? "")
    .join("");
}

function parseJsonOutput(response) {
  const text = outputText(response);
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

const results = {
  checked_at: new Date().toISOString(),
  bridge: base,
  core: {},
  upstream_capabilities: {},
};

const statusResult = await request(`${base}/status`);
results.status = {
  ok: statusResult.response.ok && statusResult.payload?.ok,
  protocol: statusResult.payload?.protocol ?? null,
};

const structuredBody = {
  model: "mimo-desktop/mimo-v2.6-pro",
  instructions: "Return valid JSON only.",
  input: "Return an object with ok set to true and protocol set to full.",
  reasoning: { effort: "high", summary: "auto" },
  text: {
    format: {
      type: "json_schema",
      name: "protocol_result",
      schema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          protocol: { type: "string" },
        },
        required: ["ok", "protocol"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
  store: true,
  metadata: { test: "structured-output" },
  service_tier: "default",
};

const first = await request(`${base}/v1/responses`, {
  method: "POST",
  body: JSON.stringify(structuredBody),
});
const firstJson = parseJsonOutput(first.payload);
results.core.structured_output = {
  http_status: first.response.status,
  ok:
    first.response.ok &&
    first.payload?.status === "completed" &&
    firstJson?.ok === true,
  response_id: first.payload?.id ?? null,
  parsed: firstJson,
  error: first.payload?.error ?? null,
};

const stateSeed = await request(`${base}/v1/responses`, {
  method: "POST",
  body: JSON.stringify({
    model: "mimo-desktop/mimo-v2.6-pro",
    input: "Remember the codeword BRIDGE-ALPHA.",
    store: true,
  }),
});
let previousId = stateSeed.payload?.id;
if (previousId) {
  const second = await request(`${base}/v1/responses`, {
    method: "POST",
    body: JSON.stringify({
      model: "mimo-desktop/mimo-v2.6-pro",
      previous_response_id: previousId,
      input:
        "What codeword did I ask you to remember? Reply with the codeword only.",
    }),
  });
  const secondText = outputText(second.payload);
  results.core.previous_response_id = {
    http_status: second.response.status,
    ok:
      second.response.ok &&
      second.payload?.status === "completed" &&
      secondText.includes("BRIDGE-ALPHA"),
    output: secondText,
    error: second.payload?.error ?? null,
  };

  const retrieved = await request(`${base}/v1/responses/${previousId}`);
  results.core.response_retrieval = {
    http_status: retrieved.response.status,
    ok:
      retrieved.response.ok &&
      retrieved.payload?.id === previousId &&
      retrieved.payload?.status === "completed",
  };
}

const background = await request(`${base}/v1/responses`, {
  method: "POST",
  body: JSON.stringify({
    model: "mimo-desktop/mimo-v2.6-pro",
    input: "Reply with BACKGROUND-OK only.",
    background: true,
  }),
});
let backgroundBody = background.payload;
const deadline = Date.now() + 60000;
while (
  background.response.ok &&
  backgroundBody &&
  ["queued", "in_progress"].includes(backgroundBody.status) &&
  Date.now() < deadline
) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  const polled = await request(
    `${base}/v1/responses/${background.payload.id}`,
  );
  backgroundBody = polled.payload;
}
results.core.background_response = {
  http_status: background.response.status,
  ok:
    background.response.ok &&
    backgroundBody?.status === "completed" &&
    outputText(backgroundBody).includes("BACKGROUND-OK"),
  id: background.payload?.id ?? null,
  status: backgroundBody?.status ?? null,
  output: outputText(backgroundBody),
  error: backgroundBody?.error ?? null,
};

if (background.payload?.id) {
  const deleted = await request(
    `${base}/v1/responses/${background.payload.id}`,
    { method: "DELETE" },
  );
  results.core.response_deletion = {
    http_status: deleted.response.status,
    ok:
      deleted.response.ok &&
      deleted.payload?.object === "response.deleted" &&
      deleted.payload?.deleted === true,
  };
}

const custom = await request(`${base}/v1/responses`, {
  method: "POST",
  body: JSON.stringify({
    model: "mimo-desktop/mimo-v2.6-pro",
    input: "Call the echo_custom tool with input hello.",
    tools: [
      {
        type: "custom",
        name: "echo_custom",
        description: "Echo custom input",
        format: { type: "text" },
      },
    ],
    tool_choice: { type: "custom", name: "echo_custom" },
  }),
});
results.upstream_capabilities.custom_tools = {
  http_status: custom.response.status,
  supported: custom.response.ok,
  output_types: (custom.payload?.output ?? []).map((item) => item.type),
  error: custom.payload?.error ?? null,
};

const logprobs = await request(`${base}/v1/responses`, {
  method: "POST",
  body: JSON.stringify({
    model: "mimo-desktop/mimo-v2.6-pro",
    input: "Reply OK.",
    logprobs: true,
    top_logprobs: 2,
  }),
});
results.upstream_capabilities.logprobs = {
  http_status: logprobs.response.status,
  supported:
    logprobs.response.ok &&
    (logprobs.payload?.output ?? []).some((item) =>
      (item.content ?? []).some((part) => Array.isArray(part.logprobs)),
    ),
  error: logprobs.payload?.error ?? null,
};

const coreFailures = Object.entries(results.core).filter(
  ([, value]) => !value.ok,
);
results.ok =
  Boolean(results.status?.ok) &&
  Boolean(results.status?.protocol?.previous_response_id) &&
  coreFailures.length === 0;

console.log(JSON.stringify(results, null, 2));
if (!results.ok) process.exitCode = 1;