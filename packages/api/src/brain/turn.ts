import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type {
  IUser,
  UserMethods,
  MessageMethods,
  MemoryMethods,
  ConversationMethods,
  AppConfig,
} from '@librechat/data-schemas';
import type { CheckAccessParams } from '~/middleware/access';
import type { BrainSession, BrainSessionOptions } from './session';
import { checkAccess } from '~/middleware/access';
import { createBrainSession } from './session';
import { isBrainSourcePersisted } from './source';
import { requestBrain } from './client';
import type { BrainFailureReporter } from './diagnostics';
import { classifyBrainFailure, createBrainFailureReporter } from './diagnostics';
import type { BrainStoredMessage, BrainConversationMessage } from './conversation';
import { conversationBranch, conversationMessages, conversationText } from './conversation';
import {
  brainConversationKey,
  brainSourceFingerprint,
  clearBrainOngoingCheckpoint,
  registerBrainTurn,
} from './ongoing';
import { getAppConfigOptionsFromUser } from '~/app/service';
import type { GetAppConfigOptions } from '~/app/service';

interface PrepareBrainTurnOptions {
  reportFailure?: BrainFailureReporter;
  config?: AppConfig;
  user: IUser;
  conversationId: string;
  messageId: string;
  sourceMessage?: {
    messageId?: string;
    text?: string;
    isCreatedByUser?: boolean;
    addedConvo?: boolean;
    createdAt?: string | Date;
    content?: BrainStoredMessage['content'];
  };
  getBudget: BrainSessionOptions['getBudget'];
  countTokens: BrainSessionOptions['countTokens'];
  dependencies: {
    getUserById: UserMethods['getUserById'];
    getMessages: MessageMethods['getMessages'];
    getRoleByName: CheckAccessParams['getRoleByName'];
    getUserMemories: MemoryMethods['getUserMemories'];
    getConvo?: ConversationMethods['getConvo'];
    getAppConfig?: (options: GetAppConfigOptions) => Promise<AppConfig>;
    getAccessibleMcpServerNames?: (userId: string, role?: string) => Promise<string[]>;
  };
}

interface PreparedBrainTurn {
  session?: BrainSession;
  context?: string;
}

/** Build the per-turn owner, evidence and permission boundary independently of the chat client. */
export async function prepareBrainTurn({
  user,
  config,
  conversationId,
  messageId,
  sourceMessage,
  getBudget,
  countTokens,
  dependencies,
  reportFailure = createBrainFailureReporter(),
}: PrepareBrainTurnOptions): Promise<PreparedBrainTurn> {
  if (
    !sourceMessage?.isCreatedByUser ||
    sourceMessage.addedConvo ||
    !sourceMessage.messageId ||
    !conversationText(sourceMessage)
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
  const signal = registerBrainTurn(userId, conversationId);
  const cacheKey = brainConversationKey(userId, conversationId);
  const memoryFingerprint = JSON.stringify(config?.memory ?? {});
  let currentRole = user.role;
  const accessibleHints = async () => {
    if (!config?.memory?.useMcpContext || !dependencies.getAccessibleMcpServerNames) return [];
    const names = await dependencies
      .getAccessibleMcpServerNames(userId, currentRole)
      .catch(() => []);
    return names
      .filter((name) => /^[\p{L}\p{N} ._-]{1,80}$/u.test(name))
      .sort()
      .slice(0, 30);
  };
  const connectionHints = await accessibleHints();
  const source = {
    id: sourceMessage.messageId,
    text: conversationText(sourceMessage),
    createdAt: new Date(sourceMessage.createdAt ?? Date.now()).toISOString(),
  };
  const canChange = async (permission: Permissions) => {
    if (signal.aborted) return false;
    const current = await dependencies.getUserById(
      userId,
      'personalization role tenantId idOnTheSource',
    );
    currentRole = current?.role ?? user.role;
    const freshConfig =
      current && dependencies.getAppConfig
        ? await dependencies.getAppConfig(getAppConfigOptionsFromUser({ ...current, id: userId }))
        : config;
    if (
      current?.personalization?.memories === false ||
      freshConfig?.memory?.disabled ||
      JSON.stringify(freshConfig?.memory ?? {}) !== memoryFingerprint
    ) {
      clearBrainOngoingCheckpoint(cacheKey);
      return false;
    }
    return (
      current != null &&
      (await isBrainSourcePersisted(
        { userId, conversationId, source },
        dependencies.getMessages,
      )) &&
      (await check(permission, current))
    );
  };
  let snapshot: BrainConversationMessage[] | undefined;
  let observedUserIds: Set<string> | undefined;
  const readConversation = async () => {
    const conversation = await dependencies.getConvo!(userId, conversationId);
    if (!conversation || conversation.expiredAt) return [];
    const records = await dependencies.getMessages({ user: userId, conversationId });
    return conversationMessages(
      records.flatMap((message) =>
        message.createdAt ? [{ ...message, createdAt: message.createdAt }] : [],
      ),
    );
  };
  const loadConversation = dependencies.getConvo
    ? async () => {
        if (snapshot) return snapshot;
        const messages = await readConversation();
        observedUserIds = new Set(
          messages.filter((message) => message.role === 'user').map((message) => message.id),
        );
        snapshot = conversationBranch(messages, source.id);
        return snapshot;
      }
    : undefined;
  const authorizeConversation = async (
    messages: BrainConversationMessage[],
    mode: 'read' | 'create' | 'update' = 'create',
  ) => {
    const permission = {
      read: Permissions.READ,
      update: Permissions.UPDATE,
      create: Permissions.CREATE,
    }[mode];
    if (!(await canChange(permission))) return false;
    const latest = await readConversation();
    const branch = conversationBranch(latest, source.id);
    const hints = await accessibleHints();
    const valid =
      branch.length === messages.length &&
      branch.every(
        (message, index) =>
          brainSourceFingerprint(message) === brainSourceFingerprint(messages[index]),
      ) &&
      !latest.some((message) => message.role === 'user' && !observedUserIds?.has(message.id)) &&
      JSON.stringify(hints) === JSON.stringify(connectionHints);
    if (!valid) clearBrainOngoingCheckpoint(cacheKey);
    return valid;
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
    ...(loadConversation ? { loadConversation, authorizeConversation } : {}),
    organizationContext:
      config?.memory?.organizationContext?.text && config.memory.organizationContext.version
        ? {
            text: config.memory.organizationContext.text,
            version: config.memory.organizationContext.version,
          }
        : undefined,
    connectionHints,
    signal,
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
  } catch (error) {
    await reportFailure({
      failure: classifyBrainFailure(error, 'recall'),
      userId,
      operation: 'recall',
      stage: 'recall',
      conversationId,
      messageId,
    }).catch(() => undefined);
    return {
      session,
      context:
        'Das persönliche Brain ist zurzeit nicht erreichbar. Verwende den aktuellen Chat; behaupte keinen erfolgten Erinnerungsabruf.',
    };
  }
}
