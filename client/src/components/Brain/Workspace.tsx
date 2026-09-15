import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@librechat/client';
import {
  Download,
  Network,
  List,
  LockKeyhole,
  Plus,
  Search,
  X,
  ArrowUpRight,
  Pin,
} from 'lucide-react';
import { useParams } from 'react-router-dom';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import type { BrainKind, BrainNode } from 'librechat-data-provider';
import { useHasAccess, useLocalize } from '~/hooks';
import {
  useBrainGraphQuery,
  useBrainMutations,
  useBrainRecallsQuery,
  useBrainProgress,
} from '~/data-provider/Brain';
import { brainKinds, kindColors, kindKeys, mergeBrainPages } from './layout';
import Details, { CreateNode } from './Details';
import Graph from './Graph';
import History from './History';

function RecallTrace({ nodes, onSelect }: { nodes: BrainNode[]; onSelect: (id: string) => void }) {
  const localize = useLocalize();
  const { conversationId } = useParams();
  const { data, isError } = useBrainRecallsQuery(conversationId);
  const recall = data?.recalls[0];
  if (!recall && !isError) return null;
  return (
    <section className="brain-recall" aria-label={localize('com_ui_brain_recall_title')}>
      <div>
        <span className="brain-eyebrow">{localize('com_ui_brain_recall_title')}</span>
        <p>
          {isError
            ? localize('com_ui_brain_recall_unavailable')
            : localize('com_ui_brain_recall_description')}
        </p>
      </div>
      {recall && (
        <>
          <div className="brain-recall-nodes">
            {recall.nodeIds.length === 0 ? (
              <span className="brain-muted">{localize('com_ui_brain_recall_empty')}</span>
            ) : (
              recall.nodeIds.map((id) => (
                <button key={id} onClick={() => onSelect(id)}>
                  {nodes.find((node) => node.id === id)?.title ??
                    localize('com_ui_brain_related_memory')}
                  <ArrowUpRight size={12} />
                </button>
              ))
            )}
          </div>
          {recall.hasMore && <p className="brain-muted">{localize('com_ui_brain_recall_more')}</p>}
        </>
      )}
    </section>
  );
}

