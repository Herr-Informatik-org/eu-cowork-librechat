import type { BrainEdge, BrainKind, BrainNode } from 'librechat-data-provider';

export const brainKinds: BrainKind[] = [
  'preference',
  'project',
  'person',
  'decision',
  'fact',
  'procedure',
];
export const kindColors: Record<BrainKind, string> = {
  preference: 'var(--brain-preference)',
  project: 'var(--brain-project)',
  person: 'var(--brain-person)',
  decision: 'var(--brain-decision)',
  fact: 'var(--brain-fact)',
  procedure: 'var(--brain-procedure)',
};

export const kindKeys = {
  preference: 'com_ui_brain_preference',
  project: 'com_ui_brain_project',
  person: 'com_ui_brain_person',
  decision: 'com_ui_brain_decision',
  fact: 'com_ui_brain_fact',
  procedure: 'com_ui_brain_procedure',
} as const;

export type PositionedNode = { node: BrainNode; x: number; y: number; radius: number };

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index++)
    value = Math.imul(value ^ text.charCodeAt(index), 16777619);
  return value >>> 0;
}

/** Fixed category sectors and ID-derived positions keep the map stable as memories grow. */
export function layoutBrain(nodes: BrainNode[], edges: BrainEdge[]): PositionedNode[] {
  const degrees = new Map<string, number>();
  for (const edge of edges) {
    degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
  }
  return nodes.map((node) => {
    const seed = hash(node.id);
    const sector = brainKinds.indexOf(node.kind);
    const angle = ((-120 + sector * 60 + 7 + (seed % 4600) / 100) * Math.PI) / 180;
    const distance = 94 + Math.sqrt(((seed >>> 9) % 10_000) / 10_000) * 153;
    return {
      node,
      x: Math.round((420 + Math.cos(angle) * distance) * 100) / 100,
      y: Math.round((320 + Math.sin(angle) * distance) * 100) / 100,
      radius: node.pinned ? 7 : Math.min(6.5, 3.7 + Math.sqrt(degrees.get(node.id) ?? 0)),
    };
  });
}

export function mergeBrainPages(pages: { nodes: BrainNode[]; edges: BrainEdge[] }[] = []) {
  const nodes = new Map<string, BrainNode>();
  const edges = new Map<string, BrainEdge>();
  for (const page of pages) {
    for (const node of page.nodes) nodes.set(node.id, node);
    for (const edge of page.edges) edges.set(edge.id, edge);
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

export function sourceHref(conversationId?: string): string | undefined {
  return conversationId && conversationId !== 'new'
    ? `/c/${encodeURIComponent(conversationId)}`
    : undefined;
}
