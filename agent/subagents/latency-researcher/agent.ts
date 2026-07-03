import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Research performance, latency, bottlenecks, sequencing, throughput, and time-to-value constraints for the assigned topic.",
  model: process.env.EVE_MODEL ?? "openai/deepseek-v4-pro",
  reasoning: "low"
});
