import React, { memo, useId, useMemo, useState } from 'react';
import { Maximize2, Minus, Plus } from 'lucide-react';
import type { BrainEdge, BrainNode } from 'librechat-data-provider';
import useLocalize from '~/hooks/useLocalize';
import { brainKinds, kindColors, kindKeys, layoutBrain } from './layout';

function Graph({
  nodes,
  edges,
  selectedId,
  onSelect,
  compact = false,
}: {
  nodes: BrainNode[];
  edges: BrainEdge[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  compact?: boolean;
}) {
  const localize = useLocalize();
  const id = useId().replace(/:/g, '');
  const [zoom, setZoom] = useState(1);
  const [hovered, setHovered] = useState<string | null>(null);
  const layout = useMemo(() => layoutBrain(nodes, edges), [nodes, edges]);
  const byId = useMemo(() => new Map(layout.map((point) => [point.node.id, point])), [layout]);
  const focusId = hovered ?? selectedId;
  const focused = focusId ? byId.get(focusId) : undefined;
  const connected = useMemo(() => {
    const result = new Set(focusId ? [focusId] : []);
    for (const edge of edges) {
      if (edge.from === focusId) result.add(edge.to);
      if (edge.to === focusId) result.add(edge.from);
    }
    return result;
  }, [edges, focusId]);

  return (
    <div className={compact ? 'brain-map brain-map-compact' : 'brain-map'}>
      <svg
        viewBox={compact ? '105 35 630 570' : '0 0 840 640'}
        role="group"
        aria-label={localize('com_ui_brain_map_label')}
      >
        <defs>
          <radialGradient id={`${id}-halo`}>
            <stop offset="0%" stopColor="var(--text-tertiary)" stopOpacity=".08" />
            <stop offset="100%" stopColor="var(--surface-primary)" stopOpacity="0" />
          </radialGradient>
          <filter id={`${id}-glow`} x="-200%" y="-200%" width="500%" height="500%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>
        <circle cx="420" cy="320" r="315" fill={`url(#${id}-halo)`} />
        <g aria-hidden="true" className="brain-map-orbits">
          {[84, 150, 212, 268].map((radius) => (
            <circle
              key={radius}
              cx="420"
              cy="320"
              r={radius}
              fill="none"
              stroke="currentColor"
              strokeDasharray={radius === 268 ? '2 8' : undefined}
            />
          ))}
          {brainKinds.map((kind, index) => {
            const angle = ((-120 + index * 60) * Math.PI) / 180;
            return (
              <line
                key={kind}
                x1={420 + Math.cos(angle) * 90}
                y1={320 + Math.sin(angle) * 90}
                x2={420 + Math.cos(angle) * 260}
                y2={320 + Math.sin(angle) * 260}
                stroke="currentColor"
              />
            );
          })}
        </g>
        <g transform={`translate(420 320) scale(${zoom}) translate(-420 -320)`}>
          <g aria-hidden="true">
            {edges.map((edge) => {
              const from = byId.get(edge.from);
              const to = byId.get(edge.to);
              if (!from || !to) return null;
              const active = edge.from === focusId || edge.to === focusId;
              const inactiveOpacity = focusId ? 0.06 : 0.18;
              return (
                <line
                  key={edge.id}
                  x1={from.x}
                  y1={from.y}
                  x2={to.x}
                  y2={to.y}
                  stroke={active ? kindColors[from.node.kind] : 'var(--text-secondary)'}
                  strokeOpacity={active ? 0.75 : inactiveOpacity}
                  strokeWidth={active ? 1.4 : 0.7}
                />
              );
            })}
          </g>
          {layout.map(({ node, x, y, radius }) => (
            <g
              key={node.id}
              role="button"
              tabIndex={compact ? -1 : 0}
              aria-label={`${node.title} · ${localize(kindKeys[node.kind])}`}
              aria-pressed={node.id === selectedId}
              className="brain-map-node"
              style={{ opacity: focusId && !connected.has(node.id) ? 0.25 : 1 }}
              onClick={() => onSelect(node.id)}
              onFocus={() => setHovered(node.id)}
              onBlur={() => setHovered(null)}
              onMouseEnter={() => setHovered(node.id)}
              onMouseLeave={() => setHovered(null)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(node.id);
                }
              }}
            >
              <title>{node.title}</title>
              <circle cx={x} cy={y} r="16" fill="transparent" />
              <circle
                cx={x}
                cy={y}
                r={radius + 3}
                fill={kindColors[node.kind]}
                opacity=".2"
                filter={`url(#${id}-glow)`}
                aria-hidden="true"
              />
              <circle
                cx={x}
                cy={y}
                r={radius}
                fill={kindColors[node.kind]}
                fillOpacity={node.status === 'superseded' ? 0.3 : 0.94}
                stroke={node.id === selectedId ? 'var(--text-primary)' : 'var(--surface-primary)'}
                strokeWidth={node.id === selectedId ? 2 : 1}
              />
              {node.pinned && (
                <circle
                  cx={x}
                  cy={y}
                  r={radius + 4}
                  fill="none"
                  stroke={kindColors[node.kind]}
                  strokeOpacity=".55"
                />
              )}
            </g>
          ))}
        </g>
        <g aria-hidden="true" className="brain-map-center">
          <circle
            cx="420"
            cy="320"
            r="55"
            fill="var(--surface-dialog)"
            stroke="var(--border-medium)"
          />
          <circle cx="420" cy="320" r="61" fill="none" stroke="var(--border-light)" />
          <text
            x="420"
            y="319"
            textAnchor="middle"
            fill="var(--text-primary)"
            fontSize="13"
            letterSpacing="3.5"
          >
            BRAIN
          </text>
          <text
            x="420"
            y="338"
            textAnchor="middle"
            fill="var(--text-secondary)"
            fontSize="9"
            letterSpacing="2"
          >
            {localize('com_ui_brain_yours')}
          </text>
        </g>
        {!compact &&
          brainKinds.map((kind, index) => {
            const angle = ((-90 + index * 60) * Math.PI) / 180;
            return (
              <text
                key={kind}
                x={420 + Math.cos(angle) * 298}
                y={324 + Math.sin(angle) * 294}
                textAnchor="middle"
                fill={kindColors[kind]}
                fillOpacity=".9"
                fontSize="10"
                letterSpacing="1.2"
              >
                {localize(kindKeys[kind]).toLocaleUpperCase()}
              </text>
            );
          })}
      </svg>
      {focused && !compact && (
        <div className="brain-map-tooltip" aria-live="polite">
          <span style={{ background: kindColors[focused.node.kind] }} />
          {focused.node.title}
        </div>
      )}
      {!compact && (
        <div className="brain-map-controls">
          <button
            type="button"
            onClick={() => setZoom((value) => Math.max(0.8, value - 0.2))}
            disabled={zoom <= 0.8}
            aria-label={localize('com_ui_brain_zoom_out')}
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            aria-label={localize('com_ui_brain_reset_view')}
          >
            <Maximize2 size={14} />
          </button>
          <button
            type="button"
            onClick={() => setZoom((value) => Math.min(1.6, value + 0.2))}
            disabled={zoom >= 1.6}
            aria-label={localize('com_ui_brain_zoom_in')}
          >
            <Plus size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

export default memo(Graph);
