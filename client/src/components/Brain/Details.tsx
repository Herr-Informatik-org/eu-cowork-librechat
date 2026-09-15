import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@librechat/client';
import { isAxiosError } from 'axios';
import { ArrowUpRight, Check, ChevronLeft, Pencil, Pin, Trash2, X } from 'lucide-react';
import type { BrainNode, BrainNodeInput, BrainEdge } from 'librechat-data-provider';
import useLocalize from '~/hooks/useLocalize';
import { useBrainMutations, useBrainNodeQuery } from '~/data-provider/Brain';
import { brainKinds, kindColors, kindKeys, sourceHref } from './layout';

const claimStateKeys = {
  stated: 'com_ui_brain_claim_stated',
  agreed: 'com_ui_brain_claim_agreed',
  planned: 'com_ui_brain_claim_planned',
  completed: 'com_ui_brain_claim_completed',
  revoked: 'com_ui_brain_claim_revoked',
} as const;
const basisKeys = {
  direct: 'com_ui_brain_basis_direct',
  confirmed: 'com_ui_brain_basis_confirmed',
  derived: 'com_ui_brain_derived',
} as const;

export function NodeForm({
  node,
  onSave,
  onCancel,
  pending,
  error,
}: {
  node?: BrainNode;
  onSave: (input: BrainNodeInput) => void;
  onCancel: () => void;
  pending: boolean;
  error?: string;
}) {
  const localize = useLocalize();
  const [title, setTitle] = useState(node?.title ?? '');
  const [text, setText] = useState(node?.text ?? '');
  const [kind, setKind] = useState(node?.kind ?? 'fact');
  const [scope, setScope] = useState(node?.scope ?? '');
  const titleRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, []);
  return (
    <form
      className="brain-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ title: title.trim(), text: text.trim(), kind, scope: scope.trim() || null });
      }}
    >
      <label>
        {localize('com_ui_brain_title_label')}
        <input
          ref={titleRef}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          required
          maxLength={160}
        />
      </label>
      <label>
        {localize('com_ui_brain_content_label')}
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          required
          maxLength={12_000}
          rows={7}
        />
      </label>
      <label>
        {localize('com_ui_brain_kind_label')}
        <select value={kind} onChange={(event) => setKind(event.target.value as BrainNode['kind'])}>
          {brainKinds.map((value) => (
            <option key={value} value={value}>
              {localize(kindKeys[value])}
            </option>
          ))}
        </select>
      </label>
      <label>
        {localize('com_ui_brain_scope_label')}
        <input
          value={scope}
          onChange={(event) => setScope(event.target.value)}
          maxLength={120}
          placeholder={localize('com_ui_brain_scope_placeholder')}
        />
      </label>
      {error && (
        <p role="alert" className="brain-error">
          {error}
        </p>
      )}
      <div className="brain-form-actions">
        <Button
          variant="outline"
          size="sm"
          className="brain-button"
          type="button"
          onClick={onCancel}
        >
          {localize('com_ui_cancel')}
        </Button>
        <Button
          variant="default"
          size="sm"
          className="brain-button"
          type="submit"
          disabled={pending || !title.trim() || !text.trim()}
        >
          {pending ? localize('com_ui_brain_saving') : localize('com_ui_save')}
        </Button>
      </div>
    </form>
  );
}

