import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Research performance, latency, bottlenecks, sequencing, throughput, and time-to-value constraints for the assigned topic.",
  model: process.env.EVE_MODEL ?? "openai/gpt-5.4-nano",
  reasoning: "low"
});
