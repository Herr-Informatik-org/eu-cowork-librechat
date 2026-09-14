import { useEffect, useRef, useState } from 'react';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { useLocalize } from '~/hooks';

const imageTypes: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

export function getImagePreviewMime(fileName: string, fileType?: string): string | undefined {
  const mime = fileType?.split(';')[0].trim().toLowerCase();
  return Object.values(imageTypes).includes(mime ?? '')
    ? mime
    : imageTypes[fileName.split('.').pop()?.toLowerCase() ?? ''];
}

export default function ImageFilePreview({ src, fileName }: { src: string; fileName: string }) {
  const localize = useLocalize();
  const viewport = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setBounds({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const ready = dimensions.width > 0;
  const fit = ready
    ? Math.min(
        1,
        Math.max(1, bounds.width - 32) / dimensions.width,
        Math.max(1, bounds.height - 32) / dimensions.height,
      )
    : 1;
  const buttonClass =
    'inline-flex size-9 items-center justify-center rounded-lg text-text-secondary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy disabled:opacity-30';

  return (
    <div className="overflow-hidden rounded-xl border border-border-light">
      <div className="flex items-center justify-between gap-3 border-b border-border-light px-3 py-1.5">
        <span className="text-xs tabular-nums text-text-secondary">
          {ready && !failed ? `${dimensions.width} × ${dimensions.height}` : ''}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={buttonClass}
            disabled={!ready || failed || zoom <= 1}
            aria-label={localize('com_ui_zoom_out')}
            title={localize('com_ui_zoom_out')}
            onClick={() => setZoom((value) => Math.max(1, value - 0.5))}
          >
            <ZoomOut className="size-4" aria-hidden="true" />
          </button>
          <span
            className="w-12 text-center text-xs tabular-nums text-text-secondary"
            aria-live="polite"
          >
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            className={buttonClass}
            disabled={!ready || failed || zoom >= 4}
            aria-label={localize('com_ui_zoom_in')}
            title={localize('com_ui_zoom_in')}
            onClick={() => setZoom((value) => Math.min(4, value + 0.5))}
          >
            <ZoomIn className="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={!ready || failed}
            aria-label={localize('com_ui_reset_zoom')}
            title={localize('com_ui_reset_zoom')}
            onClick={() => {
              setZoom(1);
              viewport.current?.scrollTo({ top: 0, left: 0 });
            }}
          >
            <Maximize className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        ref={viewport}
        className="relative h-[60vh] overflow-auto bg-surface-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-border-heavy"
        tabIndex={0}
        role="region"
        aria-label={`${localize('com_ui_preview')}: ${fileName}`}
      >
        {(!ready || failed) && (
          <div
            className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-text-secondary"
            role="status"
          >
            {localize(failed ? 'com_ui_preview_unavailable' : 'com_ui_loading')}
          </div>
        )}
        {!failed && (
          <div
            className="grid min-h-full min-w-full place-items-center p-4"
            style={{
              width: dimensions.width * fit * zoom + 32,
              height: dimensions.height * fit * zoom + 32,
            }}
          >
            <img
              src={src}
              alt={fileName}
              draggable={false}
              className="max-w-none object-contain"
              style={{
                width: ready ? dimensions.width * fit * zoom : undefined,
                height: ready ? dimensions.height * fit * zoom : undefined,
                visibility: ready ? 'visible' : 'hidden',
              }}
              onLoad={({ currentTarget }) =>
                setDimensions({
                  width: currentTarget.naturalWidth,
                  height: currentTarget.naturalHeight,
                })
              }
              onError={() => setFailed(true)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
