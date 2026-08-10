#!/usr/bin/env node
// Copyright (c) JFrog Ltd. 2026
// Licensed under the Apache License, Version 2.0
// https://www.apache.org/licenses/LICENSE-2.0

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const modulesRoot = path.join(root, "plugin", "modules");
const manifestFile = path.join(
  root,
  ".github",
  "scripts",
  "sync-modules-integrity.json",
);

async function filesUnder(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory())
      files.push(...(await filesUnder(path.join(dir, entry.name), relative)));
    else files.push(relative);
  }
  return files.sort();
}

async function digest(relative) {
  const bytes = await readFile(path.join(modulesRoot, relative));
  return createHash("sha256").update(bytes).digest("hex");
}

async function snapshot(pin) {
  const files = {};
  for (const relative of await filesUnder(modulesRoot))
    files[relative] = await digest(relative);
  return { schemaVersion: 1, pin, files };
}

const vendor = JSON.parse(
  await readFile(
    path.join(root, ".github", "scripts", "sync-modules-vendor.json"),
    "utf8",
  ),
);
const actual = await snapshot(vendor.pin);

if (process.argv.includes("--write")) {
  await writeFile(manifestFile, `${JSON.stringify(actual, null, 2)}\n`);
  console.log(`wrote ${path.relative(root, manifestFile)}`);
  process.exit(0);
}

const expected = JSON.parse(await readFile(manifestFile, "utf8"));
if (expected.pin !== vendor.pin)
  throw new Error(
    `integrity pin mismatch: manifest=${expected.pin} vendor=${vendor.pin}`,
  );
if (JSON.stringify(expected.files) !== JSON.stringify(actual.files))
  throw new Error(
    "vendored modules differ from sync-modules-integrity.json; re-vendor and update the manifest",
  );
console.log(`vendored modules match pin ${vendor.pin}`);
