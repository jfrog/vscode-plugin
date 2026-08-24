import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  allowRootsForMcpJson,
  discoverVscodeMcpJson,
  parseDiscoveryRoots,
} from "./vscode-mcp-json-discover.mjs";

function file(root, relative) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, "{}\n");
  return target;
}

function pluginModuleUrl(pluginRoot) {
  return pathToFileURL(path.join(pluginRoot, "scripts", "vscode-mcp-json-discover.mjs"))
    .href;
}

test("discovers Copilot installed-plugin, agent-plugin, and runtime configs", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-discover-"));
  const expected = [
    file(
      home,
      ".copilot/installed-plugins/marketplace/plugin/mcp.json",
    ),
    file(
      home,
      ".copilot/installed-plugins/_direct/direct-id/.mcp.json",
    ),
    file(home, ".vscode/agent-plugins/github.com/org/repo/plugin/mcp.json"),
    file(
      home,
      "Library/Application Support/Code/agentPlugins/github.com/org/repo/plugin/.mcp.json",
    ),
  ];
  file(home, "cache/copilot/marketplaces/marketplace/plugin/mcp.json");
  file(home, "self/mcp.json");
  file(home, "self/.mcp.json");

  const actual = discoverVscodeMcpJson({
    env: {
      HOME: home,
      COPILOT_CACHE_HOME: path.join(home, "cache", "copilot"),
    },
    home,
    platform: "darwin",
    includeSelf: false,
  });

  assert.deepEqual(actual, expected);
});

test("includeSelf adds this plugin's mcp.json and .mcp.json", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-self-"));
  const pluginRoot = path.join(home, "installed-jfrog");
  const wanted = [
    file(pluginRoot, "mcp.json"),
    file(pluginRoot, ".mcp.json"),
  ];
  file(home, "self/mcp.json");

  const actual = discoverVscodeMcpJson({
    env: { HOME: home },
    home,
    platform: "linux",
    moduleUrl: pluginModuleUrl(pluginRoot),
  });

  assert.deepEqual(actual, wanted);
});

test("includeSelf is skipped when JF_ALIGN_MCP_JSON_ROOTS is set", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-self-override-"));
  const pluginRoot = path.join(home, "installed-jfrog");
  file(pluginRoot, "mcp.json");
  file(pluginRoot, ".mcp.json");
  const overrideRoot = path.join(home, "override");
  const wanted = file(overrideRoot, "plugin/mcp.json");

  const actual = discoverVscodeMcpJson({
    env: {
      HOME: home,
      JF_ALIGN_MCP_JSON_ROOTS: overrideRoot,
    },
    home,
    platform: "linux",
    moduleUrl: pluginModuleUrl(pluginRoot),
  });

  assert.deepEqual(actual, [wanted]);
});

test("includeSelf deduplicates configs already found under agent-plugins", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-self-dedupe-"));
  const pluginRoot = path.join(
    home,
    ".vscode/agent-plugins/github.com/jfrog/vscode-plugin/plugin",
  );
  const wanted = file(pluginRoot, ".mcp.json");

  const actual = discoverVscodeMcpJson({
    env: { HOME: home },
    home,
    platform: "linux",
    moduleUrl: pluginModuleUrl(pluginRoot),
  });

  assert.deepEqual(actual, [wanted]);
});

test("roots override skips defaults and self while deduplicating configs", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-override-"));
  const first = path.join(home, "first");
  const second = path.join(home, "second");
  const wanted = file(first, "plugin/mcp.json");
  file(home, ".copilot/installed-plugins/market/plugin/mcp.json");
  file(path.join(home, "self"), "mcp.json");
  symlinkSync(first, second);

  const actual = discoverVscodeMcpJson({
    env: {
      HOME: home,
      JF_ALIGN_MCP_JSON_ROOTS: `${first},${second}`,
    },
    home,
    platform: "linux",
  });

  assert.deepEqual(actual, [wanted]);
});

test("defaults ignore marketplace cache even without skip-cache", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-cache-"));
  const cacheConfig = file(
    home,
    ".cache/copilot/marketplaces/market/plugin/mcp.json",
  );
  const installed = file(
    home,
    ".copilot/installed-plugins/market/plugin/mcp.json",
  );

  const actual = discoverVscodeMcpJson({
    env: { HOME: home },
    home,
    platform: "linux",
    includeSelf: false,
  });

  assert.deepEqual(actual, [installed]);
  assert.ok(!actual.includes(cacheConfig));
});

test("parses POSIX and Windows override delimiters without splitting drive colons", () => {
  assert.deepEqual(parseDiscoveryRoots("/one:/two,/three", "linux"), [
    "/one",
    "/two",
    "/three",
  ]);
  assert.deepEqual(
    parseDiscoveryRoots("C:\\one;D:\\two,E:\\three", "win32"),
    ["C:\\one", "D:\\two", "E:\\three"],
  );
});

