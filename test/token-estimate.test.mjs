import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

import {
  estimateTextTokens,
  estimateChatRequestTokens,
  estimateChatResponseTokens,
  estimateResponsesOutputTokens,
  hasRealUsage,
} from "../token-estimate.mjs";
import { createResponseStreamTranslator } from "../responses.mjs";

const projectDir = path.resolve(import.meta.dirname, "..");

test("estimateTextTokens: CJK 按字计，其他文本按 4 字符/token", () => {
  assert.equal(estimateTextTokens("你好世界"), 4);
  assert.equal(estimateTextTokens("hello world"), Math.ceil(11 / 4));
  assert.equal(estimateTextTokens("你好abc"), 2 + Math.ceil(3 / 4));
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens(null), 0);
  assert.equal(estimateTextTokens(undefined), 0);
});

test("estimateChatRequestTokens: messages、多模态 parts 与 tools 都计入", () => {
  const body = {
    messages: [
      { role: "system", content: "你是一个助手" },
      {
        role: "user",
        content: [
          { type: "text", text: "看看这张图" },
          { type: "image_url", image_url: { url: "data:..." } },
        ],
      },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "file body" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read_file",
          description: "读取文件",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ],
  };
  const tokens = estimateChatRequestTokens(body);
  assert.ok(tokens > 0);

  const textOnly = estimateChatRequestTokens({
    messages: [{ role: "user", content: "你好" }],
  });
  assert.ok(textOnly > 0);
  assert.ok(tokens > textOnly);
  // 图片 data URL 无法估算，不应被当作文本计入
  const withoutImage = estimateChatRequestTokens({
    ...body,
    messages: body.messages.filter((m) => m.role !== "user"),
  });
  assert.ok(withoutImage > 0);
});

test("estimateChatResponseTokens 与 estimateResponsesOutputTokens 覆盖主要输出形态", () => {
  const chatPayload = {
    choices: [
      {
        message: {
          role: "assistant",
          content: "好的，这是回答。",
          reasoning_content: "先想一想",
          tool_calls: [
            { function: { name: "write", arguments: "{\"x\":1}" } },
          ],
        },
      },
    ],
  };
  const chatTokens = estimateChatResponseTokens(chatPayload);
  assert.ok(chatTokens > estimateTextTokens("好的，这是回答。"));

  const response = {
    output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "思考中" }] },
      {
        type: "message",
        content: [{ type: "output_text", text: "最终答复" }],
      },
      { type: "function_call", name: "run", arguments: "{\"cmd\":\"ls\"}" },
    ],
  };
  assert.ok(estimateResponsesOutputTokens(response) > 0);
  assert.equal(estimateResponsesOutputTokens({ output: [] }), 0);
});

test("hasRealUsage: 缺失与全零都不算真实 usage", () => {
  assert.equal(hasRealUsage(undefined), false);
  assert.equal(hasRealUsage(null), false);
  assert.equal(
    hasRealUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
    false,
  );
  assert.equal(hasRealUsage({ prompt_tokens: 0, completion_tokens: 5 }), true);
  assert.equal(hasRealUsage({ input_tokens: 3, output_tokens: 0 }), true);
});

test("流式转换器：上游没给 usage 时 end() 补估算值", () => {
  const translator = createResponseStreamTranslator(
    { model: "m", input: "hi", stream: true },
    { estimatedInputTokens: 42 },
  );
  translator.start();
  translator.push({
    object: "chat.completion.chunk",
    choices: [{ delta: { content: "你好，世界" } }],
  });
  const events = translator.end();
  const completed = events
    .map((evt) => JSON.parse(evt.data))
    .find((item) => item.type === "response.completed");

  assert.equal(translator.usageEstimated(), true);
  assert.equal(completed.response.usage.input_tokens, 42);
  assert.ok(completed.response.usage.output_tokens > 0);
  assert.equal(
    completed.response.usage.total_tokens,
    completed.response.usage.input_tokens +
      completed.response.usage.output_tokens,
  );
});

test("流式转换器：上游 usage 优先于估算", () => {
  const translator = createResponseStreamTranslator(
    { model: "m", input: "hi", stream: true },
    { estimatedInputTokens: 42 },
  );
  translator.start();
  translator.push({
    object: "chat.completion.chunk",
    choices: [{ delta: { content: "hi" } }],
  });
  translator.push({
    object: "chat.completion.chunk",
    choices: [],
    usage: { prompt_tokens: 7, completion_tokens: 9, total_tokens: 16 },
  });
  const events = translator.end();
  const completed = events
    .map((evt) => JSON.parse(evt.data))
    .find((item) => item.type === "response.completed");

  assert.equal(translator.usageEstimated(), false);
  assert.equal(completed.response.usage.input_tokens, 7);
  assert.equal(completed.response.usage.total_tokens, 16);
});

