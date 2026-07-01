import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Research systems architecture, implementation, integration, observability, deployment, reliability, and operational tradeoffs for the assigned topic.",
  model: process.env.EVE_MODEL ?? "openai/gpt-5.4-nano",
  reasoning: "low"
});
