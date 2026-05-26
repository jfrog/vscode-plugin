#!/usr/bin/env node
// jfrog-setup-user — per-user setup. Idempotent. Runs at login + every 60s.
//
// Two modes:
//   (default)   apply one tick: write hook config + update settings.json.
//   --clean     strip our entry from settings.json (used by uninstall).
// "Idempotent" = if disk already matches the target, do nothing.
// "Tick"       = one pass of the setup loop.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import {
  HOOK_CONFIG_TILDE,
  PRODUCT_NAME,
  VSCODE_SETTINGS_PATH,
  audit,
  buildHookConfig,
  stripJsonc,
} from "../lib/config.mjs";

// Constants
const IS_MAC= platform() === "darwin";
const IS_WIN= platform() === "win32";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));   // folder this script lives in
const HOOK_BIN = process.env.JFROG_MCP_GATE_HOOK_BIN ?? resolvePath(SCRIPT_DIR, "jfrog-mcp-gate.mjs");
const USER_HOME = process.env.JFROG_MCP_GATE_HOME ?? homedir();
const MCP_GATE_DIR = join(USER_HOME, ".jfrog", "mcp-gate");
const HOOK_CONFIG = join(MCP_GATE_DIR, "vscode-hooks.json");

const SETTINGS_PATH = process.env.JFROG_MCP_GATE_HOME
  ? (IS_MAC ? join(USER_HOME, "Library/Application Support/Code/User/settings.json")
    : IS_WIN ? join(USER_HOME, "AppData/Roaming/Code/User/settings.json")
    :          join(USER_HOME, ".config/Code/User/settings.json"))
  : VSCODE_SETTINGS_PATH;

const SETTINGS_INDENT = 2;

// Read settings.json. Returns {} if the file doesn't exist.
const readSettings = () => {
  if (!existsSync(SETTINGS_PATH)) return {};
  try { return JSON.parse(stripJsonc(readFileSync(SETTINGS_PATH, "utf8"))) ?? {}; }
  catch (err) {
    process.stderr.write(`${PRODUCT_NAME}: cannot parse ${SETTINGS_PATH}: ${err.message}\nFix manually and rerun.\n`);
    process.exit(1);
  }
};


// Atomic write: write to a sibling temp file, then rename it onto the
// target. Used for both vscode-hooks.json and settings.json.
const atomicWrite = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
};


// Pure transforms on the parsed settings.json.
const reseededSettings = (current) => {
  const next = { ...current };
  delete next["chat.hooks.enabled"];        // legacy stray key from earlier VS Code versions
  const existing = next["chat.hookFilesLocations"];
  const locations = existing && typeof existing === "object" ? { ...existing } : {};
  locations[HOOK_CONFIG_TILDE] = true;
  next["chat.hookFilesLocations"] = locations;
  return next;
};

const cleanedSettings = (current) => {
  const next = { ...current };
  delete next["chat.hooks.enabled"];
  const existing = next["chat.hookFilesLocations"];
  const locations = existing && typeof existing === "object" ? { ...existing } : {};
  delete locations[HOOK_CONFIG_TILDE];
  if (Object.keys(locations).length === 0) delete next["chat.hookFilesLocations"];
  else next["chat.hookFilesLocations"] = locations;
  return next;
};


// stringify the target, read the file, compare. If they match we skip the write.
const tick = () => {
  const targetHookText= JSON.stringify(buildHookConfig(HOOK_BIN), null, 2) + "\n";
  const targetSettingsText= JSON.stringify(reseededSettings(readSettings()), null, SETTINGS_INDENT) + "\n";

  const currentHookText= existsSync(HOOK_CONFIG)   ? readFileSync(HOOK_CONFIG,"utf8") : null;
  const currentSettingsText= existsSync(SETTINGS_PATH) ? readFileSync(SETTINGS_PATH, "utf8") : "";

  const hookDrifted= currentHookText !== targetHookText;
  const settingsDrifted= currentSettingsText !== targetSettingsText;

  if (!hookDrifted && !settingsDrifted) {
    audit({ event_type: "setup_user_tick", changed: false });
    return;
  }

  if (hookDrifted) {
    atomicWrite(HOOK_CONFIG, targetHookText);
    audit({ event_type: "reseed", target: HOOK_CONFIG, reason: currentHookText == null ? "created" : "updated" });
  }
  if (settingsDrifted) {
    atomicWrite(SETTINGS_PATH, targetSettingsText);
    audit({ event_type: "reseed", target: SETTINGS_PATH, reason: "applied chat.hookFilesLocations" });
  }

  audit({ event_type: "setup_user_tick", changed: true });
};


// --clean — the reverse of a tick.
// Strip our chat.hookFilesLocations entry from settings.json. The hook-config directory itself is removed by the
// OS uninstaller, not here.
const clean = () => {
  if (!existsSync(SETTINGS_PATH)) return;
  const currentText = readFileSync(SETTINGS_PATH, "utf8");
  const nextText    = JSON.stringify(cleanedSettings(readSettings()), null, SETTINGS_INDENT) + "\n";
  if (currentText !== nextText) atomicWrite(SETTINGS_PATH, nextText);
};


// Entrypoint
if (process.argv[2] === "--clean") clean();
else tick();
