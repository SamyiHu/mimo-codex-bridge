import assert from "node:assert/strict";
import test from "node:test";
import {
  toChatRequest,
  toResponseObject,
  createResponseStreamTranslator,
  createSseParser,
  createQueuedResponse,
} from "../responses.mjs";

function eventPayloads(events) {
  return events.map((item) => JSON.parse(item.data));
}

test("converts Responses tools, tool_choice and multimodal input", () => {
  const request = {
    model: "mimo-x-pro-preview",
    instructions: "Be concise",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "inspect this " },
          { type: "input_image", image_url: "data:image/png;base64,abc" },
        ],
      },
      {
        type: "function_call",
        call_id: "call_a",
        name: "read_file",
        arguments: '{"path":"a.txt"}',
      },
      {
        type: "function_call",
        call_id: "call_b",
        name: "list_files",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call_a",
        output: { ok: true },
      },
      {
        type: "function_call_output",
        call_id: "call_b",
        output: { files: ["a.txt"] },
      },
    ],
    tools: [
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object" },
        strict: true,
      },
    ],
    tool_choice: { type: "function", name: "read_file" },
    max_output_tokens: 64,
  };

  const chat = toChatRequest(request);

  assert.equal(chat.model, "mimo-x-pro-preview");
  assert.equal(chat.max_tokens, 64);
  assert.deepEqual(chat.tool_choice, {
    type: "function",
    function: { name: "read_file" },
  });
  assert.deepEqual(chat.tools[0], {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object" },
      strict: true,
    },
  });

  assert.deepEqual(chat.messages[1].content, [
    { type: "text", text: "inspect this " },
    { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
  ]);

  const assistant = chat.messages[2];
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.tool_calls.length, 2);
  assert.equal(chat.messages[3].role, "tool");
  assert.equal(chat.messages[4].role, "tool");
});

test("converts non-streaming Chat Completion to Responses object", () => {
  const response = toResponseObject(
    {
      model: "xiaomi/mimo-pro",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            reasoning_content: "thinking",
            content: "I will inspect",
            tool_calls: [
              {
                id: "call_1",
                function: { name: "shell", arguments: '{"cmd":"dir"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 },
    },
    {
      model: "mimo-pro",
      tools: [{ type: "function", name: "shell" }],
    },
  );

  assert.equal(response.status, "completed");
  assert.equal(response.model, "xiaomi/mimo-pro");
  assert.deepEqual(response.usage, {
    input_tokens: 7,
    output_tokens: 5,
    total_tokens: 12,
  });
  assert.deepEqual(
    response.output.map((item) => item.type),
    ["reasoning", "message", "function_call"],
  );
  assert.equal(response.output[2].arguments, '{"cmd":"dir"}');
});

test("converts incremental Chat Completion chunks to Responses SSE", () => {
  const translator = createResponseStreamTranslator({
    model: "mimo-pro",
    tools: [{ type: "function", name: "shell" }],
  });

  const events = [
    ...translator.start(),
    ...translator.push({
      object: "chat.completion.chunk",
      model: "xiaomi/mimo-pro",
      choices: [{ delta: { content: "he" } }],
    }),
    ...translator.push({
      object: "chat.completion.chunk",
      choices: [{ delta: { content: "llo" } }],
    }),
    ...translator.push({
      object: "chat.completion.chunk",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "shell", arguments: '{"cmd":' },
              },
            ],
          },
        },
      ],
    }),
    ...translator.push({
      object: "chat.completion.chunk",
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '"dir"}' } },
            ],
          },
        },
      ],
    }),
    ...translator.end({
      object: "chat.completion.chunk",
      choices: [],
      usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
    }),
  ];

  const payloads = eventPayloads(events);
  const textDeltas = payloads
    .filter((item) => item.type === "response.output_text.delta")
    .map((item) => item.delta);
  const argsDeltas = payloads
    .filter((item) => item.type === "response.function_call_arguments.delta")
    .map((item) => item.delta);
  const completed = payloads.find(
    (item) => item.type === "response.completed",
  );

  assert.equal(events[0].event, "response.created");
  assert.equal(events.at(-1).event, "response.completed");
  assert.deepEqual(textDeltas, ["he", "llo"]);
  assert.deepEqual(argsDeltas, ['{"cmd":', '"dir"}']);
  assert.equal(
    completed.response.output.find((item) => item.type === "message")
      .content[0].text,
    "hello",
  );
  assert.equal(
    completed.response.output.find((item) => item.type === "function_call")
      .arguments,
    '{"cmd":"dir"}',
  );
  assert.deepEqual(completed.response.usage, {
    input_tokens: 2,
    output_tokens: 4,
    total_tokens: 6,
  });
});

