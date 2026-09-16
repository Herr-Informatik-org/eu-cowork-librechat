import { extractEnvVariable } from 'librechat-data-provider';
import type { ParsedServerConfig } from '~/mcp/types';

const ACCESS_TIMEOUT_MS = 3_000;

function gatewayAccessUrl(config: ParsedServerConfig): URL | null {
  if (!('url' in config) || !config.url) {
    return null;
  }
  const hasGatewayIdentity =
    config.source !== 'user' &&
    'headers' in config &&
    Object.entries(config.headers ?? {}).some(
      ([name, value]) =>
        name.toLowerCase() === 'x-eucowork-user-id' && value === '{{LIBRECHAT_USER_ID}}',
    );
  const url = new URL(extractEnvVariable(config.url));
  if (url.hostname !== 'mcp-gateway' && !hasGatewayIdentity) {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Ungültige MCP-Gateway-Adresse');
  }
  const server = url.pathname.split('/')[1];
  if (!server) {
    throw new Error('MCP-Gateway-Server fehlt');
  }
  url.pathname = `/${server}/_eucowork/access`;
  url.search = '';
  url.hash = '';
  return url;
}

/** Consult the gateway's authoritative policy without forwarding upstream credentials. */
export async function canAccessMCPServer(
  config: ParsedServerConfig,
  userId?: string,
): Promise<boolean> {
  if (!userId) {
    return true;
  }
  try {
    const url = gatewayAccessUrl(config);
    if (!url) {
      return true;
    }
    const response = await fetch(url, {
      headers: { 'X-EUCowork-User-Id': userId, Accept: 'application/json' },
      signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS),
      redirect: 'error',
      cache: 'no-store',
    });
    if (!response.ok) {
      await response.body?.cancel();
      return false;
    }
    const result: { allowed?: boolean } | null = await response.json();
    return result?.allowed === true;
  } catch {
    return false;
  }
}

/** Apply policy after config caching so revocation never reuses a cached visibility grant. */
export async function filterAccessibleMCPServers(
  configs: Record<string, ParsedServerConfig>,
  userId?: string,
): Promise<Record<string, ParsedServerConfig>> {
  if (!userId) {
    return configs;
  }
  const accessible = await Promise.all(
    Object.entries(configs).map(async ([name, config]) =>
      (await canAccessMCPServer(config, userId)) ? ([name, config] as const) : null,
    ),
  );
  return Object.fromEntries(accessible.filter((entry) => entry !== null));
}
