import assert from "node:assert/strict";
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const supervisorSource = join(repositoryRoot, "scripts/dev-services.sh");

test("development service supervisor is valid POSIX shell", () => {
  const checked = spawnSync("sh", ["-n", supervisorSource], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
});

test("development service supervisor force-stops TERM-resistant children", { timeout: 5000 }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), "deeix-dev-services-"));
  const scripts = join(fixture, "scripts");
  mkdirSync(scripts);
  copyFileSync(supervisorSource, join(scripts, "dev-services.sh"));
  const resistantService = '#!/bin/sh\nexec node -e "process.on(\\"SIGTERM\\",()=>{});setInterval(()=>{},1000)"\n';
  for (const name of ["dev-api.sh", "dev-web.sh"]) {
    const target = join(scripts, name);
    writeFileSync(target, resistantService);
    chmodSync(target, 0o755);
  }

  try {
    const child = spawn("sh", [join(scripts, "dev-services.sh")], {
      env: { ...process.env, DEEIX_DEV_SHUTDOWN_GRACE_SECONDS: "1" },
      stdio: "ignore",
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const startedAt = Date.now();
    child.kill("SIGTERM");
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    assert.ok(Date.now() - startedAt < 2500, "supervisor cleanup exceeded its grace period");
    assert.equal(result.signal, null);
    assert.equal(result.code, 143);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
