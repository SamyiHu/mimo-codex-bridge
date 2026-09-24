// token-estimate.mjs - upstream usage 缺失时的本地兜底估算器。
//
// 正常路径优先使用 MiMo 返回的真实 usage。这里只做兜底：文本使用 tokenx
// 的多语言估算，图片按尺寸/分块模型计数，不再把 data URL 当成零 token。
import { estimateTokenCount } from "tokenx";

const MESSAGE_OVERHEAD_TOKENS = 4;
const IMAGE_LOW_DETAIL_TOKENS = 85;
const IMAGE_HIGH_DETAIL_BASE_TOKENS = 85;
const IMAGE_HIGH_DETAIL_TILE_TOKENS = 170;
const IMAGE_UNKNOWN_TOKENS = 255;

function toText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

export function estimateTextTokens(value) {
  const text = toText(value);
  return text ? estimateTokenCount(text) : 0;
}

function dataUrlByteLength(value) {
  const match = /^data:[^,]*;base64,([a-z0-9+/=\s]+)$/i.exec(value || "");
  if (!match) return 0;
  const padding = (match[1].match(/=+$/)?.[0] ?? "").length;
  return Math.max(0, Math.floor((match[1].length * 3) / 4) - padding);
}

function readPngDimensions(value) {
  const match = /^data:image\/png;base64,([a-z0-9+/=\s]+)$/i.exec(value || "");
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[1], "base64");
    if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } catch {
    return null;
  }
}

function readGifDimensions(value) {
  const match = /^data:image\/gif;base64,([a-z0-9+/=\s]+)$/i.exec(value || "");
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[1], "base64");
    if (bytes.length < 10) return null;
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  } catch {
    return null;
  }
}

function readJpegDimensions(value) {
  const match = /^data:image\/jpe?g;base64,([a-z0-9+/=\s]+)$/i.exec(value || "");
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[1], "base64");
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1];
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      const isSof = marker >= 0xc0 && marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isSof && offset + 7 <= bytes.length) {
        return {
          height: bytes.readUInt16BE(offset + 3),
          width: bytes.readUInt16BE(offset + 5),
        };
      }
      if (length < 2) break;
      offset += length;
    }
  } catch {}
  return null;
}

function readWebpDimensions(value) {
  const match = /^data:image\/webp;base64,([a-z0-9+/=\s]+)$/i.exec(value || "");
  if (!match) return null;
  try {
    const bytes = Buffer.from(match[1], "base64");
    if (bytes.length < 30 || bytes.toString("ascii", 12, 16) !== "VP8X") {
      return null;
    }
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  } catch {
    return null;
  }
}

export function imageDimensions(imageUrl) {
  const value = typeof imageUrl === "string" ? imageUrl : imageUrl?.url;
  return (
    readPngDimensions(value) ??
    readGifDimensions(value) ??
    readJpegDimensions(value) ??
    readWebpDimensions(value)
  );
}

function imageTokens(part) {
  const source =
    part.type === "input_image"
      ? part.image_url ?? part.url
      : part.image_url ?? part;
  const detail = String(part.detail ?? source?.detail ?? "auto").toLowerCase();
  if (detail === "low") return IMAGE_LOW_DETAIL_TOKENS;

  const dimensions = imageDimensions(source);
  if (!dimensions?.width || !dimensions?.height) return IMAGE_UNKNOWN_TOKENS;
  const tiles =
    Math.ceil(dimensions.width / 512) * Math.ceil(dimensions.height / 512);
  return Math.max(
    IMAGE_LOW_DETAIL_TOKENS,
    IMAGE_HIGH_DETAIL_BASE_TOKENS +
      IMAGE_HIGH_DETAIL_TILE_TOKENS * Math.max(1, tiles),
  );
}

