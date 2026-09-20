/**
 * Responses API ⇄ Chat Completions 转换层。
 *
 * 支持：
 * - Responses 请求转换成 Chat Completions 请求
 * - Chat Completions 结果转换成 Responses 对象
 * - Chat Completions SSE 增量转换成 Responses SSE 事件
 */
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";

const uid = (prefix) =>
  prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);

function protocolError(message, statusCode = 400, code = "invalid_request") {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function toChatContentPart(part) {
  if (typeof part === "string") return { type: "text", text: part };
  if (!part || typeof part !== "object") {
    return { type: "text", text: String(part ?? "") };
  }

  switch (part.type) {
    case "input_text":
    case "output_text":
    case "text":
      return { type: "text", text: String(part.text ?? part.content ?? "") };

    case "refusal":
      return {
        type: "text",
        text: String(part.refusal ?? part.text ?? ""),
      };

    case "input_image": {
      const url = part.image_url ?? part.url;
      return {
        type: "image_url",
        image_url:
          typeof url === "string"
            ? { url, ...(part.detail ? { detail: part.detail } : {}) }
            : url,
      };
    }

    case "input_audio": {
      const audio = part.audio ?? part.input_audio ?? {};
      return {
        type: "input_audio",
        input_audio: {
          data: audio.data ?? part.data,
          format: audio.format ?? part.format ?? "wav",
        },
      };
    }

    case "input_file": {
      const file = {};
      if (part.file_id ?? part.id) file.file_id = part.file_id ?? part.id;
      if (part.filename) file.filename = part.filename;
      if (part.file_data ?? part.data) {
        file.file_data = part.file_data ?? part.data;
      }
      if (part.file_url ?? part.url) file.file_url = part.file_url ?? part.url;
      return { type: "file", file };
    }

    default:
      return part;
  }
}

function toChatContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const hasNonText = content.some(
    (part) =>
      part &&
      typeof part === "object" &&
      !["input_text", "output_text", "text", "refusal"].includes(part.type),
  );

  if (hasNonText) return content.map(toChatContentPart);
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      return String(
        part?.text ??
          part?.input_text ??
          part?.output_text ??
          part?.refusal ??
          "",
      );
    })
    .join("");
}

function serializeToolOutput(output) {
  if (typeof output === "string") return output;
  return JSON.stringify(output ?? "");
}

function toChatToolChoice(toolChoice, options = {}) {
  if (typeof toolChoice === "string") return toolChoice;
  if (!toolChoice || typeof toolChoice !== "object") return "auto";

  if (toolChoice.type === "function") {
    const name = toolChoice.function?.name ?? toolChoice.name;
    if (!name) throw protocolError("tool_choice.function.name is required");
    return { type: "function", function: { name } };
  }

  if (toolChoice.type === "custom") {
    const name = toolChoice.custom?.name ?? toolChoice.name;
    if (!name) throw protocolError("tool_choice.custom.name is required");
    return options.emulateCustomTools
      ? { type: "function", function: { name } }
      : { type: "custom", custom: { name } };
  }

  if (["auto", "required", "none"].includes(toolChoice.type)) {
    return toolChoice.type;
  }

  throw protocolError(
    `unsupported Responses tool_choice type: ${toolChoice.type}`,
  );
}

function toChatTools(tools, options = {}) {
  return tools
    .filter((tool) => tool && typeof tool === "object")
    .map((tool) => {
      if (tool.type === "custom") {
        if (options.emulateCustomTools) {
          return {
            type: "function",
            function: {
              name: tool.name,
              description: tool.description ?? "",
              parameters: {
                type: "object",
                properties: {
                  input: { type: "string" },
                },
                required: ["input"],
                additionalProperties: false,
              },
              strict: true,
            },
          };
        }
        return {
          type: "custom",
          custom: {
            name: tool.name,
            description: tool.description ?? "",
            format: tool.format ?? { type: "text" },
          },
        };
      }

      if (tool.type === "function" || tool.name) {
        const fn = tool.function ?? tool;
        const converted = {
          type: "function",
          function: {
            name: fn.name,
            description: fn.description ?? "",
          },
        };
        if (fn.parameters) converted.function.parameters = fn.parameters;
        if (fn.strict !== undefined) converted.function.strict = fn.strict;
        return converted;
      }

      throw protocolError(
        `unsupported Responses tool type: ${tool.type ?? "unknown"}`,
        400,
        "unsupported_tool_type",
      );
    });
}

