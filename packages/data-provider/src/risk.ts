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

/** Batch bridges that run many tool calls from code. Their inner calls skip `PreToolUse`. */
export const PROGRAMMATIC_BRIDGE_TOOLS: ReadonlySet<string> = new Set<string>([
  String(Constants.PROGRAMMATIC_TOOL_CALLING),
  String(Constants.BASH_PROGRAMMATIC_TOOL_CALLING),
]);

export function isProgrammaticBridgeTool(name: string): boolean {
  return PROGRAMMATIC_BRIDGE_TOOLS.has(name);
}

/**
 * Native and host tools with a fixed class. Personal assistant memory (Brain,
 * memory tools) counts as `read`: it is the person's own knowledge store, not
 * business data, and learning runs without confirmation by design. The batch
 * bridges are critical: no single inner call can be confirmed on a card.
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
  [Constants.PROGRAMMATIC_TOOL_CALLING]: 'critical',
  [Constants.BASH_PROGRAMMATIC_TOOL_CALLING]: 'critical',
};

/** Unambiguous side-effect verbs: critical wherever they appear in the name. */
const CRITICAL_VERBS: ReadonlySet<string> = new Set([
  'delete',
  'remove',
  'unlink',
  'destroy',
  'purge',
  'erase',
  'trash',
  'wipe',
  'truncate',
  'format',
  'send',
  'publish',
  'reply',
  'forward',
  'invite',
  'notify',
  'execute',
  'exec',
  'invoke',
  'approve',
  'confirm',
  'validate',
  'cancel',
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

/** Also nouns (`get_email`, `read_post`): critical only as the leading verb. */
const LEADING_CRITICAL_VERBS: ReadonlySet<string> = new Set([
  'drop',
  'email',
  'mail',
  'post',
  'share',
  'run',
  'call',
  'sign',
]);

/** Unambiguous change verbs: write wherever they appear in the name. */
const WRITE_VERBS: ReadonlySet<string> = new Set([
  'create',
  'insert',
  'update',
  'edit',
  'modify',
  'change',
  'write',
  'patch',
  'put',
  'save',
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
  'archive',
  'unarchive',
  'restore',
  'schedule',
  'import',
  'sync',
  'enable',
  'disable',
  'toggle',
  'apply',
  'merge',
  'close',
  'reopen',
  'register',
  'reset',
  'complete',
  'resume',
  'grant',
  'convert',
  'increment',
  'decrement',
  'checkout',
  'checkin',
]);

/** Also nouns (`get_note`, `list_tags_by_label`): write only as the leading verb. */
const LEADING_WRITE_VERBS: ReadonlySet<string> = new Set([
  'add',
  'new',
  'set',
  'store',
  'mark',
  'tag',
  'label',
  'book',
  'draft',
  'comment',
  'note',
  'link',
  'clear',
  'start',
  'stop',
  'pause',
  'lock',
  'unlock',
  'fill',
  'load',
  'scan',
  'report',
]);

/** Look-up verbs. Side-effect verbs (`scan`, `report`, `format`, `load`) are deliberately absent. */
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
  'download',
  'export',
  'health',
  'ping',
  'status',
  'summarize',
  'analyze',
  'compare',
  'calculate',
  'aggregate',
  'whoami',
  'render',
  'parse',
  'translate',
  'suggest',
  'recommend',
  'check',
  'verify',
  'inspect',
  'diagnose',
  'explain',
  'estimate',
  'simulate',
  'preview',
]);

/** Trailing nouns of pure look-ups: `business_pack_report`, `build_domain`, `schema_catalog`. */
const READ_TRAILING_NOUNS: ReadonlySet<string> = new Set([
  'report',
  'catalog',
  'schema',
  'profile',
  'info',
  'status',
  'health',
  'stats',
  'payload',
  'domain',
  'preview',
  'summary',
  'diff',
  'overview',
  'metadata',
  'fields',
]);

/** Leading verbs that turn `<verb>_<change verb>` into a dry run (`validate_write`). */
const DRY_RUN_LEADS: ReadonlySet<string> = new Set([
  'preview',
  'simulate',
  'validate',
  'check',
  'verify',
]);

const CONJUNCTIONS: ReadonlySet<string> = new Set(['and', 'then']);

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

function isChangeVerb(token: string): boolean {
  return (
    WRITE_VERBS.has(token) ||
    CRITICAL_VERBS.has(token) ||
    LEADING_WRITE_VERBS.has(token) ||
    LEADING_CRITICAL_VERBS.has(token)
  );
}

/**
 * Narrow dry-run shapes only: `dry_run_*`, `preview_*` without a chained action,
 * and `<validate|check|verify|preview|simulate>_<change verb>` (`validate_write`).
 * `validate_invoice` or `check_and_delete_x` are not dry runs.
 */
function isDryRun(tokens: readonly string[]): boolean {
  if (tokens[0] === 'dry' && tokens[1] === 'run') {
    return true;
  }
  if (tokens[0] === 'preview' && !tokens.some((token) => CONJUNCTIONS.has(token))) {
    return true;
  }
  return tokens.length === 2 && DRY_RUN_LEADS.has(tokens[0]) && isChangeVerb(tokens[1]);
}

interface NameClass {
  risk: ToolRisk;
  /** False when nothing in the name matched and `write` is only the safe default. */
  explicit: boolean;
}

function classifyByName(name: string): NameClass {
  const native = NATIVE_TOOL_RISK[name];
  if (native != null) {
    return { risk: native, explicit: true };
  }
  const tokens = tokenizeToolName(name);
  if (isDryRun(tokens)) {
    return { risk: 'read', explicit: true };
  }
  let sawWrite = false;
  let sawRead = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (CRITICAL_VERBS.has(token) || (i === 0 && LEADING_CRITICAL_VERBS.has(token))) {
      return { risk: 'critical', explicit: true };
    }
    const checkInOut = token === 'check' && (tokens[i + 1] === 'out' || tokens[i + 1] === 'in');
    sawWrite =
      sawWrite ||
      checkInOut ||
      WRITE_VERBS.has(token) ||
      (i === 0 && LEADING_WRITE_VERBS.has(token));
    sawRead = sawRead || READ_VERBS.has(token);
  }
  if (sawWrite) {
    return { risk: 'write', explicit: true };
  }
  if (sawRead || READ_TRAILING_NOUNS.has(tokens[tokens.length - 1] ?? '')) {
    return { risk: 'read', explicit: true };
  }
  return { risk: 'write', explicit: false };
}

/**
 * Name heuristic only. Critical and write verbs are checked before any read verb;
 * unknown names count as `write`, so unclassified changes are never silent.
 */
export function classifyToolName(name: string): ToolRisk {
  return classifyByName(name).risk;
}

/**
 * Risk of one tool with its MCP annotations. Annotations may only raise the
 * class (`destructiveHint` → critical, `readOnlyHint: false` → at least write)
 * or rescue a name nothing matched (`readOnlyHint: true` → read). A name that
 * says it writes or deletes is never downgraded by a server's claim. Native
 * tools ignore hints.
 */
export function classifyToolRisk(name: string, hints?: ToolRiskHints | null): ToolRisk {
  const byName = classifyByName(name);
  if (NATIVE_TOOL_RISK[name] != null || hints == null) {
    return byName.risk;
  }
  if (hints.destructiveHint === true) {
    return 'critical';
  }
  if (hints.readOnlyHint === true) {
    return byName.explicit ? byName.risk : 'read';
  }
  if (hints.readOnlyHint === false || hints.destructiveHint === false) {
    return byName.risk === 'critical' ? 'critical' : 'write';
  }
  return byName.risk;
}
