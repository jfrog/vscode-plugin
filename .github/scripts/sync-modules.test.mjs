import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { syncPaths } from "./sync-modules.mjs";

function write(root, relative, contents) {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

test("full sync replaces the base tree and restores kept overlay files", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sync-modules-"));
  const upstream = path.join(root, "upstream");
  const destination = path.join(root, "destination");
  write(upstream, "modules/core/overlay.mjs", "base overlay\n");
  write(upstream, "modules/base-only.mjs", "base\n");
  write(destination, "modules/core/overlay.mjs", "reviewed overlay\n");
  write(destination, "modules/unrelated-new.mjs", "remove me\n");

  await syncPaths({
    fromDir: upstream,
    toDir: destination,
    paths: ["modules"],
    keep: ["modules/core/overlay.mjs"],
    log: () => {},
  });

  assert.equal(
    readFileSync(
      path.join(destination, "modules/core/overlay.mjs"),
      "utf8",
    ),
    "reviewed overlay\n",
  );
  assert.equal(
    readFileSync(path.join(destination, "modules/base-only.mjs"), "utf8"),
    "base\n",
  );
  assert.throws(() =>
    readFileSync(path.join(destination, "modules/unrelated-new.mjs")),
  );
});

test("restores kept overlays when a later sync path fails", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "sync-modules-failure-"));
  const upstream = path.join(root, "upstream");
  const destination = path.join(root, "destination");
  write(upstream, "modules/core/overlay.mjs", "base overlay\n");
  write(destination, "modules/core/overlay.mjs", "reviewed overlay\n");

  await assert.rejects(
    syncPaths({
      fromDir: upstream,
      toDir: destination,
      paths: ["modules", "missing"],
      keep: ["modules/core/overlay.mjs"],
      log: () => {},
    }),
    /path missing in upstream: missing/,
  );

  assert.equal(
    readFileSync(
      path.join(destination, "modules/core/overlay.mjs"),
      "utf8",
    ),
    "reviewed overlay\n",
  );
});
