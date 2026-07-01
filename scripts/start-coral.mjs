#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: path.join(root, ".env"), quiet: true });
loadEnv({ quiet: true });

const env = {
  ...process.env,
  CONFIG_FILE_PATH: path.join(root, "coral-config.toml")
};

if (!env.CLOUD_API_KEY && env.CORAL_API_KEY) {
  env.CLOUD_API_KEY = env.CORAL_API_KEY;
}

const child = spawn("npx", ["-y", "coralos-dev@latest", "server", "start"], {
  cwd: root,
  env,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
