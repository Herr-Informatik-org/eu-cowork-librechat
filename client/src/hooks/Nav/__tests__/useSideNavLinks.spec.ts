import { renderHook } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import useSideNavLinks from '../useSideNavLinks';

const mockGrants: Record<string, boolean> = {};
let mockBrainEnabled: boolean | undefined = true;
jest.mock('~/data-provider/Brain', () => ({
  useBrainStatusQuery: () => ({ data: { enabled: mockBrainEnabled } }),
}));
jest.mock('~/components/Brain', () => ({ BrainPanel: () => null }));
jest.mock('~/hooks', () => ({
  useHasAccess: ({ permissionType, permission }: { permissionType: string; permission: string }) =>
    mockGrants[`${permissionType}.${permission}`] !== false,
  useMCPServerManager: () => ({ availableMCPServers: [{ serverName: 'approved' }] }),
  useGetAgentsConfig: () => ({ agentsConfig: { capabilities: [] } }),
  useAgentCapabilities: () => ({ skillsEnabled: true }),
}));
jest.mock('~/components/SidePanel/MCPBuilder/MCPBuilderPanel', () => () => null);
jest.mock('~/components/SidePanel/Agents/AgentPanelSwitch', () => () => null);
jest.mock('~/components/SidePanel/Bookmarks/BookmarkPanel', () => () => null);
jest.mock('~/components/SidePanel/Builder/PanelSwitch', () => () => null);
jest.mock('~/components/SidePanel/Parameters/Panel', () => () => null);
jest.mock('~/components/SidePanel/Memories', () => ({ MemoryPanel: () => null }));
jest.mock('~/components/SidePanel/Files/Panel', () => () => null);
jest.mock('~/components/Prompts', () => ({ PromptsAccordion: () => null }));
jest.mock('~/components/Skills', () => ({ SkillsAccordion: () => null }));

const readIds = () =>
  renderHook(() =>
    useSideNavLinks({
      keyProvided: true,
      endpoint: EModelEndpoint.agents,
      endpointsConfig: { agents: { order: 0 } },
      interfaceConfig: {},
      includeHidePanel: false,
    }),
  ).result.current.map(({ id }) => id);

describe('role-configured navigation', () => {
  beforeEach(() => {
    Object.keys(mockGrants).forEach((key) => delete mockGrants[key]);
    mockBrainEnabled = true;
  });
  it.each([
    ['AGENTS', 'agents'],
    ['MCP_SERVERS', 'mcp-builder'],
    ['SKILLS', 'skills'],
    ['PROMPTS', 'prompts'],
    ['MEMORIES', 'brain'],
  ])('hides %s management independently from tool use', (type, id) => {
    expect(readIds()).toContain(id);
    mockGrants[`${type}.VIEW`] = false;
    expect(readIds()).not.toContain(id);
    expect(readIds()).toContain('files');
  });
  it('continues to require agent create and use capabilities', () => {
    mockGrants['AGENTS.CREATE'] = false;
    expect(readIds()).not.toContain('agents');
    mockGrants['AGENTS.CREATE'] = true;
    mockGrants['AGENTS.USE'] = false;
    expect(readIds()).not.toContain('agents');
  });
  it('shows Brain only when the service is enabled and memory is readable', () => {
    expect(readIds()).toContain('brain');
    mockBrainEnabled = false;
    expect(readIds()).not.toContain('brain');
    mockBrainEnabled = true;
    mockGrants['MEMORIES.READ'] = false;
    expect(readIds()).not.toContain('brain');
    mockGrants['MEMORIES.READ'] = true;
    mockGrants['MEMORIES.VIEW'] = false;
    expect(readIds()).not.toContain('brain');
  });
  it('uses exactly one memory store and never flashes the legacy editor before status resolves', () => {
    expect(readIds()).toContain('brain');
    expect(readIds()).not.toContain('memories');
    mockBrainEnabled = false;
    expect(readIds()).toContain('memories');
    expect(readIds()).not.toContain('brain');
    mockBrainEnabled = undefined;
    expect(readIds()).not.toContain('brain');
    expect(readIds()).not.toContain('memories');
  });
});
