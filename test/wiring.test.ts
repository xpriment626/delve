import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const AGENTS = ["latency-researcher", "systems-researcher", "quality-researcher"];

test("project Coral config registers local Eve-backed agent manifests", async () => {
  const config = await readFile(path.join(ROOT, "coral-config.toml"), "utf8");
  assert.match(config, /\[auth\]\s+keys = \["dev"\]/);
  assert.match(config, /\[registry\]/);
  for (const agent of AGENTS) {
    assert.match(config, new RegExp(`agents/${agent}`));
    const manifest = await readFile(path.join(ROOT, "agents", agent, "coral-agent.toml"), "utf8");
    assert.match(manifest, /edition = 4/);
    assert.match(manifest, new RegExp(`name = "${agent}"`));
    assert.match(manifest, /models = \["gpt-5\.4-nano"\]/);
    assert.match(manifest, /OPENROUTER_FALLBACK_MODEL = \{ type = "string", default = "deepseek\/deepseek-v4-pro" \}/);
    assert.match(manifest, /\[options\.OPENROUTER_API_KEY\][\s\S]*?secret = true/);
    assert.match(manifest, /\[options\.EXA_API_KEY\][\s\S]*?secret = true/);
    assert.match(manifest, /\[runtimes\.executable\]/);
    assert.match(manifest, /transport = "streamable_http"/);
    assert.match(manifest, /arguments = \["startup\.sh"/);
    const startup = await readFile(path.join(ROOT, "agents", agent, "startup.sh"), "utf8");
    assert.match(startup, /src\/eve-coral-agent\.ts/);
    assert.match(startup, new RegExp(`--role ${agent}`));
  }
});

test("Eve agent files define specialists, safe blackboard tools, and Exa MCP connection", async () => {
  const rootAgent = await readFile(path.join(ROOT, "agent", "agent.ts"), "utf8");
  assert.match(rootAgent, /defineAgent/);
  assert.match(rootAgent, /openai\/gpt-5\.4-nano/);

  const writeNoteTool = await readFile(path.join(ROOT, "agent", "tools", "blackboard_write_note.ts"), "utf8");
  assert.match(writeNoteTool, /defineTool/);
  assert.match(writeNoteTool, /createBlackboardTools/);

  const readQueryTool = await readFile(path.join(ROOT, "agent", "tools", "blackboard_read_query.ts"), "utf8");
  assert.match(readQueryTool, /Only single SELECT statements/);

  const exaConnection = await readFile(path.join(ROOT, "agent", "connections", "exa.ts"), "utf8");
  assert.match(exaConnection, /defineMcpClientConnection/);
  assert.match(exaConnection, /https:\/\/mcp\.exa\.ai\/mcp/);
  assert.match(exaConnection, /EXA_API_KEY/);

  for (const agent of AGENTS) {
    const agentConfig = await readFile(path.join(ROOT, "agent", "subagents", agent, "agent.ts"), "utf8");
    assert.match(agentConfig, /description:/);
    assert.match(agentConfig, /openai\/gpt-5\.4-nano/);
    const instructions = await readFile(path.join(ROOT, "agent", "subagents", agent, "instructions.md"), "utf8");
    assert.match(instructions, /blackboard_write_note/);
    assert.match(instructions, /negotiate/i);
  }
});
