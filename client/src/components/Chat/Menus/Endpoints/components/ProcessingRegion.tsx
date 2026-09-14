import React from 'react';
import { CircleHelp, Globe, Shuffle } from 'lucide-react';
import type { TModelProcessingRegion } from 'librechat-data-provider';
import switzerlandIcon from '~/assets/regions/switzerland.svg';
import europeIcon from '~/assets/regions/europe.svg';
import useLocalize from '~/hooks/useLocalize';

const regionLabels = {
  switzerland: 'com_ui_processing_switzerland',
  europe: 'com_ui_processing_europe',
  worldwide: 'com_ui_processing_worldwide',
  variable: 'com_ui_processing_variable',
  unknown: 'com_ui_processing_unknown',
} as const;

const flagIcons: Partial<Record<TModelProcessingRegion, string>> = {
  switzerland: switzerlandIcon,
  europe: europeIcon,
};

const lineIcons: Partial<Record<TModelProcessingRegion, typeof Globe>> = {
  worldwide: Globe,
  variable: Shuffle,
};

export default function ProcessingRegion({ region }: { region?: TModelProcessingRegion }) {
  const localize = useLocalize();
  const value = region && Object.hasOwn(regionLabels, region) ? region : 'unknown';
  const label = localize(regionLabels[value]);
  const Icon = lineIcons[value] ?? CircleHelp;
  const image = flagIcons[value];

  return (
    <div
      className="flex min-w-0 flex-col gap-0.5"
      aria-label={`${localize('com_ui_processing_region')}: ${label}`}
      title={localize(
        value === 'unknown' ? 'com_ui_processing_unknown_hint' : 'com_ui_processing_region_hint',
      )}
    >
      <span className="text-[11px] font-medium">{localize('com_ui_processing_region')}</span>
      <span className="flex min-h-3.5 items-center gap-1 whitespace-nowrap text-[11px] leading-[14px]">
        {image ? (
          <img
            src={image}
            alt=""
            aria-hidden="true"
            width={14}
            height={14}
            className="size-3.5 shrink-0"
          />
        ) : (
          <Icon
            aria-hidden="true"
            className={`size-3.5 shrink-0 ${value === 'worldwide' ? 'text-amber-600 dark:text-amber-300' : 'opacity-90'}`}
            strokeWidth={1.6}
          />
        )}
        <span>{label}</span>
      </span>
    </div>
  );
}
