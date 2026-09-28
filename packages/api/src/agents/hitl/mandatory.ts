import { Constants, normalizeServerName, extractEnvVariable } from 'librechat-data-provider';
import type { HookCallback } from '@librechat/agents';

/** Match literal tool names with only '*' as a wildcard, without regex backtracking. */
function matchesGlob(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let retry = 0;
  while (v < value.length) {
    if (pattern[p] === '*') {
      star = p++;
      retry = v;
    } else if (p < pattern.length && pattern[p] === value[v]) {
      p++;
      v++;
    } else if (star >= 0) {
      p = star + 1;
      v = ++retry;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

export interface MandatoryApproval {
  enabled: boolean;
  matches: (name: string) => boolean;
  isProgrammaticBridge: (name: string) => boolean;
  hook: HookCallback<'PreToolUse'>;
}

export interface ApprovalServer {
  url?: string;
  requireToolApproval?: ReadonlyArray<string | undefined>;
}
export type ApprovalServers = Record<string, ApprovalServer | undefined> | null | undefined;

/** Treat alternate URL spellings and query strings as the same protected HTTP endpoint. */
function endpointKey(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(extractEnvVariable(url));
    if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
    const path = decodeURIComponent(parsed.pathname).replace(/\/+$/, '') || '/';
    return `${parsed.origin}${path}`;
  } catch {
    return undefined;
  }
}

/** Personal aliases must not strip the administrator's write gate from an internal endpoint. */
export function isProtectedMCPAlias({
  serverName,
  serverConfig,
  adminServers,
  userSourced,
}: {
  serverName: string;
  serverConfig: ApprovalServer | undefined;
  adminServers: ApprovalServers;
  userSourced: boolean;
}): boolean {
  const endpoint = endpointKey(serverConfig?.url);
  if (!endpoint) {
    // The caller resolves custom variables first. An unresolved personal target cannot
    // be proved distinct from a protected endpoint, so do not defer it to a cached URL.
    return (
      userSourced &&
      !!serverConfig?.url &&
      Object.values(adminServers ?? {}).some((server) => !!server?.requireToolApproval?.length)
    );
  }
  const protectedEndpoint = Object.values(adminServers ?? {}).some(
    (server) => server?.requireToolApproval?.length && endpointKey(server.url) === endpoint,
  );
  if (!protectedEndpoint) return false;
  const managedEndpoint = endpointKey(adminServers?.[serverName]?.url);
  return userSourced || managedEndpoint !== endpoint;
}

/** Only administrator-resolved MCP config is accepted; request/agent settings never grant approval. */
export function buildMandatoryApproval(
  servers: ApprovalServers,
  hitlCapable: boolean,
): MandatoryApproval {
  const entries = Object.entries(servers ?? {});
  const rules = entries.flatMap(([server, config]) => {
    const endpoint = endpointKey(config?.url);
    // Administrator-managed aliases inherit the union; policy cannot be lost through renaming.
    const patterns = entries.flatMap(([name, candidate]) =>
      name === server || (endpoint && endpointKey(candidate?.url) === endpoint)
        ? (candidate?.requireToolApproval ?? [])
        : [],
    );
    return patterns.map((pattern) => {
      if (typeof pattern !== 'string' || !pattern.trim()) {
        throw new Error('Ungültige verpflichtende Werkzeugfreigabe in der Serverkonfiguration.');
      }
      return {
        suffix: `${Constants.mcp_delimiter}${normalizeServerName(server)}`,
        rawSuffix: `${Constants.mcp_delimiter}${server}`,
        pattern,
      };
    });
  });
  // Test every suffix: ambiguous server/tool delimiters may tighten policy, never bypass it.
  const matches = (name: string) =>
    rules.some(({ suffix, rawSuffix, pattern }) =>
      [suffix, rawSuffix].some(
        (ending) => name.endsWith(ending) && matchesGlob(pattern, name.slice(0, -ending.length)),
      ),
    );
  const isProgrammaticBridge = (name: string) =>
    name === Constants.PROGRAMMATIC_TOOL_CALLING ||
    name === Constants.BASH_PROGRAMMATIC_TOOL_CALLING;
  const hook: HookCallback<'PreToolUse'> = async (input) => {
    if (rules.length && isProgrammaticBridge(input.toolName)) {
      return {
        decision: 'deny',
        reason:
          'Dieser Sammelaufruf kann die erforderliche Einzelfreigabe nicht anzeigen. Bitte das Werkzeug direkt aufrufen.',
      };
    }
    if (!matches(input.toolName)) return {};
    if (!hitlCapable || input.agentId != null) {
      return {
        decision: 'deny',
        reason:
          'Dieses Werkzeug benötigt eine ausdrückliche Freigabe im Webchat. API- und Unteragenten-Aufrufe sind gesperrt.',
      };
    }
    return {
      decision: 'ask',
      reason: 'Bitte Ziel und Änderungen prüfen. Jede Ausführung benötigt eine neue Freigabe.',
      allowedDecisions: ['approve', 'reject', 'edit'],
    };
  };
  return { enabled: rules.length > 0, matches, isProgrammaticBridge, hook };
}
