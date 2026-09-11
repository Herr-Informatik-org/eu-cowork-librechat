import React from 'react';
import { Brain, Coins, Image, MessageSquare, Mic, Video } from 'lucide-react';
import type { TModelSpec } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

const modalities = [
  { key: 'text', label: 'Text', Icon: MessageSquare },
  { key: 'image', label: 'Bilder', Icon: Image },
  { key: 'audio', label: 'Audio', Icon: Mic },
  { key: 'video', label: 'Video', Icon: Video },
] as const;

export default function ModelInsight({ insight }: { insight?: TModelSpec['insight'] }) {
  const localize = useLocalize();
  if (!insight) return null;
  return (
    <div className="flex flex-col gap-1 text-text-secondary">
      <div
        className="flex flex-wrap gap-x-5 gap-y-2"
        title={
          insight.note ??
          'Relative Einordnung im angebotenen Modellportfolio, kein Benchmark. Mehr Kostensymbole bedeuten höhere Tokenkosten.'
        }
      >
        {[
          { label: 'Intelligenz', value: insight.intelligence, Icon: Brain },
          { label: 'Tokenkosten', value: insight.tokenCost, Icon: Coins },
        ].map(({ label, value, Icon }) =>
          value == null ? null : (
            <div
              key={label}
              className="flex flex-col gap-0.5"
              aria-label={`${label}: ${value} von 5`}
            >
              <span className="text-[11px] font-medium">{label}</span>
              <span className="flex gap-1" aria-hidden="true">
                {[1, 2, 3, 4, 5].map((level) => (
                  <Icon
                    key={level}
                    className={`size-3.5 ${level <= value ? 'opacity-90' : 'opacity-15'}`}
                    fill="currentColor"
                    fillOpacity={level <= value ? 0.15 : 0}
                    strokeWidth={1.6}
                  />
                ))}
              </span>
            </div>
          ),
        )}
      </div>
      {insight.inputs?.length ? (
        <div
          className="flex items-center gap-2.5"
          aria-label={`Eingaben: ${modalities
            .filter((item) => insight.inputs?.includes(item.key))
            .map((item) => item.label)
            .join(', ')}`}
        >
          <span className="text-[11px]">{localize('com_ui_input')}</span>
          {modalities.map(({ key, label, Icon }) => (
            <span
              key={key}
              title={`${label}: ${insight.inputs?.includes(key) ? 'unterstützt' : 'nicht verfügbar'}`}
            >
              <Icon
                className={`size-3.5 ${insight.inputs?.includes(key) ? 'opacity-90' : 'opacity-15'}`}
                aria-hidden="true"
              />
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
