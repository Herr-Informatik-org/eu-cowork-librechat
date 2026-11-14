/** Shared delegated access never adds an Exchange permission the person does not have. */
export const OUTLOOK_SCOPES =
  'openid profile offline_access User.Read Mail.Read Mail.Read.Shared Calendars.Read Calendars.Read.Shared';
export const OUTLOOK_TOOLS = [
  'get-current-user',
  'list-mail-messages',
  'list-mail-folders',
  'list-mail-child-folders',
  'list-mail-folder-messages',
  'get-mail-message',
  'list-calendars',
  'get-calendar-view',
  'get-specific-calendar-view',
  'get-calendar-event',
  'list-calendar-event-instances',
  'list-shared-mailbox-messages',
  'list-shared-mailbox-folder-messages',
  'get-shared-mailbox-message',
  'list-shared-mailbox-folders',
  'list-shared-mailbox-child-folders',
  'get-shared-calendar-view',
] as const;
export const OUTLOOK_HOST = 'ms365-office-mcp';
export const outlookServerName = (): string =>
  process.env.KISUNO_OUTLOOK_SERVER_NAME || 'kisuno-outlook';
export const isManagedOutlook = (name: string): boolean => name === outlookServerName();
export const outlookAvailable = (): boolean =>
  process.env.KISUNO_OUTLOOK_ENABLED === 'true' && process.env.ALLOW_SHARED_LINKS === 'false';
export function assertOutlookTool(name: string): void {
  if (!(OUTLOOK_TOOLS as readonly string[]).includes(name)) {
    throw new Error('Dieses Outlook-Werkzeug ist nicht zum Lesen freigegeben.');
  }
}
export function assertOutlookScopes(scope: string | undefined): void {
  const granted = new Set(
    (scope ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((v) => v.replace(/^https:\/\/graph.microsoft.com\//, '')),
  );
  const required = [
    'User.Read',
    'Mail.Read',
    'Mail.Read.Shared',
    'Calendars.Read',
    'Calendars.Read.Shared',
  ];
  const allowed = new Set(OUTLOOK_SCOPES.split(' '));
  if (
    required.some((value) => !granted.has(value)) ||
    [...granted].some((value) => !allowed.has(value))
  ) {
    throw new Error(
      'Microsoft hat nicht genau die freigegebenen Outlook-Leserechte bestätigt. Bitte neu verbinden.',
    );
  }
}

/** Keep binary attachment expansion outside the chat connector. */
export function assertOutlookArguments(args?: Record<string, unknown>): void {
  if (!args) return;
  if (
    ['expand', '$expand', 'expandExtendedProperties', 'account'].some(
      (name) => args[name] !== undefined,
    )
  ) {
    throw new Error(
      'Erweiterungen und Kontowechsel sind in diesem Outlook-Leseprofil gesperrt. Bitte das persönliche Konto und die festen Lesewerkzeuge verwenden.',
    );
  }
}
