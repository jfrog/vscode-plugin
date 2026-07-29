#!/usr/bin/env node

// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const pluginRoot = path.join(repoRoot, "plugin");
const adapter = path.join(pluginRoot, "modules", "vscode-session-start.mjs");
const hooksFile = path.join(pluginRoot, "hooks", "hooks.json");
const manifestFile = path.join(pluginRoot, ".claude-plugin", "plugin.json");
const marketplaceFile = path.join(repoRoot, "marketplace.json");
const expectedCommand =
  'node "${CLAUDE_PLUGIN_ROOT}/modules/vscode-session-start.mjs" package-resolution';

const failures = [];

function check(label, fn) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(label);
    console.log(`  FAIL ${label}\n         ${error.message}`);
  }
}

function main() {
  console.log("Validating package-resolution hook assembly…");

  check("vendored adapter exists and parses", () => {
    if (!existsSync(adapter)) throw new Error(`missing: ${adapter}`);
    execFileSync(process.execPath, ["--check", adapter], { stdio: "pipe" });
  });

  let manifest;
  let marketplacePlugin;
  check("plugin and marketplace versions match", () => {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    const marketplace = JSON.parse(readFileSync(marketplaceFile, "utf8"));
    marketplacePlugin = marketplace.plugins?.find(
      (entry) => entry?.name === "jfrog",
    );
    if (!marketplacePlugin)
      throw new Error('marketplace has no plugin named "jfrog"');
    if (manifest.version !== marketplacePlugin.version) {
      throw new Error(
        `version mismatch: plugin=${manifest.version}, marketplace=${marketplacePlugin.version}`,
      );
    }
  });

  check("manifest references the hook configuration", () => {
    if (manifest?.hooks !== "hooks/hooks.json") {
      throw new Error(
        `unexpected hooks path: ${JSON.stringify(manifest?.hooks)}`,
      );
    }
    if (!existsSync(path.join(pluginRoot, manifest.hooks))) {
      throw new Error(`missing hooks file: ${manifest.hooks}`);
    }
  });

  check("SessionStart runs only package resolution", () => {
    const config = JSON.parse(readFileSync(hooksFile, "utf8"));
    const commands = (config?.hooks?.SessionStart ?? []).flatMap((entry) =>
      (entry.hooks ?? []).map((hook) => hook.command),
    );
    if (commands.length !== 1 || commands[0] !== expectedCommand) {
      throw new Error(
        `unexpected SessionStart commands: ${JSON.stringify(commands)}`,
      );
    }
  });

  check("adapter emits valid SessionStart context", () => {
    const home = mkdtempSync(path.join(tmpdir(), "jfrog-vscode-hook-"));
    try {
      const jfrogHome = path.join(home, ".jfrog");
      mkdirSync(jfrogHome, { recursive: true });
      writeFileSync(
        path.join(jfrogHome, "agents-conf.json"),
        JSON.stringify({ packageResolution: { enabled: true } }),
      );
      const stdout = execFileSync(
        process.execPath,
        [adapter, "package-resolution"],
        {
          encoding: "utf8",
          env: { ...process.env, HOME: home, PATH: "" },
          input: JSON.stringify({
            hook_event_name: "SessionStart",
            session_id: "validation",
            source: "new",
            cwd: repoRoot,
          }),
        },
      );
      const output = JSON.parse(stdout);
      const hookOutput = output?.hookSpecificOutput;
      if (
        hookOutput?.hookEventName !== "SessionStart" ||
        typeof hookOutput.additionalContext !== "string" ||
        !hookOutput.additionalContext.includes("NOT READY")
      ) {
        throw new Error("adapter emitted invalid SessionStart context");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main();
