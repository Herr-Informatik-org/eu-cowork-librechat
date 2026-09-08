import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';
import { apiBaseUrl, request } from 'librechat-data-provider';
import { Button, Spinner } from '@librechat/client';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import type { Artifact } from '~/common';
import { useLocalize } from '~/hooks';

export function hasOfficePdfReference(content: string): boolean {
  return /<meta name="librechat-office-pdf" content="[a-f0-9]{64}:(docx|pptx|xlsx|xls|ods)">/.test(
    content,
  );
}

/** Legacy cached previews are treated as content, with network and scripts disabled. */
export function simplifiedOfficeDocument(content: string): string {
  const document = new DOMParser().parseFromString(content, 'text/html');
  document
    .querySelectorAll('script, iframe, object, embed, link, base, meta[http-equiv]')
    .forEach((node) => node.remove());
  const fallback = document.querySelector<HTMLElement>('#lc-fallback');
  if (fallback) {
    document.body.replaceChildren(fallback);
    fallback.hidden = false;
  }
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content =
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";
  document.head.prepend(policy);
  return '<!DOCTYPE html>' + document.documentElement.outerHTML;
}

export default function OfficeDocumentPreview({ artifact }: { artifact: Artifact }) {
  const localize = useLocalize();
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(600);
  const [error, setError] = useState(false);
  const [rendering, setRendering] = useState(true);
  const [retry, setRetry] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textLayer = useRef<HTMLDivElement>(null);
  const content = artifact.content ?? '';
  const isPdf =
    hasOfficePdfReference(content) ||
    content === '<meta name="librechat-office-source" content="original">';
  const fileId = artifact.download?.file_id;

  useEffect(() => {
    const element = container.current;
    if (!element) {
      return;
    }
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(1, entry.contentRect.width)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [isPdf, error]);

  useEffect(() => {
    setPdf(null);
    setPage(1);
    setError(false);
    if (!isPdf || !fileId) {
      return;
    }
    const abort = new AbortController();
    let disposed = false;
    let task: ReturnType<(typeof import('pdfjs-dist'))['getDocument']> | undefined;
    async function load() {
      const bytes = await request.get<ArrayBuffer>(
        `${apiBaseUrl()}/api/files/${encodeURIComponent(fileId as string)}/preview/pdf`,
        { responseType: 'arraybuffer', signal: abort.signal, timeout: 60_000 },
      );
      if (bytes.byteLength > 10 * 1024 * 1024) {
        throw new Error('PDF exceeds preview limit');
      }
      const renderer = await import('pdfjs-dist');
      if (disposed) {
        return;
      }
      renderer.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      task = renderer.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false });
      const document = await task.promise;
      if (document.numPages > 80) {
        throw new Error('PDF exceeds page limit');
      }
      if (!disposed) {
        setPdf(document);
      }
    }
    load().catch(() => {
      if (!disposed) {
        setError(true);
      }
    });
    return () => {
      disposed = true;
      abort.abort();
      void task?.destroy();
    };
  }, [content, fileId, isPdf, retry]);

  useEffect(() => {
    if (!pdf || !canvas.current || !textLayer.current) {
      return;
    }
    let disposed = false;
    let renderTask: { cancel: () => void } | undefined;
    let layer: { cancel: () => void } | undefined;
    setRendering(true);
    async function render() {
      const documentPage = await pdf!.getPage(page);
      if (disposed || !canvas.current || !textLayer.current) {
        return;
      }
      const viewport = documentPage.getViewport({
        scale: Math.min(2000, width * zoom) / documentPage.getViewport({ scale: 1 }).width,
      });
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const element = canvas.current;
      element.width = Math.floor(viewport.width * pixelRatio);
      element.height = Math.floor(viewport.height * pixelRatio);
      element.style.width = `${viewport.width}px`;
      element.style.height = `${viewport.height}px`;
      textLayer.current.replaceChildren();
      textLayer.current.style.setProperty('--scale-factor', String(viewport.scale));
      textLayer.current.style.setProperty('--total-scale-factor', String(viewport.scale));
      textLayer.current.style.setProperty('--scale-round-x', '1px');
      textLayer.current.style.setProperty('--scale-round-y', '1px');
      const task = documentPage.render({
        canvas: element,
        viewport,
        transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      renderTask = task;
      await task.promise;
      if (disposed) {
        return;
      }
      const { TextLayer } = await import('pdfjs-dist');
      if (disposed || !textLayer.current) {
        return;
      }
      const text = new TextLayer({
        textContentSource: documentPage.streamTextContent(),
        container: textLayer.current,
        viewport,
      });
      layer = text;
      await text.render();
      if (!disposed) {
        setRendering(false);
      }
    }
    render().catch(() => {
      if (!disposed) {
        setError(true);
      }
    });
    return () => {
      disposed = true;
      renderTask?.cancel();
      layer?.cancel();
    };
  }, [pdf, page, width, zoom]);

  const controls = 'h-8 w-8 disabled:opacity-40';
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-surface-primary">
      <div className="flex flex-wrap items-center gap-2 border-b border-border-light px-3 py-2 text-xs text-text-secondary">
        <span className="min-w-0 basis-full">
          {localize(
            isPdf
              ? artifact.title?.toLowerCase().endsWith('.pdf')
                ? 'com_ui_pdf_document_view'
                : 'com_ui_office_layout'
              : 'com_ui_office_simplified',
          )}
        </span>
        {pdf && !error && (
          <div className="flex w-full min-w-0 flex-wrap items-center justify-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className={controls}
              onClick={() => setPage(page - 1)}
              disabled={page <= 1}
              aria-label={localize('com_ui_office_previous')}
            >
              <ChevronLeft size={16} />
            </Button>
            <span aria-live="polite">
              {page} / {pdf.numPages}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className={controls}
              onClick={() => setPage(page + 1)}
              disabled={page >= pdf.numPages}
              aria-label={localize('com_ui_office_next')}
            >
              <ChevronRight size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={controls}
              onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}
              disabled={zoom <= 0.5}
              aria-label={localize('com_ui_office_zoom_out')}
            >
              <Minus size={16} />
            </Button>
            <span>{Math.round(zoom * 100)}%</span>
            <Button
              variant="ghost"
              size="icon"
              className={controls}
              onClick={() => setZoom(Math.min(2, zoom + 0.25))}
              disabled={zoom >= 2}
              aria-label={localize('com_ui_office_zoom_in')}
            >
              <Plus size={16} />
            </Button>
          </div>
        )}
      </div>
      {isPdf && (error || !fileId) && (
        <div role="status" className="p-6 text-sm text-text-secondary">
          <p>{localize('com_ui_office_unavailable')}</p>
          <Button variant="outline" className="mt-3" onClick={() => setRetry(retry + 1)}>
            {localize('com_ui_refresh')}
          </Button>
        </div>
      )}
      {isPdf && !error && fileId && (
        <div
          ref={container}
          className="relative min-h-0 min-w-0 flex-1 overflow-auto bg-neutral-100 p-4"
        >
          {(!pdf || rendering) && (
            <div
              role="status"
              className="absolute left-4 top-4 z-10 flex items-center gap-2 rounded bg-surface-primary px-3 py-2 text-xs text-text-primary shadow-sm"
            >
              <Spinner size={14} />
              {localize('com_ui_office_loading')}
            </div>
          )}
          <div
            className="relative mx-auto w-fit overflow-hidden bg-white shadow-sm"
            style={{ '--user-unit': 1 } as React.CSSProperties}
          >
            <canvas ref={canvas} aria-label={localize('com_ui_office_page', { page })} />
            <div ref={textLayer} className="textLayer" />
          </div>
        </div>
      )}
      {!isPdf && (
        <iframe
          title={localize('com_ui_office_simplified')}
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={simplifiedOfficeDocument(content)}
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      )}
      <p className="border-t border-border-light px-3 py-2 text-[11px] text-text-secondary">
        {localize('com_ui_office_original')}
      </p>
    </div>
  );
}