test("default discovery rejects symlinks escaping an allowed root", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-symlink-"));
  const outside = mkdtempSync(path.join(tmpdir(), "vscode-mcp-outside-"));
  file(outside, "mcp.json");
  const leaf = path.join(
    home,
    ".copilot/installed-plugins/marketplace/plugin",
  );
  mkdirSync(path.dirname(leaf), { recursive: true });
  symlinkSync(outside, leaf);

  assert.deepEqual(
    discoverVscodeMcpJson({
      env: { HOME: home },
      home,
      platform: "linux",
      includeSelf: false,
    }),
    [],
  );
});

test("stops descending below the first plugin config", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-leaf-"));
  const root = path.join(home, "override");
  const pluginConfig = file(root, "plugin/mcp.json");
  file(root, "plugin/.vscode/mcp.json");
  file(root, "plugin/fixtures/mcp.json");
  file(root, "plugin/node_modules/dependency/mcp.json");

  assert.deepEqual(
    discoverVscodeMcpJson({
      env: { HOME: home, JF_ALIGN_MCP_JSON_ROOTS: root },
      home,
      platform: "linux",
    }),
    [pluginConfig],
  );
});

test("defaults include platform Code/agentPlugins runtime copies", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-code-user-plugin-"));
  const wanted = file(
    home,
    "Library/Application Support/Code/agentPlugins/github.com/code/user/plugin/mcp.json",
  );
  file(home, "Library/Application Support/Code/User/mcp.json");

  assert.deepEqual(
    discoverVscodeMcpJson({
      env: { HOME: home },
      home,
      platform: "darwin",
      includeSelf: false,
    }),
    [wanted],
  );
});

test("Linux runtime copies follow XDG_CONFIG_HOME", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-xdg-plugin-"));
  const xdg = path.join(home, "xdg-config");
  const wanted = file(xdg, "Code/agentPlugins/org/plugin/mcp.json");
  file(xdg, "Code/User/mcp.json");

  assert.deepEqual(
    discoverVscodeMcpJson({
      env: { HOME: home, XDG_CONFIG_HOME: xdg },
      home,
      platform: "linux",
      includeSelf: false,
    }),
    [wanted],
  );
});

test("override roots reject workspace MCP configs but keep github.com/code/user plugins", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-deny-"));
  const root = path.join(home, "override");
  const wanted = [
    file(root, "Code/User/mcp.json"),
    file(root, "github.com/code/user/plugin/mcp.json"),
    file(root, "plugins/allowed/mcp.json"),
  ];
  file(root, "project/.vscode/mcp.json");

  assert.deepEqual(
    discoverVscodeMcpJson({
      env: { HOME: home, JF_ALIGN_MCP_JSON_ROOTS: root },
      home,
      platform: "linux",
    }),
    wanted,
  );
});

test("override root pointing at a workspace .vscode directory is rejected", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-direct-vscode-"));
  const root = path.join(home, "project", ".vscode");
  file(root, "mcp.json");
  file(root, ".mcp.json");

  assert.deepEqual(
    discoverVscodeMcpJson({
      env: { HOME: home, JF_ALIGN_MCP_JSON_ROOTS: root },
      home,
      platform: "linux",
    }),
    [],
  );
});

test("override root pointing at the platform Code/User directory is rejected", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-direct-user-"));
  const root = path.join(home, ".config", "Code", "User");
  file(root, "mcp.json");
  file(root, "globalStorage/foo/mcp.json");

  assert.deepEqual(
    discoverVscodeMcpJson({
      env: { HOME: home, JF_ALIGN_MCP_JSON_ROOTS: root },
      home,
      platform: "linux",
    }),
    [],
  );
});

test("override of a Code parent excludes the platform User tree and nested storage", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-user-parent-"));
  const root = path.join(home, ".config", "Code");
  const wanted = file(root, "agentPlugins/github.com/code/user/mcp.json");
  file(root, "User/mcp.json");
  file(root, "User/globalStorage/foo/mcp.json");

  assert.deepEqual(
    discoverVscodeMcpJson({
      env: { HOME: home, JF_ALIGN_MCP_JSON_ROOTS: root },
      home,
      platform: "linux",
    }),
    [wanted],
  );
});

test("Linux Code/User follows XDG_CONFIG_HOME for denial", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-xdg-user-"));
  const xdg = path.join(home, "xdg-config");
  const userDir = path.join(xdg, "Code", "User");
  file(userDir, "mcp.json");
  file(userDir, "globalStorage/foo/mcp.json");

  assert.deepEqual(
    discoverVscodeMcpJson({
      env: {
        HOME: home,
        XDG_CONFIG_HOME: xdg,
        JF_ALIGN_MCP_JSON_ROOTS: userDir,
      },
      home,
      platform: "linux",
    }),
    [],
  );
});

test("rejects directory symlinks whose realpath is inside platform Code/User", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-user-link-"));
  const userDir = path.join(home, ".config", "Code", "User");
  const nested = file(userDir, "globalStorage/foo/mcp.json");
  const root = path.join(home, "override");
  mkdirSync(root, { recursive: true });
  symlinkSync(path.dirname(nested), path.join(root, "plugin"));

  assert.deepEqual(
    discoverVscodeMcpJson({
      env: { HOME: home, JF_ALIGN_MCP_JSON_ROOTS: root },
      home,
      platform: "linux",
    }),
    [],
  );
});

