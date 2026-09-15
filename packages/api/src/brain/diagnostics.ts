import { randomUUID } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import { safeBrainServiceDiagnostic } from './client';
import type { BrainServiceDiagnostic } from './client';

const messages = {
  model_timeout:
    'Das Lernmodell hat das Zeitlimit erreicht. Bereits abgeschlossene Beiträge bleiben erhalten. Bitte versuche es erneut oder wähle ein schnelleres Lernmodell.',
  model_rate_limit:
    'Der Modellanbieter begrenzt gerade die Anfragen. Bitte warte kurz und setze den Import danach fort.',
  model_auth:
    'Der Modellanbieter lehnt den Zugang ab. Die Administration muss den Modellzugang prüfen.',
  model_credit:
    'Der Modellanbieter meldet fehlendes Guthaben. Die Administration muss das Anbieterguthaben prüfen.',
  model_unavailable:
    'Der Modellanbieter ist vorübergehend nicht erreichbar. Bereits abgeschlossene Beiträge bleiben erhalten.',
  model_request:
    'Der Modellanbieter hat die Anfrage abgelehnt. Die Administration muss Modell und Einstellungen prüfen.',
  brain_timeout:
    'Der interne Brain-Dienst hat das Zeitlimit erreicht. Bereits ausgewertete Beiträge bleiben für das Fortsetzen gespeichert.',
  brain_auth:
    'Der interne Brain-Zugang ist fehlerhaft eingerichtet. Die Administration muss die Dienstverbindung prüfen.',
  brain_validation:
    'Der interne Brain-Dienst hat die übermittelten Wissensdaten abgelehnt. Die Administration muss die Datenprüfung kontrollieren. Bereits ausgewertete Beiträge bleiben für das Fortsetzen gespeichert.',
  brain_conflict:
    'Der Brain-Stand wurde inzwischen geändert. Bitte lade den aktuellen Stand erneut. Bereits ausgewertete Beiträge bleiben erhalten.',
  brain_source_changed:
    'Die ursprünglichen Chatquellen wurden geändert oder gelöscht. Der bisherige Zwischenstand kann so nicht übernommen werden. Bitte prüfe den Neuaufbau.',
  brain_not_found:
    'Der angefragte Brain-Eintrag wurde nicht gefunden. Bitte lade den aktuellen Stand erneut.',
  brain_rate_limit:
    'Der interne Brain-Dienst begrenzt gerade die Anfragen. Bitte warte kurz und setze die Verarbeitung danach fort.',
  brain_unavailable:
    'Der interne Brain-Dienst ist zurzeit nicht erreichbar. Bereits ausgewertete Beiträge bleiben für das Fortsetzen gespeichert.',
  database:
    'Der Verarbeitungsstand konnte nicht zuverlässig gespeichert werden. Die Administration muss die Datenbankverbindung prüfen.',
  billing:
    'Die Modellnutzung konnte nicht abschliessend verbucht werden. Die Administration muss die Buchung prüfen.',
  budget:
    'Das verfügbare Guthaben reicht nicht aus oder konnte nicht geprüft werden. Der Import ist angehalten.',
  history_stopped:
    'Die Verarbeitung wurde angehalten. Bereits abgeschlossene Beiträge bleiben erhalten.',
  interrupted:
    'Die Verarbeitung wurde durch einen Dienstunterbruch angehalten. Beim Fortsetzen kann eine noch offene Modellanfrage erneut Kosten verursachen.',
  unknown:
    'Die Brain-Verarbeitung ist fehlgeschlagen. Die Administration kann den Fehler anhand der Referenz prüfen. Bereits abgeschlossene Beiträge bleiben erhalten.',
} as const;

export type BrainFailureCode = keyof typeof messages;
export type BrainFailureStage =
  | 'start'
  | 'source'
  | 'chunk'
  | 'extract'
  | 'ingest'
  | 'heartbeat'
  | 'request'
  | 'recall'
  | 'billing';
export interface BrainFailure extends BrainServiceDiagnostic {
  code: BrainFailureCode;
  message: string;
  incidentId: string;
  upstreamStatus?: number;
  transportCode?: string;
}
export interface BrainFailureEvent {
  failure: BrainFailure;
  userId: string;
  operation: 'history' | 'learning' | 'request' | 'recall';
  stage: BrainFailureStage;
  conversationId?: string;
  messageId?: string;
  modelLabel?: string;
  processed?: number;
  durationMs?: number;
}
export type BrainFailureReporter = (event: BrainFailureEvent) => Promise<void>;

export class BrainOperationError extends Error {
  constructor(
    message: string,
    public code: BrainFailureCode = 'history_stopped',
  ) {
    super(message);
    this.name = 'BrainOperationError';
  }
}

