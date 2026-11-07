import { useId, useRef, useState } from 'react';
import { ArrowUpRight, Brain, X } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import type { BrainRecall, BrainUsage, BrainUsageItem } from 'librechat-data-provider';
import { useBrainRecallsQuery, useBrainStatusQuery } from '~/data-provider/Brain';
import { useHasAccess, useLocalize } from '~/hooks';
import { useShareContext } from '~/Providers';
import { useOptionalBrainDialog } from './Dialog';
import { sourceHref } from './layout';
import './brain.css';

const statusKeys = {
  empty: 'com_ui_brain_usage_empty',
  disabled: 'com_ui_brain_usage_disabled',
  unavailable: 'com_ui_brain_recall_unavailable',
} as const;
const nodeStatusKeys = {
  active: 'com_ui_brain_usage_active',
  uncertain: 'com_ui_brain_uncertain',
  superseded: 'com_ui_brain_superseded',
} as const;
const basisKeys = {
  direct: 'com_ui_brain_basis_direct',
  confirmed: 'com_ui_brain_basis_confirmed',
  derived: 'com_ui_brain_derived',
} as const;
const sourceKeys = {
  chat: 'com_ui_brain_open_chat',
  manual: 'com_ui_brain_manual_source',
  memory: 'com_ui_brain_imported_source',
} as const;
const claimKeys = {
  stated: 'com_ui_brain_claim_stated',
  agreed: 'com_ui_brain_claim_agreed',
  planned: 'com_ui_brain_claim_planned',
  completed: 'com_ui_brain_claim_completed',
  revoked: 'com_ui_brain_claim_revoked',
} as const;

export function usageFromRecalls(
  recalls: BrainRecall[],
  messageId: string,
): BrainUsage | undefined {
  const matches = recalls.filter(
    (recall) => recall.messageId === messageId && recall.provided === true,
  );
  if (!matches.length) return;
  const ids = new Set(matches.flatMap((recall) => recall.nodeIds));
  const items = new Map<string, BrainUsageItem>();
  for (const recall of matches) {
    for (const item of recall.items ?? []) {
      if (ids.has(item.id)) items.set(`${item.id}:${item.updatedAt ?? ''}`, item);
    }
  }
  return { status: ids.size ? 'available' : 'empty', count: ids.size, items: [...items.values()] };
}

export default function Usage({
  usage,
  loading = false,
  error = false,
  open: controlledOpen,
  onOpenChange,
  className = '',
}: {
  usage?: BrainUsage;
  loading?: boolean;
  error?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const t = useLocalize();
  const brain = useOptionalBrainDialog();
  const [localOpen, setLocalOpen] = useState(false);
  const titleId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const content = () => {
    if (loading) return <p role="status">{t('com_ui_brain_loading')}</p>;
    if (error) return <p role="alert">{t('com_ui_brain_recall_unavailable')}</p>;
    if (!usage) return <p>{t('com_ui_brain_usage_unrecorded')}</p>;
    if (usage.status !== 'available') return <p>{t(statusKeys[usage.status])}</p>;
    return (
      <>
        <p className="brain-muted">{t('com_ui_brain_usage_context', { count: usage.count })}</p>
        {!usage.items?.length && <p>{t('com_ui_brain_usage_legacy')}</p>}
        <ul className="brain-usage-items">
          {usage.items?.map((item, index) => (
            <li key={`${item.id}:${index}`}>
              <strong>{item.title}</strong>
              {item.text && <p className="brain-usage-text">{item.text}</p>}
              {item.textTruncated && (
                <p className="brain-muted">{t('com_ui_brain_usage_excerpt')}</p>
              )}
              {item.updatedAt && (
                <p className="brain-muted">
                  {t('com_ui_brain_usage_updated', {
                    date: new Date(item.updatedAt).toLocaleString(),
                  })}
                </p>
              )}
              <div className="brain-node-badges">
                {item.scope && <span>{item.scope}</span>}
                {item.status && <span>{t(nodeStatusKeys[item.status])}</span>}
                {item.claimState && <span>{t(claimKeys[item.claimState])}</span>}
                {item.basis && <span>{t(basisKeys[item.basis])}</span>}
              </div>
              {(item.validFrom || item.validUntil) && (
                <dl className="brain-validity">
                  {item.validFrom && (
                    <div>
                      <dt>{t('com_ui_brain_valid_from')}</dt>
                      <dd>{new Date(item.validFrom).toLocaleDateString()}</dd>
                    </div>
                  )}
                  {item.validUntil && (
                    <div>
                      <dt>{t('com_ui_brain_valid_until')}</dt>
                      <dd>{new Date(item.validUntil).toLocaleDateString()}</dd>
                    </div>
                  )}
                </dl>
              )}
              <div className="brain-usage-sources">
                <span>{t('com_ui_brain_sources')}:</span>
                {item.sources.map((source, sourceIndex) => {
                  const href =
                    source.type === 'chat' ? sourceHref(source.conversationId) : undefined;
                  const label = t(sourceKeys[source.type]);
                  return href ? (
                    <a key={sourceIndex} href={href}>
                      {label}
                      <ArrowUpRight size={12} />
                    </a>
                  ) : (
                    <span key={sourceIndex}>{label}</span>
                  );
                })}
                {!item.sources.length && <span>{t('com_ui_brain_no_source')}</span>}
              </div>
              {brain && (
                <button
                  type="button"
                  className="brain-text-button"
                  onClick={() => {
                    brain.triggerRef.current = trigger.current;
                    setOpen(false);
                    brain.showBrain(item.id);
                  }}
                >
                  {t('com_ui_brain_usage_details')}
                  <ArrowUpRight size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      </>
    );
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          ref={trigger}
          type="button"
          className={`brain-usage-trigger ${className}`}
          aria-label={t('com_ui_brain_usage_title')}
          title={t('com_ui_brain_usage_title')}
        >
          <Brain size={15} aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="brain-usage-popover"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-labelledby={titleId}
        >
          <header>
            <h3 id={titleId}>{t('com_ui_brain_usage_title')}</h3>
            <Popover.Close asChild>
              <button type="button" className="brain-icon-button" aria-label={t('com_ui_close')}>
                <X size={15} />
              </button>
            </Popover.Close>
          </header>
          {content()}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function MessageUsage({
  conversationId,
  messageId,
}: {
  conversationId?: string | null;
  messageId: string;
}) {
  const [open, setOpen] = useState(false);
  const { shareId } = useShareContext();
  const canRead = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.READ,
  });
  const { data: status } = useBrainStatusQuery(canRead && !shareId);
  const enabled = canRead && !shareId && status?.enabled === true;
  const query = useBrainRecallsQuery(conversationId ?? undefined, !!enabled && open, messageId);
  if (!enabled || !conversationId || conversationId === 'new') return null;
  return (
    <Usage
      key={`${conversationId}:${messageId}`}
      usage={usageFromRecalls(query.data?.recalls ?? [], messageId)}
      loading={open && query.isLoading}
      error={query.isError}
      open={open}
      onOpenChange={setOpen}
    />
  );
}
