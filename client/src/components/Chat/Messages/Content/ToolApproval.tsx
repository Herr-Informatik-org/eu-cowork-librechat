import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Button, TextareaAutosize } from '@librechat/client';
import { Pencil, TriangleAlert } from 'lucide-react';
import { SystemRoles, PROPOSAL_REJECTED_REASON } from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';
import type { ProposalStatus } from './Proposal';
import { useApprovalContext, useResumeSubmit } from './ApprovalContext';
import { ProposalCard, rememberDecision } from './Proposal';
import { AuthContext } from '~/hooks/AuthContext';
import { useLocalize } from '~/hooks';
import { cn, logger } from '~/utils';

/**
 * The resume route rejects an `edit` whose `editedArguments` isn't a plain object
 * (`findIncompleteDecisions`), so mirror that here — `JSON.parse` alone also accepts
 * `null`/arrays/primitives, which would enable Submit for a value that can only 400.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type Choice = 'approve' | 'reject';

/** Pretty-print tool args as JSON for the administrator's edit textarea. */
function seedArgs(args: string | Record<string, unknown> | undefined): string {
  if (args == null) {
    return '{}';
  }
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch (e) {
    logger.error('ToolApproval - failed to stringify args', e);
    return '{}';
  }
}

function parseEdit(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * A paused tool call as a proposal card (V5): «Verwerfen» / «Übernehmen», no
 * autofocus, the status badge stays after the decision and takes the focus.
 * A single paused call submits on click; several calls of one action share the
 * lead card's submit. Editing the arguments is reserved for administrators.
 */
export default function ToolApproval({
  approval,
  toolCallId,
  args,
  name = '',
}: {
  approval: NonNullable<Agents.ToolCall['approval']>;
  toolCallId: string;
  args: string | Record<string, unknown> | undefined;
  name?: string;
}) {
  const localize = useLocalize();
  const auth = useContext(AuthContext);
  const isAdmin = auth?.user?.role === SystemRoles.ADMIN;
  const { actionId, allowed_decisions: allowedDecisions, description } = approval;
  const {
    registerToolCall,
    unregisterToolCall,
    setDecision,
    getDecision,
    isReady,
    getStatus,
    getLeadToolCallId,
    getRegisteredCount,
  } = useApprovalContext();
  const { submitToolApproval } = useResumeSubmit();

  const [choice, setChoice] = useState<Choice | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(() => seedArgs(args));
  const badgeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    registerToolCall(actionId, toolCallId);
    // Drop the registration when this card unmounts (e.g. the tool resolved and the
    // card was replaced) so a stale entry can't keep the batch's `isReady` false.
    return () => unregisterToolCall(actionId, toolCallId);
  }, [registerToolCall, unregisterToolCall, actionId, toolCallId]);

  const status = getStatus(actionId);
  const locked = status === 'submitting' || status === 'submitted' || status === 'expired';
  const showActions = status !== 'submitted' && status !== 'expired';
  const submitting = status === 'submitting';
  const count = getRegisteredCount(actionId);
  const batched = count > 1;
  const isLead = getLeadToolCallId(actionId) === toolCallId;
  const canApprove = allowedDecisions.includes('approve');
  const canReject = allowedDecisions.includes('reject');
  const canEdit = isAdmin && allowedDecisions.includes('edit');
  const editedArgs = useMemo(() => (editing ? parseEdit(editText) : null), [editing, editText]);

  const buildResolution = (next: Choice): Agents.ToolApprovalResolution | null => {
    if (next === 'reject') {
      return { tool_call_id: toolCallId, decision: 'reject', reason: PROPOSAL_REJECTED_REASON };
    }
    if (!editing) {
      return { tool_call_id: toolCallId, decision: 'approve' };
    }
    return editedArgs != null
      ? { tool_call_id: toolCallId, decision: 'edit', editedArguments: editedArgs }
      : null;
  };

  const decide = (next: Choice) => {
    if (locked) {
      return;
    }
    if (batched && choice === next) {
      setChoice(null);
      setDecision(actionId, toolCallId, null);
      return;
    }
    const resolution = buildResolution(next);
    if (resolution == null) {
      return;
    }
    setChoice(next);
    setDecision(actionId, toolCallId, resolution);
    if (!batched) {
      submitToolApproval(actionId);
    }
  };

  /** Keep an approved edit in sync while an administrator keeps typing. */
  useEffect(() => {
    if (locked || choice !== 'approve' || !editing) {
      return;
    }
    setDecision(
      actionId,
      toolCallId,
      editedArgs != null
        ? { tool_call_id: toolCallId, decision: 'edit', editedArguments: editedArgs }
        : null,
    );
  }, [locked, choice, editing, editedArgs, setDecision, actionId, toolCallId]);

  useEffect(() => {
    if (status !== 'submitted') {
      return;
    }
    const decided = getDecision(actionId, toolCallId)?.decision ?? choice;
    if (decided == null) {
      return;
    }
    rememberDecision(toolCallId, decided === 'reject' ? 'rejected' : 'approved');
    badgeRef.current?.focus();
  }, [status, getDecision, actionId, toolCallId, choice]);

  const cardStatus: ProposalStatus = (() => {
    if (status === 'submitted') {
      return choice === 'reject' ? 'rejected' : 'approved';
    }
    if (status === 'submitting' || status === 'expired' || status === 'error') {
      return status;
    }
    return 'open';
  })();

  const ready = isReady(actionId);
  const submitLabel =
    status === 'submitting'
      ? localize('com_ui_submitting')
      : localize('com_ui_proposal_submit_n', { 0: count });

  return (
    <ProposalCard
      name={name}
      args={editing && editedArgs != null ? editedArgs : args}
      description={description}
      status={cardStatus}
      compact={status === 'submitted'}
      badgeRef={badgeRef}
    >
      {canEdit && editing && !locked && (
        <div className="flex flex-col gap-1">
          <TextareaAutosize
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            minRows={3}
            maxRows={16}
            className={cn(
              'w-full resize-none rounded-md border bg-surface-primary p-2 font-mono text-xs',
              editedArgs != null ? 'border-border-light' : 'border-red-500',
            )}
            aria-label={localize('com_ui_edit')}
          />
          {editedArgs == null && (
            <span className="text-xs text-text-warning">{localize('com_ui_invalid_json')}</span>
          )}
        </div>
      )}
      {showActions && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canEdit && (
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={editing}
              disabled={submitting}
              onClick={() => setEditing((prev) => !prev)}
              className="mr-auto inline-flex items-center gap-1.5"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
              {localize('com_ui_edit')}
            </Button>
          )}
          {canReject && (
            <Button
              size="sm"
              variant="outline"
              aria-pressed={batched ? choice === 'reject' : undefined}
              disabled={submitting}
              onClick={() => decide('reject')}
            >
              {submitting && !batched && choice === 'reject'
                ? localize('com_ui_submitting')
                : localize('com_ui_proposal_reject')}
            </Button>
          )}
          {canApprove && (
            <Button
              size="sm"
              variant={batched && choice !== 'approve' ? 'outline' : 'submit'}
              aria-pressed={batched ? choice === 'approve' : undefined}
              disabled={submitting || (editing && editedArgs == null)}
              onClick={() => decide('approve')}
            >
              {submitting && !batched && choice === 'approve'
                ? localize('com_ui_submitting')
                : localize('com_ui_proposal_approve')}
            </Button>
          )}
        </div>
      )}
      {batched && isLead && showActions && (
        <div className="flex items-center justify-end">
          <Button
            size="sm"
            variant="submit"
            disabled={!ready || submitting}
            onClick={() => submitToolApproval(actionId)}
          >
            {submitLabel}
          </Button>
        </div>
      )}
      {(status === 'expired' || status === 'error') && (
        <p className="flex items-center text-xs text-text-warning">
          <TriangleAlert className="mr-1.5 h-4 w-4" aria-hidden="true" />
          {localize(status === 'expired' ? 'com_ui_approval_expired' : 'com_ui_approval_error')}
        </p>
      )}
    </ProposalCard>
  );
}
