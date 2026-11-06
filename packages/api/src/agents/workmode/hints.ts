import { Constants, normalizeServerName } from 'librechat-data-provider';
import type { ToolRiskHints } from 'librechat-data-provider';

/** The fields of an MCP `tools/list` entry that carry risk annotations. */
export interface AnnotatedTool {
  name: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

/** Upper bound so a server with thousands of tools cannot grow the map without limit. */
const MAX_HINT_ENTRIES = 5000;

/**
 * MCP risk annotations by model-facing tool name, recorded whenever a connection
 * lists its tools. Keyed per user for user-scoped connections so one person's
 * server can never relabel another person's tools; app-level connections use the
 * empty user key and serve as the fallback.
 */
const hintStore = new Map<string, ToolRiskHints>();

function hintKey(toolName: string, userId?: string): string {
  return `${userId ?? ''}\u0000${toolName}`;
}

function pickHints(tool: AnnotatedTool): ToolRiskHints | undefined {
  const readOnlyHint = tool.annotations?.readOnlyHint;
  const destructiveHint = tool.annotations?.destructiveHint;
  const hasReadOnly = typeof readOnlyHint === 'boolean';
  const hasDestructive = typeof destructiveHint === 'boolean';
  if (!hasReadOnly && !hasDestructive) {
    return undefined;
  }
  return {
    ...(hasReadOnly ? { readOnlyHint } : {}),
    ...(hasDestructive ? { destructiveHint } : {}),
  };
}

/** Records the annotations of one `tools/list` page; tools without annotations clear stale entries. */
export function recordToolHints(
  serverName: string,
  tools: ReadonlyArray<AnnotatedTool>,
  userId?: string,
): void {
  const suffix = `${Constants.mcp_delimiter}${normalizeServerName(serverName)}`;
  for (const tool of tools) {
    if (typeof tool?.name !== 'string' || tool.name.length === 0) {
      continue;
    }
    const key = hintKey(`${tool.name}${suffix}`, userId);
    hintStore.delete(key);
    const hints = pickHints(tool);
    if (hints == null) {
      continue;
    }
    hintStore.set(key, hints);
    if (hintStore.size > MAX_HINT_ENTRIES) {
      const oldest = hintStore.keys().next().value;
      if (oldest != null) {
        hintStore.delete(oldest);
      }
    }
  }
}

/** Annotations for a model-facing tool name: the user's own connection first, then the app-level one. */
export function getToolHints(toolName: string, userId?: string): ToolRiskHints | undefined {
  if (userId != null && userId !== '') {
    const own = hintStore.get(hintKey(toolName, userId));
    if (own != null) {
      return own;
    }
  }
  return hintStore.get(hintKey(toolName));
}

/** Test/teardown helper. */
export function clearToolHints(): void {
  hintStore.clear();
}