function toChatResponseFormat(body) {
  const format = body.text?.format;
  if (!format || format.type === "text") return null;

  if (format.type === "json_object") {
    return { type: "json_object" };
  }

  if (format.type === "json_schema") {
    if (!format.name) throw protocolError("text.format.name is required");
    return {
      type: "json_schema",
      json_schema: {
        name: format.name,
        description: format.description ?? "",
        schema: format.schema ?? { type: "object" },
        strict: format.strict ?? true,
      },
    };
  }

  throw protocolError(`unsupported Responses text.format.type: ${format.type}`);
}

/** Responses 请求 → Chat Completions 请求 */
export function toChatRequest(body, options = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw protocolError("request body must be a JSON object");
  }

  if (body.prompt) {
    throw protocolError(
      "Responses prompt objects require a local prompt registry and are not supported",
      501,
      "unsupported_response_prompt",
    );
  }

  const previousResponse = options.previousResponse ?? null;
  if (body.previous_response_id && !previousResponse) {
    throw protocolError(
      `previous response not found: ${body.previous_response_id}`,
      404,
      "response_not_found",
    );
  }

  if (
    body.service_tier !== undefined &&
    !["auto", "default"].includes(body.service_tier)
  ) {
    throw protocolError(
      `unsupported Responses service_tier: ${body.service_tier}`,
    );
  }

  const messages = [];
  let pendingToolCalls = [];
  // 同一个索引同时承担两件事：解析 item_reference，以及判断某个引用是否已被
  // 自动拼接进上下文（避免重复）。以前这里是两份内容相同的 Map + Set。
  const previousItems = new Map();

  if (previousResponse?.output) {
    for (const item of previousResponse.output) {
      if (item?.id) previousItems.set(item.id, item);
      if (item?.call_id) previousItems.set(item.call_id, item);
    }
  }

  const flushToolCalls = () => {
    if (!pendingToolCalls.length) return;
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: pendingToolCalls,
    });
    pendingToolCalls = [];
  };

  const instructions = body.instructions ?? previousResponse?.instructions;
  if (instructions) {
    messages.push({ role: "system", content: String(instructions) });
  }

  const consume = (item) => {
    if (typeof item === "string") {
      flushToolCalls();
      messages.push({ role: "user", content: item });
      return;
    }
    if (!item || typeof item !== "object") return;

    switch (item.type) {
      case "message":
      case undefined:
        flushToolCalls();
        if (item.role) {
          messages.push({
            role: item.role === "developer" ? "system" : item.role,
            content: toChatContent(item.content),
          });
        }
        break;

      case "function_call":
        pendingToolCalls.push({
          id: item.call_id || item.id || uid("call_"),
          type: "function",
          function: {
            name: item.name,
            arguments:
              typeof item.arguments === "string"
                ? item.arguments
                : JSON.stringify(item.arguments ?? {}),
          },
        });
        break;

      case "function_call_output":
        flushToolCalls();
        messages.push({
          role: "tool",
          tool_call_id: item.call_id || item.id,
          content: serializeToolOutput(item.output),
        });
        break;

      case "custom_tool_call": {
        const customInput =
          typeof item.input === "string"
            ? item.input
            : JSON.stringify(item.input ?? "");
        pendingToolCalls.push(
          options.emulateCustomTools
            ? {
                id: item.call_id || item.id || uid("call_"),
                type: "function",
                function: {
                  name: item.name,
                  arguments: JSON.stringify({ input: customInput }),
                },
              }
            : {
                id: item.call_id || item.id || uid("call_"),
                type: "custom",
                custom: { name: item.name, input: customInput },
              },
        );
        break;
      }

      case "custom_tool_call_output":
        flushToolCalls();
        messages.push({
          role: "tool",
          tool_call_id: item.call_id || item.id,
          content: serializeToolOutput(item.output),
        });
        break;

      case "reasoning":
        // MiMo Chat 没有可回放的完整 reasoning 状态。
        break;

      case "item_reference": {
        if (previousItems.has(item.id)) break;
        const referenced =
          previousItems.get(item.id) ??
          previousResponse?.output?.find(
            (candidate) =>
              candidate.id === item.id || candidate.call_id === item.id,
          );
        if (!referenced) {
          throw protocolError(
            `response item reference not found: ${item.id}`,
            404,
            "response_item_not_found",
          );
        }
        consume(referenced);
        break;
      }

      default:
        if (item.role) {
          flushToolCalls();
          messages.push({
            role: item.role === "developer" ? "system" : item.role,
            content: toChatContent(item.content),
          });
        } else {
          throw protocolError(
            `unsupported Responses input item type: ${item.type}`,
            400,
            "unsupported_input_item",
          );
        }
    }
  };

  const currentInput = body.input;
  const inputItems = [];
  if (previousResponse?.output) inputItems.push(...previousResponse.output);
  if (Array.isArray(currentInput)) inputItems.push(...currentInput);
  else if (typeof currentInput === "string") inputItems.push(currentInput);

  for (const item of inputItems) consume(item);
  flushToolCalls();

  if (!body.model || typeof body.model !== "string") {
    throw protocolError("model is required");
  }

  if (!messages.length) {
    throw protocolError(
      "input is empty: provide instructions, input or previous_response_id",
    );
  }

  const chat = {
    model: body.model,
    messages,
  };

  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) {
    chat.max_tokens = body.max_output_tokens;
  }
  if (body.parallel_tool_calls !== undefined) {
    chat.parallel_tool_calls = body.parallel_tool_calls;
  }
  const compatibility = {
    emulateCustomTools: options.emulateCustomTools === true,
  };
  const structuredOutput = options.structuredOutput ?? "native";
  const nativeLogprobs = options.nativeLogprobs ?? true;
  if (body.tool_choice !== undefined) {
    chat.tool_choice = toChatToolChoice(body.tool_choice, compatibility);
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    chat.tools = toChatTools(body.tools, compatibility);
  }

  const responseFormat = toChatResponseFormat(body);
  if (responseFormat) {
    if (structuredOutput === "native") {
      chat.response_format = responseFormat;
    } else if (structuredOutput === "prompt") {
      const format = body.text.format;
      const schemaText =
        format.type === "json_schema"
          ? `\nJSON Schema:\n${JSON.stringify(format.schema ?? { type: "object" })}`
          : "";
      messages.push({
        role: "system",
        content:
          "Structured output requirement: return only one valid JSON value " +
          `with no Markdown fences or explanatory text. Output type: ${format.type}.${schemaText}`,
      });
    }
  }

  if (body.reasoning?.effort !== undefined) {
    chat.reasoning_effort = body.reasoning.effort;
  }
  if (nativeLogprobs) {
    if (body.logprobs !== undefined) chat.logprobs = Boolean(body.logprobs);
    if (body.top_logprobs !== undefined) {
      chat.top_logprobs = Number(body.top_logprobs);
    }
  }

  return chat;
}

