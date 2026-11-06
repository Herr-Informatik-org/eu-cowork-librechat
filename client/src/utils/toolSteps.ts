import { Constants, tokenizeToolName } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';

/**
 * Readable work steps (V2): what a tool call does, in the user's words, as the
 * fallback when the model wrote no `intent` label. MCP tools are recognized by
 * their leading verb (the Odoo bridge's `search_records`, `get_record`,
 * `create_record` …); unknown names stay `other` and keep the generic labels.
 */
export type StepKind =
  | 'web'
  | 'file_read'
  | 'file_search'
  | 'code'
  | 'file_write'
  | 'knowledge'
  | 'search'
  | 'read'
  | 'list'
  | 'create'
  | 'update'
  | 'delete'
  | 'send'
  | 'execute'
  | 'other';

type KnownStepKind = Exclude<StepKind, 'other'>;

interface StepKeys {
  running: TranslationKeys;
  done: TranslationKeys;
  runningMany: TranslationKeys;
  doneMany: TranslationKeys;
}

const NATIVE_STEP_KIND: Readonly<Record<string, KnownStepKind>> = {
  web_search: 'web',
  read_file: 'file_read',
  file_search: 'file_search',
  retrieval: 'file_search',
  execute_code: 'code',
  bash_tool: 'code',
  code_interpreter: 'code',
  [Constants.PROGRAMMATIC_TOOL_CALLING]: 'code',
  [Constants.BASH_PROGRAMMATIC_TOOL_CALLING]: 'code',
  create_file: 'file_write',
  edit_file: 'file_write',
  brain_search: 'knowledge',
  brain_context: 'knowledge',
  brain_remember: 'knowledge',
  brain_update: 'knowledge',
  brain_forget: 'knowledge',
  set_memory: 'knowledge',
  delete_memory: 'knowledge',
};

const VERB_STEP_KIND: Readonly<Record<string, KnownStepKind>> = {
  search: 'search',
  find: 'search',
  query: 'search',
  lookup: 'search',
  browse: 'search',
  get: 'read',
  read: 'read',
  fetch: 'read',
  retrieve: 'read',
  load: 'read',
  show: 'read',
  view: 'read',
  describe: 'read',
  list: 'list',
  create: 'create',
  add: 'create',
  insert: 'create',
  new: 'create',
  update: 'update',
  edit: 'update',
  modify: 'update',
  change: 'update',
  set: 'update',
  write: 'update',
  patch: 'update',
  put: 'update',
  save: 'update',
  delete: 'delete',
  remove: 'delete',
  unlink: 'delete',
  destroy: 'delete',
  purge: 'delete',
  erase: 'delete',
  trash: 'delete',
  send: 'send',
  email: 'send',
  mail: 'send',
  reply: 'send',
  forward: 'send',
  notify: 'send',
  publish: 'send',
  invite: 'send',
  execute: 'execute',
  exec: 'execute',
  run: 'execute',
  call: 'execute',
  invoke: 'execute',
  post: 'execute',
  approve: 'execute',
  confirm: 'execute',
  cancel: 'execute',
};

const STEP_KEYS: Readonly<Record<KnownStepKind, StepKeys>> = {
  web: {
    running: 'com_ui_step_web_running',
    done: 'com_ui_step_web_done',
    runningMany: 'com_ui_steps_web_running',
    doneMany: 'com_ui_steps_web_done',
  },
  file_read: {
    running: 'com_ui_step_file_read_running',
    done: 'com_ui_step_file_read_done',
    runningMany: 'com_ui_steps_file_read_running',
    doneMany: 'com_ui_steps_file_read_done',
  },
  file_search: {
    running: 'com_ui_step_file_search_running',
    done: 'com_ui_step_file_search_done',
    runningMany: 'com_ui_steps_file_search_running',
    doneMany: 'com_ui_steps_file_search_done',
  },
  code: {
    running: 'com_ui_step_code_running',
    done: 'com_ui_step_code_done',
    runningMany: 'com_ui_steps_code_running',
    doneMany: 'com_ui_steps_code_done',
  },
  file_write: {
    running: 'com_ui_step_file_write_running',
    done: 'com_ui_step_file_write_done',
    runningMany: 'com_ui_steps_file_write_running',
    doneMany: 'com_ui_steps_file_write_done',
  },
  knowledge: {
    running: 'com_ui_step_knowledge_running',
    done: 'com_ui_step_knowledge_done',
    runningMany: 'com_ui_steps_knowledge_running',
    doneMany: 'com_ui_steps_knowledge_done',
  },
  search: {
    running: 'com_ui_step_search_running',
    done: 'com_ui_step_search_done',
    runningMany: 'com_ui_steps_search_running',
    doneMany: 'com_ui_steps_search_done',
  },
  read: {
    running: 'com_ui_step_read_running',
    done: 'com_ui_step_read_done',
    runningMany: 'com_ui_steps_read_running',
    doneMany: 'com_ui_steps_read_done',
  },
  list: {
    running: 'com_ui_step_list_running',
    done: 'com_ui_step_list_done',
    runningMany: 'com_ui_steps_list_running',
    doneMany: 'com_ui_steps_list_done',
  },
  create: {
    running: 'com_ui_step_create_running',
    done: 'com_ui_step_create_done',
    runningMany: 'com_ui_steps_create_running',
    doneMany: 'com_ui_steps_create_done',
  },
  update: {
    running: 'com_ui_step_update_running',
    done: 'com_ui_step_update_done',
    runningMany: 'com_ui_steps_update_running',
    doneMany: 'com_ui_steps_update_done',
  },
  delete: {
    running: 'com_ui_step_delete_running',
    done: 'com_ui_step_delete_done',
    runningMany: 'com_ui_steps_delete_running',
    doneMany: 'com_ui_steps_delete_done',
  },
  send: {
    running: 'com_ui_step_send_running',
    done: 'com_ui_step_send_done',
    runningMany: 'com_ui_steps_send_running',
    doneMany: 'com_ui_steps_send_done',
  },
  execute: {
    running: 'com_ui_step_execute_running',
    done: 'com_ui_step_execute_done',
    runningMany: 'com_ui_steps_execute_running',
    doneMany: 'com_ui_steps_execute_done',
  },
};

