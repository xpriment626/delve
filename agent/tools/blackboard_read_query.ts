import { defineTool } from "eve/tools";
import { z } from "zod";

import { Blackboard, createBlackboardTools } from "../../src/blackboard.js";

export default defineTool({
  description:
    "Run a safe blackboard read. Only single SELECT statements are allowed, and the run id is bound to the first positional placeholder when present.",
  inputSchema: z.object({
    runId: z.string().min(1),
    sql: z.string().min(1)
  }),
  execute(input) {
    const db = new Blackboard(process.env.BLACKBOARD_DB_PATH ?? ".delve/blackboard.db");
    return createBlackboardTools(db).readOnlyQuery(input);
  }
});
