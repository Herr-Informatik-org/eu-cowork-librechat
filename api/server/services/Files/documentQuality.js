const path = require('path');
const { Readable } = require('stream');
const { z } = require('zod');
const { tool } = require('@librechat/agents/langchain/tools');
const {
  DOCUMENT_TOOL_NAME,
  documentToolDefinition,
  HOST_FILE_AUTHORING_ARTIFACT_KEY,
} = require('@librechat/api');

const MAX_BYTES = 10 * 1024 * 1024;
const failedAttempts = new WeakMap();
const FORMATS = new Set(['pdf', 'docx', 'xlsx', 'doc', 'xls', 'odt', 'ods']);

function enabled() {
  return process.env.KISUNO_DOCUMENTS_ENABLED === 'true';
}

function governedFormat(name, buffer) {
  const extension = path
    .extname((name || '').replace(/[";\s]+$/, ''))
    .slice(1)
    .toLowerCase();
  if (FORMATS.has(extension)) return extension;
  if (buffer?.subarray(0, 5).equals(Buffer.from('%PDF-'))) return 'pdf';
  if (buffer?.subarray(0, 2).toString() === 'PK') {
    if (buffer.includes(Buffer.from('word/document.xml'))) return 'docx';
    if (buffer.includes(Buffer.from('xl/workbook.xml'))) return 'xlsx';
  }
  return null;
}

function serviceURL(route) {
  const target = new URL(process.env.OFFICE_PREVIEW_RENDERER_URL || 'http://office-preview:8090');
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('Dokumentverarbeitung ist nicht korrekt konfiguriert.');
  }
  target.pathname = route;
  target.search = '';
  return target;
}

async function boundedBody(response, limit = MAX_BYTES) {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) throw new Error('Dokument ist zu gross.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('Dokument ist zu gross.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function serviceRequest(route, body, format) {
  const target = serviceURL(route);
  if (format) target.searchParams.set('format', format);
  let response;
  try {
    response = await fetch(target, {
      method: 'POST',
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(110000),
      headers: { 'content-type': format ? 'application/octet-stream' : 'application/json' },
    });
  } catch (_error) {
    throw new Error(
      'Dokumentprüfung ist vorübergehend nicht erreichbar. Ausgabe bleibt gesperrt; später erneut versuchen.',
    );
  }
  const data = await boundedBody(response);
  if (!response.ok) {
    let reason = 'Dokument konnte nicht vollständig geprüft werden.';
    try {
      reason = JSON.parse(data.toString()).error || reason;
    } catch (_error) {
      /* Keep the bounded generic error. */
    }
    const error = new Error(String(reason).slice(0, 1000));
    error.code = 'DOCUMENT_QUALITY_BLOCKED';
    throw error;
  }
  return { response, data };
}

async function assertDocumentQuality(name, buffer) {
  const format = governedFormat(name, buffer);
  if (!enabled() || !format) return null;
  if (!buffer || buffer.length > MAX_BYTES) {
    const error = new Error(
      'Dokumentausgabe gesperrt: Datei überschreitet 10 MiB. Dokument aufteilen.',
    );
    error.code = 'DOCUMENT_QUALITY_BLOCKED';
    throw error;
  }
  try {
    const { data } = await serviceRequest('/documents/check', buffer, format);
    return JSON.parse(data.toString());
  } catch (error) {
    error.code = 'DOCUMENT_QUALITY_BLOCKED';
    throw error;
  }
}

function createDocumentTool(req) {
  return tool(
    async (input) => {
      const attempts = failedAttempts.get(req) || new Map();
      failedAttempts.set(req, attempts);
      const key = input.filename + ':' + input.format;
      if ((attempts.get(key) || 0) >= 3) {
        return [
          'Dokument nicht freigegeben: Drei Versuche sind fehlgeschlagen. Offenen Prüfpunkt erläutern und einen korrigierten Auftrag abwarten.',
          { files: [] },
        ];
      }
      try {
        if (!enabled()) throw new Error('Dokumenterzeugung ist nicht aktiviert.');
        let content;
        try {
          content = JSON.parse(input.document);
        } catch (_error) {
          throw new Error('document muss eine gültige JSON-Zeichenfolge sein.');
        }
        if (!content || typeof content !== 'object' || Array.isArray(content))
          throw new Error('Dokumentinhalt muss ein JSON-Objekt sein.');
        const raw = Buffer.from(
          JSON.stringify({
            ...content,
            version: 1,
            format: input.format,
            filename: input.filename,
            branding: input.include_logo === false ? 'none' : 'default',
          }),
        );
        if (raw.length > 2 * 1024 * 1024) throw new Error('Dokumentauftrag ist zu gross.');
        const { response, data } = await serviceRequest('/documents/generate', raw);
        const report = JSON.parse(
          Buffer.from(response.headers.get('x-kisuno-document-report'), 'base64').toString(),
        );
        if (report.format !== input.format || report.filename !== input.filename)
          throw new Error('Dokumentauftrag und geprüfte Ausgabe stimmen nicht überein.');
        const { uploadCodeEnvFile } = require('./Code/crud');
        const reference = await uploadCodeEnvFile({
          req,
          stream: Readable.from([data]),
          filename: input.filename,
          kind: 'user',
          id: req.user.id,
        });
        return [
          `Datei ${input.filename} erstellt und geprüft. ${report.pages} Vorschauseiten. Mindestkontrast ${report.minimumContrast}:1. ` +
            (report.logoApplied
              ? 'Kundenlogo eingefügt.'
              : input.include_logo === false
                ? 'Logo auf Wunsch weggelassen.'
                : 'Kein verifiziertes Kundenlogo hinterlegt; kein fremdes Logo eingesetzt.'),
          {
            [HOST_FILE_AUTHORING_ARTIFACT_KEY]: true,
            session_id: reference.storage_session_id,
            files: [
              {
                id: reference.file_id,
                name: input.filename,
                storage_session_id: reference.storage_session_id,
              },
            ],
            documentQuality: report,
          },
        ];
      } catch (error) {
        attempts.set(key, (attempts.get(key) || 0) + 1);
        return [
          'Dokument nicht freigegeben: ' + String(error.message).slice(0, 1000),
          { files: [] },
        ];
      }
    },
    {
      name: DOCUMENT_TOOL_NAME,
      description: documentToolDefinition.description,
      schema: z.object({
        format: z.enum(['pdf', 'docx', 'xlsx']),
        filename: z.string().min(1).max(120),
        document: z
          .string()
          .min(2)
          .max(2 * 1024 * 1024),
        include_logo: z.boolean().optional(),
      }),
      responseFormat: 'content_and_artifact',
    },
  );
}

function guardBashDocumentOutputs(bashTool) {
  if (!enabled()) return bashTool;
  const original = bashTool.func.bind(bashTool);
  bashTool.func = async (...args) => {
    const output = await original(...args);
    const artifact = Array.isArray(output) ? output[1] : null;
    const files = artifact?.files ?? [];
    const unverified = files.filter((file) => !file.inherited && governedFormat(file.name));
    if (!unverified.length) return output;
    return [
      (Array.isArray(output) ? String(output[0]) : '') +
        '\nDateiausgabe gesperrt: Neue Word-, Excel- und PDF-Dateien mit generate_document erstellen. Die verbindlichen Gestaltungs- und Rechenprüfungen können nicht durch freien Code ersetzt werden. Analyseergebnisse als Daten an generate_document übergeben.',
      { ...artifact, files: files.filter((file) => file.inherited || !governedFormat(file.name)) },
    ];
  };
  return bashTool;
}

module.exports = {
  enabled,
  governedFormat,
  boundedBody,
  serviceRequest,
  assertDocumentQuality,
  createDocumentTool,
  guardBashDocumentOutputs,
};
