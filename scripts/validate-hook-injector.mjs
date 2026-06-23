#!/usr/bin/env node

// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// Smoke test for the SessionStart injector + plugin packaging. A
// template-filename / read-path mismatch makes the injector silently emit
// nothing (it catches the read error and exits 0). This asserts the happy path
// actually produces non-empty instructions, that the hook + template wiring is
// internally consistent, and that marketplace.json / plugin.json agree on name
// and version and reference only paths that exist.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const injector = path.join(repoRoot, "plugin", "scripts", "inject-instructions.mjs");
const templatesDir = path.join(repoRoot, "plugin", "templates");
const hooksFile = path.join(repoRoot, "plugin", "hooks", "hooks.json");

const failures = [];
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(label);
    console.log(`  FAIL ${label}\n         ${error.message}`);
  }
};

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

console.log("Validating SessionStart injector + plugin packaging…");

check("injector source exists", () => {
  if (!existsSync(injector)) throw new Error(`missing: ${injector}`);
});

check("injector parses (node --check)", () => {
  execFileSync(process.execPath, ["--check", injector], { stdio: "pipe" });
});

// The filename the injector reads must match a real template file.
let templateName;
check("injector reads an existing template file", () => {
  const src = readFileSync(injector, "utf8");
  const match = src.match(/"templates"\s*,\s*"([^"]+)"/);
  if (!match) throw new Error('could not find the templates/<file> read path in the injector');
  templateName = match[1];
  const templatePath = path.join(templatesDir, templateName);
  if (!existsSync(templatePath)) {
    throw new Error(`injector reads "${templateName}" but it does not exist in plugin/templates/`);
  }
  if (statSync(templatePath).size === 0) {
    throw new Error(`template "${templateName}" is empty`);
  }
});

check("force-enable injects the actual template as additionalContext", () => {
  const stdout = runInjector({ JF_AGENT_GUARD_FORCE_ENABLE: "true" });
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
  // Not just non-empty — the injected payload must be the real template,
  // byte-for-byte. Proves the injector actually delivers the instructions.
  if (!templateName) {
    throw new Error("template filename was not resolved (see earlier check)");
  }
  const expected = readFileSync(path.join(templatesDir, templateName), "utf8");
  if (hook.additionalContext !== expected) {
    throw new Error("injected additionalContext does not match the template file content");
  }
});

check("force-disable emits {}", () => {
  const stdout = runInjector({ _JF_AGENT_GUARD_FORCE_DISABLE: "true" }).trim();
  if (stdout !== "{}") throw new Error(`expected "{}", got ${JSON.stringify(stdout)}`);
});

check("hooks.json wires SessionStart to the injector", () => {
  const hooks = JSON.parse(readFileSync(hooksFile, "utf8"));
  const entries = hooks?.hooks?.SessionStart;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("hooks.json has no SessionStart hooks");
  }
  const commands = entries.flatMap((e) => (e.hooks ?? []).map((h) => h.command ?? ""));
  if (!commands.some((c) => c.includes("inject-instructions.mjs"))) {
    throw new Error("no SessionStart command references inject-instructions.mjs");
  }
});

// ---- Manifest / packaging checks ----
// marketplace.json and plugin.json must be valid, agree on name + version,
// and point only at paths that exist.
const marketplaceFile = path.join(repoRoot, "marketplace.json");
const pluginManifestFile = path.join(repoRoot, "plugin", ".claude-plugin", "plugin.json");

let marketplacePlugin;
check("marketplace.json lists the jfrog plugin with a valid version and source", () => {
  const mp = JSON.parse(readFileSync(marketplaceFile, "utf8"));
  if (!Array.isArray(mp.plugins) || mp.plugins.length === 0) {
    throw new Error('"plugins" must be a non-empty array');
  }
  marketplacePlugin = mp.plugins.find((p) => p && p.name === "jfrog");
  if (!marketplacePlugin) throw new Error('no plugin named "jfrog" in marketplace.json');
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

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
