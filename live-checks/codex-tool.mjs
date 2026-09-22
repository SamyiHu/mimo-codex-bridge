#!/usr/bin/env node
/**
 * 可选的真实 Codex + MiMo 工具调用测试。
 *
 * 默认只输出验证结果；使用 --show-commands 时显示 Codex JSONL 中的
 * 工具调用事件，并自动遮蔽凭据、Authorization 和用户目录。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const projectDir = path.resolve(import.meta.dirname, "..");
const outputFile = path.join(projectDir, ".bridge-live-tool-output.txt");
const showCommands = process.argv.includes("--show-commands");

function readSecret(file) {
  try {
    return fs.readFileSync(path.join(projectDir, file), "utf8").trim();
  } catch {
    return "";
  }
}

function createSanitizer() {
  const secrets = [
    readSecret("token.txt"),
    readSecret("bridge-secret.txt"),
  ].filter((value) => value.length >= 8);

  return (value) => {
    let text = String(value ?? "");
    for (const secret of secrets) {
      text = text.split(secret).join("[REDACTED]");
    }

    text = text.replace(
      /(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi,
      "$1[REDACTED]",
    );
    text = text.replace(
      /((?:api[_-]?key|bridge[_-]?secret|mimo[_-]?token|token|secret)\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,}\]]+)/gi,
      "$1[REDACTED]",
    );

    const username = os.userInfo().username;
    if (username) {
      const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = text.replace(
        new RegExp(`([\\\\/]+)Users[\\\\/]+${escaped}(?=[\\\\/]+|"|$)`, "gi"),
        "$1Users/<user>",
      );
    }

    return text;
  };
}

function parseEventLine(line, sanitize) {
  try {
    return JSON.parse(line);
  } catch {
    return { type: "non_json_output", text: sanitize(line) };
  }
}

function eventItem(event) {
  return (
    event?.item ??
    event?.data?.item ??
    event?.result ??
    event?.payload ??
    event
  );
}

function eventType(event, item) {
  return (
    event?.type ??
    event?.event ??
    item?.type ??
    item?.event ??
    "unknown_event"
  );
}

function looksLikeToolEvent(type, item) {
  const structuredType = [
    type,
    item?.type,
    item?.event,
    item?.kind,
  ]
    .filter(Boolean)
    .join(" ");
  return /command_execution|function_call|tool_call|shell_execution|apply_patch|file_change|write_file|create_file/i.test(
    structuredType,
  );
}

function extractCommand(item) {
  return (
    item?.command ??
    item?.cmd ??
    item?.arguments?.command ??
    item?.arguments?.cmd ??
    item?.action?.command ??
    item?.input?.command ??
    null
  );
}

function printDetailedCodexOutput(stdout, stderr, sanitize) {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const events = lines.map((line) => parseEventLine(line, sanitize));
  const toolEvents = [];

  for (const event of events) {
    const item = eventItem(event);
    const type = eventType(event, item);
    if (!looksLikeToolEvent(type, item)) continue;

    const command = extractCommand(item);
    toolEvents.push({
      type,
      command: command ? sanitize(command) : null,
      item: sanitize(JSON.stringify(item, null, 2)),
    });
  }

  console.log("[codex-detail] captured JSONL events:", events.length);
  console.log("[codex-detail] detected tool events:", toolEvents.length);

  if (toolEvents.length) {
    for (const toolEvent of toolEvents) {
      console.log(`\n[codex-tool] ${toolEvent.type}`);
      if (toolEvent.command) {
        console.log("command:");
        console.log(toolEvent.command);
      }
      console.log("event:");
      console.log(toolEvent.item);
    }
  } else {
    console.log(
      "\n[codex-detail] No structured tool event was recognized; showing sanitized stdout:",
    );
    console.log(sanitize(stdout));
  }

  const safeStderr = sanitize(stderr).trim();
  if (safeStderr) {
    console.log("\n[codex-detail] sanitized stderr:");
    console.log(safeStderr);
  }
}

function runCodex() {
  const jsonFlag = showCommands ? " --json" : "";
  const script =
    "& codex exec" +
    jsonFlag +
    " --skip-git-repo-check --sandbox workspace-write " +
    "-c model_provider=mimo -c model=mimo-desktop/mimo-pro -c model_reasoning_effort=high " +
    "'Create a file named .bridge-live-tool-output.txt in the current working directory containing exactly bridge-tool-ok. Use your file editing or shell tool. Do not use any other file.'";

  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      {
        cwd: projectDir,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) =>
      resolve({ code: -1, stdout, stderr: stderr + error.message }),
    );
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const sanitize = createSanitizer();

try {
  if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);

  console.log(
    `[live-test] running Codex through the mimo bridge${showCommands ? " with command details" : ""}...`,
  );
  const result = await runCodex();

  if (showCommands) {
    printDetailedCodexOutput(result.stdout, result.stderr, sanitize);
  }

  assert.equal(
    result.code,
    0,
    sanitize(
      `Codex exited with ${result.code}\n${result.stderr}\n${result.stdout}`,
    ),
  );
  assert.ok(
    fs.existsSync(outputFile),
    sanitize(`Codex did not create ${outputFile}\n${result.stdout}`),
  );

  const content = fs.readFileSync(outputFile, "utf8").trim();
  assert.equal(
    content,
    "bridge-tool-ok",
    `Unexpected tool output: ${JSON.stringify(content)}`,
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        provider: "mimo",
        model: "mimo-desktop/mimo-pro",
        file_created: true,
        content_verified: true,
        command_details: showCommands,
      },
      null,
      2,
    ),
  );
} finally {
  if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
}