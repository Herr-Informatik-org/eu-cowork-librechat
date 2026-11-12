import type { Document, Types } from 'mongoose';

export interface SessionAssurance {
  method: 'totp' | 'passkey' | 'recovery' | 'operator' | 'idp';
  verifiedAt: number;
  version: number;
}

export interface ISession extends Document {
  securityAssurance?: SessionAssurance;
  refreshTokenHash: string;
  expiration: Date;
  user: Types.ObjectId;
  tenantId?: string;
}

export interface CreateSessionOptions {
  securityAssurance?: SessionAssurance;
  expiration?: Date;
  /** Duration in milliseconds for session expiry. Default: 7 days */
  expiresIn?: number;
}

export interface UpdateExpirationOptions {
  /** Duration in milliseconds for session expiry. Default: 7 days */
  expiresIn?: number;
}

export interface SessionSearchParams {
  refreshToken?: string;
  userId?: string;
  sessionId?: string | { sessionId: string };
}

export interface SessionQueryOptions {
  lean?: boolean;
}

export interface DeleteSessionParams {
  refreshToken?: string;
  sessionId?: string;
}

export interface DeleteAllSessionsOptions {
  excludeCurrentSession?: boolean;
  currentSessionId?: string;
}

export interface SessionResult {
  session: Partial<ISession>;
  refreshToken: string;
}

export interface SignPayloadParams {
  payload: Record<string, unknown>;
  secret?: string;
  expirationTime: number;
}
