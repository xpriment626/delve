import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Research quality, evaluation, robustness, user or stakeholder impact, safety, and risk tradeoffs for the assigned topic.",
  model: process.env.EVE_MODEL ?? "openai/gpt-5.4-nano",
  reasoning: "low"
});
