import { render, screen, fireEvent } from '@testing-library/react';
import { request } from 'librechat-data-provider';
import SpreadsheetPreview, { columnName } from './SpreadsheetPreview';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('librechat-data-provider', () => ({
  request: { get: jest.fn() },
  apiBaseUrl: () => '',
}));
const cell = {
  text: '42',
  formula: '=SUM(A2:A3)',
  background: '#ffffff',
  color: '#202020',
  bold: false,
  italic: false,
  fontSize: 11,
  align: 'right',
  wrap: false,
  rowspan: 1,
  colspan: 1,
};
const sheet = {
  name: 'Übersicht',
  widths: [100, 120],
  rows: [
    {
      height: 22,
      cells: [cell, { ...cell, text: '<script>alert(1)</script>', formula: '' }],
    },
  ],
  truncated: false,
};
const artifact = {
  id: 'test',
  lastUpdateTime: 1,
  download: { file_id: 'own-file' },
};

test('displays actual sheets and selects values/formulas without executing cell content', async () => {
  (request.get as jest.Mock).mockResolvedValue({
    sheets: [sheet, { ...sheet, name: 'Details' }],
  });
  render(<SpreadsheetPreview artifact={artifact} />);
  const cells = await screen.findAllByRole('gridcell');
  expect(screen.getByRole('textbox')).toHaveValue('=SUM(A2:A3)');
  fireEvent.click(cells[1]);
  expect(screen.getByRole('textbox')).toHaveValue('<script>alert(1)</script>');
  expect(document.querySelector('script')).toBeNull();
  fireEvent.keyDown(cells[1], { key: 'ArrowLeft' });
  expect(cells[0]).toHaveFocus();
  fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
  expect(await screen.findByRole('grid')).toHaveAccessibleName('Details');
  expect(request.get).toHaveBeenCalledWith(
    '/api/files/own-file/preview/workbook?sheet=0',
    expect.objectContaining({ signal: expect.anything() }),
  );
});
test('fails closed on malformed or oversized workbook data', async () => {
  (request.get as jest.Mock).mockResolvedValue({
    sheets: Array(21).fill(sheet),
  });
  render(<SpreadsheetPreview artifact={artifact} />);
  expect(await screen.findByText('com_ui_sheet_unavailable')).toBeInTheDocument();
  expect(screen.queryByRole('grid')).toBeNull();
});
test('column addresses continue after Z', () => {
  expect(columnName(25)).toBe('Z');
  expect(columnName(26)).toBe('AA');
  expect(columnName(59)).toBe('BH');
});

test('loads a selected sheet on demand without dropping the other tabs', async () => {
  (request.get as jest.Mock)
    .mockResolvedValueOnce({
      sheets: [sheet, { ...sheet, name: 'Bilanzen', rows: [], widths: [], loaded: false }],
    })
    .mockResolvedValueOnce({
      sheets: [
        { ...sheet, rows: [], widths: [], loaded: false },
        {
          ...sheet,
          name: 'Bilanzen',
          rows: [{ height: 22, cells: [{ ...cell, text: '913', formula: '' }] }],
        },
      ],
    });
  render(<SpreadsheetPreview artifact={artifact} />);
  await screen.findByRole('grid');
  fireEvent.click(screen.getByRole('tab', { name: 'Bilanzen' }));
  expect(await screen.findByText('913')).toBeInTheDocument();
  expect(screen.getAllByRole('tab')).toHaveLength(2);
  expect(request.get).toHaveBeenLastCalledWith(
    '/api/files/own-file/preview/workbook?sheet=1',
    expect.objectContaining({ signal: expect.anything() }),
  );
});

test('preserves narrow columns, source fonts and row heights instead of stretching the sheet', async () => {
  (request.get as jest.Mock).mockResolvedValue({
    sheets: [
      {
        ...sheet,
        widths: [12, 80],
        rows: [{ height: 16, cells: [{ ...cell, fontFamily: 'Calibri' }, cell] }],
      },
    ],
  });
  render(<SpreadsheetPreview artifact={artifact} />);
  const grid = await screen.findByRole('grid');
  expect(grid).toHaveStyle({ width: '134px' });
  expect(grid.querySelectorAll('col')[1]).toHaveStyle({ width: '12px' });
  expect(grid.querySelector('tbody tr')).toHaveStyle({ height: '16px' });
  expect(screen.getAllByRole('gridcell')[0]).toHaveStyle({ fontFamily: 'Calibri' });
});

test('collapses hidden columns without shifting the remaining cell-to-column mapping', async () => {
  (request.get as jest.Mock).mockResolvedValue({ sheets: [{ ...sheet, widths: [0, 100] }] });
  render(<SpreadsheetPreview artifact={artifact} />);
  const grid = await screen.findByRole('grid');
  expect(grid.querySelectorAll('col')[1]).toHaveStyle({ visibility: 'collapse' });
  expect(grid.querySelectorAll('tbody td')).toHaveLength(2);
  expect(screen.getByRole('textbox')).toHaveValue('<script>alert(1)</script>');
});
