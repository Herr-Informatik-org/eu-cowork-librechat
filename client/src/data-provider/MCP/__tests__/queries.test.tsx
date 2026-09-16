import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import {
  QueryClient,
  focusManager,
  onlineManager,
  QueryClientProvider,
} from '@tanstack/react-query';
import { dataService } from 'librechat-data-provider';
import type { MCPServersListResponse } from 'librechat-data-provider';
import { useMCPServersQuery } from '../queries';

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

describe('useMCPServersQuery access refresh', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    jest.useFakeTimers();
    getServers.mockReset();
    focusManager.setFocused(true);
    onlineManager.setOnline(true);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    queryClient.clear();
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
    jest.useRealTimers();
  });

  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it('replaces revoked servers during the foreground refresh interval', async () => {
    getServers.mockResolvedValueOnce(allowedServers).mockResolvedValue({});
    const { result } = renderHook(() => useMCPServersQuery(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.data).toEqual(allowedServers));

    await act(async () => {
      jest.advanceTimersByTime(30_000);
    });

    await waitFor(() => expect(result.current.data).toEqual({}));
    expect(getServers).toHaveBeenCalledTimes(2);
  });

  it.each(['focus', 'reconnect'])('refreshes a stale list after %s', async (event) => {
    getServers.mockResolvedValueOnce(allowedServers).mockResolvedValue({});
    const { result } = renderHook(() => useMCPServersQuery({ refetchInterval: false }), {
      wrapper: Wrapper,
    });

    await waitFor(() => expect(result.current.data).toEqual(allowedServers));

    await act(async () => {
      focusManager.setFocused(false);
      onlineManager.setOnline(event !== 'reconnect');
      jest.advanceTimersByTime(30_001);
      if (event === 'focus') {
        focusManager.setFocused(true);
      } else {
        onlineManager.setOnline(true);
      }
    });

    await waitFor(() => expect(result.current.data).toEqual({}));
    expect(getServers).toHaveBeenCalledTimes(2);
  });

  it('does not poll while the app is in the background', async () => {
    getServers.mockResolvedValue(allowedServers);
    const { result } = renderHook(() => useMCPServersQuery(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.data).toEqual(allowedServers));

    await act(async () => {
      focusManager.setFocused(false);
      jest.advanceTimersByTime(60_000);
    });

    expect(getServers).toHaveBeenCalledTimes(1);
  });
});
