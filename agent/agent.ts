import { defineAgent } from "eve";

export default defineAgent({
  model: process.env.EVE_MODEL ?? "openai/deepseek-v4-pro",
  reasoning: "low"
});
