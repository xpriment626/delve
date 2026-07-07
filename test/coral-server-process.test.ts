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

test("runtime Coral config uses absolute agent paths without persisted proxy settings", () => {
  const projectRoot = "/tmp/delve-project";
  const config = buildRuntimeCoralConfig(projectRoot);

  assert.doesNotMatch(config, /coral-secret/);
  assert.doesNotMatch(config, /\[cloud\]/);
  assert.doesNotMatch(config, /\[llm-proxy\.providers\.openai\]/);
  assert.doesNotMatch(config, /baseUrl = "https:\/\/llm\.coralcloud\.ai\/deepseek\/v1"/);
  assert.doesNotMatch(config, /models = /);
  assert.doesNotMatch(config, /allowAnyModel/);
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
    const configPath = await writeRuntimeCoralConfig(projectRoot, {
      CORAL_API_KEY: "coral-secret",
      DELVE_HOME: dir
    });
    const env = buildCoralServerEnv(projectRoot, {
      CORAL_API_KEY: "coral-secret",
      CLOUD_API_KEY: ""
    }, configPath);

    assert.equal(env.CONFIG_FILE_PATH, path.join(dir, "coral-config.runtime.toml"));
    assert.equal(env.CLOUD_API_KEY, "coral-secret");
    assert.equal(env.DELVE_NODE_BIN, process.execPath);
    const configText = await readFile(configPath, "utf8");
    assert.match(configText, /runtime-agents\/deepseek-v4-pro\/latency-researcher/);
    assert.doesNotMatch(configText, /\[llm-proxy\.providers\.openai\]/);
    const manifest = await readFile(path.join(dir, "runtime-agents", "deepseek-v4-pro", "latency-researcher", "coral-agent.toml"), "utf8");
    assert.match(manifest, /MODEL_NAME = \{ type = "string", default = "deepseek-v4-pro" \}/);
    assert.match(manifest, /model = "deepseek-v4-pro"/);
    const startup = await readFile(path.join(dir, "runtime-agents", "deepseek-v4-pro", "latency-researcher", "startup.sh"), "utf8");
    assert.match(startup, /cd '\/tmp\/delve-project'/);
    assert.match(startup, /DELVE_NODE_BIN:-node/);
    assert.match(startup, /exec "\$node_bin" dist\/src\/eve-coral-agent\.js/);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.doesNotMatch(configText, /coral-secret/);
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
