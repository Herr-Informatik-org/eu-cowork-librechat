import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, Library } from 'lucide-react';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import type { BrainUsedMemory, TMessage } from 'librechat-data-provider';
import {
  useBrainMutations,
  useBrainStatusQuery,
  useBrainRecallUsageQuery,
} from '~/data-provider/Brain';
import { useHasAccess, useLocalize } from '~/hooks';
import { sourceHref } from './layout';
import { cn } from '~/utils';

/** A trace is saved before the answer streams; a fresh answer may refetch once to find it. */
const FRESH_ANSWER_MS = 5 * 60_000;

const isFresh = (createdAt?: string): boolean =>
  !createdAt || Date.now() - Date.parse(createdAt) < FRESH_ANSWER_MS;

function Origin({ memory }: { memory: BrainUsedMemory }) {
  const localize = useLocalize();
  const source = memory.sources[memory.sources.length - 1];
  if (!source) return null;
  const date = new Date(source.createdAt).toLocaleDateString();
  const href = source.type === 'chat' ? sourceHref(source.conversationId) : undefined;
  if (href) {
    return (
      <a
        href={href}
        className="underline decoration-dotted underline-offset-2 hover:text-text-primary"
      >
        {`${source.label} · ${date}`}
      </a>
    );
  }
  const label =
    source.type === 'manual'
      ? localize('com_ui_brain_usage_manual')
      : source.label || localize('com_ui_brain_imported_source');
  return <span>{`${label} · ${date}`}</span>;
}

function UsedMemory({ memory, canUpdate }: { memory: BrainUsedMemory; canUpdate: boolean }) {
  const localize = useLocalize();
  const { update } = useBrainMutations();
  const outdated = memory.status === 'superseded';
  return (
    <li className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
      <div className="min-w-0">
        <p className={cn('break-words text-text-primary', outdated && 'line-through')}>
          {memory.title}
        </p>
        <p className="text-text-secondary">
          <Origin memory={memory} />
        </p>
        {update.isError && (
          <p role="alert" className="text-red-600 dark:text-red-400">
            {localize('com_ui_brain_usage_error')}
          </p>
        )}
      </div>
      {outdated ? (
        <span className="shrink-0 text-text-secondary">
          {localize('com_ui_brain_usage_outdated')}
        </span>
      ) : (
        canUpdate && (
          <button
            type="button"
            disabled={update.isLoading}
            onClick={() =>
              update.mutate({
                id: memory.id,
                data: { status: 'superseded', version: memory.version },
              })
            }
            className="shrink-0 self-start rounded-md px-2 py-1 text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy disabled:opacity-50"
          >
            {localize('com_ui_brain_usage_outdated_action')}
          </button>
        )
      )}
    </li>
  );
}

function UsageChip({
  messageId,
  conversationId,
  createdAt,
}: {
  messageId: string;
  conversationId: string;
  createdAt?: string;
}) {
  const localize = useLocalize();
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const refetched = useRef(false);
  const canUpdate = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.UPDATE,
  });
  const { data: status } = useBrainStatusQuery();
  const { data, refetch } = useBrainRecallUsageQuery(conversationId, status?.enabled === true);
  const memories = useMemo(() => {
    const entry = data?.messages.find((item) => item.messageId === messageId);
    if (!entry || !data) return [];
    const byId = new Map(data.nodes.map((node) => [node.id, node]));
    return entry.nodeIds.flatMap((id) => byId.get(id) ?? []);
  }, [data, messageId]);

  useEffect(() => {
    if (refetched.current || !data || memories.length || !isFresh(createdAt)) return;
    refetched.current = true;
    void refetch();
  }, [data, memories.length, createdAt, refetch]);

  if (!memories.length) return null;
  return (
    <div className="mt-1 text-xs text-text-secondary">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 rounded-full border border-border-light px-2 py-0.5 hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
      >
        <Library className="h-3.5 w-3.5" aria-hidden="true" />
        {localize('com_ui_brain_usage', { count: memories.length })}
        <ChevronDown
          className={cn('h-3 w-3 transition-transform', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open && (
        <ul
          id={panelId}
          aria-label={localize('com_ui_brain_usage_list')}
          className="mt-2 flex flex-col gap-3 rounded-lg border border-border-light bg-surface-secondary p-3"
        >
          {memories.map((memory) => (
            <UsedMemory key={memory.id} memory={memory} canUpdate={canUpdate} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Small "from your knowledge" chip under an answer whose recall used personal memories. */
export default function BrainUsage({
  message,
  isSubmitting,
}: {
  message?: TMessage;
  isSubmitting?: boolean;
}) {
  const canUse = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.USE,
  });
  const canRead = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.READ,
  });
  const conversationId = message?.conversationId;
  if (
    !message ||
    message.isCreatedByUser ||
    isSubmitting ||
    !canUse ||
    !canRead ||
    !conversationId ||
    conversationId === 'new'
  ) {
    return null;
  }
  return (
    <UsageChip
      messageId={message.messageId}
      conversationId={conversationId}
      createdAt={message.createdAt}
    />
  );
}
