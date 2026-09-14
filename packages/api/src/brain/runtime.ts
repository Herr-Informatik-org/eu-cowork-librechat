import type { GenericTool, LCTool, LCToolRegistry } from '@librechat/agents';
import { createBrainSession } from './session';

interface BrainAgent {
  tools?: (GenericTool | string)[];
  toolDefinitions?: LCTool[];
  toolRegistry?: LCToolRegistry;
  brainTools?: GenericTool[];
  memoryToolsRegistered?: boolean;
}

const legacyNames = new Set(['memory', 'set_memory', 'delete_memory']);

export function attachBrainTools(
  agent: BrainAgent,
  session?: ReturnType<typeof createBrainSession>,
): void {
  agent.tools = agent.tools?.filter(
    (entry) => !legacyNames.has(typeof entry === 'string' ? entry : entry.name),
  );
  agent.toolDefinitions = agent.toolDefinitions?.filter((entry) => !legacyNames.has(entry.name));
  if (agent.toolRegistry) {
    agent.toolRegistry = new Map(agent.toolRegistry);
    for (const name of legacyNames) {
      agent.toolRegistry.delete(name);
    }
  }
  agent.memoryToolsRegistered = false;
  agent.brainTools = session?.tools;
}
