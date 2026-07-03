import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { listModels } from "../src/model-config.ts";
import { chooseModelRoute, DEFAULT_CORAL_PROXY_MODEL, redactSecretStatus, resolveConfiguredModel } from "../src/model-routing.ts";

test("model routing uses Coral LLM proxy with configurable deepseek default", () => {
  assert.equal(DEFAULT_CORAL_PROXY_MODEL, "deepseek-v4-pro");
  assert.equal(resolveConfiguredModel({}), "deepseek-v4-pro");
  assert.equal(resolveConfiguredModel({ DELVE_MODEL: "claude-sonnet-4-0" }), "claude-sonnet-4-0");

  assert.deepEqual(
    chooseModelRoute({
      coralProxyReady: true,
      coralApiKeyPresent: true,
      configuredModel: "deepseek-v4-pro"
    }),
    {
      provider: "coral",
      model: "deepseek-v4-pro",
      baseUrl: "https://llm.coralcloud.ai/deepseek/v1",
      reason: "coral_cloud_llm_proxy"
    }
  );

  assert.deepEqual(
    chooseModelRoute({
      coralProxyReady: false,
      coralApiKeyPresent: true,
      configuredModel: "deepseek-v4-pro"
    }),
    {
      provider: "coral",
      model: "deepseek-v4-pro",
      baseUrl: "https://llm.coralcloud.ai/deepseek/v1",
      reason: "coral_cloud_llm_proxy"
    }
  );
});

test("doctor status reports secret presence without leaking values", () => {
  assert.deepEqual(redactSecretStatus("abc123"), { present: true, source: "env" });
  assert.deepEqual(redactSecretStatus(""), { present: false, source: "missing" });
  assert.deepEqual(redactSecretStatus(undefined), { present: false, source: "missing" });
});

test("model list reads an OpenAI-compatible Coral proxy model endpoint", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/llm-proxy/secret/openai/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "deepseek-v4-pro" }, { id: "gpt-5.4-nano" }] }));
      return;
    }
    response.statusCode = 404;
    response.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const proxyUrl = `http://127.0.0.1:${address?.port}/llm-proxy/secret/openai/v1`;
    const result = await listModels({
      env: { DELVE_MODEL: "deepseek-v4-pro" },
      proxyUrl
    });

    assert.equal(result.source, "proxy");
    assert.equal(result.proxyUrl, proxyUrl);
    assert.equal(result.selectedModel, "deepseek-v4-pro");
    assert.deepEqual(result.models, ["deepseek-v4-pro", "gpt-5.4-nano"]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