function makeBaseResponse(chatResponse, requestBody) {
  const response = {
    id: uid("resp_"),
    object: "response",
    created_at: chatResponse?.created ?? Math.floor(Date.now() / 1000),
    status: "completed",
    model: chatResponse?.model ?? requestBody?.model ?? "",
    output: [],
    parallel_tool_calls: requestBody?.parallel_tool_calls ?? true,
    tool_choice: requestBody?.tool_choice ?? "auto",
    tools: requestBody?.tools ?? [],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
    incomplete_details: null,
    instructions: requestBody?.instructions ?? null,
    error: null,
    background: Boolean(requestBody?.background),
    store: requestBody?.store === undefined ? true : Boolean(requestBody.store),
    service_tier: requestBody?.service_tier ?? "auto",
    metadata: requestBody?.metadata ?? {},
    user: requestBody?.user ?? null,
  };

  for (const field of [
    "truncation",
    "prompt_cache_key",
    "safety_identifier",
    "priority",
    "top_logprobs",
  ]) {
    if (requestBody?.[field] !== undefined) {
      response[field] = requestBody[field];
    }
  }

  if (requestBody?.text !== undefined) response.text = requestBody.text;
  if (requestBody?.reasoning !== undefined) {
    response.reasoning = requestBody.reasoning;
  }
  if (Array.isArray(requestBody?.include)) {
    response.include = requestBody.include;
  }

  return response;
}

export function createQueuedResponse(requestBody) {
  const response = makeBaseResponse(null, requestBody);
  response.status = "in_progress";
  response.background = true;
  response.output = [];
  return response;
}

function usageDetails(details) {
  if (!details || typeof details !== "object") return undefined;
  return { ...details };
}

