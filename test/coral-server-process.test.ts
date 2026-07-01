import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildCoralServerEnv, buildCoralServerStartArgs, canAutoStartCoralUrl } from "../src/coral-server-process.ts";

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

test("Coral server env points at repo config and maps Coral API key for Cloud proxy", () => {
  const projectRoot = "/tmp/delve-project";
  const env = buildCoralServerEnv(projectRoot, {
    CORAL_API_KEY: "coral-secret",
    CLOUD_API_KEY: ""
  });

  assert.equal(env.CONFIG_FILE_PATH, path.join(projectRoot, "coral-config.toml"));
  assert.equal(env.CLOUD_API_KEY, "coral-secret");
});

test("existing Cloud API key is preserved when starting Coral", () => {
  const env = buildCoralServerEnv("/tmp/delve-project", {
    CORAL_API_KEY: "coral-secret",
    CLOUD_API_KEY: "cloud-secret"
  });

  assert.equal(env.CLOUD_API_KEY, "cloud-secret");
});
