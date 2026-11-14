import type { ToolDefinition } from "./registry";
import { taskTools } from "./tasks";
import { noteTools, projectTools } from "./notes";
import { memoryTools } from "./memories";
import { reminderTools } from "./reminders";
import { searchTools } from "./search";
import { proactiveTools } from "./proactive";
import { contextTools } from "./context";

/**
 * Every tool available to the agent. To add a capability, create a module with
 * `defineTool(...)` entries and add it here. Tools may only touch the owner's
 * own data through the service layer: no shell, code execution, credentials or
 * arbitrary network access. The one exception, reading public web pages (browse_page), lives in
 * src/browsing with its own URL guard and daily cap, and is appended by the agent like the
 * connector tools.
 */
export const ALL_TOOLS: ToolDefinition[] = [
  ...taskTools,
  ...noteTools,
  ...projectTools,
  ...memoryTools,
  ...reminderTools,
  ...searchTools,
  ...proactiveTools,
  ...contextTools,
] as ToolDefinition[];

const names = new Set<string>();
for (const t of ALL_TOOLS) {
  if (names.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
  names.add(t.name);
}

export { runApprovedAction, ToolExecutor, ToolError, type ToolContext, type ToolDefinition } from "./registry";