function binaryPartTokens(part) {
  const data =
    part.data ??
    part.file_data ??
    part.audio?.data ??
    part.input_audio?.data ??
    "";
  const byteLength = dataUrlByteLength(data) ||
    (typeof data === "string" ? data.length : 0);
  const label = estimateTextTokens(part.filename ?? part.format ?? "");
  return label + Math.max(32, Math.ceil(byteLength / 256));
}

function contentTokens(content) {
  if (content === null || content === undefined) return 0;
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;

  let tokens = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") {
      tokens += estimateTextTokens(part);
      continue;
    }
    if (part.type === "image_url" || part.type === "input_image") {
      tokens += imageTokens(part);
      continue;
    }
    if (
      part.type === "input_audio" ||
      part.type === "input_file" ||
      part.type === "file"
    ) {
      tokens += binaryPartTokens(part);
      continue;
    }
    tokens += estimateTextTokens(part.text);
    tokens += estimateTextTokens(part.refusal);
    tokens += estimateTextTokens(part.content);
  }
  return tokens;
}

function toolCallTokens(call) {
  if (!call || typeof call !== "object") return 0;
  return (
    estimateTextTokens(call.id) +
    estimateTextTokens(call.function?.name) +
    estimateTextTokens(call.function?.arguments) +
    estimateTextTokens(call.custom?.input)
  );
}

export function estimateChatRequestTokens(chatBody) {
  if (!chatBody || typeof chatBody !== "object") return 0;
  let tokens = 0;

  for (const message of chatBody.messages ?? []) {
    if (!message || typeof message !== "object") continue;
    tokens += MESSAGE_OVERHEAD_TOKENS;
    tokens += estimateTextTokens(message.role);
    tokens += estimateTextTokens(message.name);
    tokens += estimateTextTokens(message.tool_call_id);
    tokens += contentTokens(message.content);
    for (const call of message.tool_calls ?? []) {
      tokens += MESSAGE_OVERHEAD_TOKENS + toolCallTokens(call);
    }
  }

  for (const tool of chatBody.tools ?? []) {
    if (!tool || typeof tool !== "object") continue;
    const definition = tool.function ?? tool.custom ?? tool;
    tokens += MESSAGE_OVERHEAD_TOKENS;
    tokens += estimateTextTokens(definition?.name);
    tokens += estimateTextTokens(definition?.description);
    if (definition?.parameters && typeof definition.parameters === "object") {
      tokens += estimateTextTokens(JSON.stringify(definition.parameters));
    }
    if (definition?.format && typeof definition.format === "object") {
      tokens += estimateTextTokens(JSON.stringify(definition.format));
    }
  }

  return tokens;
}

export function estimateChatResponseTokens(chatPayload) {
  let tokens = 0;
  for (const choice of chatPayload?.choices ?? []) {
    const message = choice?.message ?? choice?.delta ?? {};
    tokens += contentTokens(message.content);
    tokens += estimateTextTokens(message.reasoning_content);
    tokens += estimateTextTokens(message.reasoning);
    tokens += estimateTextTokens(message.refusal);
    for (const call of message.tool_calls ?? []) {
      tokens += toolCallTokens(call);
    }
  }
  return tokens;
}

export function estimateResponsesOutputTokens(response) {
  let tokens = 0;
  for (const item of response?.output ?? []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "message") {
      tokens += contentTokens(item.content);
    } else if (item.type === "reasoning") {
      for (const part of item.summary ?? []) {
        tokens += estimateTextTokens(part?.text);
      }
    } else if (item.type === "function_call") {
      tokens += estimateTextTokens(item.name) + estimateTextTokens(item.arguments);
    } else if (item.type === "custom_tool_call") {
      tokens += estimateTextTokens(item.name) + estimateTextTokens(item.input);
    }
  }
  return tokens;
}

export function hasRealUsage(usage) {
  if (!usage || typeof usage !== "object") return false;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const total = Number(usage.total_tokens ?? 0);
  return input > 0 || output > 0 || total > 0;
}
