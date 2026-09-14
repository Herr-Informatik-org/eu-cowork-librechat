import React, { useMemo } from 'react';
import { ArrowUpRight, LockKeyhole, Network } from 'lucide-react';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { Switch } from '@librechat/client';
import { useHasAccess, useLocalize } from '~/hooks';
import { useGetUserQuery, useUpdateMemoryPreferencesMutation } from '~/data-provider';
import { useBrainGraphQuery } from '~/data-provider/Brain';
import { mergeBrainPages } from './layout';
import { useBrainDialog } from './Dialog';
import Graph from './Graph';
import './brain.css';

export default function BrainPanel() {
  const localize = useLocalize();
  const { showBrain, triggerRef } = useBrainDialog();
  const { data: user } = useGetUserQuery();
  const canOptOut = useHasAccess({
    permissionType: PermissionTypes.MEMORIES,
    permission: Permissions.OPT_OUT,
  });
  const graph = useBrainGraphQuery({ limit: 500 });
  const { nodes, edges } = useMemo(() => mergeBrainPages(graph.data?.pages), [graph.data]);
  const preferences = useUpdateMemoryPreferencesMutation();
  const active = user?.personalization?.memories !== false;
  return (
    <div className="brain-panel">
      <div className="brain-panel-intro">
        <span className="brain-eyebrow">
          <LockKeyhole size={12} />
          {localize('com_ui_brain_private')}
        </span>
        <h2>{localize('com_ui_brain_title')}</h2>
        <p>{localize('com_ui_brain_panel_intro')}</p>
      </div>
      <div className="brain-preview">
        <Graph nodes={nodes.slice(0, 200)} edges={edges} onSelect={showBrain} compact />
        <button
          type="button"
          ref={triggerRef}
          className="brain-preview-open"
          onClick={() => showBrain()}
        >
          <Network size={15} />
          {localize('com_ui_brain_explore')}
          <ArrowUpRight size={15} />
        </button>
      </div>
      {graph.isError ? (
        <div className="brain-panel-note" role="alert">
          {localize('com_ui_brain_unavailable')}
          <button className="brain-text-button" onClick={() => graph.refetch()}>
            {localize('com_ui_brain_retry')}
          </button>
        </div>
      ) : (
        <div className="brain-panel-count" role="status">
          <strong>{graph.isLoading ? '—' : (graph.data?.pages[0]?.total ?? 0)}</strong>
          <span>{localize('com_ui_brain_saved')}</span>
        </div>
      )}
      {!graph.isLoading && !graph.isError && nodes.length === 0 && (
        <p className="brain-panel-note">{localize('com_ui_brain_empty_description')}</p>
      )}
      <div className="brain-panel-preference">
        <div>
          <strong id="brain-toggle-label">{localize('com_ui_brain_active')}</strong>
          <p id="brain-toggle-description">
            {active
              ? localize('com_ui_brain_active_description')
              : localize('com_ui_brain_paused_description')}
          </p>
        </div>
        <Switch
          checked={active}
          disabled={!canOptOut || preferences.isLoading}
          aria-labelledby="brain-toggle-label"
          aria-describedby="brain-toggle-description"
          onCheckedChange={(memories) => preferences.mutate({ memories })}
        />
      </div>
      {preferences.isError && (
        <p className="brain-error" role="alert">
          {localize('com_ui_error_updating_preferences')}
        </p>
      )}
      <p className="brain-panel-footnote">{localize('com_ui_brain_private_description')}</p>
    </div>
  );
}
