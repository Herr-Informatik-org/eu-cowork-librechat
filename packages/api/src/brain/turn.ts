import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { IUser, UserMethods, MessageMethods, MemoryMethods } from '@librechat/data-schemas';
import type { CheckAccessParams } from '~/middleware/access';
import type { BrainSession, BrainSessionOptions } from './session';
import { checkAccess } from '~/middleware/access';
import { createBrainSession } from './session';
import { isBrainSourcePersisted } from './source';
import { requestBrain } from './client';

interface PrepareBrainTurnOptions {
  user: IUser;
  conversationId: string;
  messageId: string;
  sourceMessage?: {
    messageId?: string;
    text?: string;
    isCreatedByUser?: boolean;
    addedConvo?: boolean;
    createdAt?: string | Date;
  };
  getBudget: BrainSessionOptions['getBudget'];
  countTokens: BrainSessionOptions['countTokens'];
  dependencies: {
    getUserById: UserMethods['getUserById'];
    getMessages: MessageMethods['getMessages'];
    getRoleByName: CheckAccessParams['getRoleByName'];
    getUserMemories: MemoryMethods['getUserMemories'];
  };
}

interface PreparedBrainTurn {
  session?: BrainSession;
  context?: string;
}

/** Build the per-turn owner, evidence and permission boundary independently of the chat client. */
export async function prepareBrainTurn({
  user,
  conversationId,
  messageId,
  sourceMessage,
  getBudget,
  countTokens,
  dependencies,
}: PrepareBrainTurnOptions): Promise<PreparedBrainTurn> {
  if (
    !sourceMessage?.isCreatedByUser ||
    sourceMessage.addedConvo ||
    !sourceMessage.messageId ||
    !sourceMessage.text
  ) {
    return {};
  }
  const check = (permission: Permissions, currentUser = user) =>
    checkAccess({
      user: currentUser,
      permissionType: PermissionTypes.MEMORIES,
      permissions: [Permissions.USE, permission],
      getRoleByName: dependencies.getRoleByName,
    });
  const [canRead, canWrite, canUpdate] = await Promise.all([
    check(Permissions.READ),
    check(Permissions.CREATE),
    check(Permissions.UPDATE),
  ]);
  if (!canRead) {
    return {};
  }
  const userId = String(user.id);
  const source = {
    id: sourceMessage.messageId,
    text: sourceMessage.text,
    createdAt: new Date(sourceMessage.createdAt ?? Date.now()).toISOString(),
  };
  const canChange = async (permission: Permissions) => {
    const current = await dependencies.getUserById(userId, 'personalization role');
    return (
      current != null &&
      current.personalization?.memories !== false &&
      (await isBrainSourcePersisted(
        { userId, conversationId, source },
        dependencies.getMessages,
      )) &&
      (await check(permission, current))
    );
  };
  const session = createBrainSession({
    userId,
    conversationId,
    messageId,
    source,
    contextBudgetTokens: 0,
    canWrite,
    canUpdate,
    countTokens,
    getBudget,
    canPersist: () => canChange(Permissions.CREATE),
    canModify: () => canChange(Permissions.UPDATE),
  });
  try {
    if (canWrite) {
      const legacy = await dependencies.getUserMemories({ userId });
      const personal = legacy.filter((entry) => !entry.agentId);
      if (personal.length > 0) {
        await requestBrain(userId, 'POST', '/v1/import', {
          memories: personal.map(({ key, value, updated_at }) => ({
            key,
            value,
            updatedAt: updated_at,
          })),
        });
      }
    }
    return { session };
  } catch {
    return {
      session,
      context:
        'Das persönliche Brain ist zurzeit nicht erreichbar. Verwende den aktuellen Chat; behaupte keinen erfolgten Erinnerungsabruf.',
    };
  }
}
