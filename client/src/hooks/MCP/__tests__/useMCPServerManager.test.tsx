import React from 'react';
import { RecoilRoot } from 'recoil';
import { Provider, createStore } from 'jotai';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  QueryKeys,
  dataService,
  Permissions,
  roleDefaults,
  ResourceType,
  LocalStorageKeys,
  PermissionTypes,
} from 'librechat-data-provider';
import type { MCPServersListResponse } from 'librechat-data-provider';
import type { TAuthContext } from '~/common';
import { useMCPServerManager } from '../useMCPServerManager';
import { AuthContext } from '~/hooks/AuthContext';
import store from '~/store';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getMCPServers: jest.fn() },
  };
});

const getServers = jest.mocked(dataService.getMCPServers);
const allowedServers: MCPServersListResponse = {
  server1: { serverName: 'server1', type: 'sse', url: 'http://mcp' },
};
const rolesWithAccess = (allowed: boolean): TAuthContext['roles'] => ({
  USER: {
    ...roleDefaults.USER,
    permissions: {
      ...roleDefaults.USER.permissions,
      [PermissionTypes.MCP_SERVERS]: {
        ...roleDefaults.USER.permissions[PermissionTypes.MCP_SERVERS],
        [Permissions.USE]: allowed,
      },
    },
  },
});

describe('useMCPServerManager access loading', () => {
  let auth: TAuthContext;
  let queryClient: QueryClient;
  let atomStore: ReturnType<typeof createStore>;

  beforeEach(() => {
    localStorage.clear();
    getServers.mockReset().mockResolvedValue(allowedServers);
    atomStore = createStore();
    auth = {
      user: {
        id: 'user1',
        role: 'USER',
        username: 'test',
        name: 'Test',
        email: 'test@example.test',
        avatar: '',
        provider: 'local',
        createdAt: '',
        updatedAt: '',
      },
      isAuthenticated: true,
      roles: {},
      token: undefined,
      error: undefined,
      login: jest.fn(),
      logout: jest.fn(),
      setError: jest.fn(),
    };
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
      logger: { log: console.log, warn: console.warn, error: jest.fn() },
    });
    queryClient.setQueryData([QueryKeys.effectivePermissions, 'all', ResourceType.MCPSERVER], {});
    queryClient.setQueryData([QueryKeys.mcpConnectionStatus], { connectionStatus: {} });
  });

  afterEach(() => {
    queryClient.clear();
  });

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <RecoilRoot initializeState={({ set }) => set(store.queriesEnabled, false)}>
          <Provider store={atomStore}>{children}</Provider>
        </RecoilRoot>
      </AuthContext.Provider>
    </QueryClientProvider>
  );

  it.each([false, true])(
    'preserves defaults until role permissions load (cached: %s)',
    async (cached) => {
      const storageContextKey = `pending-role-${cached}`;
      const storageKey = `${LocalStorageKeys.LAST_MCP_}${storageContextKey}`;
      localStorage.setItem(storageKey, JSON.stringify(['server1']));
      if (cached) {
        queryClient.setQueryData([QueryKeys.mcpServers], allowedServers);
      }
      const { result, rerender } = renderHook(() => useMCPServerManager({ storageContextKey }), {
        wrapper: Wrapper,
      });

      expect(result.current.availableMCPServers).toEqual([]);
      expect(result.current.mcpValues).toEqual(['server1']);
      expect(localStorage.getItem(storageKey)).toBe(JSON.stringify(['server1']));
      expect(getServers).not.toHaveBeenCalled();

      auth = { ...auth, roles: rolesWithAccess(true) };
      rerender();

      await waitFor(() => {
        expect(result.current.availableMCPServers.map((server) => server.serverName)).toEqual([
          'server1',
        ]);
        expect(result.current.mcpValues).toEqual(['server1']);
      });
    },
  );

  it('preserves defaults after an initial request error until a successful access response arrives', async () => {
    const storageContextKey = 'initial-request-error';
    const storageKey = `${LocalStorageKeys.LAST_MCP_}${storageContextKey}`;
    localStorage.setItem(storageKey, JSON.stringify(['server1']));
    auth = { ...auth, roles: rolesWithAccess(true) };
    getServers.mockRejectedValueOnce(new Error('Network unavailable'));
    const { result } = renderHook(() => useMCPServerManager({ storageContextKey }), {
      wrapper: Wrapper,
    });

    await waitFor(() => {
      expect(queryClient.getQueryState([QueryKeys.mcpServers])?.status).toBe('error');
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.availableMCPServers).toEqual([]);
    expect(result.current.mcpValues).toEqual(['server1']);
    expect(localStorage.getItem(storageKey)).toBe(JSON.stringify(['server1']));

    getServers.mockResolvedValue({});
    await act(async () => {
      await queryClient.refetchQueries([QueryKeys.mcpServers]);
    });

    await waitFor(() => expect(result.current.mcpValues).toEqual([]));
    expect(localStorage.getItem(storageKey)).toBe('[]');
  });

  it('clears defaults and hides a cached list when loaded role permissions deny MCP use', () => {
    const storageContextKey = 'denied-role';
    const storageKey = `${LocalStorageKeys.LAST_MCP_}${storageContextKey}`;
    localStorage.setItem(storageKey, JSON.stringify(['server1']));
    queryClient.setQueryData([QueryKeys.mcpServers], allowedServers);
    auth = { ...auth, roles: rolesWithAccess(false) };
    const { result } = renderHook(() => useMCPServerManager({ storageContextKey }), {
      wrapper: Wrapper,
    });

    expect(result.current.availableMCPServers).toEqual([]);
    expect(result.current.mcpValues).toEqual([]);
    expect(localStorage.getItem(storageKey)).toBe('[]');
    expect(getServers).not.toHaveBeenCalled();
  });
});