function field(value: unknown, key: string): unknown {
  return value != null && typeof value === 'object' && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** Only controlled codes/statuses leave the error boundary; raw provider errors can contain prompts or credentials. */
export function classifyBrainFailure(error: unknown, stage: BrainFailureStage): BrainFailure {
  let current = error;
  let status: number | undefined;
  let transportCode: string | undefined;
  let timeout = false;
  let code: BrainFailureCode | undefined;
  let isBrain = false;
  let database = false;
  let serviceDiagnostic: BrainServiceDiagnostic = {};
  for (let depth = 0; current && depth < 5; depth++) {
    const name = field(current, 'name');
    const rawCode = field(current, 'code');
    const rawStatus =
      field(current, 'upstreamStatus') ??
      field(current, 'status') ??
      field(field(current, 'response'), 'status');
    if (typeof rawStatus === 'number' && rawStatus >= 400 && rawStatus <= 599) status ??= rawStatus;
    isBrain ||= name === 'BrainServiceError';
    if (name === 'BrainServiceError') {
      serviceDiagnostic = {
        ...safeBrainServiceDiagnostic({
          code: field(current, 'serviceCode'),
          field: field(current, 'validationField'),
          reason: field(current, 'validationReason'),
        }),
        ...serviceDiagnostic,
      };
    }
    database ||= typeof name === 'string' && /^(Mongo|Mongoose)/.test(name);
    timeout ||=
      name === 'TimeoutError' || name === 'AbortError' || name === 'APIConnectionTimeoutError';
    if (
      typeof rawCode === 'string' &&
      [
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'ENOTFOUND',
        'EAI_AGAIN',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_SOCKET',
      ].includes(rawCode)
    ) {
      transportCode ??= rawCode;
      timeout ||= rawCode.includes('TIMEOUT') || rawCode === 'ETIMEDOUT';
    }
    current = field(current, 'cause');
  }
  if (error instanceof BrainOperationError) code = error.code;
  else if (isBrain) {
    code = 'brain_unavailable';
    if (timeout) code = 'brain_timeout';
    else if (status === 401 || status === 403) code = 'brain_auth';
    else if (status === 400 || status === 413 || status === 422) code = 'brain_validation';
    else if (status === 409)
      code = ['stale_sources', 'deleted_source'].includes(serviceDiagnostic.serviceCode ?? '')
        ? 'brain_source_changed'
        : 'brain_conflict';
    else if (status === 404) code = 'brain_not_found';
    else if (status === 429) code = 'brain_rate_limit';
  } else if (database || stage === 'heartbeat') code = 'database';
  else if (stage === 'billing') code = 'billing';
  else if (stage === 'extract') {
    if (timeout) code = 'model_timeout';
    else if (status === 429) code = 'model_rate_limit';
    else if (status === 401 || status === 403) code = 'model_auth';
    else if (status === 402) code = 'model_credit';
    else if ((status && status >= 500) || transportCode) code = 'model_unavailable';
    else if (status) code = 'model_request';
  }
  code ??= 'unknown';
  return {
    code,
    message: error instanceof BrainOperationError ? error.message : messages[code],
    incidentId: randomUUID(),
    ...serviceDiagnostic,
    ...(status ? { upstreamStatus: status } : {}),
    ...(transportCode ? { transportCode } : {}),
  };
}

export interface BrainDiagnosticEntry {
  at: Date;
  source: 'cowork-chat';
  kind: 'brain';
  message: string;
  detail: string;
  user: { id: string; email?: string; name?: string };
  client: { host: 'Chat-Server'; version: string };
  context: {
    incidentId: string;
    code: BrainFailureCode;
    operation: BrainFailureEvent['operation'];
    stage: BrainFailureStage;
    conversationId?: string;
    messageId?: string;
    model?: string;
    processed?: number;
    durationMs?: number;
    upstreamStatus?: number;
    transportCode?: string;
    serviceCode?: BrainServiceDiagnostic['serviceCode'];
    validationField?: BrainServiceDiagnostic['validationField'];
    validationReason?: BrainServiceDiagnostic['validationReason'];
  };
}

export function createBrainFailureReporter(
  insert?: (entry: BrainDiagnosticEntry) => Promise<void>,
): BrainFailureReporter {
  return async (event) => {
    const { failure } = event;
    const safeService = safeBrainServiceDiagnostic({
      code: failure.serviceCode,
      field: failure.validationField,
      reason: failure.validationReason,
    });
    const context: BrainDiagnosticEntry['context'] = {
      incidentId: failure.incidentId,
      code: failure.code,
      operation: event.operation,
      stage: event.stage,
      ...safeService,
      ...(event.conversationId ? { conversationId: event.conversationId.slice(0, 100) } : {}),
      ...(event.messageId ? { messageId: event.messageId.slice(0, 100) } : {}),
      ...(event.modelLabel ? { model: event.modelLabel.slice(0, 200) } : {}),
      ...(event.processed != null ? { processed: event.processed } : {}),
      ...(event.durationMs != null ? { durationMs: event.durationMs } : {}),
      ...(failure.upstreamStatus ? { upstreamStatus: failure.upstreamStatus } : {}),
      ...(failure.transportCode ? { transportCode: failure.transportCode } : {}),
    };
    logger.error('[Brain] ' + JSON.stringify(context));
    if (!insert) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const write = insert({
        at: new Date(),
        source: 'cowork-chat',
        kind: 'brain',
        message: messages[failure.code],
        detail: '',
        user: { id: event.userId },
        client: { host: 'Chat-Server', version: (process.env.BUILD_COMMIT ?? '').slice(0, 40) },
        context,
      });
      await Promise.race([
        write,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('Diagnostic write timeout')), 2000);
          timer.unref?.();
        }),
      ]);
    } catch {
      logger.error(`[Brain] Fehlerprotokoll nicht speicherbar; Referenz ${failure.incidentId}`);
    } finally {
      clearTimeout(timer);
    }
  };
}
