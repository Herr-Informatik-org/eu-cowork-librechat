import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { BrainNode, BrainUsage, BrainUsageItem } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import type { CheckAccessParams } from '~/middleware/access';
import { checkAccess } from '~/middleware/access';
import { countTokens } from '~/utils/tokenizer';
import { isBrainChatEligible } from './session';
import { requestBrain } from './client';
import { buildBrainRecallQuery } from './query';
import { containsBrainCredential } from './safety';
import { personalMailScope } from './policy';
import { brainUsageItem } from './usage';

type Roles = CheckAccessParams['getRoleByName'];
export interface PersonalMailContext extends BrainUsage {
  context: string;
}

export async function isPersonalMailMemoryAllowed(
  req: ServerRequest,
  getRoleByName: Roles,
  permission: Permissions = Permissions.READ,
): Promise<boolean> {
  if (
    !req.user?.id ||
    !req.config?.memory ||
    !isBrainChatEligible({
      memoriesEnabled: req.user.personalization?.memories,
      memoryDisabled: req.config.memory.disabled,
    })
  )
    return false;
  return checkAccess({
    user: req.user,
    permissionType: PermissionTypes.MEMORIES,
    permissions: [Permissions.USE, permission],
    getRoleByName,
  });
}

/** Mail workers may read private context; they never turn incoming mail into personal evidence. */
export async function readPersonalMailContext(
  req: ServerRequest,
  getRoleByName: Roles,
  input: { query: string; sender: string; contextBudgetTokens?: number },
): Promise<PersonalMailContext> {
  if (!(await isPersonalMailMemoryAllowed(req, getRoleByName)))
    return { context: '', status: 'disabled', count: 0 };
  try {
    const scope = personalMailScope(input.sender);
    const budget = Math.max(0, Math.floor(input.contextBudgetTokens ?? 2800));
    if (budget < 128) return { context: '', status: 'empty', count: 0 };
    const query = `${input.sender}\n${buildBrainRecallQuery({ text: input.query })}`;
    const result = await requestBrain<{ nodes: BrainNode[] }>(
      String(req.user!.id),
      'POST',
      '/v1/recall',
      {
        query,
        purpose: 'mail',
        applicableScopes: [scope, 'Mail'],
        contextBudgetTokens: Math.min(1_000_000, budget),
        recordTrace: false,
      },
    );
    const selected = new Set<string>();
    const lines: string[] = [];
    const items: BrainUsageItem[] = [];
    for (const node of result.nodes) {
      if (
        selected.has(node.id) ||
        (node.scope?.startsWith('Mail: ') && node.scope !== scope) ||
        (node.kind === 'preference' && node.scope && ![scope, 'Mail'].includes(node.scope))
      )
        continue;
      const line = JSON.stringify({
        id: node.id,
        text: node.text,
        scope: node.scope,
        confidence: node.confidence,
        updatedAt: node.updatedAt,
        createdAt: node.createdAt,
        claimState: node.claimState,
        validFrom: node.validFrom,
        validUntil: node.validUntil,
        sources: node.sources.map(({ type, conversationId }) => ({ type, conversationId })),
      });
      if ((await countTokens([...lines, line].join('\n'))) > budget) continue;
      selected.add(node.id);
      lines.push(line);
      items.push(brainUsageItem(node));
    }
    return {
      context: lines.join('\n'),
      status: lines.length ? 'available' : 'empty',
      count: lines.length,
      items,
    };
  } catch {
    return { context: '', status: 'unavailable', count: 0 };
  }
}

/** Only an explicitly authored rule is stored; the caller supplies an owned result's sender. */
export async function rememberPersonalMailRule(
  req: ServerRequest,
  getRoleByName: Roles,
  input: { text: string; scope: 'sender' | 'global'; sender: string },
): Promise<BrainNode> {
  if (!(await isPersonalMailMemoryAllowed(req, getRoleByName, Permissions.CREATE)))
    throw new Error(
      'Das persönliche Brain ist ausgeschaltet oder das Speichern ist nicht erlaubt.',
    );
  const text = input.text.trim();
  if (
    text.length < 12 ||
    text.length > 2400 ||
    text.includes('\0') ||
    containsBrainCredential(text)
  )
    throw new Error(
      'Bitte eine eigene dauerhafte Regel mit 12 bis 2400 Zeichen ohne Zugangsdaten eingeben.',
    );
  if (input.scope !== 'sender' && input.scope !== 'global')
    throw new Error('Bitte den Geltungsbereich der Regel auswählen.');
  const result = await requestBrain<{ node: BrainNode }>(
    String(req.user!.id),
    'POST',
    '/v1/nodes',
    {
      title: text.slice(0, 140),
      text,
      kind: 'preference',
      scope: input.scope === 'global' ? 'Mail' : personalMailScope(input.sender),
      tags: ['Mail'],
    },
  );
  return result.node;
}
