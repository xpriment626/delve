import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Research systems architecture, implementation, integration, observability, deployment, reliability, and operational tradeoffs for the assigned topic.",
  model: process.env.EVE_MODEL ?? "openai/deepseek-v4-pro",
  reasoning: "low"
});
