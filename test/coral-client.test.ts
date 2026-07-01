import assert from "node:assert/strict";
import test from "node:test";

import { agentsReady, buildLocalSessionRequest } from "../src/coral-client.ts";

test("buildLocalSessionRequest creates executable local Coral agents with blackboard options", () => {
  const payload = buildLocalSessionRequest({
    namespace: "delve-test",
    topic: "optimisation techniques for real-time voice agents",
    dbPath: "/tmp/delve/blackboard.db",
    agents: ["latency-researcher", "systems-researcher"],
    modelName: "gpt-5.4-nano",
    fallbackModel: "deepseek/deepseek-v4-pro",
    ttlMs: 1234,
    holdAfterExitMs: 5678
  }) as {
    agentGraphRequest: {
      agents: Array<{
        name: string;
        provider: { type: string; runtime: string };
        blocking: boolean;
        options: Record<string, { type: string; value: string }>;
      }>;
      groups: string[][];
    };
    namespaceProvider: { namespaceRequest: { name: string } };
    execution: { runtimeSettings: { ttl: number; persistenceMode: { duration: number } } };
  };

  assert.equal(payload.namespaceProvider.namespaceRequest.name, "delve-test");
  assert.deepEqual(payload.agentGraphRequest.groups, [["latency-researcher", "systems-researcher"]]);
  assert.equal(payload.execution.runtimeSettings.ttl, 1234);
  assert.equal(payload.execution.runtimeSettings.persistenceMode.duration, 5678);
  assert.equal(payload.agentGraphRequest.agents[0].provider.type, "local");
  assert.equal(payload.agentGraphRequest.agents[0].provider.runtime, "executable");
  assert.equal(payload.agentGraphRequest.agents[0].blocking, true);
  assert.deepEqual(payload.agentGraphRequest.agents[0].options.BLACKBOARD_DB_PATH, {
    type: "string",
    value: "/tmp/delve/blackboard.db"
  });
  assert.deepEqual(payload.agentGraphRequest.agents[1].options.RESEARCH_ROLE, {
    type: "string",
    value: "systems-researcher"
  });
});

test("buildLocalSessionRequest passes only agent-needed secrets", () => {
  const payload = buildLocalSessionRequest({
    namespace: "delve-test",
    topic: "privacy preserving synthetic customer support data",
    dbPath: "/tmp/delve/blackboard.db",
    agents: ["latency-researcher"],
    modelName: "gpt-5.4-nano",
    fallbackModel: "deepseek/deepseek-v4-pro",
    secrets: {
      openRouterApiKey: "openrouter-secret",
      exaApiKey: "exa-secret"
    }
  }) as {
    agentGraphRequest: {
      agents: Array<{ options: Record<string, { type: string; value: string }> }>;
    };
  };

  const options = payload.agentGraphRequest.agents[0].options;
  assert.equal(options.CORAL_API_KEY, undefined);
  assert.deepEqual(options.OPENROUTER_API_KEY, { type: "string", value: "openrouter-secret" });
  assert.deepEqual(options.EXA_API_KEY, { type: "string", value: "exa-secret" });
});

test("agentsReady accepts only connected waiting agents and rejects partial state", () => {
  const ready = [
    {
      name: "latency-researcher",
      status: {
        type: "running",
        connectionStatus: {
          type: "connected",
          communicationStatus: { type: "waiting_message" }
        }
      }
    },
    {
      name: "systems-researcher",
      status: {
        type: "running",
        connectionStatus: {
          type: "connected",
          communicationStatus: { type: "thinking" }
        }
      }
    }
  ];

  assert.equal(agentsReady(ready, ["latency-researcher", "systems-researcher"]), false);
  assert.equal(agentsReady(ready, ["latency-researcher", "quality-researcher"]), false);

  ready[1].status.connectionStatus.communicationStatus.type = "waiting_message";
  assert.equal(agentsReady(ready, ["latency-researcher", "systems-researcher"]), true);
});
