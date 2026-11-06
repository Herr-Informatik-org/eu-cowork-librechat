import { useId, useMemo } from 'react';
import { Check, X, TriangleAlert, PencilLine, CircleSlash } from 'lucide-react';
import { classifyToolName, splitToolCallName, Constants } from 'librechat-data-provider';
import type { ReactNode, Ref } from 'react';
import type { TranslationKeys } from '~/hooks';
import type { ProposalField, ProposalTarget } from './values';
import type { ProposalOutcome } from './decisions';
import { getProposalTitle } from '~/utils/toolSteps';
import { useMCPServerNames } from '~/hooks/MCP';
import { buildProposalView } from './values';
import { useLocalize } from '~/hooks';
import './proposal.css';

export type ProposalStatus = 'open' | 'submitting' | 'error' | 'expired' | ProposalOutcome;

const BADGE_KEYS: Partial<Record<ProposalStatus, TranslationKeys>> = {
  approved: 'com_ui_proposal_approved',
  rejected: 'com_ui_proposal_rejected',
  planned: 'com_ui_proposal_planned',
  expired: 'com_ui_proposal_expired',
};

/** Readable labels for argument keys that appear in most write tools. */
const FIELD_LABEL_KEYS: Record<string, TranslationKeys> = {
  command: 'com_ui_proposal_field_command',
  code: 'com_ui_proposal_field_code',
  lang: 'com_ui_proposal_field_language',
  name: 'com_ui_proposal_field_name',
  email: 'com_ui_proposal_field_email',
  phone: 'com_ui_proposal_field_phone',
  mobile: 'com_ui_proposal_field_phone',
  subject: 'com_ui_proposal_field_subject',
  body: 'com_ui_proposal_field_text',
  description: 'com_ui_proposal_field_text',
  note: 'com_ui_proposal_field_text',
  date: 'com_ui_proposal_field_date',
  query: 'com_ui_proposal_field_query',
};

const BADGE_ICONS: Partial<Record<ProposalStatus, typeof Check>> = {
  approved: Check,
  rejected: X,
  planned: PencilLine,
  expired: CircleSlash,
};

function useTargetText(target: ProposalTarget, serverName: string): string | undefined {
  const localize = useLocalize();
  const parts: string[] = [];
  if (target.model != null) {
    parts.push(target.model);
  }
  if (target.ids != null) {
    parts.push(localize('com_ui_proposal_record', { 0: target.ids }));
  }
  if (target.path != null) {
    parts.push(target.path);
  }
  if (target.recipient != null) {
    parts.push(localize('com_ui_proposal_recipient', { 0: target.recipient }));
  }
  if (serverName !== '') {
    parts.push(localize('com_ui_via_server', { 0: serverName }));
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function FieldValue({ field }: { field: ProposalField }) {
  const localize = useLocalize();
  if (field.kind === 'yes') {
    return <>{localize('com_ui_yes')}</>;
  }
  if (field.kind === 'no') {
    return <>{localize('com_ui_no')}</>;
  }
  if (field.kind === 'empty') {
    return <span className="text-text-secondary">{localize('com_ui_proposal_empty')}</span>;
  }
  return <span title={field.full}>{field.value}</span>;
}

/**
 * A proposed tool call shown as a decision card: the intent as title, the target,
 * readable values instead of JSON, and a status badge that stays after the
 * decision. Actions are passed in as children so the same card serves the open
 * approval and the record of a decision.
 */
export default function ProposalCard({
  name,
  args,
  description,
  status,
  compact = false,
  badgeRef,
  children,
}: {
  name: string;
  args: unknown;
  description?: string;
  status: ProposalStatus;
  /** Decided cards show title, target and badge only; the values stay in the step detail. */
  compact?: boolean;
  badgeRef?: Ref<HTMLSpanElement>;
  children?: ReactNode;
}) {
  const localize = useLocalize();
  const titleId = useId();
  const serverNames = useMCPServerNames();
  const view = useMemo(() => buildProposalView(args), [args]);
  const serverName = useMemo(() => {
    if (!name.includes(Constants.mcp_delimiter)) {
      return '';
    }
    return splitToolCallName(name, serverNames)[1] ?? '';
  }, [name, serverNames]);
  const target = useTargetText(view.target, serverName);
  const critical = classifyToolName(name) === 'critical';
  const title = view.intent ?? getProposalTitle(name, localize);
  const badgeKey = BADGE_KEYS[status];
  const BadgeIcon = BADGE_ICONS[status];

  return (
    <section
      className="kisuno-proposal my-2 flex w-full flex-col gap-2"
      data-status={status}
      data-testid="proposal-card"
      aria-labelledby={titleId}
    >
      <div className="flex items-start gap-2">
        {critical && (
          <TriangleAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-text-warning"
            aria-label={localize('com_ui_proposal_critical')}
            role="img"
          />
        )}
        <h3 id={titleId} className="min-w-0 flex-1 text-sm font-medium text-text-primary">
          {title}
        </h3>
        {badgeKey != null && (
          <span
            ref={badgeRef}
            tabIndex={-1}
            className="kisuno-proposal-badge"
            data-status={status}
            role="status"
          >
            {BadgeIcon != null && <BadgeIcon className="h-3 w-3" aria-hidden="true" />}
            {localize(badgeKey)}
          </span>
        )}
      </div>
      {target != null && (
        <p className="text-xs text-text-secondary">
          <span className="sr-only">{localize('com_ui_proposal_target')}: </span>
          {target}
        </p>
      )}
      {!compact && description != null && description.length > 0 && (
        <p className="text-xs text-text-secondary">{description}</p>
      )}
      {!compact && view.fields.length > 0 && (
        <dl className="kisuno-proposal-fields" aria-label={localize('com_ui_proposal_values')}>
          {view.fields.map((field) => (
            <div key={field.key} className="contents">
              <dt>
                {FIELD_LABEL_KEYS[field.key] != null
                  ? localize(FIELD_LABEL_KEYS[field.key])
                  : field.label || localize('com_ui_proposal_input')}
              </dt>
              <dd>
                <FieldValue field={field} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      {!compact && view.moreCount > 0 && (
        <p className="text-xs text-text-secondary">
          {localize('com_ui_proposal_more_fields', { 0: view.moreCount })}
        </p>
      )}
      {children}
    </section>
  );
}
