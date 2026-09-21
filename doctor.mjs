#!/usr/bin/env node
/**
 * mimo-bridge doctor — 检查 Node、bridge、MiMo 引擎、Codex 配置和可选实时请求。
 * 不输出任何凭据内容。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const argOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const projectDir = import.meta.dirname;
const port = Number(argOf("--port", process.env.MIMO_BRIDGE_PORT || 8788));
const configPath = argOf(
  "--config",
  path.join(os.homedir(), ".codex", "config.toml"),
);
const liveRequest = !hasFlag("--no-live-request");
const bridgeBase = `http://127.0.0.1:${port}`;
const bridgeSecretFile = path.join(projectDir, "bridge-secret.txt");
const mimoTokenFile = path.join(projectDir, "token.txt");

function readCredential(file, fallback) {
  return fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").trim()
    : fallback;
}

const mimoToken = readCredential(mimoTokenFile, "");
const bridgeSecret = readCredential(bridgeSecretFile, mimoToken);
const checks = [];

function check(name, ok, detail, required = true) {
  checks.push({ name, ok: Boolean(ok), detail, required });
}

async function fetchJson(url, options = {}, timeoutMs = 10000) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

function extractTomlString(text, name) {
  const match = text.match(
    new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "m"),
  );
  return match?.[1] ?? "";
}

/**
 * 只在 [model_providers.<providerId>] 段内取值。
 * 配置文件里可能还有别的 provider（例如前面的 DeepSeek），
 * 用全局第一个匹配会取到它们的 base_url / token。
 */
function extractProviderString(text, providerId, name) {
  if (!providerId) return "";
  const lines = text.split(/\r?\n/);
  let inside = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]*)\]\s*$/.exec(line);
    if (header) {
      inside = header[1].trim() === `model_providers.${providerId}`;
      continue;
    }
    if (!inside) continue;
    const match = new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`).exec(line);
    if (match) return match[1];
  }
  return "";
}

const major = Number(process.versions.node.split(".")[0]);
check(
  "node_version",
  major >= 18,
  `Node.js ${process.version}; required >= 18`,
);

let health = null;
try {
  const result = await fetchJson(`${bridgeBase}/health`);
  health = result.payload;
  check(
    "bridge_health",
    result.response.ok && health?.ok === true,
    health
      ? `engine=${health.engine || "not found"} authMode=${health.authMode || "unknown"}`
      : `HTTP ${result.response.status}`,
  );
} catch (error) {
  check("bridge_health", false, error.message);
}

let status = null;
if (bridgeSecret) {
  try {
    const result = await fetchJson(`${bridgeBase}/status`, {
      headers: { Authorization: `Bearer ${bridgeSecret}` },
    });
    status = result.payload;
    check(
      "bridge_status_auth",
      result.response.ok && status?.authMode === "bridge_secret",
      status
        ? `pid=${status.pid} version=${status.version} authMode=${status.authMode}`
        : `HTTP ${result.response.status}`,
    );
  } catch (error) {
    check("bridge_status_auth", false, error.message);
  }
} else {
  check("bridge_status_auth", false, "bridge-secret.txt not found");
}

if (status?.engine && mimoToken) {
  try {
    const modelsUrl =
      `${status.engine}/v1/models` +
      `?directory=${encodeURIComponent(status.instanceDir)}`;
    const result = await fetchJson(modelsUrl, {
      headers: { Authorization: `Bearer ${mimoToken}` },
    });
    const models = Array.isArray(result.payload?.data)
      ? result.payload.data.map((model) => String(model?.id || ""))
      : [];
    check(
      "mimo_engine_models",
      result.response.ok &&
        models.some((model) => model.startsWith("xiaomi/")),
      result.response.ok
        ? `${models.length} model(s); xiaomi models detected=${models.some((model) => model.startsWith("xiaomi/"))}`
        : `HTTP ${result.response.status}`,
    );
  } catch (error) {
    check("mimo_engine_models", false, error.message);
  }
} else {
  check(
    "mimo_engine_models",
    false,
    "engine URL or MiMo token unavailable",
  );
}

let configModel = "xiaomi/mimo-x-pro-preview";
if (fs.existsSync(configPath)) {
  const config = fs.readFileSync(configPath, "utf8");
  const provider = extractTomlString(config, "model_provider");
  const baseUrl = extractProviderString(config, provider, "base_url");
  const wireApi = extractProviderString(config, provider, "wire_api");
  const configuredSecret = extractProviderString(
    config,
    provider,
    "experimental_bearer_token",
  );
  configModel =
    extractTomlString(config, "model") || configModel;
  const secretMatches =
    bridgeSecret && configuredSecret === bridgeSecret;
  check(
    "codex_config",
    provider === "mimo" &&
      baseUrl === `${bridgeBase}/v1` &&
      wireApi === "responses" &&
      secretMatches,
    `provider=${provider || "missing"} base_url=${baseUrl || "missing"} wire_api=${wireApi || "missing"} bridge_secret_matches=${secretMatches}`,
  );
} else {
  check("codex_config", false, `config not found: ${configPath}`);
}

if (status?.pid) {
  try {
    process.kill(status.pid, 0);
    check("bridge_process", true, `PID ${status.pid} is running`);
  } catch {
    check("bridge_process", false, `PID ${status.pid} is not accessible`);
  }
}

if (liveRequest && status?.ok && bridgeSecret) {
  try {
    const result = await fetchJson(
      `${bridgeBase}/v1/responses`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bridgeSecret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: configModel,
          input: "Reply with OK only.",
          stream: false,
        }),
      },
      60000,
    );
    const outputText = (result.payload?.output ?? [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .map((part) => part.text ?? "")
      .join("");
    check(
      "live_model_request",
      result.response.ok && outputText.trim().length > 0,
      result.response.ok
        ? `model=${result.payload?.model || configModel} output_length=${outputText.trim().length}`
        : result.payload?.error?.message || `HTTP ${result.response.status}`,
    );
  } catch (error) {
    check("live_model_request", false, error.message);
  }
} else if (liveRequest) {
  check("live_model_request", false, "bridge status unavailable");
}

const failedRequired = checks.filter(
  (item) => item.required && !item.ok,
);
const result = {
  ok: failedRequired.length === 0,
  checked_at: new Date().toISOString(),
  bridge: bridgeBase,
  config: configPath,
  live_request: liveRequest,
  checks,
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;