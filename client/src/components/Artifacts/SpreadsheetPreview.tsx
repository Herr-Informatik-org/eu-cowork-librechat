import { useEffect, useState } from 'react';
import { apiBaseUrl, request } from 'librechat-data-provider';
import type { Artifact } from '~/common';
import { useLocalize } from '~/hooks';
import './spreadsheet.css';

type Cell = {
  text: string;
  formula: string;
  background: string;
  color: string;
  bold: boolean;
  italic: boolean;
  fontSize: number;
  align: 'left' | 'right' | 'center';
  wrap: boolean;
  rowspan: number;
  colspan: number;
};
type Sheet = {
  name: string;
  widths: number[];
  rows: { height: number; cells: (Cell | null)[] }[];
  truncated: boolean;
};
const PAGE_SIZE = 100;
export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
function safeColor(value: string, fallback: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export default function SpreadsheetPreview({ artifact }: { artifact: Artifact }) {
  const localize = useLocalize();
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [selected, setSelected] = useState([0, 0]);
  const [page, setPage] = useState(0);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const fileId = artifact.download?.file_id;
  useEffect(() => {
    const abort = new AbortController();
    setSheets([]);
    setError(false);
    setSheetIndex(0);
    setSelected([0, 0]);
    setPage(0);
    request
      .get<{ sheets: Sheet[] }>(
        `${apiBaseUrl()}/api/files/${encodeURIComponent(fileId ?? '')}/preview/workbook`,
        { signal: abort.signal, timeout: 60000 },
      )
      .then((data) => {
        if (
          !Array.isArray(data.sheets) ||
          !data.sheets.length ||
          data.sheets.length > 20 ||
          data.sheets.some((s) => s.rows.length > 1000 || s.widths.length > 60)
        )
          throw new Error('Invalid workbook');
        if (!abort.signal.aborted) setSheets(data.sheets);
      })
      .catch(() => {
        if (!abort.signal.aborted) setError(true);
      });
    return () => abort.abort();
  }, [fileId, retry]);
  if (error)
    return (
      <div className="p-5 text-sm" role="status">
        {localize('com_ui_sheet_unavailable')}
        <button className="ml-3 underline" onClick={() => setRetry(retry + 1)}>
          {localize('com_ui_refresh')}
        </button>
      </div>
    );
  const sheet = sheets[sheetIndex];
  if (!sheet)
    return (
      <div className="p-5 text-sm text-text-secondary" role="status">
        {localize('com_ui_sheet_loading')}
      </div>
    );
  const cell = sheet.rows[selected[0]]?.cells[selected[1]];
  const start = page * PAGE_SIZE;
  return (
    <div className="spreadsheet-view" data-testid="spreadsheet-preview">
      <div className="spreadsheet-formula">
        <span>
          {columnName(selected[1])}
          {selected[0] + 1}
        </span>
        <span aria-hidden="true">{'ƒx'}</span>
        <input
          aria-label={localize('com_ui_sheet_value')}
          readOnly
          value={cell?.formula || cell?.text || ''}
        />
      </div>
      {sheet.truncated && (
        <div role="status" className="px-3 py-1 text-xs">
          {localize('com_ui_sheet_limited')}
        </div>
      )}
      <div className="spreadsheet-scroll">
        <table role="grid" aria-label={sheet.name} aria-readonly="true">
          <colgroup>
            <col style={{ width: 42 }} />
            {sheet.widths.map((w, c) => (
              <col key={c} style={{ width: Math.min(600, Math.max(40, w)) }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th />
              {sheet.widths.map((_, c) => (
                <th key={c} className={selected[1] === c ? 'selected' : ''}>
                  {columnName(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.slice(start, start + PAGE_SIZE).map((row, i) => {
              const r = start + i;
              return (
                <tr key={r} style={{ height: Math.min(200, Math.max(22, row.height)) }}>
                  <th className={selected[0] === r ? 'selected' : ''}>{r + 1}</th>
                  {row.cells.map(
                    (value, c) =>
                      value && (
                        <td
                          key={c}
                          data-cell={`${r}-${c}`}
                          role="gridcell"
                          aria-selected={selected[0] === r && selected[1] === c}
                          tabIndex={selected[0] === r && selected[1] === c ? 0 : -1}
                          rowSpan={Math.min(value.rowspan, start + PAGE_SIZE - r)}
                          colSpan={value.colspan}
                          onClick={() => setSelected([r, c])}
                          onFocus={() => setSelected([r, c])}
                          onKeyDown={(event) => {
                            const moves: Record<string, number[]> = {
                              ArrowDown: [1, 0],
                              ArrowUp: [-1, 0],
                              ArrowLeft: [0, -1],
                              ArrowRight: [0, 1],
                            };
                            const move = moves[event.key];
                            if (!move) return;
                            event.preventDefault();
                            let nr = r + move[0],
                              nc = c + move[1];
                            while (
                              nr >= start &&
                              nr < Math.min(start + PAGE_SIZE, sheet.rows.length) &&
                              nc >= 0 &&
                              nc < sheet.widths.length
                            ) {
                              if (sheet.rows[nr].cells[nc]) {
                                setSelected([nr, nc]);
                                event.currentTarget
                                  .closest('table')
                                  ?.querySelector<HTMLElement>(`[data-cell="${nr}-${nc}"]`)
                                  ?.focus();
                                break;
                              }
                              nr += move[0];
                              nc += move[1];
                            }
                          }}
                          style={{
                            background: safeColor(value.background, '#ffffff'),
                            color: safeColor(value.color, '#202020'),
                            fontWeight: value.bold ? 600 : 400,
                            fontStyle: value.italic ? 'italic' : 'normal',
                            fontSize: `${Math.min(36, Math.max(8, value.fontSize))}pt`,
                            textAlign: ['left', 'right', 'center'].includes(value.align)
                              ? value.align
                              : 'left',
                            whiteSpace: value.wrap ? 'pre-wrap' : 'nowrap',
                          }}
                        >
                          {value.text}
                        </td>
                      ),
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="spreadsheet-tabs" role="tablist" aria-label={localize('com_ui_sheet_tabs')}>
        {sheets.map((s, i) => (
          <button
            key={i}
            role="tab"
            aria-selected={sheetIndex === i}
            onClick={() => {
              setSheetIndex(i);
              setSelected([0, 0]);
              setPage(0);
            }}
          >
            {s.name}
          </button>
        ))}
      </div>
      <div className="spreadsheet-status">
        <span>{localize('com_ui_sheet_readonly')}</span>
        {sheet.rows.length > PAGE_SIZE && (
          <span>
            <button
              aria-label={localize('com_ui_prev')}
              disabled={!page}
              onClick={() => {
                setPage(page - 1);
                setSelected([(page - 1) * PAGE_SIZE, 0]);
              }}
            >
              ←
            </button>{' '}
            {start + 1}–{Math.min(start + PAGE_SIZE, sheet.rows.length)} / {sheet.rows.length}{' '}
            <button
              aria-label={localize('com_ui_next')}
              disabled={start + PAGE_SIZE >= sheet.rows.length}
              onClick={() => {
                setPage(page + 1);
                setSelected([(page + 1) * PAGE_SIZE, 0]);
              }}
            >
              →
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
