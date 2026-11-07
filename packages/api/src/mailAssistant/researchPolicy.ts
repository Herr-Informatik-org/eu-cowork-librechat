import type { ResearchProfile } from './researchMcp';

type Rule = { users?: Record<string, boolean>; roles?: Record<string, boolean>; allow?: boolean };
export interface ResearchPolicy {
  _id: string;
  defaultAllow?: boolean;
  users?: Record<string, boolean>;
  roles?: Record<string, boolean>;
  groups?: Record<string, boolean>;
  tools?: Record<string, Rule>;
}
/** Match gateway precedence, while missing policies and implicit defaults remain denied. */
export function researchPolicyAllows(
  policy: ResearchPolicy | null,
  owner: string,
  role: string,
  groups: string[],
  tool?: string,
): boolean {
  if (!policy) return false;
  let allowed = policy.defaultAllow === true;
  if (typeof policy.users?.[owner] === 'boolean') allowed = policy.users[owner];
  else if (typeof policy.roles?.[role] === 'boolean') allowed = policy.roles[role];
  else {
    const rules = groups.map((id) => policy.groups?.[id]).filter((v) => typeof v === 'boolean');
    if (rules.length) allowed = !rules.includes(false);
  }
  if (!allowed) return false;
  const rule = tool ? policy.tools?.[tool] : undefined;
  if (!rule) return true;
  if (typeof rule.users?.[owner] === 'boolean') return rule.users[owner];
  if (typeof rule.roles?.[role] === 'boolean') return rule.roles[role];
  return rule.allow !== false;
}
/** Names only discover candidates; exact gateway targets and policy checks authorize them later. */
export function researchProfileCandidate(id: string, value: unknown): ResearchProfile | undefined {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id) || !value || typeof value !== 'object') return;
  const config = value as { type?: unknown; url?: unknown };
  if (config.type !== 'streamable-http' || config.url !== `http://mcp-gateway:3020/${id}`) return;
  const odoo = /odoo/i.test(id);
  const ops = /ops[-_]?manager/i.test(id);
  if (odoo === ops) return;
  return { id, label: id, kind: odoo ? 'odoo' : 'ops' };
}
