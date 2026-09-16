import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAtom } from 'jotai';
import isEqual from 'lodash/isEqual';
import { useRecoilState } from 'recoil';
import { Constants, LocalStorageKeys } from 'librechat-data-provider';
import type { MCPServerDefinition } from './useMCPServerManager';
import { ephemeralAgentByConvoId, mcpValuesAtomFamily, mcpPinnedAtom } from '~/store';
import { useGetStartupConfig } from '~/data-provider';
import { setTimestamp } from '~/utils/timestamps';

/** Sentinel in `interface.defaultPinnedTools` that pins the MCP dropdown to the prompt bar. */
const MCP_PIN_KEYWORD = 'mcp';

export function useMCPSelect({
  conversationId,
  storageContextKey,
  servers,
  serversLoaded = true,
}: {
  conversationId?: string | null;
  storageContextKey?: string;
  servers: MCPServerDefinition[];
  serversLoaded?: boolean;
}) {
  const key = conversationId ?? Constants.NEW_CONVO;
  const configuredServers = useMemo(() => {
    return new Set(servers?.map((s) => s.serverName));
  }, [servers]);

  /**
   * For new conversations, key the MCP atom by environment (spec or defaults)
   * so switching between spec ↔ non-spec gives each its own atom.
   * For existing conversations, key by conversation ID for per-conversation isolation.
   */
  const isNewConvo = key === Constants.NEW_CONVO;
  const mcpAtomKey = isNewConvo && storageContextKey ? storageContextKey : key;

  const { data: startupConfig } = useGetStartupConfig();
  const [isPinned, setIsPinned] = useAtom(mcpPinnedAtom);
  const [mcpValues, setMCPValuesRaw] = useAtom(mcpValuesAtomFamily(mcpAtomKey));
  const [ephemeralAgent, setEphemeralAgent] = useRecoilState(ephemeralAgentByConvoId(key));
  const hasAppliedDefaultPin = useRef(false);

  /**
   * Seed the MCP dropdown's pinned state from the admin-configured `defaultPinnedTools`:
   * pin when the array includes the `'mcp'` keyword or any configured server name.
   * Only applies on first load when the user has no stored preference; when the option
   * is absent entirely, the legacy default (pinned) is kept.
   */
  useEffect(() => {
    if (hasAppliedDefaultPin.current || !startupConfig) {
      return;
    }
    const defaultPinnedTools = startupConfig.interface?.defaultPinnedTools;
    if (!Array.isArray(defaultPinnedTools)) {
      hasAppliedDefaultPin.current = true;
      return;
    }
    if (localStorage.getItem(LocalStorageKeys.PIN_MCP_) != null) {
      hasAppliedDefaultPin.current = true;
      return;
    }
    const pinnedByKeyword = defaultPinnedTools.includes(MCP_PIN_KEYWORD);
    /** Wait for servers before deciding so a configured server name isn't missed. */
    if (!pinnedByKeyword && !serversLoaded) {
      return;
    }
    hasAppliedDefaultPin.current = true;
    const shouldPin =
      pinnedByKeyword || servers.some((server) => defaultPinnedTools.includes(server.serverName));
    if (shouldPin !== isPinned) {
      setIsPinned(shouldPin);
    }
  }, [startupConfig, servers, serversLoaded, isPinned, setIsPinned]);

  /** A loaded empty list revokes every server; an initial pending list must preserve selections. */
  useEffect(() => {
    if (!serversLoaded) {
      return;
    }
    const mcps = ephemeralAgent?.mcp;
    const sourceMcps = Array.isArray(mcps) ? mcps : mcpValues;
    const activeMcps = sourceMcps.filter((mcp) => configuredServers.has(mcp));
    if (!isEqual(activeMcps, mcpValues)) {
      setMCPValuesRaw(activeMcps);
    }
    if (Array.isArray(mcps) && !isEqual(activeMcps, mcps)) {
      setEphemeralAgent((prev) => {
        if (!Array.isArray(prev?.mcp)) {
          return prev;
        }
        const allowedMcps = prev.mcp.filter((mcp) => configuredServers.has(mcp));
        return isEqual(allowedMcps, prev.mcp) ? prev : { ...prev, mcp: allowedMcps };
      });
    }
  }, [
    ephemeralAgent?.mcp,
    setMCPValuesRaw,
    setEphemeralAgent,
    configuredServers,
    serversLoaded,
    mcpValues,
  ]);

  const availableValues = useMemo(
    () => (serversLoaded ? mcpValues.filter((mcp) => configuredServers.has(mcp)) : mcpValues),
    [mcpValues, configuredServers, serversLoaded],
  );

  // Write timestamp when MCP values change
  useEffect(() => {
    const mcpStorageKey = `${LocalStorageKeys.LAST_MCP_}${mcpAtomKey}`;
    if (mcpValues.length > 0) {
      setTimestamp(mcpStorageKey);
    }
  }, [mcpValues, mcpAtomKey]);

  /** Stable memoized setter with dual-write to environment key */
  const setMCPValues = useCallback(
    (value: string[]) => {
      if (!Array.isArray(value)) {
        return;
      }
      const activeValues = serversLoaded
        ? value.filter((mcp) => configuredServers.has(mcp))
        : value;
      setMCPValuesRaw(activeValues);
      setEphemeralAgent((prev) => {
        if (!isEqual(prev?.mcp, activeValues)) {
          return { ...(prev ?? {}), mcp: activeValues };
        }
        return prev;
      });
      // Dual-write to environment key for new conversation defaults
      if (storageContextKey) {
        const envKey = `${LocalStorageKeys.LAST_MCP_}${storageContextKey}`;
        localStorage.setItem(envKey, JSON.stringify(activeValues));
        setTimestamp(envKey);
      }
    },
    [setMCPValuesRaw, setEphemeralAgent, storageContextKey, configuredServers, serversLoaded],
  );

  return {
    isPinned,
    mcpValues: availableValues,
    setIsPinned,
    setMCPValues,
  };
}
