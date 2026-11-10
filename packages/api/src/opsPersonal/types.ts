import type { OpsPersonalScope } from 'librechat-data-provider';
export type {
  OpsAuthorization,
  OpsPersonalTokens,
  OpsPersonalScope,
} from 'librechat-data-provider';
import type { IUser, AppConfig } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';

export interface OpsPersonalGrant {
  _id: string;
  ownerId: string;
  ownerTenantId: string | null;
  opsUserId: string;
  scopes: OpsPersonalScope[];
  status: 'pending' | 'active' | 'revoked';
  createdAt: Date;
  expiresAt: Date;
  codeHash: string;
  codeChallenge: string;
  codeExpiresAt: Date;
  accessHash: string;
  accessExpiresAt: Date;
  refreshHash: string;
  usedRefreshHashes: string[];
  revokedAt?: Date;
}
export interface OpsPersonalSkill {
  id: string;
  name: string;
  version: string;
  body: string;
  userInvocable?: boolean;
}
export interface OpsPersonalSources {
  skills: Array<Pick<OpsPersonalSkill, 'id' | 'name' | 'version'>>;
  brain: boolean;
}
export interface OpsPersonalContextOptions {
  input: string;
  skillIds: string[];
  brain: boolean;
  background?: boolean;
  sender?: string;
  signal?: AbortSignal;
}
export interface OpsPersonalContext {
  assertActive: () => Promise<void>;
  contextText: string;
  ownerId: string;
  grantId: string;
  subject: string;
  sourcesUsed: OpsPersonalSources;
  user: IUser;
  config: AppConfig;
}
export interface OpsPersonalNative {
  currentUser: (ownerId: string) => Promise<IUser | null>;
  config: (user: IUser) => Promise<AppConfig>;
  skillsAllowed: (user: IUser) => Promise<boolean>;
  brainAllowed: (req: ServerRequest) => Promise<boolean>;
  skillIds: (user: IUser) => Promise<string[]>;
  skill: (id: string) => Promise<OpsPersonalSkill | null>;
  mailContext: (
    req: ServerRequest,
    input: { query: string; sender?: string; contextBudgetTokens: number; signal?: AbortSignal },
  ) => Promise<{ context: string; status: string }>;
}
