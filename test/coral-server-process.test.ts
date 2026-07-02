import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCoralServerEnv,
  buildCoralServerStartArgs,
  buildRuntimeCoralConfig,
  canAutoStartCoralUrl,
  writeRuntimeCoralConfig
} from "../src/coral-server-process.ts";

test("Coral auto-start is limited to the packaged local server URL", () => {
  assert.equal(canAutoStartCoralUrl("http://localhost:5555"), true);
  assert.equal(canAutoStartCoralUrl("http://127.0.0.1:5555"), true);
  assert.equal(canAutoStartCoralUrl("http://localhost:5556"), true);
  assert.equal(canAutoStartCoralUrl("http://localhost"), false);
  assert.equal(canAutoStartCoralUrl("https://coral.example.com"), false);
  assert.equal(canAutoStartCoralUrl("not a url"), false);
});

test("Coral auto-start forwards explicit alternate loopback ports", () => {
  assert.deepEqual(buildCoralServerStartArgs("http://localhost:5555"), [
    "-y",
    "coralos-dev@latest",
    "server",
    "start"
  ]);
  assert.deepEqual(buildCoralServerStartArgs("http://localhost:5556"), [
    "-y",
    "coralos-dev@latest",
    "server",
    "start",
    "--",
    "--network.bind-port=5556"
  ]);
});

test("runtime Coral config uses absolute packaged agent paths", () => {
  const projectRoot = "/tmp/delve-project";
  const config = buildRuntimeCoralConfig(projectRoot);

  assert.match(config, /\[registry\]/);
  assert.match(config, /"\/tmp\/delve-project\/agents\/latency-researcher"/);
  assert.match(config, /"\/tmp\/delve-project\/agents\/systems-researcher"/);
  assert.match(config, /"\/tmp\/delve-project\/agents\/quality-researcher"/);
  assert.doesNotMatch(config, /"agents\//);
});

test("Coral server env points at generated runtime config and maps Coral API key for Cloud proxy", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "delve-coral-config-"));
  const projectRoot = "/tmp/delve-project";
  try {
    const configPath = await writeRuntimeCoralConfig(projectRoot, { DELVE_HOME: dir });
    const env = buildCoralServerEnv(projectRoot, {
      CORAL_API_KEY: "coral-secret",
      CLOUD_API_KEY: ""
    }, configPath);

    assert.equal(env.CONFIG_FILE_PATH, path.join(dir, "coral-config.runtime.toml"));
    assert.equal(env.CLOUD_API_KEY, "coral-secret");
    assert.match(await readFile(configPath, "utf8"), /"\/tmp\/delve-project\/agents\/latency-researcher"/);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("existing Cloud API key is preserved when starting Coral", () => {
  const env = buildCoralServerEnv("/tmp/delve-project", {
    CORAL_API_KEY: "coral-secret",
    CLOUD_API_KEY: "cloud-secret"
  });

  assert.equal(env.CLOUD_API_KEY, "cloud-secret");
});