/** Proposal-card title per kind when the model wrote no intent ("Datensatz ändern"). */
const PROPOSAL_TITLE_KEYS: Readonly<Partial<Record<StepKind, TranslationKeys>>> = {
  code: 'com_ui_proposal_title_code',
  file_write: 'com_ui_proposal_title_file_write',
  create: 'com_ui_proposal_title_create',
  update: 'com_ui_proposal_title_update',
  delete: 'com_ui_proposal_title_delete',
  send: 'com_ui_proposal_title_send',
  execute: 'com_ui_proposal_title_execute',
};

type Localize = (key: TranslationKeys, values?: Record<string | number, string | number>) => string;

/** Step kind of a tool id: native tools by name, MCP tools by their first known verb. */
export function getStepKind(name: string): StepKind {
  const native = NATIVE_STEP_KIND[name];
  if (native != null) {
    return native;
  }
  if (!name.includes(Constants.mcp_delimiter)) {
    return 'other';
  }
  for (const token of tokenizeToolName(name)) {
    const kind = VERB_STEP_KIND[token];
    if (kind != null) {
      return kind;
    }
  }
  return 'other';
}

/** Single-step label ("Sucht Datensätze" / "Datensätze gesucht"); undefined for `other`. */
export function getStepLabel(
  name: string,
  phase: 'running' | 'done',
  localize: Localize,
): string | undefined {
  const kind = getStepKind(name);
  if (kind === 'other') {
    return undefined;
  }
  return localize(STEP_KEYS[kind][phase]);
}

/** Title of a proposal card when the call carries no intent. */
export function getProposalTitle(name: string, localize: Localize): string {
  const key = PROPOSAL_TITLE_KEYS[getStepKind(name)] ?? 'com_ui_proposal_title_other';
  return localize(key);
}

export interface StepRun {
  kind: StepKind;
  count: number;
}

/** Consecutive same-kind steps folded into runs, in order. */
export function groupStepRuns(names: readonly string[]): StepRun[] {
  const runs: StepRun[] = [];
  for (const name of names) {
    const kind = getStepKind(name);
    const last = runs[runs.length - 1];
    if (last != null && last.kind === kind) {
      last.count += 1;
    } else {
      runs.push({ kind, count: 1 });
    }
  }
  return runs;
}

function phrase(kind: KnownStepKind, count: number, running: boolean, localize: Localize) {
  const keys = STEP_KEYS[kind];
  if (count <= 1) {
    return localize(running ? keys.running : keys.done);
  }
  return localize(running ? keys.runningMany : keys.doneMany, { 0: count });
}

/** Maximum phrases in a finished summary before "+N weitere". */
const MAX_SUMMARY_PHRASES = 2;

/**
 * Header of a group of steps. While running it names the trailing run of
 * same-kind steps ("Liest 3 Dateien …"); once finished it counts each kind in
 * order of first appearance ("3 Dateien gelesen, Im Web gesucht"). Returns
 * undefined when any step is `other`, so the caller keeps its generic label.
 */
export function summarizeSteps(
  names: readonly string[],
  running: boolean,
  localize: Localize,
): string | undefined {
  const runs = groupStepRuns(names);
  if (runs.length === 0 || runs.some((run) => run.kind === 'other')) {
    return undefined;
  }
  if (running) {
    const last = runs[runs.length - 1];
    return `${phrase(last.kind as KnownStepKind, last.count, true, localize)} …`;
  }
  const totals = new Map<KnownStepKind, number>();
  for (const run of runs) {
    const kind = run.kind as KnownStepKind;
    totals.set(kind, (totals.get(kind) ?? 0) + run.count);
  }
  const phrases: string[] = [];
  let hidden = 0;
  for (const [kind, count] of totals) {
    if (phrases.length < MAX_SUMMARY_PHRASES) {
      phrases.push(phrase(kind, count, false, localize));
    } else {
      hidden += count;
    }
  }
  if (hidden > 0) {
    phrases.push(localize('com_ui_steps_more', { 0: hidden }));
  }
  return phrases.join(', ');
}

/** "0.4 s", "12 s", "1 min 5 s": duration of one finished step. */
export function formatStepDuration(ms: number | undefined): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return undefined;
  }
  if (ms < 10_000) {
    return `${(Math.max(ms, 100) / 1000).toFixed(1)} s`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds} s`;
  }
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}
