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
const adapter = path.join(pluginRoot, "modules", "copilot-session-start.mjs");
const hooksFile = path.join(pluginRoot, "hooks", "hooks.json");
const manifestFile = path.join(pluginRoot, ".claude-plugin", "plugin.json");
const marketplaceFile = path.join(repoRoot, "marketplace.json");
const expectedCommand =
  'node "${CLAUDE_PLUGIN_ROOT}/modules/copilot-session-start.mjs" package-resolution';

// Anything a developer or CI step may already have exported that would steer
// the hook away from the behaviour under test — a kill switch or a redirected
// JFrog home turns these checks red for reasons that have nothing to do with
// the assembly.
const STRIPPED_ENV = [
  "JF_AGENT_PACKAGE_RESOLUTION_DISABLE",
  "JF_AGENT_PACKAGE_RESOLUTION_ENABLED",
  "JF_AGENT_PACKAGE_RESOLUTION_LOG_LEVEL",
  "JF_AGENT_PACKAGE_RESOLUTION_LOG_FILE",
  "JF_AGENT_IDENTITY_PROBE",
  "JFROG_AGENT_HOOKS_LOG_FILE",
  "JFROG_CLI_HOME_DIR",
];

const failures = [];

/** Run the vendored adapter against a throwaway HOME and return its stdout JSON. */
function runAdapter(home, extraEnv = {}) {
  const env = { ...process.env, HOME: home, PATH: "", ...extraEnv };
  for (const key of STRIPPED_ENV) {
    if (!(key in extraEnv)) delete env[key];
  }
  const stdout = execFileSync(
    process.execPath,
    [adapter, "package-resolution"],
    {
      encoding: "utf8",
      env,
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "validation",
        source: "new",
        cwd: repoRoot,
      }),
    },
  );
  return JSON.parse(stdout);
}

function writeAgentsConf(home, config) {
  const jfrogHome = path.join(home, ".jfrog");
  mkdirSync(jfrogHome, { recursive: true });
  writeFileSync(
    path.join(jfrogHome, "agents-conf.json"),
    JSON.stringify(config),
  );
}

/** Minimal `jf` stand-in: only `jf config export` is needed to form an identity. */
function installFakeJf(home, { url = "https://validation.jfrog.io" } = {}) {
  const binDir = path.join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  const blob = Buffer.from(
    JSON.stringify({
      url,
      accessToken: "validation-token",
      serverId: "validation",
    }),
  ).toString("base64");
  const jf = path.join(binDir, "jf");
  writeFileSync(
    jf,
    `#!/bin/sh\nif [ "$1" = "config" ] && [ "$2" = "export" ]; then printf %s '${blob}'; exit 0; fi\nexit 1\n`,
    { mode: 0o755 },
  );
  return binDir;
}

function additionalContextOf(output) {
  const hookOutput = output?.hookSpecificOutput;
  if (
    hookOutput?.hookEventName !== "SessionStart" ||
    typeof hookOutput.additionalContext !== "string"
  ) {
    throw new Error(
      `adapter emitted invalid SessionStart context: ${JSON.stringify(output)}`,
    );
  }
  return hookOutput.additionalContext;
}

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

  check("adapter emits the unconfigured advisory when jf is absent", () => {
    const home = mkdtempSync(path.join(tmpdir(), "jfrog-vscode-hook-"));
    try {
      writeAgentsConf(home, { packageResolution: { enabled: true } });
      const context = additionalContextOf(runAdapter(home));
      if (!context.includes("NOT READY")) {
        throw new Error("expected the unconfigured advisory");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The advisory and the routing policy come from different branches, and only
  // the routing branch carries the Artifactory URLs this plugin exists to
  // inject. Validating the advisory alone would pass with routing broken.
  check("adapter emits the routing policy when a server is configured", () => {
    const home = mkdtempSync(path.join(tmpdir(), "jfrog-vscode-hook-"));
    try {
      writeAgentsConf(home, {
        packageResolution: {
          enabled: true,
          verifyRepos: false,
          defaultGlobalRepos: { npm: "npm-virtual" },
        },
      });
      const context = additionalContextOf(
        runAdapter(home, {
          PATH: installFakeJf(home),
          // Documented production kill switch: keeps the readiness probe off
          // the network so CI does not depend on a reachable platform.
          JF_AGENT_IDENTITY_PROBE: "0",
        }),
      );
      if (context.includes("NOT READY")) {
        throw new Error("configured session still emitted the advisory");
      }
      if (!context.includes("npm-virtual")) {
        throw new Error(
          `routing policy missing the repo key: ${context.slice(0, 200)}`,
        );
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