test("流式转换器：未开启估算时保持零 usage", () => {
  const translator = createResponseStreamTranslator({
    model: "m",
    input: "hi",
    stream: true,
  });
  translator.start();
  translator.push({
    object: "chat.completion.chunk",
    choices: [{ delta: { content: "hi" } }],
  });
  const events = translator.end();
  const completed = events
    .map((evt) => JSON.parse(evt.data))
    .find((item) => item.type === "response.completed");

  assert.equal(translator.usageEstimated(), false);
  assert.equal(completed.response.usage.total_tokens, 0);
});

// ---------------------------------------------------------------------------
// 集成：起真实 bridge 进程 + mock 引擎（不返回 usage），验证端到端估算。
// ---------------------------------------------------------------------------

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function unusedPort() {
  const server = http.createServer();
  await listen(server);
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(port, child, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`bridge exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError ?? new Error("bridge health check timed out");
}

test("bridge 在上游缺失 usage 时返回估算值并在指标中单独统计", async () => {
  const bridgeToken = "estimate-token";
  const bridgeSecret = "estimate-bridge-secret";

  const engine = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url.startsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ data: [{ id: "mimo-desktop/mimo-pro" }] }),
      );
      return;
    }

    if (req.method === "POST" && req.url.startsWith("/v1/chat/completions")) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));

      if (body.stream !== true) {
        // 关键：上游响应完全没有 usage 字段
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: body.model,
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: "这是一段估算测试回答。" },
              },
            ],
          }),
        );
        return;
      }

      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      res.write(
        'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"流式"}}]}\n\n',
      );
      res.write(
        'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"回答"}}]}\n\n',
      );
      // 关键：SSE 里也不带 usage chunk
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(404).end();
  });
  await listen(engine);

  const bridgePort = await unusedPort();
  const child = spawn(
    process.execPath,
    [
      path.join(projectDir, "bridge.mjs"),
      "--port",
      String(bridgePort),
      "--token",
      bridgeToken,
      "--bridge-secret",
      bridgeSecret,
      "--engine-url",
      `http://127.0.0.1:${engine.address().port}`,
    ],
    { cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await waitForHealth(bridgePort, child);
    const auth = {
      Authorization: `Bearer ${bridgeSecret}`,
      "Content-Type": "application/json",
    };

    // 非流式：usage 应为估算值
    const nonStream = await fetch(
      `http://127.0.0.1:${bridgePort}/v1/responses`,
      {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          model: "mimo-desktop/mimo-pro",
          input: "请回答",
          stream: false,
        }),
      },
    );
    assert.equal(nonStream.status, 200);
    const nonStreamJson = await nonStream.json();
    assert.ok(nonStreamJson.usage.input_tokens > 0);
    assert.ok(nonStreamJson.usage.output_tokens > 0);
    assert.equal(
      nonStreamJson.usage.total_tokens,
      nonStreamJson.usage.input_tokens + nonStreamJson.usage.output_tokens,
    );

    // 流式：response.completed 携带估算 usage
    const stream = await fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
      method: "POST",
      headers: { ...auth, Accept: "text/event-stream" },
      body: JSON.stringify({
        model: "mimo-desktop/mimo-pro",
        input: "请流式回答",
        stream: true,
      }),
    });
    assert.equal(stream.status, 200);
    const streamText = await stream.text();
    const completedLine = streamText
      .split("\n")
      .find((line) => line.startsWith("data: ") && line.includes("response.completed"));
    assert.ok(completedLine, "stream should contain response.completed");
    const completed = JSON.parse(completedLine.slice("data: ".length));
    assert.ok(completed.response.usage.input_tokens > 0);
    assert.ok(completed.response.usage.output_tokens > 0);

    // /status：估算与真实 usage 分开统计
    const status = await (
      await fetch(`http://127.0.0.1:${bridgePort}/status`, {
        headers: { Authorization: `Bearer ${bridgeSecret}` },
      })
    ).json();
    assert.equal(status.metrics.usage.estimated.requests, 2);
    assert.equal(status.metrics.usage.requests_with_usage, 0);
    assert.ok(status.metrics.usage.estimated.total_tokens > 0);
  } finally {
    child.kill();
    await Promise.race([
      once(child, "exit"),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    engine.close();
    await new Promise((resolve) => engine.close(resolve));
  }
});
