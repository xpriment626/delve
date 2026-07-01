import { defineTool } from "eve/tools";
import { z } from "zod";

import { Blackboard, createBlackboardTools } from "../../src/blackboard.js";

const sourceSchema = z.object({
  title: z.string().min(1),
  url: z.string().url(),
  domain: z.string().optional(),
  publisher: z.string().optional(),
  publishedAt: z.string().optional(),
  retrievedAt: z.string().optional(),
  excerpt: z.string().optional(),
  summary: z.string().optional(),
  relevance: z.string().optional(),
  reliability: z.string().optional()
});

export default defineTool({
  description:
    "Write a bounded research note to the app-owned SQLite blackboard. Use this for durable notes and sources, not Coral thread history.",
  inputSchema: z.object({
    runId: z.string().min(1),
    agentName: z.string().min(1),
    angle: z.string().min(1),
    content: z.string().min(1),
    sources: z.array(sourceSchema)
  }),
  execute(input) {
    const db = new Blackboard(process.env.BLACKBOARD_DB_PATH ?? ".delve/blackboard.db");
    return createBlackboardTools(db).writeNote(input);
  }
});
