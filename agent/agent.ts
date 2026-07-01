import { defineAgent } from "eve";

export default defineAgent({
  model: process.env.EVE_MODEL ?? "openai/gpt-5.4-nano",
  reasoning: "low"
});
