import { Constants } from './config';

/**
 * Risk class of a tool call, shared by the server policy (which decides) and the
 * client (which only labels):
 * - `read`: looks things up or produces output without changing business data.
 * - `write`: routine change (create, update, upload, run code in the sandbox).
 * - `critical`: deleting, sending, executing, approving or anything with legal or
 *   financial effect.
 */
export type ToolRisk = 'read' | 'write' | 'critical';

/** MCP tool annotations relevant to risk (`tools/list` → `annotations`). */
export interface ToolRiskHints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/** Prefix of the server's block reason when the work mode `plan` stopped a write. */
export const WORK_MODE_PLAN_MARKER = 'Arbeitsmodus Planen';

/** Reason the web chat sends with «Verwerfen»; the model reads it, the card recognizes it. */
export const PROPOSAL_REJECTED_REASON = 'Die Person hat diesen Vorschlag verworfen.';

/** Prefix the agents SDK puts in front of every blocked tool result. */
export const BLOCKED_OUTPUT_PREFIX = 'Blocked: ';

/**
 * Native and host tools with a fixed class. Personal assistant memory (Brain,
 * memory tools) counts as `read`: it is the person's own knowledge store, not
 * business data, and learning runs without confirmation by design.
 */
const NATIVE_TOOL_RISK: Readonly<Record<string, ToolRisk>> = {
  web_search: 'read',
  file_search: 'read',
  retrieval: 'read',
  read_file: 'read',
  tool_search: 'read',
  skill: 'read',
  ask_user_question: 'read',
  plan_aktualisieren: 'read',
  [Constants.CHECK_BACKGROUND_TASK]: 'read',
  [Constants.SUBAGENT]: 'read',
  image_gen_oai: 'read',
  image_edit_oai: 'read',
  gemini_image_gen: 'read',
  brain_search: 'read',
  brain_context: 'read',
  brain_remember: 'read',
  brain_update: 'read',
  brain_forget: 'read',
  set_memory: 'read',
  delete_memory: 'read',
  execute_code: 'write',
  bash_tool: 'write',
  create_file: 'write',
  edit_file: 'write',
  [Constants.PROGRAMMATIC_TOOL_CALLING]: 'write',
  [Constants.BASH_PROGRAMMATIC_TOOL_CALLING]: 'write',
};

const CRITICAL_VERBS: ReadonlySet<string> = new Set([
  'delete',
  'remove',
  'unlink',
  'destroy',
  'purge',
  'drop',
  'erase',
  'trash',
  'wipe',
  'truncate',
  'send',
  'email',
  'mail',
  'post',
  'publish',
  'reply',
  'forward',
  'invite',
  'share',
  'notify',
  'execute',
  'exec',
  'run',
  'call',
  'invoke',
  'approve',
  'confirm',
  'cancel',
  'sign',
  'submit',
  'pay',
  'transfer',
  'refund',
  'revoke',
  'terminate',
  'kill',
  'shutdown',
  'reboot',
  'restart',
  'deploy',
]);

const WRITE_VERBS: ReadonlySet<string> = new Set([
  'create',
  'add',
  'insert',
  'new',
  'update',
  'edit',
  'modify',
  'change',
  'set',
  'write',
  'patch',
  'put',
  'save',
  'store',
  'upsert',
  'append',
  'upload',
  'move',
  'rename',
  'copy',
  'duplicate',
  'assign',
  'attach',
  'detach',
  'mark',
  'tag',
  'label',
  'archive',
  'unarchive',
  'restore',
  'schedule',
  'book',
  'draft',
  'comment',
  'note',
  'import',
  'sync',
  'enable',
  'disable',
  'toggle',
  'apply',
  'merge',
  'close',
  'reopen',
  'link',
  'register',
  'reset',
  'clear',
  'complete',
  'start',
  'stop',
  'pause',
  'resume',
  'lock',
  'unlock',
  'grant',
  'convert',
  'fill',
  'increment',
  'decrement',
]);

const READ_VERBS: ReadonlySet<string> = new Set([
  'get',
  'list',
  'search',
  'find',
  'read',
  'fetch',
  'query',
  'lookup',
  'describe',
  'show',
  'view',
  'count',
  'browse',
  'retrieve',
  'load',
  'download',
  'export',
  'health',
  'ping',
  'status',
  'summarize',
  'analyze',
  'report',
  'scan',
  'compare',
  'calculate',
  'aggregate',
  'group',
  'stats',
  'schema',
  'info',
  'whoami',
  'profile',
  'build',
  'render',
  'format',
  'parse',
  'translate',
  'suggest',
  'recommend',
]);

/** Leading verbs of dry runs: `validate_write`, `preview_update` never change data. */
const DRY_RUN_VERBS: ReadonlySet<string> = new Set([
  'preview',
  'validate',
  'check',
  'diagnose',
  'simulate',
  'dry',
  'explain',
  'estimate',
  'verify',
  'inspect',
]);

/** The model-facing tool part of an MCP key (`search_records_mcp_odoo` → `search_records`). */
export function getToolBaseName(name: string): string {
  const idx = name.lastIndexOf(Constants.mcp_delimiter);
  return idx > 0 ? name.slice(0, idx) : name;
}

/** Lower-case word tokens of a tool name: snake, kebab, dotted and camel case. */
export function tokenizeToolName(name: string): string[] {
  return getToolBaseName(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Name heuristic only. Unknown names count as `write`: unclassified changes are never silent. */
export function classifyToolName(name: string): ToolRisk {
  const native = NATIVE_TOOL_RISK[name];
  if (native != null) {
    return native;
  }
  const tokens = tokenizeToolName(name);
  if (tokens.length > 0 && DRY_RUN_VERBS.has(tokens[0])) {
    return 'read';
  }
  let sawWrite = false;
  let sawRead = false;
  for (const token of tokens) {
    if (CRITICAL_VERBS.has(token)) {
      return 'critical';
    }
    sawWrite = sawWrite || WRITE_VERBS.has(token);
    sawRead = sawRead || READ_VERBS.has(token);
  }
  if (sawWrite) {
    return 'write';
  }
  return sawRead ? 'read' : 'write';
}

/**
 * Risk of one tool. MCP annotations win when present (`readOnlyHint` → read,
 * `destructiveHint` → critical); an explicitly non-destructive write still keeps
 * a critical name class (sending is not destructive but needs confirmation).
 * Native tools ignore hints.
 */
export function classifyToolRisk(name: string, hints?: ToolRiskHints | null): ToolRisk {
  if (NATIVE_TOOL_RISK[name] != null || hints == null) {
    return classifyToolName(name);
  }
  if (hints.readOnlyHint === true) {
    return 'read';
  }
  if (hints.destructiveHint === true) {
    return 'critical';
  }
  const byName = classifyToolName(name);
  if (hints.readOnlyHint === false || hints.destructiveHint === false) {
    return byName === 'critical' ? 'critical' : 'write';
  }
  return byName;
}
