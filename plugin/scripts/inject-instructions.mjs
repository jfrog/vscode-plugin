#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Logs go to stderr; stdout is reserved for the hook JSON payload.
const debugEnabled = process.env.JF_AGENT_GUARD_DEBUG === "true";
const log = (message) => console.error(`[jfrog-agent-guard] ${message}`);
const debug = (message) => {
  if (debugEnabled) log(message);
};

// New JFROG_* env vars take precedence over the legacy JF_* names.
const env = (newName, oldName) =>
    process.env[newName] ?? process.env[oldName];

const forceDisabled =
    env("_JF_AGENT_GUARD_FORCE_DISABLE", "_JF_MCP_GATEWAY_FORCE_DISABLE") === "true";
const forceEnabled =
    env("JF_AGENT_GUARD_FORCE_ENABLE", "JF_MCP_GATEWAY_FORCE_ENABLE") === "true";

/**
 * Parses process arguments to extract the value of the `--server` flag.
 * Supports both `--server=my-id` and `--server my-id`.
 */
function getServerFlagValue() {
  const args = process.argv;
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--server=")) {
      return args[i].split("=")[1];
    }
    if (args[i] === "--server" && i + 1 < args.length) {
      return args[i + 1];
    }
  }
  return null;
}

/**
 * Resolve {baseUrl, token} following strict authentication precedence:
 * 1. The --server flag (matched against profiles in the JF CLI config)
 * 2. Environment variables (JFROG_URL/JF_URL and JFROG_ACCESS_TOKEN/JF_ACCESS_TOKEN)
 * 3. Configuration File created by the JF CLI (~/.jfrog/jfrog-cli.conf.v6)
 *    a. Profile marked isDefault: true
 *    b. The only profile that exists (if exactly one is defined)
 */
function resolveCredentials() {
  // Read and parse JF CLI config safely, as multiple layers depend on it
  const confPath = path.join(os.homedir(), ".jfrog", "jfrog-cli.conf.v6");
  let conf = null;
  try {
    conf = JSON.parse(readFileSync(confPath, "utf8"));
  } catch (error) {
    debug(`Could not read or parse JF CLI config at ${confPath}: ${error.message}`);
  }

  const servers = Array.isArray(conf?.servers) ? conf.servers.filter((s) => s.url && s.accessToken) : [];

  // Priority 1: --server flag
  const serverFlagId = getServerFlagValue();
  if (serverFlagId) {
    debug(`--server flag detected with value: "${serverFlagId}". Searching config...`);
    const flaggedProfile = servers.find((s) => s.serverId === serverFlagId);
    if (flaggedProfile) {
      debug(`Resolved credentials via --server flag using profile: ${flaggedProfile.serverId}`);
      return { baseUrl: flaggedProfile.url, token: flaggedProfile.accessToken };
    }
    debug(`Warning: --server flag specified ID "${serverFlagId}" but no matching profile was found in config.`);
    // Fall through to next authentication method
  }

  // Priority 2: Environment variables
  const baseUrl = env("JFROG_URL", "JF_URL");
  const token = env("JFROG_ACCESS_TOKEN", "JF_ACCESS_TOKEN");
  if (baseUrl && token) {
    debug("Resolved credentials from environment variables");
    return { baseUrl, token };
  }

  // If config file couldn't be loaded/parsed earlier, we can't proceed with priorities 3 & 4
  if (!conf || servers.length === 0) {
    debug("No server profiles available via JF CLI config; authentication resolution failed.");
    return null;
  }

  // Priority 3: Default profile in config
  let profile = servers.find((s) => s.isDefault);
  if (profile) {
    debug(`Resolved credentials using default profile: ${profile.serverId}`);
    return { baseUrl: profile.url, token: profile.accessToken };
  }

  // Priority 4: The only profile that exists
  if (servers.length === 1) {
    profile = servers[0];
    debug(`Resolved credentials using the single available profile: ${profile.serverId}`);
    return { baseUrl: profile.url, token: profile.accessToken };
  }

  debug("Authentication resolution failed: Multiple profiles exist but none are marked default.");
  return null;
}

async function isGatewayEnabledViaSettings() {
  const credentials = resolveCredentials();
  if (!credentials) {
    debug("No credentials resolved; skipping settings check");
    return false;
  }
  const { baseUrl, token } = credentials;
  const url =
      baseUrl.replace(/\/+$/, "") +
      "/ml/core/api/v1/administration/account-settings/mcp_gateway_plugin_enabled";

  debug(`Fetching gateway setting from ${url}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      debug(`Settings request returned HTTP ${response.status}; body: ${body || "<empty>"}`);
      return false;
    }
    const data = await response.json();
    const enabled = data?.settings?.mcpGatewayPluginEnabled?.value === true;
    debug(`Settings response indicates gateway enabled=${enabled}`);
    return enabled;
  } catch (error) {
    const reason = error?.name === "AbortError" ? "timeout" : error?.message ?? "unknown error";
    debug(`Settings request failed: ${reason}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

if (forceDisabled) {
  debug("Force-disable flag is set.");
  process.exit(0);
} else if (forceEnabled) {
  debug("Force-enable flag is set.");
} else if (!(await isGatewayEnabledViaSettings())) {
  debug("Gateway not enabled; exiting without injecting instructions");
  process.exit(0);
}
debug("Injecting instructions");

// Derive the plugin root from this script's own location instead of relying
// on CLAUDE_PLUGIN_ROOT, which Claude Code interpolates into the hook command
// string but does not always export to the subprocess.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let template;
try {
  template = readFileSync(
    path.join(root, "templates", "jfrog-mcp-management.md"),
    "utf8",
  );
} catch {
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: template,
    },
  }),
);