function setUsage(response, usage) {
  const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  response.usage = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens:
      usage?.total_tokens ?? inputTokens + outputTokens,
  };

  const inputDetails = usageDetails(
    usage?.prompt_tokens_details ?? usage?.input_tokens_details,
  );
  const outputDetails = usageDetails(
    usage?.completion_tokens_details ?? usage?.output_tokens_details,
  );
  if (inputDetails) response.usage.input_tokens_details = inputDetails;
  if (outputDetails) response.usage.output_tokens_details = outputDetails;
}

function chatContentToResponse(message, choice) {
  const logprobs =
    Array.isArray(choice?.logprobs?.content) && choice.logprobs.content.length
      ? choice.logprobs.content
      : undefined;

  if (typeof message.content === "string" && message.content) {
    return [
      {
        type: "output_text",
        text: message.content,
        annotations: [],
        ...(logprobs ? { logprobs } : {}),
      },
    ];
  }

  if (Array.isArray(message.content)) {
    const parts = message.content
      .map((part) => {
        if (typeof part === "string") {
          return {
            type: "output_text",
            text: part,
            annotations: [],
            ...(logprobs ? { logprobs } : {}),
          };
        }
        if (part?.type === "refusal" || part?.refusal !== undefined) {
          return {
            type: "refusal",
            refusal: String(part.refusal ?? part.text ?? ""),
          };
        }
        if (part?.type === "output_audio" || part?.type === "audio") {
          return { ...part, type: "output_audio" };
        }
        return {
          type: "output_text",
          text: String(part?.text ?? part?.content ?? ""),
          annotations: part?.annotations ?? [],
          ...(logprobs ? { logprobs } : {}),
        };
      })
      .filter(Boolean);
    if (parts.length) return parts;
  }

  if (message.refusal) {
    return [{ type: "refusal", refusal: String(message.refusal) }];
  }

  return [];
}

function responseStatusFromChoice(choice) {
  const finishReason = choice?.finish_reason;
  if (finishReason === "length") {
    return {
      status: "incomplete",
      details: { reason: "max_output_tokens" },
    };
  }
  if (finishReason === "content_filter") {
    return {
      status: "incomplete",
      details: { reason: "content_filter" },
    };
  }
  return { status: "completed", details: null };
}

/** Chat Completion → Responses 对象 */

/** Chat Completion → Responses 对象 */
export function toResponseObject(chatResponse, requestBody) {
  const choice = chatResponse?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const response = makeBaseResponse(chatResponse, requestBody);

  if (message.reasoning_content || message.reasoning) {
    response.output.push({
      type: "reasoning",
      id: uid("rs_"),
      status: "completed",
      summary: [
        {
          type: "summary_text",
          text: String(message.reasoning_content ?? message.reasoning),
        },
      ],
    });
  }

  const content = chatContentToResponse(message, choice);
  if (content.length) {
    response.output.push({
      type: "message",
      id: uid("msg_"),
      status: "completed",
      role: message.role ?? "assistant",
      content,
    });
  }

  const customToolNames = new Set(
    (requestBody?.tools ?? [])
      .filter((tool) => tool?.type === "custom")
      .map((tool) => tool.name),
  );

  for (const toolCall of message.tool_calls ?? []) {
    const toolName = toolCall.custom?.name ?? toolCall.function?.name;
    const isCustom =
      toolCall.type === "custom" ||
      toolCall.custom !== undefined ||
      customToolNames.has(toolName);
    if (isCustom) {
      const rawInput =
        toolCall.custom?.input ??
        toolCall.function?.arguments ??
        "";
      let customInput = rawInput;
      if (toolCall.custom === undefined && typeof rawInput === "string") {
        try {
          const parsed = JSON.parse(rawInput);
          customInput = parsed?.input ?? rawInput;
        } catch {}
      }
      response.output.push({
        type: "custom_tool_call",
        id: uid("ctc_"),
        call_id: toolCall.id,
        name: toolName,
        input: customInput,
        status: "completed",
      });
    } else {
      response.output.push({
        type: "function_call",
        id: uid("fc_"),
        call_id: toolCall.id,
        name: toolCall.function?.name,
        arguments: toolCall.function?.arguments ?? "{}",
        status: "completed",
      });
    }
  }

  setUsage(response, chatResponse?.usage);
  const status = responseStatusFromChoice(choice);
  response.status = status.status;
  response.incomplete_details = status.details;
  return response;
}
const event = (type, payload) => ({
  event: type,
  data: JSON.stringify({ type, ...payload }),
});

