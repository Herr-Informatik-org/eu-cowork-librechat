export class MailGraphError extends Error {
  constructor(
    public readonly status: number,
    public readonly uncertain = false,
  ) {
    super(
      uncertain
        ? 'Ob die Änderung vollständig ausgeführt wurde, ist unklar. Bitte prüfe Outlook; es erfolgt kein automatischer neuer Versuch.'
        : status === 401 || status === 403
          ? 'Microsoft verweigert den Zugriff. Bitte prüfe die persönliche Verbindung und Freigabe.'
          : status === 429
            ? 'Microsoft begrenzt die Anfragen. Die Verarbeitung pausiert bis zur nächsten Prüfung.'
            : 'Microsoft ist momentan nicht erreichbar. Bitte prüfe die Verbindung.',
    );
  }
}

export class MailDraftError extends MailGraphError {
  constructor(message: string, status = 409) {
    super(status);
    this.message = message;
  }
}
