import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectDir = path.resolve(import.meta.dirname, "..");

test(
  "Codex direct config writes provider only and can restore the original",
  { skip: process.platform !== "win32" },
  () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "mimo-codex-config-"),
    );
    const configPath = path.join(directory, "config.toml");
    const backupPath = `${configPath}.mimo-bridge-original`;
    const original = [
      'model_provider = "previous"',
      'model = "user-selected-model"',
      'model_catalog_json = "cc-switch-model-catalog.json"',
      "",
      "[feature]",
      'model = "must-not-change"',
      "",
      "[model_providers.previous]",
      'name = "previous"',
      "",
    ].join("\r\n");

    try {
      fs.writeFileSync(configPath, original, "utf8");
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(projectDir, "apply-mimo-provider.ps1"),
          "-ApiKey",
          "test-secret",
          "-ConfigPath",
          configPath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);

      const configured = fs.readFileSync(configPath, "utf8");
      assert.match(configured, /^\s*model = "user-selected-model"/m);
      assert.match(
        configured,
        /^\s*model_catalog_json = "cc-switch-model-catalog\.json"/m,
      );
      assert.match(configured, /\[feature\]\s+model = "must-not-change"/);
      assert.match(configured, /\[model_providers\.mimo\]/);
      assert.match(configured, /experimental_bearer_token = "test-secret"/);
      assert.equal(fs.readFileSync(backupPath, "utf8"), original);

      const restore = spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join(projectDir, "apply-mimo-provider.ps1"),
          "-Restore",
          "-ConfigPath",
          configPath,
        ],
        { encoding: "utf8" },
      );
      assert.equal(restore.status, 0, restore.stdout + restore.stderr);
      assert.equal(fs.readFileSync(configPath, "utf8"), original);
    } finally {
      for (const file of [configPath, backupPath]) {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      }
      fs.rmdirSync(directory);
    }
  },
);