/** 非流式 Responses 对象 → 标准 SSE 事件序列 */
export function responseEvents(response) {
  const events = [];
  const created = { ...response, output: [], status: "in_progress" };
  events.push(event("response.created", { response: created }));
  events.push(event("response.in_progress", { response: created }));

  response.output.forEach((item, outputIndex) => {
    const inProgressItem =
      item.type === "message"
        ? { ...item, status: "in_progress", content: [] }
        : item.type === "reasoning"
          ? { ...item, summary: [] }
          : { ...item, status: "in_progress", arguments: "" };

    events.push(
      event("response.output_item.added", {
        output_index: outputIndex,
        item: inProgressItem,
      }),
    );

    if (item.type === "message") {
      const part = item.content?.[0] ?? { type: "output_text", text: "", annotations: [] };
      events.push(
        event("response.content_part.added", {
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          part: { ...part, text: "" },
        }),
      );
      if (part.text) {
        events.push(
          event("response.output_text.delta", {
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            delta: part.text,
          }),
        );
      }
      events.push(
        event("response.output_text.done", {
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          text: part.text,
        }),
      );
      events.push(
        event("response.content_part.done", {
          item_id: item.id,
          output_index: outputIndex,
          content_index: 0,
          part,
        }),
      );
    } else if (item.type === "function_call") {
      if (item.arguments) {
        events.push(
          event("response.function_call_arguments.delta", {
            item_id: item.id,
            output_index: outputIndex,
            delta: item.arguments,
          }),
        );
      }
      events.push(
        event("response.function_call_arguments.done", {
          item_id: item.id,
          output_index: outputIndex,
          arguments: item.arguments,
        }),
      );
    } else if (item.type === "custom_tool_call") {
      if (item.input) {
        events.push(
          event("response.custom_tool_call_input.delta", {
            item_id: item.id,
            output_index: outputIndex,
            delta: item.input,
          }),
        );
      }
      events.push(
        event("response.custom_tool_call_input.done", {
          item_id: item.id,
          output_index: outputIndex,
          input: item.input,
        }),
      );
    } else if (item.type === "reasoning") {
      const summary = item.summary?.[0] ?? { type: "summary_text", text: "" };
      events.push(
        event("response.reasoning_summary_part.added", {
          item_id: item.id,
          output_index: outputIndex,
          summary_index: 0,
          part: { ...summary, text: "" },
        }),
      );
      if (summary.text) {
        events.push(
          event("response.reasoning_summary_text.delta", {
            item_id: item.id,
            output_index: outputIndex,
            summary_index: 0,
            delta: summary.text,
          }),
        );
        events.push(
          event("response.reasoning_summary_text.done", {
            item_id: item.id,
            output_index: outputIndex,
            summary_index: 0,
            text: summary.text,
          }),
        );
      }
      events.push(
        event("response.reasoning_summary_part.done", {
          item_id: item.id,
          output_index: outputIndex,
          summary_index: 0,
          part: summary,
        }),
      );
    }

    events.push(event("response.output_item.done", { output_index: outputIndex, item }));
  });

  events.push(event("response.completed", { response }));
  return events;
}

/**
 * 创建 Chat Completions SSE → Responses SSE 转换器。
 *
 * start() 在收到上游成功响应后调用；
 * push() 接收已解析的 chat.completion.chunk；
 * end() 输出最终状态；
 * fail() 用于上游流中断。
 */
