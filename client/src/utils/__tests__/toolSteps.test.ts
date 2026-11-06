import {
  getStepKind,
  getStepLabel,
  groupStepRuns,
  summarizeSteps,
  getProposalTitle,
  formatStepDuration,
} from '../toolSteps';

const de: Record<string, string> = {
  com_ui_step_file_read_running: 'Liest eine Datei',
  com_ui_step_file_read_done: 'Datei gelesen',
  com_ui_steps_file_read_running: 'Liest {{0}} Dateien',
  com_ui_steps_file_read_done: '{{0}} Dateien gelesen',
  com_ui_step_web_done: 'Websuche durchgeführt',
  com_ui_steps_web_done: '{{0}} Websuchen durchgeführt',
  com_ui_step_search_running: 'Sucht Datensätze',
  com_ui_step_search_done: 'Suche ausgeführt',
  com_ui_steps_search_done: '{{0}} Suchen ausgeführt',
  com_ui_step_read_done: 'Datensatz gelesen',
  com_ui_steps_read_done: '{{0}} Datensätze gelesen',
  com_ui_step_update_done: 'Datensatz geändert',
  com_ui_steps_more: '+{{0}} weitere',
  com_ui_proposal_title_update: 'Datensatz ändern',
  com_ui_proposal_title_other: 'Änderung ausführen',
};

const localize = (key: string, values?: Record<string | number, string | number>) =>
  (de[key] ?? key).replace('{{0}}', String(values?.[0] ?? ''));

const ODOO = '_mcp_odoo-admin';

describe('tool steps', () => {
  test('recognizes native tools and the Odoo bridge verbs', () => {
    expect(getStepKind('read_file')).toBe('file_read');
    expect(getStepKind('web_search')).toBe('web');
    expect(getStepKind('execute_code')).toBe('code');
    expect(getStepKind('brain_search')).toBe('knowledge');
    expect(getStepKind(`search_records${ODOO}`)).toBe('search');
    expect(getStepKind(`get_record${ODOO}`)).toBe('read');
    expect(getStepKind(`list_models${ODOO}`)).toBe('list');
    expect(getStepKind(`create_record${ODOO}`)).toBe('create');
    expect(getStepKind(`update_record${ODOO}`)).toBe('update');
    expect(getStepKind(`delete_record${ODOO}`)).toBe('delete');
    expect(getStepKind(`execute_method${ODOO}`)).toBe('execute');
  });

  test('unknown non-MCP names stay generic', () => {
    expect(getStepKind('fetch_image')).toBe('other');
    expect(getStepKind('weather_mcp_x')).toBe('other');
    expect(getStepLabel('fetch_image', 'done', localize)).toBeUndefined();
  });

  test('labels a single step in German', () => {
    expect(getStepLabel(`search_records${ODOO}`, 'running', localize)).toBe('Sucht Datensätze');
    expect(getStepLabel(`get_record${ODOO}`, 'done', localize)).toBe('Datensatz gelesen');
  });

  test('groups consecutive steps of the same kind', () => {
    expect(groupStepRuns(['read_file', 'read_file', 'web_search', 'read_file'])).toEqual([
      { kind: 'file_read', count: 2 },
      { kind: 'web', count: 1 },
      { kind: 'file_read', count: 1 },
    ]);
  });

  test('running summary names the current run, finished summary counts by kind', () => {
    const files = ['read_file', 'read_file', 'read_file'];
    expect(summarizeSteps(files, true, localize)).toBe('Liest 3 Dateien …');
    expect(summarizeSteps(files, false, localize)).toBe('3 Dateien gelesen');
    expect(summarizeSteps(['web_search', 'read_file', 'read_file'], true, localize)).toBe(
      'Liest 2 Dateien …',
    );
    expect(summarizeSteps(['read_file', 'web_search', 'read_file'], false, localize)).toBe(
      '2 Dateien gelesen, Websuche durchgeführt',
    );
  });

  test('a long mixed summary is capped with "+N weitere"', () => {
    const names = [
      `search_records${ODOO}`,
      `get_record${ODOO}`,
      `get_record${ODOO}`,
      `update_record${ODOO}`,
      'web_search',
    ];
    expect(summarizeSteps(names, false, localize)).toBe(
      'Suche ausgeführt, 2 Datensätze gelesen, +2 weitere',
    );
  });

  test('any generic step keeps the caller label', () => {
    expect(summarizeSteps(['read_file', 'fetch_image'], false, localize)).toBeUndefined();
    expect(summarizeSteps([], false, localize)).toBeUndefined();
  });

  test('proposal titles fall back per kind', () => {
    expect(getProposalTitle(`update_record${ODOO}`, localize)).toBe('Datensatz ändern');
    expect(getProposalTitle('mystery', localize)).toBe('Änderung ausführen');
  });

  test('formats step durations', () => {
    expect(formatStepDuration(undefined)).toBeUndefined();
    expect(formatStepDuration(30)).toBe('0.1 s');
    expect(formatStepDuration(420)).toBe('0.4 s');
    expect(formatStepDuration(12_400)).toBe('12 s');
    expect(formatStepDuration(65_000)).toBe('1 min 5 s');
  });
});
