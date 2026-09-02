#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

// Tests the skill-governance hook wiring. hooks.json invokes agent-guard DIRECTLY via npx — no
// plugin-side governance code at all — so this validator asserts the wiring's shape and then
// EXECUTES the real command string out of hooks.json against a stub agent-guard.
//
// Four properties carry the whole design:
//
//  1. A VS Code verdict travels as JSON on stdout. An ALLOW is explicit `{"continue": true}` and
//     never `permissionDecision: "allow"`, which would APPROVE the call, bypass VS Code's own
//     permission prompt and overrule every other hook.
//
//  2. Infrastructure failure fails OPEN. npx missing, a failed install, an unreachable registry
//     or no configured JFrog server must let the skill through: a machine that cannot run the
//     guard is not governed by it. A real policy denial still blocks, in the JSON payload.
//
//  3. Nothing may pin the agent-guard version — unlike the MCP-align hook, which pins on purpose.
//     Governance must pick up a shipped GA fix without a plugin release.
//
//  4. UserPromptSubmit refreshes the npx cache and PreToolUse reads it. VS Code has no `async`
//     hook, so there is no session-start pre-warm to keep `--prefer-offline` safe; without the
//     split, agent-guard freezes at whatever version a machine first fetched.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = path.join(repoRoot, "plugin");
const hooks = JSON.parse(readFileSync(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"));

const RELEASES_REGISTRY = "https://releases.jfrog.io/artifactory/api/npm/coding-agents-npm/";
const GOVERNED_EVENTS = ["UserPromptSubmit", "PreToolUse"];
// An absolute sh: the PATH below is deliberately minimal, so `sh` by name would not resolve.
const SH = "/bin/sh";

const sandbox = mkdtempSync(path.join(tmpdir(), "vscode-gov-"));
const binDir = path.join(sandbox, "bin");
mkdirSync(binDir, { recursive: true });
// A directory holding ONLY node, so the stub's shebang resolves while the real npx stays
// unreachable. `date` lives here too: the hook computes its deadline with $(date +%s), and a PATH
// without it would silently yield "$(( + 25))" = 25 — an epoch in 1970 — rather than exercising
// the real computation. Keeping both here (not by adding /bin to PATH) preserves the isolate mode,
// where npx must stay unreachable.
const nodeDir = path.join(sandbox, "node-only");
mkdirSync(nodeDir, { recursive: true });
symlinkSync(process.execPath, path.join(nodeDir, "node"));
symlinkSync("/bin/date", path.join(nodeDir, "date"));

const failures = [];
const check = async (label, fn) => {
  try { await fn(); console.log(`  ok   ${label}`); }
  catch (e) { failures.push(label); console.log(`  FAIL ${label}\n         ${e.message}`); }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const groupsFor = (event) => hooks?.hooks?.[event] ?? [];
const hooksFor = (event) => groupsFor(event).flatMap((g) => g.hooks ?? []);
const commandFor = (event) => hooksFor(event)[0]?.command ?? "";
// A blocking answer is a deny in the JSON, or agent-guard's own exit 2. Anything else lets the
// skill through — which is what "fails open" has to mean here.
const blocks = (r) => r.code === 2 || /"permissionDecision"\s*:\s*"deny"|"continue"\s*:\s*false/.test(r.stdout);

// A stub npx that records the argv it was handed and the stdin it received, then replays a canned
// result. Installed as `npx` so the hook command finds it first on PATH.
function stubNpx({ stdout = "", exitCode = 0 }) {
  const record = path.join(sandbox, "record.json");
  rmSync(record, { force: true });
  writeFileSync(path.join(binDir, "npx"), `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), stdin: input, deadline: process.env.JF_AGENT_GUARD_ENFORCE_DEADLINE ?? "" }));
  if (${JSON.stringify(stdout)}) process.stdout.write(${JSON.stringify(stdout)});
  process.exit(${exitCode});
});
`, { mode: 0o755 });
  chmodSync(path.join(binDir, "npx"), 0o755);
  return record;
}

// Run a hook command the way VS Code does: the string from hooks.json handed to a shell, with the
// event JSON on the child's real stdin. `isolate` drops the stub from PATH, which is how "npx is
// not installed at all" is reproduced.
//
// The delivery model is client-specific and must be checked per client, not assumed. VS Code
// writes the payload to the process's stdin pipe — `stdin.write(JSON.stringify(...))` with
// `stdio: ["pipe", ...]` in agentHostMain.js — so `input:` below is faithful. Cursor does NOT:
// it base64s the event into the command string and pipes it in from a pipeline the spawned shell
// builds, leaving the child's own stdin as /dev/null. Testing Cursor this way is what let
// MLAI-1310 ship — a top-level `;` in the command severed Cursor's pipeline and every skill was
// silently allowed, while a stdin-based harness passed all 34 checks. If a third delivery shape
// ever appears, model it here rather than reusing this one.
function runHook(command, payload, { isolate = false, extraEnv = {} } = {}) {
  const result = spawnSync(SH, ["-c", command], {
    input: Buffer.from(payload),
    encoding: "buffer",
    timeout: 30_000,
    env: {
      PATH: isolate ? nodeDir : `${binDir}:${nodeDir}`,
      HOME: sandbox,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      ...extraEnv,
    },
  });
  if (result.error) throw new Error(`could not run the hook via ${SH}: ${result.error.message}`);
  return {
    code: result.status,
    stdout: result.stdout ? result.stdout.toString() : "",
    stderr: result.stderr ? result.stderr.toString() : "",
  };
}

console.log("Validating the skill-governance hook wiring…");

check("no plugin-side governance code exists", () => {
  const gone = [
    "scripts/governance/block-skill.mjs",
    "scripts/governance/request-waiver.mjs",
    "scripts/governance/helpers/credentials.mjs",
    "scripts/governance/helpers/governance-client.mjs",
    "scripts/governance/helpers/skill-fingerprint.mjs",
    "scripts/governance/helpers/skill-package.mjs",
    "scripts/governance/helpers/skill-path.mjs",
    "scripts/governance/helpers/policy-block.mjs",
    "scripts/governance/helpers/template-messages.mjs",
  ];
  for (const rel of gone) {
    let exists = true;
    try { readFileSync(path.join(pluginRoot, rel)); } catch { exists = false; }
    assert(!exists, `${rel} exists; all governance logic — waivers included — lives in agent-guard`);
  }
});

check("the SessionStart hooks are untouched", () => {
  // Located by CONTENT, never by index: SessionStart is a shared list that other features append
  // to, so an index pins this check to whatever happens to sit there.
  const found = hooksFor("SessionStart");
  for (const [needle, timeout] of [
    ["modules/copilot-session-start.mjs", 15],
    ["scripts/vscode-align-mcp-json.mjs", 60],
  ]) {
    const h = found.find((e) => e.command.includes(needle));
    assert(h, `the SessionStart hook running ${needle} is missing or was altered; found: ` +
      found.map((e) => e.command).join(" | "));
    assert(h.timeout === timeout, `${needle} timeout changed from ${timeout} to ${h.timeout}`);
  }
});

check("one governed hook refreshes the npx cache, the other reads it", () => {
  // VS Code documents no `async` hook field, so there is no session-start pre-warm that could
  // keep the cache fresh without delaying startup. The refresh therefore has to happen on a hook
  // VS Code already waits for: UserPromptSubmit fires once per prompt and revalidates against the
  // registry; PreToolUse fires on EVERY tool call — VS Code ignores matchers — and reads what the
  // prompt hook left behind.
  assert(!hooksFor("SessionStart").some((h) => h.command.includes("@jfrog/agent-guard")),
    "SessionStart must not pre-warm agent-guard: VS Code has no async hook, so it would delay startup");
  assert(!commandFor("UserPromptSubmit").includes("--prefer-offline"),
    "UserPromptSubmit must NOT pass --prefer-offline: it is the only thing that refreshes the " +
    "cache, and without it agent-guard is frozen at whatever version was first fetched");
  assert(commandFor("PreToolUse").includes("--prefer-offline"),
    "PreToolUse must pass --prefer-offline: VS Code ignores matchers, so it fires on every tool call");
});

for (const event of GOVERNED_EVENTS) {
  check(`${event} invokes agent-guard through npx only, with no plugin script in the path`, () => {
    const entries = hooksFor(event);
    assert(entries.length === 1, `expected exactly one ${event} hook, got ${entries.length}`);
    const h = entries[0];
    assert(h.type === "command", `${event} must be a command hook, got ${h.type}`);
    assert(/(^|\s)npx\s/.test(h.command), `${event} must invoke npx directly, got: ${h.command}`);
    assert(!h.command.includes("command -v"),
      `${event} must not have a PATH fast path: a hijackable agent-guard earlier on PATH would win`);
    assert(!/block-skill|governance-client|skill-path|request-waiver|--waiver-helper/.test(h.command),
      `${event} must not route through a plugin governance script; agent-guard owns the waiver flow`);
    assert(h.command.includes("--enforce-skill") && h.command.includes("--client vscode"),
      `${event} must pass --enforce-skill --client vscode`);
    assert(h.command.includes(RELEASES_REGISTRY),
      `${event} must default to the releases registry, so the artifact is the published one`);
  });

  check(`${event} carries no matcher, which VS Code would ignore anyway`, () => {
    assert(groupsFor(event).every((g) => g.matcher === undefined),
      `VS Code parses matchers for Claude Code compatibility but ignores their values, so one ` +
      `here reads as protection that does not exist. The tool-name filter lives in agent-guard.`);
  });

  check(`${event} fails OPEN: no exit-2 wrapper`, () => {
    assert(!/\|\|\s*exit\b/.test(commandFor(event)),
      `${event} must not wrap the call in "|| exit": converting an npx or install failure into a ` +
      `block refuses every skill on a machine that simply cannot run the guard`);
  });

  check(`${event} lets npx cold-start and bounds its fetch`, () => {
    const h = hooksFor(event)[0];
    assert((h.timeout ?? 0) >= 30, `${event} timeout ${h.timeout} is too short for an npx cold start`);
    const retries = /npm_config_fetch_retries=(\d+)/.exec(h.command);
    const fetchTimeout = /npm_config_fetch_timeout=(\d+)/.exec(h.command);
    assert(retries && Number(retries[1]) === 0,
      `${event} must set npm_config_fetch_retries=0: npm's default of 2 backs off 10s then 60s`);
    // The VALUE, not just its presence: npm_config_fetch_timeout=300000 is npm's own default, so
    // asserting presence alone would let an edit back to the default pass unnoticed.
    assert(fetchTimeout && Number(fetchTimeout[1]) <= 10_000,
      `${event} must set npm_config_fetch_timeout <= 10000 (npm's default is 300000ms), got ${fetchTimeout?.[1]}`);
  });

  check(`${event} computes the deadline fresh, with no inheritable fallback`, () => {
    const h = hooksFor(event)[0];
    assert(/_JFAG_NOW=\$\(date \+%s 2>\/dev\/null\);/.test(h.command),
      `${event} must read the clock defensively, tolerating an absent date(1)`);
    // Computed INSIDE a command substitution, so the `;` the clock read needs is scoped and the
    // hook stays one simple command. See the top-level-operator check below for why.
    assert(h.command.includes(
      'JF_AGENT_GUARD_ENFORCE_DEADLINE="$(_JFAG_NOW=$(date +%s 2>/dev/null); ' +
      'echo ${_JFAG_NOW:+$((_JFAG_NOW + 25))})"'),
      `${event} must compute an absolute deadline at invocation time INSIDE a command ` +
      `substitution, and pass EMPTY when the clock could not be read: agent-guard ignores an ` +
      `empty deadline and falls back to its own budget, whereas a garbage epoch floors the ` +
      `budget at 500ms and blocks every skill`);
    assert(!/JF_AGENT_GUARD_ENFORCE_DEADLINE:[-=]/.test(h.command),
      `${event} must not fall back to an inherited value: an absolute instant inherited from an ` +
      `earlier process pins every later invocation to the past`);
  });

  check(`${event} cannot pin the agent-guard version`, () => {
    const h = hooksFor(event)[0];
    // Deliberately unlike the MCP-align hook, which pins on purpose. Governance must pick up a
    // shipped GA fix without waiting for a plugin release.
    assert(!h.command.includes("JFROG_AGENT_GUARD_VERSION"),
      `${event} must resolve latest, so a shipped GA fix reaches users without a plugin release`);
    assert(/@jfrog\/agent-guard(\s|$)/.test(h.command),
      `${event} must name the package unpinned: ${h.command}`);
  });
}

check("the two governed hooks differ ONLY in the cache flag", () => {
  const norm = (c) => c.replace(" --prefer-offline", "");
  assert(norm(commandFor("UserPromptSubmit")) === norm(commandFor("PreToolUse")),
    "the two surfaces must enforce identically apart from --prefer-offline; they have drifted:\n" +
    `  UserPromptSubmit: ${commandFor("UserPromptSubmit")}\n  PreToolUse: ${commandFor("PreToolUse")}`);
});

check("every hook command is valid POSIX sh", () => {
  for (const event of Object.keys(hooks.hooks ?? {})) {
    for (const h of hooksFor(event)) {
      const r = spawnSync(SH, ["-n", "-c", h.command], { encoding: "utf8" });
      assert(r.status === 0, `${event} command is not valid sh: ${r.stderr.trim()}`);
    }
  }
});

// Strip every $(…) / $((…)) group, leaving only the command's TOP-LEVEL text. A ';' inside a
// substitution is scoped and harmless; one outside it is not.
const topLevelOf = (s) => {
  let out = "", depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith("$(", i)) { depth++; i++; continue; }
    if (depth && s[i] === "(") { depth++; continue; }
    if (depth && s[i] === ")") { depth--; continue; }
    if (!depth) out += s[i];
  }
  return out;
};

// Asserted here even though VS Code delivers the payload on the child's real stdin, where a
// top-level `;` is harmless. Two reasons it is still a requirement:
//
//   * These command strings are kept deliberately identical across the Cursor, Claude Code and
//     VS Code plugins, and on Cursor a top-level `;` severs the pipeline Cursor wraps around the
//     command, silently allowing every skill (MLAI-1310). A string copied from here to there must
//     not carry the defect with it.
//   * "Harmless on today's client" is not a property to depend on. A one-simple-command hook works
//     under every delivery model; one that relies on inheriting the shell's stdin does not.
check("no governed command has a top-level ';', '&&' or '||'", () => {
  for (const event of GOVERNED_EVENTS) {
    const top = topLevelOf(hooksFor(event)[0].command);
    for (const op of [";", "&&", "||"]) {
      assert(!top.includes(op),
        `${event}: a top-level "${op}" makes the hook depend on inheriting the shell's stdin. ` +
        `On Cursor that silently allows every skill (MLAI-1310). Keep it inside $( ).\n` +
        `         top-level text: ${top.trim()}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Behavioural: execute the real hooks.json command string.
// ---------------------------------------------------------------------------

// A payload shaped like the surface actually sends, so a check cannot pass by feeding one
// surface's event to the other's hook.
const payloadFor = (event) => event === "PreToolUse"
  ? `{"hook_event_name":"PreToolUse","tool_name":"skill","tool_input":{"skill":"demo"},"cwd":"/w"}`
  : `{"hook_event_name":"UserPromptSubmit","prompt":"/demo","cwd":"/w"}`;

// Run every behavioural check against BOTH governed surfaces. The cache-flag check above already
// makes divergence loud, but it only holds while it runs first; looping here means a future hook
// that stops matching is still exercised on its own terms.
for (const event of GOVERNED_EVENTS) {
  await check(`${event}: forwards stdin verbatim and hands agent-guard the expected argv`, async () => {
    const record = stubNpx({ stdout: `{"continue":true}` });
    const payload = payloadFor(event);
    const r = runHook(commandFor(event), payload);
    assert(r.code === 0, `exit=${r.code} stderr=${r.stderr}`);
    const seen = JSON.parse(readFileSync(record, "utf8"));
    assert(seen.stdin === payload, `stdin altered: ${seen.stdin}`);
    assert(seen.argv.includes("--enforce-skill"), `argv missing --enforce-skill: ${seen.argv}`);
    assert(seen.argv[seen.argv.indexOf("--client") + 1] === "vscode", `bad --client: ${seen.argv}`);
    assert(seen.argv[seen.argv.indexOf("--registry") + 1] === RELEASES_REGISTRY,
      `must default to the releases registry: ${seen.argv}`);
  });

  await check(`${event}: hands agent-guard a deadline in the future, computed at invocation`, async () => {
    const record = stubNpx({ stdout: `{"continue":true}` });
    const before = Math.floor(Date.now() / 1000);
    runHook(commandFor(event), payloadFor(event), {
      // A stale value in the environment must NOT survive into the child.
      extraEnv: { JF_AGENT_GUARD_ENFORCE_DEADLINE: "1" },
    });
    const seen = JSON.parse(readFileSync(record, "utf8"));
    const deadline = Number(seen.deadline);
    assert(Number.isFinite(deadline) && deadline > before,
      `the deadline must be recomputed, not inherited; got ${seen.deadline}`);
  });

  await check(`${event}: forwards a deny verbatim and exits 0 (the JSON decides)`, async () => {
    const deny = event === "PreToolUse"
      ? `{"systemMessage":"blocked","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"policy"}}`
      : `{"continue":false,"stopReason":"blocked","systemMessage":"blocked"}`;
    stubNpx({ stdout: deny });
    const r = runHook(commandFor(event), payloadFor(event));
    assert(r.code === 0, `a rendered verdict must exit 0 and let the JSON decide, got ${r.code}`);
    assert(r.stdout === deny, `stdout altered: ${r.stdout}`);
    assert(blocks(r), "a deny payload must read as a block");
  });

  await check(`${event}: an allow is forwarded as-is (explicit JSON, never silence)`, async () => {
    stubNpx({ stdout: `{"continue":true}` });
    const r = runHook(commandFor(event), payloadFor(event));
    assert(r.code === 0 && r.stdout === `{"continue":true}`,
      `an allow must be explicit JSON: exit=${r.code} stdout=${r.stdout}`);
    assert(!blocks(r), "continue:true must not read as a block");
    // permissionDecision:"allow" would APPROVE the call, bypassing VS Code's own permission
    // prompt and overruling every other hook.
    assert(!r.stdout.includes("permissionDecision"), "an allow must carry no permission decision");
  });

  await check(`${event}: output that is not valid JSON is forwarded, not repaired`, async () => {
    stubNpx({ stdout: "not json at all" });
    const r = runHook(commandFor(event), payloadFor(event));
    assert(r.stdout === "not json at all",
      `the hook must forward bytes verbatim and never rewrite a verdict: ${r.stdout}`);
    assert(!blocks(r), "unparseable output is not a deny");
  });

  await check(`${event}: empty stdout with exit 0 stays empty`, async () => {
    stubNpx({ stdout: "", exitCode: 0 });
    const r = runHook(commandFor(event), payloadFor(event));
    assert(r.stdout === "", `the hook must not invent a verdict: ${r.stdout}`);
    assert(!blocks(r), "silence is not a deny");
  });

  await check(`${event}: an agent-guard failure fails OPEN, not closed`, async () => {
    stubNpx({ stdout: "", exitCode: 1 });
    const r = runHook(commandFor(event), payloadFor(event));
    assert(!blocks(r),
      `an internal failure must let the skill through, got exit=${r.code} stdout=${r.stdout}`);
  });

  // With npx absent the guard never runs at all. That machine is not governed, so it must not be
  // punished.
  await check(`${event}: npx missing entirely fails OPEN`, async () => {
    const r = runHook(commandFor(event), payloadFor(event), { isolate: true });
    assert(!blocks(r), `a missing npx must fail open, got exit=${r.code} stdout=${r.stdout}`);
  });

  await check(`${event}: agent-guard's own exit 2 still blocks`, async () => {
    stubNpx({ stdout: "", exitCode: 2 });
    const r = runHook(commandFor(event), payloadFor(event));
    assert(r.code === 2,
      `agent-guard exits 2 for a block it could not deliver; the hook must not mask it, got ${r.code}`);
  });

  await check(`${event}: JFROG_AGENT_GUARD_REPO redirects the registry, and nothing can pin the version`, async () => {
    const record = stubNpx({ stdout: `{"continue":true}` });
    runHook(commandFor(event), payloadFor(event), {
      extraEnv: {
        JFROG_AGENT_GUARD_REPO: "https://example.invalid/npm/dev/",
        JFROG_AGENT_GUARD_VERSION: "0.0.0-master.1.gabc",
      },
    });
    const seen = JSON.parse(readFileSync(record, "utf8"));
    assert(seen.argv[seen.argv.indexOf("--registry") + 1] === "https://example.invalid/npm/dev/",
      `registry override ignored: ${seen.argv}`);
    assert(seen.argv.includes("@jfrog/agent-guard"),
      `the package spec must stay unpinned: ${seen.argv}`);
    assert(!seen.argv.some((a) => a.startsWith("@jfrog/agent-guard@")),
      `no environment variable may pin the version: ${seen.argv}`);
  });
}

rmSync(sandbox, { recursive: true, force: true });
if (failures.length) { console.error(`\n${failures.length} check(s) failed.`); process.exit(1); }
console.log("\nAll checks passed.");
