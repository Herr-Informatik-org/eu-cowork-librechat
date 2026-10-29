import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { BrainNode } from 'librechat-data-provider';
import type { ServerRequest } from '~/types';
import type { CheckAccessParams } from '~/middleware/access';
import { checkAccess } from '~/middleware/access';
import { countTokens } from '~/utils/tokenizer';
import { isBrainChatEligible } from './session';
import { requestBrain } from './client';
import { buildBrainRecallQuery } from './query';
import { containsBrainCredential } from './safety';

type Roles = CheckAccessParams['getRoleByName'];
export interface PersonalMailContext {
  context: string;
  status: 'available' | 'empty' | 'disabled' | 'unavailable';
  count: number;
}

function senderScope(sender: string): string {
  const address = z.string().email().max(254).parse(sender.trim().toLowerCase());
  return `Mail: ${address.length <= 150 ? address : createHash('sha256').update(address).digest('hex')}`;
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
    const scope = senderScope(input.sender);
    const budget = Math.max(0, Math.floor(input.contextBudgetTokens ?? 2800));
    if (budget < 128) return { context: '', status: 'empty', count: 0 };
    const query = `${input.sender}\n${buildBrainRecallQuery({ text: input.query })}`;
    const recalls = await Promise.all(
      [scope, 'Mail', undefined].map((selectedScope) =>
        requestBrain<{ nodes: BrainNode[] }>(String(req.user!.id), 'POST', '/v1/recall', {
          query,
          ...(selectedScope ? { scope: selectedScope } : {}),
          contextBudgetTokens: Math.min(1_000_000, Math.max(128, Math.floor(budget / 2))),
          recordTrace: false,
        }),
      ),
    );
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const result of recalls)
      for (const node of result.nodes) {
        if (seen.has(node.id) || (node.scope?.startsWith('Mail: ') && node.scope !== scope))
          continue;
        seen.add(node.id);
        const line = JSON.stringify({
          id: node.id,
          text: node.text,
          scope: node.scope,
          confidence: node.confidence,
          updatedAt: node.updatedAt,
          createdAt: node.createdAt,
          claimState: node.claimState,
          validUntil: node.validUntil,
          sources: node.sources.map(({ type, conversationId }) => ({ type, conversationId })),
        });
        if ((await countTokens([...lines, line].join('\n'))) > budget) continue;
        lines.push(line);
      }
    return {
      context: lines.join('\n'),
      status: lines.length ? 'available' : 'empty',
      count: lines.length,
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
      scope: input.scope === 'global' ? 'Mail' : senderScope(input.sender),
      tags: ['Mail'],
    },
  );
  return result.node;
}