test("parses fragmented and multi-line SSE messages", () => {
  const parsed = [];
  const parser = createSseParser((item) => parsed.push(item));

  parser.push('event: mess');
  parser.push('age\ndata: {"object":"chat.completion.chu');
  parser.push('nk","choices":[{"delta":{"content":"x"}}]}\n');
  parser.push('\ndata: [DONE]\n\n');

  parser.end();
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].event, "message");
  assert.equal(parsed[0].data.choices[0].delta.content, "x");
  assert.equal(parsed[1].data, "[DONE]");
});

test("preserves multi-byte UTF-8 split across SSE chunk boundaries", () => {
  // 上游的 SSE chunk 边界与 UTF-8 字符边界无关。用 Buffer#toString()
  // 逐个 chunk 解码会把跨包的中文字符切成 U+FFFD。
  const expected = "中文测试-流式输出";
  const raw = Buffer.from(
    'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"' +
      expected +
      '"}}]}\n\n',
    "utf8",
  );

  for (let cut = 1; cut < raw.length; cut += 1) {
    const parsed = [];
    const parser = createSseParser((item) => parsed.push(item));
    parser.push(raw.subarray(0, cut));
    parser.push(raw.subarray(cut));
    parser.end();

    assert.equal(parsed.length, 1, "cut=" + cut + " should yield one event");
    assert.equal(
      parsed[0].data.choices[0].delta.content,
      expected,
      "cut=" + cut + " corrupted the streamed text",
    );
  }
});

test("stream translator emits a cancelled terminal event", () => {
  const translator = createResponseStreamTranslator({
    model: "mimo-x-pro-preview",
    input: "hello",
    stream: true,
  });

  translator.start();
  translator.push({
    object: "chat.completion.chunk",
    choices: [{ delta: { content: "partial" } }],
  });

  const cancelled = eventPayloads(translator.cancel());
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].type, "response.cancelled");
  assert.equal(cancelled[0].response.status, "cancelled");
  assert.deepEqual(cancelled[0].response.incomplete_details, {
    reason: "cancelled",
  });
  // 取消必须保留已产出的部分输出，便于客户端留存。
  assert.equal(cancelled[0].response.output[0].content[0].text, "partial");
});

test("stream translator exposes the in-flight response for registration", () => {
  const translator = createResponseStreamTranslator({
    model: "mimo-x-pro-preview",
    input: "hello",
    stream: true,
  });

  const created = eventPayloads(translator.start());
  const live = translator.currentResponse();
  assert.ok(live.id, "translator must expose a response id before completion");
  assert.equal(created[0].response.id, live.id);
  assert.equal(live.status, "in_progress");
});
test("supports stateful Responses context, item_reference and structured output", () => {
  const previous = {
    id: "resp_previous",
    instructions: "Keep answers short",
    output: [
      {
        type: "message",
        id: "msg_previous",
        role: "assistant",
        content: [{ type: "output_text", text: "first answer" }],
      },
    ],
  };

  const chat = toChatRequest(
    {
      model: "mimo-pro",
      previous_response_id: previous.id,
      input: [
        { type: "item_reference", id: "msg_previous" },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "next" }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "result",
          schema: { type: "object" },
          strict: true,
        },
      },
      reasoning: { effort: "high", summary: "auto" },
      top_logprobs: 2,
    },
    { previousResponse: previous },
  );

  assert.equal(chat.messages[0].content, "Keep answers short");
  assert.deepEqual(chat.messages[1], {
    role: "assistant",
    content: "first answer",
  });
  assert.deepEqual(chat.messages[2], { role: "user", content: "next" });
  assert.deepEqual(chat.response_format, {
    type: "json_schema",
    json_schema: {
      name: "result",
      description: "",
      schema: { type: "object" },
      strict: true,
    },
  });
  assert.equal(chat.reasoning_effort, "high");
  assert.equal(chat.top_logprobs, 2);
});

