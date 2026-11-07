/** Personal, explicit mail research. Content never grants tools or updates a skill. */
export type MailResearchSource = 'odoo' | 'ops';
export const MAIL_RESEARCH_CONSENT_VERSION = '2026-10-29';
export interface MailResearchProfile {
  id: string;
  label: string;
  kind: MailResearchSource;
}
export interface MailResearchCustomer {
  id: string;
  name: string;
  odooPartnerId?: number;
}
export interface MailResearchSkill {
  id: string;
  revision: string;
  name: string;
  instructions: string;
  topic: string;
  lookbackMonths: number;
  sources: MailResearchSource[];
}
export interface MailResearchSkillInput {
  expectedRevision: string;
  name: string;
  instructions: string;
  topic: string;
  lookbackMonths: number;
  sources: MailResearchSource[];
  consentVersion: string;
}
export interface MailResearchSettings {
  available: boolean;
  reason?: string;
  modelLabel?: string;
  consentVersion?: string;
  profiles: MailResearchProfile[];
  skills: MailResearchSkill[];
}
export interface MailResearchEvidence {
  id: string;
  source: MailResearchSource;
  profileId: string;
  customerId: string;
  kind: string;
  title: string;
  fields: { label: string; value: string }[];
  url?: string;
  updatedAt?: string;
}
export interface MailResearchRunRequest {
  requestId: string;
  revision: string;
  skillId: string;
  skillRevision: string;
  selections: { profileId: string; customerId: string }[];
  customersConfirmed: boolean;
  reference?: string;
}
export interface MailResearchJob {
  id: string;
  resultId: string;
  revision: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  completedAt?: string;
  skill: { id: string; revision: string; name: string };
  sources: {
    profileId: string;
    kind: MailResearchSource;
    customer?: MailResearchCustomer;
    status: 'pending' | 'complete' | 'unavailable';
    truncated?: boolean;
  }[];
  evidence: MailResearchEvidence[];
  answer?: string;
  warnings: string[];
  error?: string;
}
