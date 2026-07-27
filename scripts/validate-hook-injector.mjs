#!/usr/bin/env node

// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// Smoke test for the SessionStart injector + plugin packaging, grouped into:
//   Syntax         — the injector exists and parses.
//   Lint           — marketplace.json / plugin.json / hooks.json / template
//                    wiring is internally consistent (names, versions, paths).
//   Format         — running the injector emits a well-formed SessionStart
//                    payload (valid JSON, correct shape).
//   Injection logic — the payload actually carries the real template, and
//                    fail-closed paths emit {}.
// A template-filename / read-path mismatch makes the injector silently emit
// nothing (it catches the read error and exits 0); these checks turn that
// silent failure into a hard error.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const injector = path.join(repoRoot, "plugin", "scripts", "inject-instructions.mjs");
const packageResolutionAdapter = path.join(
  repoRoot,
  "plugin",
  "modules",
  "vscode-session-start.mjs",
);
const templatesDir = path.join(repoRoot, "plugin", "templates");
const hooksFile = path.join(repoRoot, "plugin", "hooks", "hooks.json");
const marketplaceFile = path.join(repoRoot, "marketplace.json");
const pluginManifestFile = path.join(repoRoot, "plugin", ".claude-plugin", "plugin.json");

const failures = [];

function section(title) {
  console.log(`\n${title}`);
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

// Run the injector with a clean copy of the env plus the given overrides, so an
// inherited force-flag or real JFrog credentials can't skew the result.
function runInjector(overrides) {
  const env = { ...process.env };
  delete env._JF_AGENT_GUARD_FORCE_DISABLE;
  delete env.JF_AGENT_GUARD_FORCE_ENABLE;
  return execFileSync(process.execPath, [injector], {
    encoding: "utf8",
    env: { ...env, ...overrides },
  });
}

function main() {
  console.log("Validating SessionStart injector + plugin packaging…");

  // ---- Syntax: the injector exists and is parseable JS ----
  section("Syntax");
  check("injector source exists", () => {
    if (!existsSync(injector)) throw new Error(`missing: ${injector}`);
  });
  check("injector parses (node --check)", () => {
    execFileSync(process.execPath, ["--check", injector], { stdio: "pipe" });
  });
  check("package-resolution adapter exists and parses", () => {
    if (!existsSync(packageResolutionAdapter)) {
      throw new Error(`missing vendored module: ${packageResolutionAdapter}`);
    }
    execFileSync(process.execPath, ["--check", packageResolutionAdapter], { stdio: "pipe" });
  });

  // ---- Lint: manifests, hook wiring, and template read-path are consistent ----
  section("Lint (manifest & wiring)");

  let marketplacePlugin;
  check("marketplace.json lists the jfrog plugin with a valid version and source", () => {
    const mp = JSON.parse(readFileSync(marketplaceFile, "utf8"));
    if (!Array.isArray(mp.plugins) || mp.plugins.length === 0) {
      throw new Error('"plugins" must be a non-empty array');
    }
    marketplacePlugin = mp.plugins.find((p) => p && p.name === "jfrog");
    if (!marketplacePlugin) throw new Error('no plugin named "jfrog" in marketplace.json');
    if (mp.plugins[0] !== marketplacePlugin) {
      throw new Error(
        'the sync contract requires plugin "jfrog" at marketplace.json index 0',
      );
    }
    if (!/^\d+\.\d+\.\d+$/.test(marketplacePlugin.version ?? "")) {
      throw new Error(`plugin version is missing or not semver: ${JSON.stringify(marketplacePlugin.version)}`);
    }
    const src = marketplacePlugin.source;
    if (typeof src !== "string" || !src) throw new Error('plugin "source" must be a non-empty string');
    if (!existsSync(path.join(repoRoot, src))) throw new Error(`source dir "${src}" does not exist`);
  });

  let pluginManifest;
  check("plugin.json matches the marketplace entry (name + version)", () => {
    pluginManifest = JSON.parse(readFileSync(pluginManifestFile, "utf8"));
    if (pluginManifest.name !== "jfrog") {
      throw new Error(`plugin.json name "${pluginManifest.name}" does not match marketplace name "jfrog"`);
    }
    if (marketplacePlugin && pluginManifest.version !== marketplacePlugin.version) {
      throw new Error(`plugin.json version "${pluginManifest.version}" does not match marketplace version "${marketplacePlugin.version}"`);
    }
  });

  check("plugin.json hooks path exists", () => {
    if (!pluginManifest) throw new Error("plugin.json was not parsed (see earlier check)");
    const hooksRel = pluginManifest.hooks;
    if (typeof hooksRel !== "string" || !hooksRel) throw new Error('plugin.json "hooks" must be a non-empty string');
    if (!existsSync(path.join(repoRoot, "plugin", hooksRel))) {
      throw new Error(`plugin.json "hooks" references missing path "${hooksRel}"`);
    }
  });

  let sessionStartCommands = [];
  check("hooks.json wires SessionStart to the injector", () => {
    const hooks = JSON.parse(readFileSync(hooksFile, "utf8"));
    const entries = hooks?.hooks?.SessionStart;
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error("hooks.json has no SessionStart hooks");
    }
    sessionStartCommands = entries.flatMap((e) =>
      (e.hooks ?? []).map((h) => h.command ?? ""),
    );
    if (!sessionStartCommands.some((c) => c.includes("inject-instructions.mjs"))) {
      throw new Error("no SessionStart command references inject-instructions.mjs");
    }
  });
  check("hooks.json wires SessionStart to package resolution", () => {
    const expected =
      'node "${CLAUDE_PLUGIN_ROOT}/modules/vscode-session-start.mjs" package-resolution';
    if (!sessionStartCommands.includes(expected)) {
      throw new Error(
        `no SessionStart command exactly matches ${JSON.stringify(expected)}`,
      );
    }
  });
  check("package-resolution hook emits valid SessionStart JSON", () => {
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
        [packageResolutionAdapter, "package-resolution"],
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
      const payload = JSON.parse(stdout);
      if (
        payload?.hookSpecificOutput?.hookEventName !== "SessionStart" ||
        typeof payload.hookSpecificOutput.additionalContext !== "string" ||
        payload.hookSpecificOutput.additionalContext.length === 0
      ) {
        throw new Error("package-resolution hook emitted an invalid payload");
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The filename the injector reads must match a real, non-empty template.
  let templateName;
  check("injector reads an existing template file", () => {
    const src = readFileSync(injector, "utf8");
    const match = src.match(/"templates"\s*,\s*"([^"]+)"/);
    if (!match) throw new Error("could not find the templates/<file> read path in the injector");
    templateName = match[1];
    const templatePath = path.join(templatesDir, templateName);
    if (!existsSync(templatePath)) {
      throw new Error(`injector reads "${templateName}" but it does not exist in plugin/templates/`);
    }
    if (statSync(templatePath).size === 0) {
      throw new Error(`template "${templateName}" is empty`);
    }
  });

  // ---- Format: force-enable emits a well-formed SessionStart payload ----
  section("Format (injected payload shape)");
  let injectedContext;
  check("force-enable emits valid JSON with a SessionStart additionalContext", () => {
    const stdout = runInjector({ JF_AGENT_GUARD_FORCE_ENABLE: "true", JFROG_URL: "https://example.jfrog.io" });
    if (!stdout.trim()) throw new Error("stdout was empty");
    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch (error) {
      throw new Error(`stdout did not parse as JSON: ${error.message}`);
    }
    const hook = payload?.hookSpecificOutput;
    if (hook?.hookEventName !== "SessionStart") {
      throw new Error(`expected hookSpecificOutput.hookEventName === "SessionStart", got ${JSON.stringify(hook?.hookEventName)}`);
    }
    if (typeof hook.additionalContext !== "string" || hook.additionalContext.trim().length === 0) {
      throw new Error("hookSpecificOutput.additionalContext is missing or empty");
    }
    injectedContext = hook.additionalContext;
  });

  // ---- Injection logic: the payload is the real template; fail-closed works ----
  section("Injection logic");
  check("force-enable injects the actual template, byte-for-byte", () => {
    if (injectedContext === undefined) throw new Error("force-enable payload not captured (see Format check)");
    if (!templateName) throw new Error("template name was not resolved (see Lint check)");
    const expected = readFileSync(path.join(templatesDir, templateName), "utf8");
    if (injectedContext !== expected) {
      throw new Error("injected additionalContext does not match the template file content");
    }
  });
  check("force-disable emits {} (fail-closed)", () => {
    const stdout = runInjector({ _JF_AGENT_GUARD_FORCE_DISABLE: "true" }).trim();
    if (stdout !== "{}") throw new Error(`expected "{}", got ${JSON.stringify(stdout)}`);
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll checks passed.");
}

main();
