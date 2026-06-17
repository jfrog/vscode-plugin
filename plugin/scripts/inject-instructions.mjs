#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

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
    env("_JF_AGENT_GUARD_FORCE_DISABLE") === "true";
const forceEnabled =
    env("JF_AGENT_GUARD_FORCE_ENABLE") === "true";

// Resolve {baseUrl, token}, preferring env vars and falling back to the JF CLI
// config (~/.jfrog/jfrog-cli.conf.v6): the profile marked isDefault, or the
// only profile when exactly one is defined. Returns null when nothing resolves.
function resolveCredentials() {
  const baseUrl = env("JFROG_URL", "JF_URL");
  const token = env("JFROG_ACCESS_TOKEN", "JF_ACCESS_TOKEN");
  if (baseUrl && token) {
    debug("Resolved credentials from environment variables");
    return { baseUrl, token };
  }

  const confPath = path.join(os.homedir(), ".jfrog", "jfrog-cli.conf.v6");
  let conf;
  try {
    conf = JSON.parse(readFileSync(confPath, "utf8"));
  } catch (error) {
    debug(`Could not read or parse JF CLI config at ${confPath}: ${error.message}`);
    return null;
  }

  // Only profiles that actually carry a URL and access token are usable.
  const servers = Array.isArray(conf?.servers)
    ? conf.servers.filter((s) => s.url && s.accessToken)
    : [];
  if (servers.length === 0) {
    debug("No usable server profiles found in JF CLI config");
    return null;
  }

  const defaultProfile = servers.find((s) => s.isDefault);
  if (defaultProfile) {
    debug(`Resolved credentials using default profile: ${defaultProfile.serverId}`);
    return { baseUrl: defaultProfile.url, token: defaultProfile.accessToken };
  }

  if (servers.length === 1) {
    debug(`Resolved credentials using the single available profile: ${servers[0].serverId}`);
    return { baseUrl: servers[0].url, token: servers[0].accessToken };
  }

  debug("Multiple JF CLI profiles exist but none is marked default; cannot resolve credentials");
  return null;
}

async function isAgentGuardEnabledViaSettings() {
  const credentials = resolveCredentials();
  if (!credentials) {
    debug("No JFrog credentials resolved; skipping settings check");
    return false;
  }
  const { baseUrl, token } = credentials;

  const url =
      baseUrl.replace(/\/+$/, "") +
      "/ml/core/api/v1/administration/account-settings/mcp_gateway_plugin_enabled";

  debug(`Fetching agent guard setting from ${url}`);

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
    debug(`Settings response indicates agent guard enabled=${enabled}`);
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
  process.stdout.write("{}");
  process.exit(0);
} else if (forceEnabled) {
  debug("Force-enable flag is set.");
} else if (!(await isAgentGuardEnabledViaSettings())) {
  debug("Agent Guard not enabled; exiting without injecting instructions");
  process.stdout.write("{}");
  process.exit(0);
}
debug("Injecting instructions");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let template;
try {
  template = readFileSync(
    path.join(root, "templates", "jfrog-mcp-management.md"),
    "utf8",
  );
} catch {
  process.stdout.write("{}");
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    additional_context: template,
  }),
);