export function createResponseStreamTranslator(requestBody) {
  const response = makeBaseResponse(null, requestBody);
  const customToolNames = new Set(
    (requestBody?.tools ?? [])
      .filter((tool) => tool?.type === "custom")
      .map((tool) => tool.name),
  );
  response.status = "in_progress";
  response.usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };

  const state = {
    response,
    text: null,
    reasoning: null,
    toolCallsByIndex: new Map(),
  };

  const addText = (delta) => {
    if (!delta) return [];
    if (!state.text) {
      const item = {
        type: "message",
        id: uid("msg_"),
        status: "in_progress",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: "",
            annotations: [],
          },
        ],
      };
      state.text = item;
      response.output.push(item);
      return [
        event("response.output_item.added", {
          output_index: response.output.indexOf(item),
          item: { ...item, content: [] },
        }),
        event("response.content_part.added", {
          item_id: item.id,
          output_index: response.output.indexOf(item),
          content_index: 0,
          part: item.content[0],
        }),
      ];
    }
    return [];
  };

  const addReasoning = (delta) => {
    if (!delta) return [];
    if (!state.reasoning) {
      const item = {
        type: "reasoning",
        id: uid("rs_"),
        summary: [{ type: "summary_text", text: "" }],
      };
      state.reasoning = item;
      response.output.push(item);
      return [
        event("response.output_item.added", {
          output_index: response.output.indexOf(item),
          item: { ...item, summary: [] },
        }),
        event("response.reasoning_summary_part.added", {
          item_id: item.id,
          output_index: response.output.indexOf(item),
          summary_index: 0,
          part: item.summary[0],
        }),
      ];
    }
    return [];
  };

  return {
    /** 返回正在构建的响应对象；调用方可据此尽早登记响应 ID 与取消控制器。 */
    currentResponse() {
      return response;
    },

    start() {
      return [
        event("response.created", { response: { ...response, output: [] } }),
        event("response.in_progress", { response: { ...response, output: [] } }),
      ];
    },

    push(chatChunk) {
      const events = [];
      const choice = chatChunk?.choices?.[0] ?? {};
      const delta = choice.delta ?? {};

      if (chatChunk?.model) response.model = chatChunk.model;
      if (chatChunk?.usage) setUsage(response, chatChunk.usage);

      const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
      if (reasoningDelta) {
        events.push(...addReasoning(String(reasoningDelta)));
        state.reasoning.summary[0].text += String(reasoningDelta);
        events.push(
          event("response.reasoning_summary_text.delta", {
            item_id: state.reasoning.id,
            output_index: response.output.indexOf(state.reasoning),
            summary_index: 0,
            delta: String(reasoningDelta),
          }),
        );
      }

      if (delta.content) {
        events.push(...addText(String(delta.content)));
        state.text.content[0].text += String(delta.content);
        events.push(
          event("response.output_text.delta", {
            item_id: state.text.id,
            output_index: response.output.indexOf(state.text),
            content_index: 0,
            delta: String(delta.content),
          }),
        );
      }

      for (const chunkToolCall of delta.tool_calls ?? []) {
        const toolIndex = Number(chunkToolCall.index ?? 0);
        let item = state.toolCallsByIndex.get(toolIndex);
        const incomingToolName =
          chunkToolCall.custom?.name ?? chunkToolCall.function?.name;
        const isCustom =
          chunkToolCall.type === "custom" ||
          chunkToolCall.custom !== undefined ||
          customToolNames.has(incomingToolName);

        if (!item) {
          item = isCustom
            ? {
                type: "custom_tool_call",
                id: uid("ctc_"),
                call_id: chunkToolCall.id || uid("call_"),
                name: incomingToolName ?? "",
                input: "",
                rawArguments: "",
                status: "in_progress",
              }
            : {
                type: "function_call",
                id: uid("fc_"),
                call_id: chunkToolCall.id || uid("call_"),
                name: chunkToolCall.function?.name ?? "",
                arguments: "",
                status: "in_progress",
              };
          state.toolCallsByIndex.set(toolIndex, item);
          response.output.push(item);
          events.push(
            event("response.output_item.added", {
              output_index: response.output.indexOf(item),
              item: isCustom
                ? { ...item, input: "" }
                : { ...item, arguments: "" },
            }),
          );
        }

        if (chunkToolCall.id) item.call_id = chunkToolCall.id;
        const incomingName =
          chunkToolCall.custom?.name ?? chunkToolCall.function?.name;
        if (incomingName) item.name = incomingName;

        if (item.type === "custom_tool_call") {
          const inputDelta =
            chunkToolCall.custom?.input ??
            chunkToolCall.function?.arguments;
          if (inputDelta) {
            if (chunkToolCall.custom?.input !== undefined) {
              item.input += String(inputDelta);
              events.push(
                event("response.custom_tool_call_input.delta", {
                  item_id: item.id,
                  output_index: response.output.indexOf(item),
                  delta: String(inputDelta),
                }),
              );
            } else {
              item.rawArguments += String(inputDelta);
            }
          }
        } else {
          const argsDelta = chunkToolCall.function?.arguments;
          if (argsDelta) {
            item.arguments += String(argsDelta);
            events.push(
              event("response.function_call_arguments.delta", {
                item_id: item.id,
                output_index: response.output.indexOf(item),
                delta: String(argsDelta),
              }),
            );
          }
        }
      }

      return events;
    },

    end(chatChunk) {
      const events = [];
      if (chatChunk) events.push(...this.push(chatChunk));

      if (state.reasoning) {
        const item = state.reasoning;
        const summary = item.summary[0];
        events.push(
          event("response.reasoning_summary_text.done", {
            item_id: item.id,
            output_index: response.output.indexOf(item),
            summary_index: 0,
            text: summary.text,
          }),
        );
        events.push(
          event("response.reasoning_summary_part.done", {
            item_id: item.id,
            output_index: response.output.indexOf(item),
            summary_index: 0,
            part: summary,
          }),
        );
        events.push(
          event("response.output_item.done", {
            output_index: response.output.indexOf(item),
            item: { ...item, status: "completed" },
          }),
        );
        item.status = "completed";
      }

      if (state.text) {
        const item = state.text;
        const part = item.content[0];
        events.push(
          event("response.output_text.done", {
            item_id: item.id,
            output_index: response.output.indexOf(item),
            content_index: 0,
            text: part.text,
          }),
        );
        events.push(
          event("response.content_part.done", {
            item_id: item.id,
            output_index: response.output.indexOf(item),
            content_index: 0,
            part,
          }),
        );
        item.status = "completed";
        events.push(
          event("response.output_item.done", {
            output_index: response.output.indexOf(item),
            item,
          }),
        );
      }

      for (const item of state.toolCallsByIndex.values()) {
        if (
          item.type === "custom_tool_call" &&
          !item.input &&
          item.rawArguments
        ) {
          try {
            const parsed = JSON.parse(item.rawArguments);
            item.input = String(parsed?.input ?? item.rawArguments);
          } catch {
            item.input = item.rawArguments;
          }
        }
        if (item.type === "custom_tool_call") delete item.rawArguments;

        events.push(
          item.type === "custom_tool_call"
            ? event("response.custom_tool_call_input.done", {
                item_id: item.id,
                output_index: response.output.indexOf(item),
                input: item.input,
              })
            : event("response.function_call_arguments.done", {
                item_id: item.id,
                output_index: response.output.indexOf(item),
                arguments: item.arguments,
              }),
        );
        item.status = "completed";
        events.push(
          event("response.output_item.done", {
            output_index: response.output.indexOf(item),
            item,
          }),
        );
      }

      response.status = "completed";
      response.output = response.output.map((item) => ({ ...item, status: "completed" }));
      events.push(event("response.completed", { response: { ...response } }));
      return events;
    },

    fail(error) {
      response.status = "failed";
      response.error = {
        code: "upstream_stream_error",
        message: String(error?.message ?? error),
      };
      return [event("response.failed", { response: { ...response } })];
    },

    cancel() {
      response.status = "cancelled";
      response.incomplete_details = { reason: "cancelled" };
      return [event("response.cancelled", { response: { ...response } })];
    },
  };
}

