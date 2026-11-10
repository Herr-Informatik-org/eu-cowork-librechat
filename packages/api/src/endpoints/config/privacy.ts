import { Agent } from 'undici';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TEndpoint } from 'librechat-data-provider';

const basePattern = /^http:\/\/privacy-proxy:3040\/r\/[a-z0-9][a-z0-9-]{0,47}\/v1\/?$/;
const routeHeader = 'X-EUCowork-Privacy-Key';
const requiredHeaders = {
  [routeHeader]: '${PRIVACY_ROUTE_TOKEN}',
  'X-EUCowork-User-Id': '{{LIBRECHAT_USER_ID}}',
  'X-EUCowork-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
};
const direct = new Agent();
type ModelFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const isPrivacyRequired = (): boolean => process.env.PRIVACY_REQUIRED === 'true';

export class PrivacyRouteError extends Error {
  constructor() {
    super('Diese Modellanfrage benötigt eine konfigurierte lokale Datenschutzroute.');
  }
}

export function isProtectedModelEndpoint(endpoint?: Partial<TEndpoint>): boolean {
  return Boolean(
    process.env.PRIVACY_ROUTE_TOKEN?.trim() &&
      typeof endpoint?.baseURL === 'string' &&
      basePattern.test(endpoint.baseURL) &&
      endpoint.provider !== EModelEndpoint.anthropic &&
      endpoint.directEndpoint !== true &&
      Object.entries(requiredHeaders).every(([name, value]) => endpoint.headers?.[name] === value),
  );
}

export function requirePrivacyModelEndpoint(endpoint?: Partial<TEndpoint>): void {
  if (isPrivacyRequired() && !isProtectedModelEndpoint(endpoint)) {
    throw new PrivacyRouteError();
  }
}

/** The SDK may build its own Request. Verify its destination before sending any bytes. */
export function createPrivacyModelFetch(baseURL: string | null | undefined): ModelFetch {
  if (typeof baseURL !== 'string' || !basePattern.test(baseURL)) {
    throw new PrivacyRouteError();
  }
  const chat = `${baseURL.replace(/\/$/, '')}/chat/completions`;
  return async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const token = process.env.PRIVACY_ROUTE_TOKEN;
    if (
      url !== chat ||
      method.toUpperCase() !== 'POST' ||
      !token?.trim() ||
      headers.get(routeHeader) !== token
    ) {
      throw new PrivacyRouteError();
    }
    const directRequest = { ...init, redirect: 'error' as const, dispatcher: direct };
    return fetch(input, directRequest);
  };
}
