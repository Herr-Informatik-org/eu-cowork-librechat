import type { IMongoFile } from '@librechat/data-schemas';
import type { ServerRequest, StrategyFunctions } from '~/types';
import { DOCX_MIME, inspectWordTemplate, isWordTemplate } from './templates';

export type CopyDependencies = {
  findFileById: (
    id: string,
    filter: { user: string },
  ) => Promise<Pick<
    IMongoFile,
    'user' | 'tenantId' | 'source' | 'filename' | 'filepath' | 'storageKey' | 'type'
  > | null>;
  canEditSkill: (input: { req: ServerRequest; skillId: string }) => Promise<boolean>;
  getStrategyFunctions: (source: string) => Pick<StrategyFunctions, 'getDownloadStream'>;
  saveContent: (input: {
    req: ServerRequest;
    skillId: string;
    relativePath: string;
    content: Buffer;
    mimeType: string;
  }) => Promise<{ bytes: number; relativePath: string }>;
};

export async function copyUploadToSkill(
  input: {
    req: ServerRequest;
    skillId: string;
    relativePath: string;
    sourceFileId: string;
    tenantId?: string;
  },
  deps: CopyDependencies,
): Promise<{ bytes: number; relativePath: string }> {
  const { req, skillId, relativePath, sourceFileId, tenantId } = input;
  if (
    !req.user?.id ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(sourceFileId) ||
    !/^(templates|assets|references)\/[a-zA-Z0-9_. /-]+\.docx$/i.test(relativePath) ||
    relativePath.split('/').some((part) => part === '..' || part === '.')
  ) {
    throw new Error(
      'Originalvorlage benötigt eine gültige private DOCX-Datei und einen sicheren Skillpfad.',
    );
  }
  if (!(await deps.canEditSkill({ req, skillId })))
    throw new Error('Keine Berechtigung zum Bearbeiten dieses Skills.');
  const file = await deps.findFileById(sourceFileId, { user: req.user.id });
  if (
    !file ||
    String(file.user) !== req.user.id ||
    (file.tenantId != null && file.tenantId !== tenantId) ||
    !isWordTemplate(file.filename, file.type)
  ) {
    throw new Error('Originalvorlage nicht gefunden oder nicht für dieses Konto freigegeben.');
  }
  const stream = await deps
    .getStrategyFunctions(file.source)
    .getDownloadStream?.(req, file.storageKey || file.filepath);
  if (!stream) throw new Error('Originalvorlage ist im privaten Dateispeicher nicht lesbar.');
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > 10 * 1024 * 1024) throw new Error('Originalvorlage ist grösser als 10 MiB.');
      chunks.push(value);
    }
  } finally {
    stream.destroy();
  }
  const data = Buffer.concat(chunks);
  await inspectWordTemplate(data);
  return deps.saveContent({ req, skillId, relativePath, content: data, mimeType: DOCX_MIME });
}
