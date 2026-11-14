import { selectRelevantMemories } from "../agent/memory";
import type { Env } from "../env";
import type { RunnerExtensions } from "../semantic/hooks";
import type { Services } from "../services/container";
import { ALL_TOOLS, type ToolDefinition } from "../tools";
import type { QuickActionBinding } from "./engine";
import { browsingTools } from "./tools";

export { browse, BrowseFailedError, type BrowseDeps, type QuickActionBinding } from "./engine";
export { BROWSE_TOOL, browsingTools } from "./tools";
export { BlockedUrlError, checkPublicUrl } from "./url-guard";
export { browsingUsageToday, recordBrowsing } from "./usage";

/** The Browser Run binding when the Worker has one (`"browser": { "binding": "BROWSER" }`). */
export function browserBinding(env: Env): QuickActionBinding | null {
  const b = env.BROWSER as unknown as Partial<QuickActionBinding> | undefined;
  return b && typeof b.quickAction === "function" ? (b as QuickActionBinding) : null;
}

/**
 * Runner extensions with `browse_page` appended to whatever tool set came before (semantic,
 * connectors or upstream), and the prompt told the agent can read web pages. The tool is listed
 * while the owner's setting is on; with the setting off, the extensions pass through unchanged.
 */
export function withBrowsing(ext: RunnerExtensions | undefined, services: Services, env: Env): RunnerExtensions | undefined {
  try {
    if (!services.settings.get().browsing.enabled) return ext;
  } catch {
    return ext;
  }
  const tools: ToolDefinition[] = browsingTools({ browser: browserBinding(env) });
  return {
    selectMemories: ext?.selectMemories ?? (async (query) => selectRelevantMemories(services.memories, query)),
    tools: [...(ext?.tools ?? ALL_TOOLS), ...tools],
    ...(ext?.connectors ? { connectors: true } : {}),
    browsing: true,
  };
}
