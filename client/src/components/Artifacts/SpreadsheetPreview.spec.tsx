import { render, screen, fireEvent } from '@testing-library/react';
import { request } from 'librechat-data-provider';
import SpreadsheetPreview, { columnName } from './SpreadsheetPreview';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('librechat-data-provider', () => ({ request: { get: jest.fn() }, apiBaseUrl: () => '' }));
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
    { height: 22, cells: [cell, { ...cell, text: '<script>alert(1)</script>', formula: '' }] },
  ],
  truncated: false,
};
const artifact = { id: 'test', lastUpdateTime: 1, download: { file_id: 'own-file' } };

test('displays actual sheets and selects values/formulas without executing cell content', async () => {
  (request.get as jest.Mock).mockResolvedValue({ sheets: [sheet, { ...sheet, name: 'Details' }] });
  render(<SpreadsheetPreview artifact={artifact} />);
  const cells = await screen.findAllByRole('gridcell');
  expect(screen.getByRole('textbox')).toHaveValue('=SUM(A2:A3)');
  fireEvent.click(cells[1]);
  expect(screen.getByRole('textbox')).toHaveValue('<script>alert(1)</script>');
  expect(document.querySelector('script')).toBeNull();
  fireEvent.keyDown(cells[1], { key: 'ArrowLeft' });
  expect(cells[0]).toHaveFocus();
  fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
  expect(screen.getByRole('grid')).toHaveAccessibleName('Details');
  expect(request.get).toHaveBeenCalledWith(
    '/api/files/own-file/preview/workbook',
    expect.objectContaining({ signal: expect.anything() }),
  );
});
test('fails closed on malformed or oversized workbook data', async () => {
  (request.get as jest.Mock).mockResolvedValue({ sheets: Array(21).fill(sheet) });
  render(<SpreadsheetPreview artifact={artifact} />);
  expect(await screen.findByText('com_ui_sheet_unavailable')).toBeInTheDocument();
  expect(screen.queryByRole('grid')).toBeNull();
});
test('column addresses continue after Z', () => {
  expect(columnName(25)).toBe('Z');
  expect(columnName(26)).toBe('AA');
  expect(columnName(59)).toBe('BH');
});
