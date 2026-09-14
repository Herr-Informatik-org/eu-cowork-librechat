import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { FormProvider, useForm, useFormContext } from 'react-hook-form';
import { Tools, MemoryScope, AgentCapabilities } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { useAgentItems, useShowMemory } from '../hooks';

let mockBrainEnabled: boolean | undefined;
let mockHasMemoryAccess = true;
let mockMemoriesPreference = true;
let mockCapabilities: string[] = [AgentCapabilities.memory];
const mockBrainStatusQuery = jest.fn();

jest.mock('librechat-data-provider/react-query', () => ({
  useUpdateUserPluginsMutation: () => ({ mutate: jest.fn() }),
}));

jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: jest.fn() }) }));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: () => true,
  useHasMemoryAccess: () => mockHasMemoryAccess,
}));
jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({
    user: { id: 'user-1', personalization: { memories: mockMemoriesPreference } },
  }),
}));
jest.mock('~/Providers', () => ({
  useAgentPanelContext: () => ({
    agentsConfig: { capabilities: mockCapabilities },
    regularTools: [],
    mcpServersMap: new Map(),
    actions: [],
  }),
  useFileMapContext: () => ({}),
}));
jest.mock('~/data-provider', () => ({
  useVerifyAgentToolAuth: () => ({ data: undefined }),
  useGetAgentFiles: () => ({ data: [] }),
}));
jest.mock('~/data-provider/Brain', () => ({
  useBrainStatusQuery: (enabled: boolean) => mockBrainStatusQuery(enabled),
}));

beforeEach(() => {
  mockBrainEnabled = false;
  mockHasMemoryAccess = true;
  mockMemoriesPreference = true;
  mockCapabilities = [AgentCapabilities.memory];
  mockBrainStatusQuery.mockImplementation(() => ({
    data: mockBrainEnabled === undefined ? undefined : { enabled: mockBrainEnabled },
  }));
});

describe('useShowMemory', () => {
  test('offers native memory when Brain is disabled', () => {
    const { result } = renderHook(() => useShowMemory());
    expect(result.current).toBe(true);
  });

  test.each([true, undefined])('hides native memory when Brain status is %s', (enabled) => {
    mockBrainEnabled = enabled;
    const { result } = renderHook(() => useShowMemory());
    expect(result.current).toBe(false);
  });

  test('keeps the memory permission gate and skips its Brain status request', () => {
    mockHasMemoryAccess = false;
    const { result } = renderHook(() => useShowMemory());
    expect(result.current).toBe(false);
    expect(mockBrainStatusQuery).toHaveBeenCalledWith(false);
  });

  test('keeps the deployment capability gate', () => {
    mockCapabilities = [];
    const { result } = renderHook(() => useShowMemory());
    expect(result.current).toBe(false);
  });

  test('keeps the user opt-out gate', () => {
    mockMemoriesPreference = false;
    const { result } = renderHook(() => useShowMemory());
    expect(result.current).toBe(false);
  });
});

describe('agent memory configuration', () => {
  function Wrapper({ children }: { children: React.ReactNode }) {
    const form = useForm<AgentForm>({
      defaultValues: {
        id: 'agent-1',
        name: 'Saved agent',
        memory: true,
        memory_scope: MemoryScope.agent,
        tools: [Tools.memory],
      },
    });
    return <FormProvider {...form}>{children}</FormProvider>;
  }

  test('hides saved memory in both tool lists without clearing its form configuration', () => {
    const { result, rerender } = renderHook(
      () => ({ items: useAgentItems({ agentId: 'agent-1' }), form: useFormContext<AgentForm>() }),
      { wrapper: Wrapper },
    );
    expect(result.current.items.catalog.map((item) => item.id)).toContain(AgentCapabilities.memory);
    expect(result.current.items.selected.map((item) => item.id)).toContain(
      AgentCapabilities.memory,
    );

    mockBrainEnabled = true;
    rerender();
    act(() => result.current.form.setValue('name', 'Renamed agent'));

    expect(result.current.items.catalog.map((item) => item.id)).not.toContain(
      AgentCapabilities.memory,
    );
    expect(result.current.items.selected.map((item) => item.id)).not.toContain(
      AgentCapabilities.memory,
    );
    expect(result.current.form.getValues()).toMatchObject({
      name: 'Renamed agent',
      memory: true,
      memory_scope: MemoryScope.agent,
      tools: [Tools.memory],
    });

    mockBrainEnabled = false;
    rerender();
    expect(result.current.items.selected.map((item) => item.id)).toContain(
      AgentCapabilities.memory,
    );
    expect(result.current.form.getValues('memory_scope')).toBe(MemoryScope.agent);
  });
});