/** 创建增量 SSE 解析器。 */
export function createSseParser(onEvent) {
  // 上游的 SSE chunk 边界与 UTF-8 字符边界无关，直接用
  // Buffer#toString() 会把跨包的多字节字符切成 U+FFFD。
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let currentEvent = "";
  let currentData = [];

  const dispatch = () => {
    if (!currentEvent && !currentData.length) return;
    const raw = currentData.join("\n");
    let data = raw;
    try {
      data = raw ? JSON.parse(raw) : "";
    } catch {}
    onEvent({ event: currentEvent || "message", data });
    currentEvent = "";
    currentData = [];
  };

  const processLine = (line) => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;

    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") currentEvent = value;
    if (field === "data") currentData.push(value);
  };

  return {
    push(chunk) {
      buffer += decoder.write(Buffer.from(chunk));
      while (true) {
        const match = buffer.match(/\r?\n/);
        if (!match) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        processLine(line);
      }
    },
    end() {
      buffer += decoder.end();
      if (buffer) {
        processLine(buffer);
        buffer = "";
      }
      dispatch();
    },
  };
}

export async function sseWrite(response, evt) {
  const canContinue = response.write(`event: ${evt.event}\ndata: ${evt.data}\n\n`);
  if (!canContinue) await once(response, "drain");
}