export default function Workspace({
  onClose,
  initialSelectedId,
}: {
  onClose: () => void;
  initialSelectedId?: string | null;
}) {
  const localize = useLocalize();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<BrainKind | ''>('');
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId ?? null);
  const [creating, setCreating] = useState(false);
  const canCreate = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.CREATE,
  });
  const canRead = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.READ,
  });
  const canEdit = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.UPDATE,
  });
  const progress = useBrainProgress(canCreate && canRead);
  const generationId = progress.rebuild.rebuild.data?.rebuild?.id;
  const isDraft = !!generationId;
  const graph = useBrainGraphQuery(
    { query, limit: 500, ...(generationId ? { generationId } : {}) },
    !(canCreate && canRead) || progress.rebuild.rebuild.data !== undefined,
  );
  const { download } = useBrainMutations();
  const previousGeneration = useRef(generationId);
  useEffect(() => {
    if (previousGeneration.current === generationId) return;
    previousGeneration.current = generationId;
    setSelectedId(null);
    setCreating(false);
  }, [generationId]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 220);
    return () => clearTimeout(timer);
  }, [search]);
  const { nodes, edges } = useMemo(() => mergeBrainPages(graph.data?.pages), [graph.data]);
  const visibleNodes = useMemo(
    () => (kind ? nodes.filter((node) => node.kind === kind) : nodes),
    [nodes, kind],
  );
  const mapNodes = useMemo(() => visibleNodes.slice(0, 1000), [visibleNodes]);
  const total = graph.data?.pages[0]?.total ?? 0;
  const select = (id: string) => {
    setSelectedId(id);
    setCreating(false);
  };
  const clear = () => {
    setSelectedId(null);
    setCreating(false);
  };
  const exportData = () =>
    download.mutate(undefined, {
      onSuccess: (data) => {
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
        );
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `brain-${new Date().toISOString().slice(0, 10)}.json`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
    });

  return (
    <div
      data-testid="brain-workspace"
      className={[
        'brain-workspace',
        view === 'list' && 'brain-list-mode',
        (selectedId || creating) && 'brain-has-detail',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <header className="brain-header">
        <div>
          <span className="brain-eyebrow">
            <span className="brain-status-dot" />
            {localize('com_ui_brain_personal')}
          </span>
          <h1>{localize('com_ui_brain_title')}</h1>
          <p>{localize('com_ui_brain_subtitle')}</p>
        </div>
        <div className="brain-header-actions">
          <span className="brain-private">
            <LockKeyhole size={13} />
            {localize('com_ui_brain_private')}
          </span>
          <button
            type="button"
            className="brain-icon-button"
            onClick={onClose}
            aria-label={localize('com_ui_close')}
          >
            <X size={20} />
          </button>
        </div>
      </header>
      <div className="brain-toolbar">
        <div className="brain-view-switch" role="group" aria-label={localize('com_ui_brain_view')}>
          <button aria-pressed={view === 'graph'} onClick={() => setView('graph')}>
            <Network size={15} />
            {localize('com_ui_brain_map')}
          </button>
          <button aria-pressed={view === 'list'} onClick={() => setView('list')}>
            <List size={16} />
            {localize('com_ui_brain_list')}
          </button>
        </div>
        <label className="brain-search">
          <Search size={16} />
          <input
            type="search"
            data-testid="brain-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={localize('com_ui_brain_search')}
            aria-label={localize('com_ui_brain_search')}
          />
        </label>
        <select
          className="brain-filter"
          value={kind}
          onChange={(event) => setKind(event.target.value as BrainKind | '')}
          aria-label={localize('com_ui_brain_kind_label')}
        >
          <option value="">{localize('com_ui_brain_all_kinds')}</option>
          {brainKinds.map((value) => (
            <option key={value} value={value}>
              {localize(kindKeys[value])}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="brain-icon-button"
          onClick={exportData}
          disabled={isDraft || download.isLoading || graph.isLoading || graph.isError}
          aria-label={localize('com_ui_brain_export')}
          title={localize('com_ui_brain_export')}
        >
          <Download size={17} />
        </button>
        {canCreate && !isDraft && (
          <Button
            variant="default"
            size="sm"
            className="brain-button"
            data-testid="brain-create"
            onClick={() => {
              setCreating(true);
              setSelectedId(null);
            }}
          >
            <Plus size={15} />
            <span>{localize('com_ui_brain_create')}</span>
          </Button>
        )}
      </div>
      <History enabled={canCreate && canRead} progress={progress} />
      {isDraft && (
        <div className="brain-draft-banner" role="status">
          <span className="brain-draft-badge">{localize('com_ui_brain_rebuild_draft')}</span>
          <p>{localize('com_ui_brain_rebuild_live_preview')}</p>
        </div>
      )}
      {download.isError && (
        <p role="alert" className="brain-inline-error">
          {localize('com_ui_brain_export_failed')}
        </p>
      )}
      <div className="brain-body">
        <main className="brain-main">
          <div className="brain-map-heading">
            <span>{localize('com_ui_brain_map_heading')}</span>
            <span>{localize('com_ui_brain_map_count', { count: mapNodes.length, total })}</span>
          </div>
          <Graph nodes={mapNodes} edges={edges} selectedId={selectedId} onSelect={select} />
          {visibleNodes.length > 1000 && (
            <p className="brain-map-limit">{localize('com_ui_brain_map_limit')}</p>
          )}
          <div className="brain-map-footer">
            <span>{localize('com_ui_brain_map_hint')}</span>
            <span>{localize('com_ui_brain_connection_count', { count: edges.length })}</span>
          </div>
          {!isDraft && <RecallTrace nodes={nodes} onSelect={select} />}
        </main>
        <div className="brain-rail">
          {creating && !isDraft && <CreateNode onClose={clear} onCreated={(id) => select(id)} />}
          {!creating && selectedId && (
            <Details
              key={`${generationId ?? 'active'}:${selectedId}`}
              id={selectedId}
              nodes={nodes}
              edges={edges}
              canEdit={canEdit && !isDraft}
              generationId={generationId}
              onClose={clear}
              onSelect={select}
              onNavigate={onClose}
            />
          )}
          {!creating && !selectedId && (
            <>
              <div className="brain-list-heading">
                <h2>{localize('com_ui_brain_memories')}</h2>
                <span>
                  {visibleNodes.length}
                  {graph.hasNextPage ? '+' : ''}
                </span>
              </div>
              {graph.isLoading && (
                <div className="brain-empty" role="status">
                  <span className="brain-loader" />
                  <h3>{localize('com_ui_brain_loading')}</h3>
                </div>
              )}
              {graph.isError && (
                <div className="brain-empty" role="alert">
                  <h3>{localize('com_ui_brain_unavailable')}</h3>
                  <p>{localize('com_ui_brain_unavailable_hint')}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="brain-button"
                    onClick={() => graph.refetch()}
                  >
                    {localize('com_ui_brain_retry')}
                  </Button>
                </div>
              )}
              {!graph.isLoading && !graph.isError && visibleNodes.length === 0 && (
                <div className="brain-empty">
                  <Network size={28} strokeWidth={1} />
                  <h3>
                    {query || kind
                      ? localize('com_ui_brain_no_results')
                      : localize(
                          isDraft ? 'com_ui_brain_rebuild_draft_empty' : 'com_ui_brain_empty_title',
                        )}
                  </h3>
                  <p>
                    {query || kind
                      ? localize('com_ui_brain_no_results_hint')
                      : localize(
                          isDraft
                            ? 'com_ui_brain_rebuild_draft_empty_hint'
                            : 'com_ui_brain_empty_description',
                        )}
                  </p>
                  {!query && !kind && canCreate && !isDraft && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="brain-button"
                      onClick={() => setCreating(true)}
                    >
                      <Plus size={14} />
                      {localize('com_ui_brain_first_memory')}
                    </Button>
                  )}
                </div>
              )}
              {!graph.isLoading && !graph.isError && visibleNodes.length > 0 && (
                <ul className="brain-node-list" aria-label={localize('com_ui_brain_memories')}>
                  {visibleNodes.map((node) => (
                    <li key={node.id}>
                      <button
                        onClick={() => select(node.id)}
                        className={node.status === 'superseded' ? 'is-superseded' : ''}
                      >
                        <span
                          className="brain-list-dot"
                          style={{ background: kindColors[node.kind] }}
                        />
                        <span className="brain-list-content">
                          <span className="brain-list-title">
                            {node.title}
                            {node.pinned && <Pin size={11} />}
                          </span>
                          <span className="brain-list-excerpt">{node.text}</span>
                          <span className="brain-list-meta">
                            {localize(kindKeys[node.kind])}
                            <span>·</span>
                            {node.scope || new Date(node.updatedAt).toLocaleDateString()}
                          </span>
                        </span>
                        <ArrowUpRight size={13} className="brain-list-arrow" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {graph.hasNextPage && (
                <div className="brain-load-more">
                  <p>{localize('com_ui_brain_loaded_count', { count: nodes.length, total })}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="brain-button"
                    disabled={graph.isFetchingNextPage}
                    onClick={() => graph.fetchNextPage()}
                  >
                    {graph.isFetchingNextPage
                      ? localize('com_ui_brain_loading')
                      : localize('com_ui_brain_load_more')}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
