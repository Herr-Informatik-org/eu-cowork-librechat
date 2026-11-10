export type OpsPersonalScope = 'mail:compose' | 'skills:use' | 'brain:read' | 'mail:background';
export interface OpsAuthorization {
  response_type: 'code';
  client_id: 'ops';
  redirect_uri: 'https://ops.rzcloud.ch/functions/v1/kisuno-personal/callback';
  state: string;
  code_challenge: string;
  code_challenge_method: 'S256';
  ops_user_id: string;
  scope?: string;
}
export interface OpsPersonalTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  scope: string;
  tenant_id: 'cwv01';
  grant_id: string;
  subject: string;
  ops_user_id: string;
}
export interface OpsPersonalConsentInfo {
  authorization: OpsAuthorization;
  account: string;
  client_name: string;
  scopes: OpsPersonalScope[];
  optional_scopes: OpsPersonalScope[];
}
export interface OpsPersonalGrantSummary {
  id: string;
  scopes: OpsPersonalScope[];
  created_at: string;
  expires_at: string;
}