export function CreateNode({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const localize = useLocalize();
  const { create } = useBrainMutations();
  return (
    <aside className="brain-details">
      <div className="brain-details-heading">
        <h2>{localize('com_ui_brain_create')}</h2>
        <button
          type="button"
          className="brain-icon-button"
          onClick={onClose}
          aria-label={localize('com_ui_close')}
        >
          <X size={18} />
        </button>
      </div>
      <p className="brain-muted">{localize('com_ui_brain_create_hint')}</p>
      <NodeForm
        onCancel={onClose}
        onSave={(data) => create.mutate(data, { onSuccess: ({ node }) => onCreated(node.id) })}
        pending={create.isLoading}
        error={create.isError ? localize('com_ui_brain_save_failed') : undefined}
      />
    </aside>
  );
}

export default function Details({
  id,
  nodes,
  edges,
  canEdit,
  generationId,
  onClose,
  onSelect,
  onNavigate,
}: {
  id: string;
  nodes: BrainNode[];
  edges: BrainEdge[];
  canEdit: boolean;
  generationId?: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNavigate?: () => void;
}) {
  const localize = useLocalize();
  const query = useBrainNodeQuery(id, generationId);
  const { update, forget } = useBrainMutations();
  const [editing, setEditing] = useState(false);
  const [editVersion, setEditVersion] = useState<number | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const [conflict, setConflict] = useState(false);
  const node = query.data?.node ?? nodes.find((item) => item.id === id);
  const nodeEdges = query.data?.edges ?? edges.filter((edge) => edge.from === id || edge.to === id);
  const confidenceKey =
    node?.confidence === 'confirmed' ? 'com_ui_brain_confirmed' : 'com_ui_brain_derived';
  if (query.isError)
    return (
      <aside className="brain-details">
        <button className="brain-text-button" onClick={onClose}>
          <ChevronLeft size={16} />
          {localize('com_ui_brain_back')}
        </button>
        <p role="alert" className="brain-error">
          {localize('com_ui_brain_node_unavailable')}
        </p>
        <Button
          variant="outline"
          size="sm"
          className="brain-button"
          onClick={() => query.refetch()}
        >
          {localize('com_ui_brain_retry')}
        </Button>
      </aside>
    );
  if (!node)
    return (
      <aside className="brain-details" role="status">
        {localize('com_ui_brain_loading')}
      </aside>
    );

  const evidenceSources = node.sources.filter((source) => !source.dependency || source.excerpt);
  const contextSourceCount =
    node.sourceDependencyCount ?? node.sources.length - evidenceSources.length;

  const save = (input: BrainNodeInput) =>
    update.mutate(
      { id, data: { ...input, version: editVersion ?? node.version } },
      {
        onSuccess: () => {
          setEditing(false);
          setConflict(false);
        },
        onError: (error) => {
          if (isAxiosError(error) && error.response?.status === 409) {
            setConflict(true);
            query.refetch().then(({ data }) => {
              if (data) setEditVersion(data.node.version);
            });
          }
        },
      },
    );

  return (
    <aside className="brain-details" aria-label={localize('com_ui_brain_details')}>
      <div className="brain-details-heading">
        <span className="brain-kind" style={{ color: kindColors[node.kind] }}>
          <span />
          {localize(kindKeys[node.kind])}
        </span>
        <button
          type="button"
          className="brain-icon-button"
          onClick={onClose}
          aria-label={localize('com_ui_close')}
        >
          <X size={18} />
        </button>
      </div>
      {editing ? (
        <>
          <h2>{localize('com_ui_brain_edit')}</h2>
          {conflict && (
            <div className="brain-conflict" role="alert">
              <p>{localize('com_ui_brain_conflict')}</p>
              <blockquote>{node.text}</blockquote>
            </div>
          )}
          <NodeForm
            node={node}
            onSave={save}
            onCancel={() => {
              setEditing(false);
              setConflict(false);
              update.reset();
            }}
            pending={update.isLoading || (conflict && query.isFetching)}
            error={update.isError && !conflict ? localize('com_ui_brain_save_failed') : undefined}
          />
        </>
      ) : (
        <>
          <h2 className="brain-node-title">{node.title}</h2>
          <div className="brain-node-badges">
            <span>{localize(node.basis ? basisKeys[node.basis] : confidenceKey)}</span>
            {node.status !== 'active' && (
              <span>
                {node.status === 'superseded'
                  ? localize('com_ui_brain_superseded')
                  : localize('com_ui_brain_uncertain')}
              </span>
            )}
            {node.scope && <span>{node.scope}</span>}
            {node.claimState && <span>{localize(claimStateKeys[node.claimState])}</span>}
          </div>
          <p className="brain-node-text">{node.text}</p>
          {(node.validFrom || node.validUntil) && (
            <dl className="brain-validity">
              {node.validFrom && (
                <div>
                  <dt>{localize('com_ui_brain_valid_from')}</dt>
                  <dd>{new Date(node.validFrom).toLocaleDateString()}</dd>
                </div>
              )}
              {node.validUntil && (
                <div>
                  <dt>{localize('com_ui_brain_valid_until')}</dt>
                  <dd>{new Date(node.validUntil).toLocaleDateString()}</dd>
                </div>
              )}
            </dl>
          )}
          {canEdit && (
            <div className="brain-node-actions">
              <Button
                variant="outline"
                size="sm"
                type="button"
                className="brain-button"
                onClick={() => {
                  setEditVersion(node.version);
                  setEditing(true);
                }}
              >
                <Pencil size={14} />
                {localize('com_ui_brain_edit')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                type="button"
                className="brain-button"
                aria-pressed={node.pinned}
                disabled={update.isLoading}
                onClick={() =>
                  update.mutate({ id, data: { pinned: !node.pinned, version: node.version } })
                }
              >
                <Pin size={14} />
                {node.pinned ? localize('com_ui_brain_unpin') : localize('com_ui_brain_pin')}
              </Button>
              {node.status === 'uncertain' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="brain-button"
                  disabled={update.isLoading}
                  onClick={() =>
                    update.mutate({ id, data: { status: 'active', version: node.version } })
                  }
                >
                  <Check size={14} />
                  {localize('com_ui_brain_mark_current')}
                </Button>
              )}
            </div>
          )}
          {update.isError && (
            <p className="brain-error" role="alert">
              {isAxiosError(update.error) && update.error.response?.status === 409
                ? localize('com_ui_brain_changed_reload')
                : localize('com_ui_brain_save_failed')}
              <button
                className="brain-text-button"
                onClick={() => {
                  query.refetch();
                  update.reset();
                }}
              >
                {localize('com_ui_brain_retry')}
              </button>
            </p>
          )}
          {node.tags.length > 0 && (
            <div className="brain-tags">
              {node.tags.map((tag) => (
                <span key={tag}>#{tag}</span>
              ))}
            </div>
          )}
          <section className="brain-detail-section">
            <h3>{localize('com_ui_brain_sources')}</h3>
            {evidenceSources.length === 0 ? (
              <p className="brain-muted">{localize('com_ui_brain_no_source')}</p>
            ) : (
              <ol className="brain-source-list">
                {[...evidenceSources]
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .map((source) => {
                    const href =
                      source.type === 'chat' ? sourceHref(source.conversationId) : undefined;
                    return (
                      <li key={source.id}>
                        <span className="brain-source-date">
                          {new Date(source.createdAt).toLocaleDateString()}
                        </span>
                        {source.role && (
                          <span className="brain-source-role">
                            {source.role === 'assistant'
                              ? localize('com_ui_brain_source_assistant')
                              : localize('com_ui_brain_source_user')}
                          </span>
                        )}
                        {source.dependency && (
                          <span className="brain-muted">
                            {localize('com_ui_brain_source_context')}
                          </span>
                        )}
                        {href ? (
                          <a href={href} onClick={onNavigate}>
                            {source.label || localize('com_ui_brain_open_chat')}
                            <ArrowUpRight size={14} />
                          </a>
                        ) : (
                          <strong>
                            {source.type === 'manual'
                              ? localize('com_ui_brain_manual_source')
                              : source.label || localize('com_ui_brain_imported_source')}
                          </strong>
                        )}
                        {source.excerpt && <blockquote>{source.excerpt}</blockquote>}
                      </li>
                    );
                  })}
              </ol>
            )}
            {contextSourceCount > 0 && (
              <details className="brain-source-context">
                <summary>
                  {localize('com_ui_brain_source_context_count', { count: contextSourceCount })}
                </summary>
                <p className="brain-muted">{localize('com_ui_brain_source_context_explanation')}</p>
              </details>
            )}
          </section>
          {nodeEdges.length > 0 && (
            <section className="brain-detail-section">
              <h3>{localize('com_ui_brain_connections')}</h3>
              <ul className="brain-related-list">
                {nodeEdges.map((edge) => {
                  const otherId = edge.from === id ? edge.to : edge.from;
                  const related = nodes.find((item) => item.id === otherId);
                  return (
                    <li key={edge.id}>
                      <button type="button" onClick={() => onSelect(otherId)}>
                        <span>{related?.title ?? localize('com_ui_brain_related_memory')}</span>
                        <small>{edge.label}</small>
                        <ArrowUpRight size={14} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <div className="brain-updated">
            {localize('com_ui_brain_updated', {
              date: new Date(node.updatedAt).toLocaleDateString(),
              version: node.version,
            })}
          </div>
          {canEdit && (
            <div className="brain-forget-area">
              {confirmForget ? (
                <>
                  <p>{localize('com_ui_brain_forget_confirm')}</p>
                  <div className="brain-form-actions">
                    <Button
                      variant="outline"
                      size="sm"
                      className="brain-button"
                      onClick={() => setConfirmForget(false)}
                      disabled={forget.isLoading}
                    >
                      {localize('com_ui_cancel')}
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="brain-button"
                      onClick={() => forget.mutate(id, { onSuccess: onClose })}
                      data-testid="brain-forget-confirm"
                      disabled={forget.isLoading}
                    >
                      {localize('com_ui_brain_forget')}
                    </Button>
                  </div>
                </>
              ) : (
                <button className="brain-text-button" onClick={() => setConfirmForget(true)}>
                  <Trash2 size={14} />
                  {localize('com_ui_brain_forget')}
                </button>
              )}
              {forget.isError && (
                <p role="alert" className="brain-error">
                  {localize('com_ui_brain_forget_failed')}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </aside>
  );
}
