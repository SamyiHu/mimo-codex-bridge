#!/usr/bin/env node
/**
 * Codex + MiMo 多工具调用演示。
 * 会要求 Codex 使用多个独立 command_execution 工具调用，并打印脱敏后的实际命令。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const projectDir = path.resolve(import.meta.dirname, "..");
const openReport = process.argv.includes("--open-report");
const reportFile = path.join(
  projectDir,
  "reports",
  "tool-demo-latest.txt",
);
const outputFiles = [
  path.join(projectDir, ".bridge-tool-demo-1.txt"),
  path.join(projectDir, ".bridge-tool-demo-2.txt"),
  path.join(projectDir, ".bridge-tool-demo-report.txt"),
];

function readSecret(file) {
  try {
    return fs.readFileSync(path.join(projectDir, file), "utf8").trim();
  } catch {
    return "";
  }
}

function sanitize(value) {
  let text = String(value ?? "");
  for (const secret of [
    readSecret("token.txt"),
    readSecret("bridge-secret.txt"),
  ]) {
    if (secret.length >= 8) text = text.split(secret).join("[REDACTED]");
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
}

function runCodex() {
  const prompt =
    "Use at least five separate Codex command_execution tool calls. " +
    "Do not combine multiple tasks into one command. " +
    "First create .bridge-tool-demo-1.txt with exactly alpha. " +
    "Second create .bridge-tool-demo-2.txt with exactly beta. " +
    "Third read .bridge-tool-demo-1.txt in a separate tool call. " +
    "Fourth read .bridge-tool-demo-2.txt in a separate tool call. " +
    "Fifth create .bridge-tool-demo-report.txt with exactly alpha+beta. " +
    "Do not modify any other file.";

  const script =
    "& codex exec --json --skip-git-repo-check --sandbox workspace-write " +
    "-c model_provider=mimo -c model=xiaomi/mimo-pro -c model_reasoning_effort=high " +
    `'${prompt}'`;

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

function parseToolEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const item = event.item ?? event.data?.item ?? event;
    if (
      item?.type === "command_execution" ||
      item?.type === "function_call" ||
      item?.type === "file_change"
    ) {
      events.push({
        eventId: event.type ?? event.event ?? "unknown",
        item,
      });
    }
  }
  return events;
}

function cleanup() {
  for (const file of outputFiles) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {}
  }
}

try {
  cleanup();
  console.log(
    "[tools-demo] running a multi-step Codex task through the mimo bridge...",
  );

  const result = await runCodex();
  const toolEvents = parseToolEvents(result.stdout);
  const completedCommands = toolEvents.filter(
    (event) =>
      event.item.type === "command_execution" &&
      event.item.status === "completed",
  );
  const distinctCommands = new Set(
    completedCommands.map((event) => event.item.command),
  );

  console.log(`[tools-demo] structured tool events: ${toolEvents.length}`);
  console.log(
    `[tools-demo] completed command_execution calls: ${completedCommands.length}`,
  );
  console.log(`[tools-demo] distinct commands: ${distinctCommands.size}`);

  toolEvents.forEach((event, index) => {
    console.log(`\n[tool-${index + 1}] ${event.eventId}`);
    console.log(sanitize(JSON.stringify(event.item, null, 2)));
  });

  if (result.stderr.trim()) {
    console.log("\n[tools-demo] sanitized Codex stderr:");
    console.log(sanitize(result.stderr));
  }

  assert.equal(
    result.code,
    0,
    sanitize(`Codex exited with ${result.code}\n${result.stderr}\n${result.stdout}`),
  );
  assert.ok(
    distinctCommands.size >= 3,
    `Expected at least three distinct tool commands, got ${distinctCommands.size}`,
  );

  const contents = outputFiles.map((file) =>
    fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null,
  );
  assert.deepEqual(contents, ["alpha", "beta", "alpha+beta"]);

  const verification = {
    ok: true,
    provider: "mimo",
    model: "xiaomi/mimo-pro",
    structured_tool_events: toolEvents.length,
    distinct_completed_commands: distinctCommands.size,
    files_verified: outputFiles.map((file) => path.basename(file)),
  };

  const reportLines = [
    "MiMo Bridge - Codex own tool calls",
    `Generated: ${new Date().toISOString()}`,
    `Provider: ${verification.provider}`,
    `Model: ${verification.model}`,
    "",
    `Structured tool events: ${toolEvents.length}`,
    `Distinct completed commands: ${distinctCommands.size}`,
    "",
    "Actual tool commands",
    "====================",
    "",
  ];

  toolEvents.forEach((event, index) => {
    const item = event.item;
    reportLines.push(`[${index + 1}] ${event.eventId}`);
    reportLines.push(`Type: ${item.type}`);
    reportLines.push(`Status: ${item.status ?? "unknown"}`);
    reportLines.push(`Exit code: ${item.exit_code ?? "not finished"}`);
    if (item.command) {
      reportLines.push("Command:");
      reportLines.push(sanitize(item.command));
    }
    if (item.aggregated_output) {
      reportLines.push("Tool output:");
      reportLines.push(sanitize(item.aggregated_output));
    }
    reportLines.push("");
  });

  reportLines.push("Verification");
  reportLines.push("============");
  reportLines.push(sanitize(JSON.stringify(verification, null, 2)));
  reportLines.push("");
  reportLines.push(
    "Note: Codex Desktop may hide these tool events in its chat UI. " +
      "This report is written directly by the local test.",
  );

  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, reportLines.join("\r\n"), "utf8");
  console.log(`[tools-demo] visible report: ${reportFile}`);

  console.log(JSON.stringify(verification, null, 2));

  if (openReport && process.platform === "win32") {
    const notepad = spawn(
      "notepad.exe",
      [reportFile],
      { detached: true, stdio: "ignore", windowsHide: false },
    );
    notepad.unref();
  }
} finally {
  cleanup();
}