test("supports custom tools, refusal content, logprobs and usage details", () => {
  const chat = toChatRequest({
    model: "mimo-pro",
    input: [
      { type: "custom_tool_call", call_id: "custom_1", name: "render", input: "x" },
      { type: "custom_tool_call_output", call_id: "custom_1", output: { ok: true } },
    ],
    tools: [
      {
        type: "custom",
        name: "render",
        description: "Render input",
        format: { type: "text" },
      },
    ],
    tool_choice: { type: "custom", name: "render" },
  });

  assert.deepEqual(chat.tools[0], {
    type: "custom",
    custom: {
      name: "render",
      description: "Render input",
      format: { type: "text" },
    },
  });
  assert.deepEqual(chat.tool_choice, {
    type: "custom",
    custom: { name: "render" },
  });
  assert.equal(chat.messages[0].tool_calls[0].type, "custom");
  assert.equal(chat.messages[1].role, "tool");

  const response = toResponseObject(
    {
      choices: [
        {
          finish_reason: "content_filter",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "safe text",
                annotations: [{ type: "url_citation", url: "https://example.test" }],
              },
              { type: "refusal", refusal: "not allowed" },
            ],
          },
          logprobs: {
            content: [{ token: "safe", logprob: -0.1 }],
          },
        },
      ],
      usage: {
        prompt_tokens: 4,
        completion_tokens: 3,
        total_tokens: 7,
        prompt_tokens_details: { cached_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1 },
      },
    },
    {
      model: "mimo-pro",
      metadata: { request: "protocol" },
      service_tier: "default",
      store: false,
      background: false,
    },
  );

  const message = response.output.find((item) => item.type === "message");
  assert.equal(message.content[0].annotations[0].url, "https://example.test");
  assert.deepEqual(message.content[0].logprobs, [
    { token: "safe", logprob: -0.1 },
  ]);
  assert.deepEqual(message.content[1], {
    type: "refusal",
    refusal: "not allowed",
  });
  assert.equal(response.status, "incomplete");
  assert.deepEqual(response.incomplete_details, { reason: "content_filter" });
  assert.deepEqual(response.usage.input_tokens_details, { cached_tokens: 2 });
  assert.deepEqual(response.usage.output_tokens_details, {
    reasoning_tokens: 1,
  });
  assert.equal(response.store, false);
  assert.equal(response.service_tier, "default");
  assert.deepEqual(response.metadata, { request: "protocol" });
});

test("creates background response objects with protocol metadata", () => {
  const queued = createQueuedResponse({
    model: "mimo-pro",
    background: true,
    store: true,
    metadata: { job: "one" },
  });

  assert.match(queued.id, /^resp_/);
  assert.equal(queued.object, "response");
  assert.equal(queued.status, "in_progress");
  assert.equal(queued.background, true);
  assert.deepEqual(queued.metadata, { job: "one" });
  assert.deepEqual(queued.output, []);
});

test("rejects requests that would produce an empty message list", () => {
  assert.throws(
    () => toChatRequest({ model: "mimo-x-pro-preview", input: [] }),
    /input is empty/,
  );
  assert.throws(
    () => toChatRequest({ model: "mimo-x-pro-preview", input: null }),
    /input is empty/,
  );
  // 仅有 instructions 时合法。
  const chat = toChatRequest({
    model: "mimo-x-pro-preview",
    instructions: "Be concise",
  });
  assert.equal(chat.messages[0].role, "system");
});

test("rejects unsupported hosted prompt and tool types explicitly", () => {
  assert.throws(
    () => toChatRequest({ model: "mimo-pro", prompt: { id: "prompt_1" } }),
    (error) => error.statusCode === 501 && error.code === "unsupported_response_prompt",
  );
  // web_search 等 hosted 工具：MiMo 引擎没有对应能力，而 Codex 默认就会下发，
  // 所以丢弃而不是让整轮请求失败；只有真正未知的类型才明确报错。
  const droppedTools = toChatRequest({
    model: "mimo-pro",
    input: "hello",
    tools: [{ type: "web_search" }, { type: "function", name: "shell" }],
  });
  assert.deepEqual(
    droppedTools.tools.map((tool) => tool.function?.name ?? tool.type),
    ["shell"],
  );
  const onlyHosted = toChatRequest({
    model: "mimo-pro",
    input: "hello",
    tools: [{ type: "web_search" }],
  });
  assert.equal(onlyHosted.tools, undefined);
  assert.throws(
    () =>
      toChatRequest({
        model: "mimo-pro",
        input: "hello",
        tools: [{ type: "quantum_search" }],
      }),
    (error) => error.code === "unsupported_tool_type",
  );
});
