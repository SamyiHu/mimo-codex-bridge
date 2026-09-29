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

test("toChatRequestFromAnthropic: 纯 tool_calls 时 content 为 null", () => {
  const chat = toChatRequestFromAnthropic({
    model: "m",
    max_tokens: 8,
    tools: [{ name: "Write", input_schema: { type: "object", properties: { content: { type: "string" } } } }],
    messages: [
      { role: "user", content: "write file" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Write",
            input: { file_path: "a.svg", content: "<svg>" + "x".repeat(200) + "</svg>" },
          },
        ],
      },
    ],
  });
  const assistant = chat.messages.find((m) => m.role === "assistant");
  assert.equal(assistant.content, null);
  assert.equal(assistant.tool_calls.length, 1);
  assert.ok(assistant.tool_calls[0].function.arguments.length > 200);
});

test("toChatRequestFromAnthropic: 清洗 tool schema 冷门关键字", () => {
  const chat = toChatRequestFromAnthropic({
    model: "m",
    max_tokens: 8,
    tools: [
      {
        name: "Ask",
        input_schema: {
          type: "object",
          $schema: "http://json-schema.org/draft-07/schema#",
          propertyNames: { type: "string" },
          minItems: 1,
          format: "uri",
          properties: {
            url: { type: "string", format: "uri" },
          },
        },
      },
    ],
    messages: [{ role: "user", content: "x" }],
  });
  const schema = chat.tools[0].function.parameters;
  assert.equal(schema.$schema, undefined);
  assert.equal(schema.propertyNames, undefined);
  assert.equal(schema.minItems, undefined);
  assert.equal(schema.format, undefined);
  assert.equal(schema.properties.url.format, undefined);
  assert.equal(schema.properties.url.type, "string");
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

test("toChatRequestFromAnthropic: tool_result 里的图片转成后续 user 附件", () => {
  const chat = toChatRequestFromAnthropic({
    model: "m",
    max_tokens: 8,
    tools: [
      {
        name: "screenshot",
        input_schema: { type: "object", properties: {} },
      },
    ],
    messages: [
      { role: "user", content: "look" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_s",
            name: "screenshot",
            input: {},
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_s",
            content: [
              { type: "text", text: "ok" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "AAAA",
                },
              },
            ],
          },
        ],
      },
    ],
  });

  const toolMsg = chat.messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /ok/);
  assert.match(toolMsg.content, /media item/);
  assert.doesNotMatch(toolMsg.content, /omitted/);

  const attachmentMsg = chat.messages.find(
    (m) =>
      m.role === "user" &&
      Array.isArray(m.content) &&
      m.content.some((p) => p.type === "image_url"),
  );
  assert.ok(attachmentMsg, "应有携带图片的 user 附件消息");
  const img = attachmentMsg.content.find((p) => p.type === "image_url");
  assert.match(img.image_url.url, /^data:image\/png;base64,AAAA$/);
});

test("toChatRequestFromAnthropic: 丢弃空 name 的坏 tool_use 并降级结果", () => {
  const chat = toChatRequestFromAnthropic({
    model: "m",
    max_tokens: 8,
    messages: [
      { role: "user", content: "draw" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "trying" },
          {
            type: "tool_use",
            id: "call_ok",
            name: "Write",
            input: { file_path: "a.svg", content: "<svg/>" },
          },
          {
            type: "tool_use",
            id: "0",
            name: "",
            input: { file_path: "b.svg", content: "<svg/>" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_ok",
            content: "ok",
          },
          {
            type: "tool_result",
            tool_use_id: "0",
            content: "No such tool available: ",
            is_error: true,
          },
        ],
      },
    ],
  });

  const toolNames = chat.messages.flatMap((m) =>
    (m.tool_calls || []).map((tc) => tc.function.name),
  );
  assert.deepEqual(toolNames, ["Write"], "只保留有名字的工具");

  const toolMsgs = chat.messages.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 1);
  assert.equal(toolMsgs[0].tool_call_id, "call_ok");

  // 坏 tool 的结果变成用户文本，不再以 tool 角色出现
  const userText = chat.messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
  assert.match(userText, /No such tool available/);
});

test("toChatRequestFromAnthropic: thinking 默认不映射 reasoning_effort", () => {
  const chat = toChatRequestFromAnthropic({
    model: "m",
    max_tokens: 8,
    thinking: { type: "enabled", budget_tokens: 4096 },
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal(chat.reasoning_effort, undefined);
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

test("流式转换：按 index 分片的 tool_calls 合并成同一个块", () => {
  const translator = createAnthropicStreamTranslator(
    { model: "m" },
    { estimateMissingUsage: false },
  );
  // OpenAI 风格：首片 index=0 带 id/name，后续片只带 arguments。
  const events = parseSseEvents([
    ...translator.start(),
    ...translator.push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_abc",
                type: "function",
                function: { name: "Write", arguments: "" },
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
              { index: 0, function: { arguments: '{"file_path":' } },
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
              { index: 0, function: { arguments: '"a.svg"}' } },
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

  const starts = events.filter((e) => e.event === "content_block_start");
  assert.equal(starts.length, 1, "只应有一个 tool_use 块");
  assert.equal(starts[0].data.content_block.name, "Write");
  assert.equal(starts[0].data.content_block.id, "call_abc");

  const stops = events.filter((e) => e.event === "content_block_stop");
  assert.equal(stops.length, 1);

  const deltas = events.filter((e) => e.event === "content_block_delta");
  const json = deltas.map((d) => d.data.delta.partial_json).join("");
  assert.equal(json, '{"file_path":"a.svg"}');
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
