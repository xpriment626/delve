import assert from "node:assert/strict";
import test from "node:test";

import { chooseModelRoute, redactSecretStatus } from "../src/model-routing.ts";

test("model routing prefers Coral LLM proxy and falls back to OpenRouter deepseek slug", () => {
  assert.deepEqual(
    chooseModelRoute({
      coralProxyReady: true,
      coralApiKeyPresent: true,
      openRouterApiKeyPresent: true
    }),
    {
      provider: "coral",
      model: "gpt-5.4-nano",
      baseUrl: "coral-llm-proxy",
      reason: "coral_proxy_ready"
    }
  );

  assert.deepEqual(
    chooseModelRoute({
      coralProxyReady: false,
      coralApiKeyPresent: true,
      openRouterApiKeyPresent: true
    }),
    {
      provider: "openrouter",
      model: "deepseek/deepseek-v4-pro",
      baseUrl: "https://openrouter.ai/api/v1",
      reason: "coral_proxy_unavailable"
    }
  );
});

test("doctor status reports secret presence without leaking values", () => {
  assert.deepEqual(redactSecretStatus("abc123"), { present: true, source: "env" });
  assert.deepEqual(redactSecretStatus(""), { present: false, source: "missing" });
  assert.deepEqual(redactSecretStatus(undefined), { present: false, source: "missing" });
});
