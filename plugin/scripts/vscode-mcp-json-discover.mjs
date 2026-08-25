import {
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CONFIG_NAMES = ["mcp.json", ".mcp.json"];
const VSCODE_APP_DIR_NAMES = ["Code", "Code - Insiders", "VSCodium"];

export function parseDiscoveryRoots(value, platform = process.platform) {
  if (!value?.trim()) return [];
  const delimiter = platform === "win32" ? /[;,]/ : /[:,]/;
  return value
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function platformVsCodeAppDir(home, env, platform, appDirName) {
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", appDirName);
  }
  if (platform === "win32") {
    return env.APPDATA ? path.join(env.APPDATA, appDirName) : null;
  }
  const configHome = env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(configHome, appDirName);
}

function platformVsCodeDir(home, env, platform) {
  return platformVsCodeAppDir(home, env, platform, "Code");
}

function platformVsCodeUserDirs(home, env, platform) {
  return VSCODE_APP_DIR_NAMES.map((appDirName) => {
    const appDir = platformVsCodeAppDir(home, env, platform, appDirName);
    return appDir ? path.join(appDir, "User") : null;
  }).filter(Boolean);
}

function platformVsCodeAgentPluginsDir(home, env, platform) {
  const codeDir = platformVsCodeDir(home, env, platform);
  return codeDir ? path.join(codeDir, "agentPlugins") : null;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function safeRealpath(candidate) {
  try {
    return realpathSync(candidate);
  } catch {
    return null;
  }
}

function isWorkspaceVscodeDirectory(directory) {
  return Boolean(directory) && path.basename(directory).toLowerCase() === ".vscode";
}

function isInsideRoot(candidate, root) {
  if (!root) return false;
  const logicalRoot = path.resolve(root);
  const logicalCandidate = path.resolve(candidate);
  if (isContained(logicalRoot, logicalCandidate)) return true;
  const realRoot = safeRealpath(logicalRoot);
  const realCandidate = safeRealpath(candidate);
  return Boolean(
    realRoot && realCandidate && isContained(realRoot, realCandidate),
  );
}

function isInsideAnyRoot(candidate, roots) {
  return roots.some((root) => isInsideRoot(candidate, root));
}

function isVsCodeUserTree(directory, realDirectory, userDirs) {
  return (
    isInsideAnyRoot(directory, userDirs) ||
    (Boolean(realDirectory) && isInsideAnyRoot(realDirectory, userDirs))
  );
}

function isResolvedWorkspaceVscode(directory, realDirectory, workspaceVscodeDirs) {
  return (
    isInsideAnyRoot(directory, workspaceVscodeDirs) ||
    (Boolean(realDirectory) &&
      isInsideAnyRoot(realDirectory, workspaceVscodeDirs))
  );
}

function collectRoot(
  root,
  maxDepth,
  output,
  seen,
  userDirs,
  workspaceVscodeDirs,
) {
  const realRoot = safeRealpath(root);
  if (!realRoot) return;
  if (isVsCodeUserTree(root, realRoot, userDirs)) return;
  if (isResolvedWorkspaceVscode(root, realRoot, workspaceVscodeDirs)) return;

  function visit(directory, depth) {
    const realDirectory = safeRealpath(directory);
    if (!realDirectory || !isContained(realRoot, realDirectory)) return;
    if (isVsCodeUserTree(directory, realDirectory, userDirs)) return;
    if (isResolvedWorkspaceVscode(directory, realDirectory, workspaceVscodeDirs)) {
      return;
    }

    const deniedWorkspace =
      isWorkspaceVscodeDirectory(directory) ||
      isWorkspaceVscodeDirectory(realDirectory);
    if (deniedWorkspace && depth > 0) return;

    let containsConfig = false;
    if (!deniedWorkspace) {
      for (const name of CONFIG_NAMES) {
        const candidate = path.join(directory, name);
        try {
          lstatSync(candidate);
          containsConfig = true;
        } catch {
          continue;
        }
        const realCandidate = safeRealpath(candidate);
        const realParent = realCandidate ? path.dirname(realCandidate) : null;
        if (
          !realCandidate ||
          !isContained(realRoot, realCandidate) ||
          isWorkspaceVscodeDirectory(realParent) ||
          isInsideAnyRoot(realParent, workspaceVscodeDirs) ||
          isInsideAnyRoot(realParent, userDirs) ||
          seen.has(realCandidate)
        ) {
          continue;
        }
        try {
          if (!statSync(candidate).isFile()) continue;
        } catch {
          continue;
        }
        seen.add(realCandidate);
        output.push(candidate);
      }
    }

    if (containsConfig || depth >= maxDepth) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .sort((left, right) => {
          if (left.name === "_direct") return 1;
          if (right.name === "_direct") return -1;
          return left.name.localeCompare(right.name);
        });
    } catch {
      return;
    }
    for (const entry of entries) {
      visit(path.join(directory, entry.name), depth + 1);
    }
  }

  visit(root, 0);
}

/**
 * Plugin root is the parent of `scripts/` (where this file lives).
 * @param {string} [moduleUrl]
 */
export function resolvePluginRoot(moduleUrl = import.meta.url) {
  return path.dirname(path.dirname(fileURLToPath(moduleUrl)));
}

function addSelfConfigs(
  output,
  seen,
  userDirs,
  workspaceVscodeDirs,
  moduleUrl,
) {
  const pluginRoot = resolvePluginRoot(moduleUrl);
  const realPluginRoot = safeRealpath(pluginRoot);
  if (!realPluginRoot) return;
  for (const name of CONFIG_NAMES) {
    const candidate = path.join(pluginRoot, name);
    try {
      lstatSync(candidate);
    } catch {
      continue;
    }
    const realCandidate = safeRealpath(candidate);
    const realParent = realCandidate ? path.dirname(realCandidate) : null;
    if (
      !realCandidate ||
      !realParent ||
      !isContained(realPluginRoot, realCandidate) ||
      isWorkspaceVscodeDirectory(realParent) ||
      isInsideAnyRoot(realParent, workspaceVscodeDirs) ||
      isInsideAnyRoot(realParent, userDirs) ||
      seen.has(realCandidate)
    ) {
      continue;
    }
    try {
      if (!statSync(candidate).isFile()) continue;
    } catch {
      continue;
    }
    seen.add(realCandidate);
    output.push(candidate);
  }
}

export function discoverVscodeMcpJson(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? env.HOME ?? homedir();
  const userDirs = platformVsCodeUserDirs(home, env, platform);
  const workspaceVscodeDirs = (options.workspaceRoots ?? []).map((root) =>
    path.join(path.resolve(root), ".vscode"),
  );
  const override = parseDiscoveryRoots(
    env.JF_ALIGN_MCP_JSON_ROOTS,
    platform,
  );
  const output = [];
  const seen = new Set();
  const includeSelf = options.includeSelf !== false;
  const moduleUrl = options.moduleUrl ?? import.meta.url;

  if (override.length) {
    for (const root of override) {
      collectRoot(
        path.resolve(root),
        4,
        output,
        seen,
        userDirs,
        workspaceVscodeDirs,
      );
    }
    return output;
  }

  collectRoot(
    path.join(home, ".copilot", "installed-plugins"),
    2,
    output,
    seen,
    userDirs,
    workspaceVscodeDirs,
  );
  collectRoot(
    path.join(home, ".vscode", "agent-plugins"),
    4,
    output,
    seen,
    userDirs,
    workspaceVscodeDirs,
  );
  // VS Code loads plugin MCP servers from its own per-install copy under
  // Code/agentPlugins, not from the install tree, so rewriting only the source
  // leaves the running servers unsecured until VS Code re-copies.
  const agentPluginsDir = platformVsCodeAgentPluginsDir(home, env, platform);
  if (agentPluginsDir) {
    collectRoot(
      agentPluginsDir,
      4,
      output,
      seen,
      userDirs,
      workspaceVscodeDirs,
    );
  }
  if (includeSelf) {
    addSelfConfigs(output, seen, userDirs, workspaceVscodeDirs, moduleUrl);
  }
  return output;
}

export function allowRootsForMcpJson(paths) {
  const roots = [];
  const seen = new Set();
  for (const configPath of paths) {
    const realFile = safeRealpath(configPath);
    const root = realFile
      ? path.dirname(realFile)
      : safeRealpath(path.dirname(configPath));
    if (!root || seen.has(root)) continue;
    seen.add(root);
    roots.push(root);
  }
  return roots;
}
