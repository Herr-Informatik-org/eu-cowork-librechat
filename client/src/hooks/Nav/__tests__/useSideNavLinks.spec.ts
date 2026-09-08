import { renderHook } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import useSideNavLinks from '../useSideNavLinks';

const mockGrants: Record<string, boolean> = {};
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
  beforeEach(() => Object.keys(mockGrants).forEach((key) => delete mockGrants[key]));
  it.each([
    ['AGENTS', 'agents'],
    ['MCP_SERVERS', 'mcp-builder'],
    ['SKILLS', 'skills'],
    ['PROMPTS', 'prompts'],
    ['MEMORIES', 'memories'],
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
});
