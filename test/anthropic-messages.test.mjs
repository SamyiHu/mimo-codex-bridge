import assert from "node:assert/strict";
import test from "node:test";
import {
  toChatRequestFromAnthropic,
  toAnthropicMessage,
  createAnthropicStreamTranslator,
} from "../anthropic-messages.mjs";

test("toChatRequestFromAnthropic: 文本、system 与 max_tokens", () => {
  const chat = toChatRequestFromAnthropic({
    model: "mimo-desktop/mimo-pro",
    max_tokens: 128,
    system: "You are terse.",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(chat.model, "mimo-desktop/mimo-pro");
  assert.equal(chat.max_tokens, 128);
  assert.equal(chat.stream, false);
  assert.equal(chat.messages[0].role, "system");
  assert.equal(chat.messages[0].content, "You are terse.");
  assert.deepEqual(chat.messages[1], { role: "user", content: "hello" });
});

test("toChatRequestFromAnthropic: system 数组块", () => {
  const chat = toChatRequestFromAnthropic({
    model: "m",
    max_tokens: 16,
    system: [
      { type: "text", text: "line1" },
      { type: "text", text: "line2" },
    ],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.match(chat.messages[0].content, /line1/);
  assert.match(chat.messages[0].content, /line2/);
});

test("toChatRequestFromAnthropic: tool_use 与 tool_result", () => {
  const chat = toChatRequestFromAnthropic({
    model: "m",
    max_tokens: 64,
    tools: [
      {
        name: "exec_command",
        description: "run",
        input_schema: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
        },
      },
    ],
    tool_choice: { type: "any" },
    messages: [
      { role: "user", content: "run ls" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "exec_command",
            input: { cmd: "ls" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: "file.txt",
          },
        ],
      },
    ],
  });

  assert.equal(chat.tool_choice, "required");
  assert.equal(chat.tools[0].function.name, "exec_command");
  assert.equal(chat.tools[0].function.parameters.type, "object");

  const assistant = chat.messages.find((m) => m.role === "assistant");
  assert.equal(assistant.tool_calls.length, 1);
  assert.equal(assistant.tool_calls[0].id, "toolu_1");
  assert.equal(assistant.tool_calls[0].function.name, "exec_command");
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), {
    cmd: "ls",
  });

  const toolMsg = chat.messages.find((m) => m.role === "tool");
  assert.equal(toolMsg.tool_call_id, "toolu_1");
  assert.equal(toolMsg.content, "file.txt");
});

test("toChatRequestFromAnthropic: tool_choice.tool 指定函数", () => {
  const chat = toChatRequestFromAnthropic({
    model: "m",
    max_tokens: 8,
    tools: [{ name: "a", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "a" },
    messages: [{ role: "user", content: "x" }],
  });
  assert.deepEqual(chat.tool_choice, {
    type: "function",
    function: { name: "a" },
  });
});

test("toChatRequestFromAnthropic: 图片 base64 与 url", () => {
  const chat = toChatRequestFromAnthropic({
    model: "m",
    max_tokens: 8,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "AAAA",
            },
          },
          {
            type: "image",
            source: { type: "url", url: "https://example.com/a.png" },
          },
        ],
      },
    ],
  });
  const parts = chat.messages[0].content;
  assert.equal(parts[0].type, "text");
  assert.equal(parts[1].type, "image_url");
  assert.match(parts[1].image_url.url, /^data:image\/png;base64,AAAA$/);
  assert.equal(parts[2].image_url.url, "https://example.com/a.png");
});

test("toChatRequestFromAnthropic: 缺 max_tokens 报错", () => {
  assert.throws(
    () =>
      toChatRequestFromAnthropic({
        model: "m",
        messages: [{ role: "user", content: "x" }],
      }),
    /max_tokens is required/,
  );
});

