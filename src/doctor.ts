import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

import { chooseModelRoute, redactSecretStatus } from "./model-routing.js";

export interface DoctorOptions {
  coralUrl: string;
  dbPath: string;
  projectRoot: string;
  env: NodeJS.ProcessEnv;
}

export interface DoctorReport {
  ok: boolean;
  env: {
    CORAL_API_KEY: ReturnType<typeof redactSecretStatus>;
    OPENROUTER_API_KEY: ReturnType<typeof redactSecretStatus>;
    EXA_API_KEY: ReturnType<typeof redactSecretStatus>;
  };
  coral: {
    reachable: boolean;
    url: string;
    schemaUrl: string;
    error?: string;
  };
  exa: {
    configured: boolean;
    mcpUrl: string;
    tools: string[];
  };
  sqlite: {
    path: string;
    mode: "configured";
  };
  tooling: {
    node: string;
    latex: {
      optional: true;
      available: boolean;
      commands: {
        tectonic: boolean;
        pdflatex: boolean;
        latexmk: boolean;
      };
    };
  };
  agents: {
    configPath: string;
    expected: string[];
    manifestsPresent: boolean;
  };
  model: ReturnType<typeof chooseModelRoute>;
}

export async function createDoctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const schemaUrl = new URL("/api_v1.json", ensureTrailingSlash(options.coralUrl)).toString();
  const coral = await probeCoral(schemaUrl);
  const expected = ["latency-researcher", "systems-researcher", "quality-researcher"];
  const configPath = path.join(options.projectRoot, "coral-config.toml");
  const manifestsPresent = await allPresent(
    expected.map((agentName) => path.join(options.projectRoot, "agents", agentName, "coral-agent.toml"))
  );
  const env = {
    CORAL_API_KEY: redactSecretStatus(options.env.CORAL_API_KEY),
    OPENROUTER_API_KEY: redactSecretStatus(options.env.OPENROUTER_API_KEY),
    EXA_API_KEY: redactSecretStatus(options.env.EXA_API_KEY)
  };
  const model = chooseModelRoute({
    coralProxyReady: coral.reachable,
    coralApiKeyPresent: env.CORAL_API_KEY.present,
    openRouterApiKeyPresent: env.OPENROUTER_API_KEY.present
  });
  const latexCommands = {
    tectonic: await commandExists("tectonic"),
    pdflatex: await commandExists("pdflatex"),
    latexmk: await commandExists("latexmk")
  };
  const modelConfigured = env.CORAL_API_KEY.present || env.OPENROUTER_API_KEY.present;

  return {
    ok: env.EXA_API_KEY.present && modelConfigured && manifestsPresent,
    env,
    coral: {
      reachable: coral.reachable,
      url: options.coralUrl,
      schemaUrl,
      ...(coral.error ? { error: coral.error } : {})
    },
    exa: {
      configured: env.EXA_API_KEY.present,
      mcpUrl: "https://mcp.exa.ai/mcp",
      tools: ["web_search_exa", "web_search_advanced_exa", "web_fetch_exa"]
    },
    sqlite: {
      path: options.dbPath,
      mode: "configured"
    },
    tooling: {
      node: process.version,
      latex: {
        optional: true,
        available: latexCommands.tectonic || latexCommands.pdflatex || latexCommands.latexmk,
        commands: latexCommands
      }
    },
    agents: {
      configPath,
      expected,
      manifestsPresent
    },
    model
  };
}

async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function probeCoral(schemaUrl: string): Promise<{ reachable: boolean; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(schemaUrl, { signal: controller.signal });
    if (!response.ok) return { reachable: false, error: `http_${response.status}` };
    await response.arrayBuffer();
    return { reachable: true };
  } catch (error) {
    return { reachable: false, error: error instanceof Error ? error.message : "unknown_error" };
  } finally {
    clearTimeout(timeout);
  }
}

async function allPresent(files: string[]): Promise<boolean> {
  const checks = await Promise.all(
    files.map(async (file) => {
      try {
        await access(file);
        return true;
      } catch {
        return false;
      }
    })
  );
  return checks.every(Boolean);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