test("override of the realpath of Code/User is rejected", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-user-real-"));
  const actual = path.join(home, "actual-user");
  file(actual, "mcp.json");
  file(actual, "globalStorage/foo/mcp.json");
  const userDir = path.join(home, ".config", "Code", "User");
  mkdirSync(path.dirname(userDir), { recursive: true });
  symlinkSync(actual, userDir);

  assert.deepEqual(
    discoverVscodeMcpJson({
      env: { HOME: home, JF_ALIGN_MCP_JSON_ROOTS: actual },
      home,
      platform: "linux",
    }),
    [],
  );
});

test("override root at ~/.vscode still yields agent plugin configs", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-vscode-root-"));
  const root = path.join(home, ".vscode");
  file(root, "mcp.json");
  const wanted = file(root, "agent-plugins/github.com/org/repo/mcp.json");

  assert.deepEqual(
    discoverVscodeMcpJson({
      env: { HOME: home, JF_ALIGN_MCP_JSON_ROOTS: root },
      home,
      platform: "linux",
    }),
    [wanted],
  );
});

test("override roots reject directory symlinks that escape", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-override-link-"));
  const root = path.join(home, "override");
  const outside = mkdtempSync(path.join(tmpdir(), "vscode-mcp-outside-"));
  file(outside, "mcp.json");
  mkdirSync(root, { recursive: true });
  symlinkSync(outside, path.join(root, "escaped"));

  assert.deepEqual(
    discoverVscodeMcpJson({
      env: { HOME: home, JF_ALIGN_MCP_JSON_ROOTS: root },
      home,
      platform: "linux",
    }),
    [],
  );
});

test("follows contained config symlinks and rejects config symlink escapes", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-file-link-"));
  const root = path.join(home, "override");
  const canonical = file(root, "shared/config.json");
  const plugin = path.join(root, "plugin");
  mkdirSync(plugin, { recursive: true });
  symlinkSync(canonical, path.join(plugin, "mcp.json"));

  const outside = file(home, "outside.json");
  const escapedPlugin = path.join(root, "escaped-plugin");
  mkdirSync(escapedPlugin, { recursive: true });
  symlinkSync(outside, path.join(escapedPlugin, "mcp.json"));

  assert.deepEqual(
    discoverVscodeMcpJson({
      env: { HOME: home, JF_ALIGN_MCP_JSON_ROOTS: root },
      home,
      platform: "linux",
    }),
    [path.join(plugin, "mcp.json")],
  );
});

test("does not overscan below a rejected config symlink", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-overscan-"));
  const root = path.join(home, "override");
  const plugin = path.join(root, "plugin");
  const outside = file(home, "outside.json");
  mkdirSync(plugin, { recursive: true });
  symlinkSync(outside, path.join(plugin, "mcp.json"));
  file(plugin, "fixtures/mcp.json");

  assert.deepEqual(
    discoverVscodeMcpJson({
      env: { HOME: home, JF_ALIGN_MCP_JSON_ROOTS: root },
      home,
      platform: "linux",
    }),
    [],
  );
});

test("allow roots are canonical directories and deduplicated", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-roots-"));
  const canonical = path.join(home, "canonical");
  const alias = path.join(home, "alias");
  mkdirSync(canonical);
  symlinkSync(canonical, alias);

  assert.deepEqual(
    allowRootsForMcpJson([
      path.join(canonical, "mcp.json"),
      path.join(alias, ".mcp.json"),
    ]),
    [realpathSync(canonical)],
  );
});

test("Windows Code/User under APPDATA is excluded from override discovery", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-win-user-"));
  const appData = path.join(home, "AppData", "Roaming");
  const userDir = path.join(appData, "Code", "User");
  file(userDir, "mcp.json");
  file(userDir, "globalStorage/foo/mcp.json");

  assert.deepEqual(
    discoverVscodeMcpJson({
      env: {
        HOME: home,
        APPDATA: appData,
        JF_ALIGN_MCP_JSON_ROOTS: userDir,
      },
      home,
      platform: "win32",
    }),
    [],
  );
});

test("Windows defaults use installed-plugins, agent-plugins, and APPDATA runtime", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vscode-mcp-windows-"));
  const appData = path.join(home, "AppData", "Roaming");
  const localAppData = path.join(home, "AppData", "Local");
  const expected = [
    file(home, ".copilot/installed-plugins/org/plugin/mcp.json"),
    file(home, ".vscode/agent-plugins/github.com/org/repo/plugin/mcp.json"),
    file(appData, "Code/agentPlugins/org/plugin/mcp.json"),
  ];
  file(localAppData, "copilot/marketplaces/org/plugin/.mcp.json");

  assert.deepEqual(
    discoverVscodeMcpJson({
      env: {
        HOME: home,
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
      },
      home,
      platform: "win32",
      includeSelf: false,
    }),
    expected,
  );
});
