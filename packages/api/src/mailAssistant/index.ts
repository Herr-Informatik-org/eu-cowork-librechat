export { createMailAssistantRuntime, mailAssistantConfigurationStatus } from './runtime';
export { createMailAssistantRouter, createMailAssistantCallbackRouter } from './router';
export type { MailRuntimeDependencies } from './runtime';
export { createMailSecurityAdminRouter, MAIL_SECURITY_COLLECTION } from './policy';
export { scanMailAttachment } from './scanner';