test("toAnthropicMessage: 文本 + tool_use + stop_reason", () => {
  const message = toAnthropicMessage(
    {
      id: "chatcmpl-1",
      model: "mimo-pro",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: "calling tool",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "exec_command",
                  arguments: '{"cmd":"pwd"}',
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
    { model: "mimo-pro" },
    { estimateMissingUsage: true },
  );

  assert.equal(message.type, "message");
  assert.equal(message.role, "assistant");
  assert.equal(message.stop_reason, "tool_use");
  assert.equal(message.content[0].type, "text");
  assert.equal(message.content[0].text, "calling tool");
  assert.equal(message.content[1].type, "tool_use");
  assert.equal(message.content[1].name, "exec_command");
  assert.deepEqual(message.content[1].input, { cmd: "pwd" });
  assert.equal(message.usage.input_tokens, 10);
  assert.equal(message.usage.output_tokens, 5);
});

test("toAnthropicMessage: length → max_tokens，无工具纯文本", () => {
  const message = toAnthropicMessage(
    {
      choices: [
        {
          finish_reason: "length",
          message: { role: "assistant", content: "partial" },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    },
    { model: "m" },
    { estimateMissingUsage: false },
  );
  assert.equal(message.stop_reason, "max_tokens");
  assert.equal(message.content.length, 1);
  assert.equal(message.content[0].text, "partial");
});

function parseSseEvents(events) {
  return events.map((evt) => ({
    event: evt.event,
    data: JSON.parse(evt.data),
  }));
}

test("流式转换：文本增量", () => {
  const translator = createAnthropicStreamTranslator(
    { model: "mimo-pro" },
    { estimatedInputTokens: 3, estimateMissingUsage: true },
  );
  const events = parseSseEvents([
    ...translator.start(),
    ...translator.push({
      choices: [{ delta: { content: "Hel" } }],
    }),
    ...translator.push({
      choices: [{ delta: { content: "lo" } }],
    }),
    ...translator.push({
      choices: [{ delta: {}, finish_reason: "stop" }],
    }),
    ...translator.end(),
  ]);

  assert.equal(events[0].event, "message_start");
  assert.equal(events[0].data.message.role, "assistant");
  assert.equal(events[1].event, "content_block_start");
  assert.equal(events[1].data.content_block.type, "text");
  assert.equal(events[2].event, "content_block_delta");
  assert.equal(events[2].data.delta.type, "text_delta");
  assert.equal(events[2].data.delta.text, "Hel");
  assert.equal(events[3].data.delta.text, "lo");
  assert.equal(events[4].event, "content_block_stop");

  const messageDelta = events.find((e) => e.event === "message_delta");
  assert.equal(messageDelta.data.delta.stop_reason, "end_turn");
  assert.equal(events.at(-1).event, "message_stop");
});

test("流式转换：工具调用 input_json_delta", () => {
  const translator = createAnthropicStreamTranslator(
    { model: "m" },
    { estimateMissingUsage: false },
  );
  const events = parseSseEvents([
    ...translator.start(),
    ...translator.push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                id: "call_9",
                function: { name: "exec_command", arguments: "" },
              },
            ],
          },
        },
      ],
    }),
    ...translator.push({
      choices: [
        {
          delta: {
            tool_calls: [
              { id: "call_9", function: { arguments: '{"cmd":' } },
            ],
          },
        },
      ],
    }),
    ...translator.push({
      choices: [
        {
          delta: {
            tool_calls: [
              { id: "call_9", function: { arguments: '"ls"}' } },
            ],
          },
        },
      ],
    }),
    ...translator.push({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    }),
    ...translator.end(),
  ]);

  const start = events.find((e) => e.event === "content_block_start");
  assert.equal(start.data.content_block.type, "tool_use");
  assert.equal(start.data.content_block.name, "exec_command");

  const deltas = events.filter((e) => e.event === "content_block_delta");
  assert.ok(deltas.length >= 2);
  assert.equal(deltas[0].data.delta.type, "input_json_delta");
  assert.match(deltas.map((d) => d.data.delta.partial_json).join(""), /"ls"/);

  const messageDelta = events.find((e) => e.event === "message_delta");
  assert.equal(messageDelta.data.delta.stop_reason, "tool_use");
});

test("流式转换：上游 usage 优先于估算", () => {
  const translator = createAnthropicStreamTranslator(
    { model: "m" },
    { estimatedInputTokens: 99, estimateMissingUsage: true },
  );
  translator.start();
  translator.push({ choices: [{ delta: { content: "x" } }] });
  translator.push({
    choices: [{ delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
  });
  const events = parseSseEvents(translator.end());
  const messageDelta = events.find((e) => e.event === "message_delta");
  assert.equal(messageDelta.data.usage.output_tokens, 22);
  assert.equal(translator.usageEstimated(), false);
});
