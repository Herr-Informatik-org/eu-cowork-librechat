import { Readable } from 'stream';
import { Types } from 'mongoose';
import type { ServerRequest } from '~/types';
import type { CopyDependencies } from './uploads';
import { copyUploadToSkill } from './uploads';
import { inspectWordTemplate } from './templates';

jest.mock('./templates', () => ({
  ...jest.requireActual('./templates'),
  inspectWordTemplate: jest.fn(async () => '{}'),
}));

describe('retain original Word templates as private skill files', () => {
  const data = Buffer.from('unchanged synthetic document binary');
  const owner = new Types.ObjectId();
  const req = { user: { id: owner.toString() } } as ServerRequest;
  const input = {
    req,
    skillId: 'skill-1',
    relativePath: 'templates/Vorlage.docx',
    sourceFileId: 'file-1',
    tenantId: 'tenant-1',
  };
  const dependencies = () => ({
    findFileById: jest.fn(async () => ({
      user: owner,
      tenantId: 'tenant-1',
      source: 'local',
      filename: 'Vorlage.docx',
      filepath: '/private/input',
      type: 'application/octet-stream',
    })),
    canEditSkill: jest.fn(async () => true),
    getStrategyFunctions: jest.fn(() => ({ getDownloadStream: async () => Readable.from([data]) })),
    saveContent: jest.fn(async (_input: Parameters<CopyDependencies['saveContent']>[0]) => ({
      bytes: data.length,
      relativePath: input.relativePath,
    })),
  });
  beforeEach(() => jest.clearAllMocks());
  it('copies exact original bytes after permission and local validation', async () => {
    const deps = dependencies();
    await copyUploadToSkill(input, deps);
    expect(deps.findFileById).toHaveBeenCalledWith('file-1', { user: owner.toString() });
    expect(inspectWordTemplate).toHaveBeenCalledWith(data);
    expect(deps.saveContent.mock.calls[0][0].content.equals(data)).toBe(true);
  });
  it.each([
    { user: new Types.ObjectId(), tenantId: 'tenant-1' },
    { user: owner, tenantId: 'another-tenant' },
  ])('rejects a foreign source before opening storage', async (owner) => {
    const deps = dependencies();
    deps.findFileById.mockResolvedValue({ ...(await deps.findFileById()), ...owner });
    await expect(copyUploadToSkill(input, deps)).rejects.toThrow('nicht für dieses Konto');
    expect(deps.getStrategyFunctions).not.toHaveBeenCalled();
    expect(deps.saveContent).not.toHaveBeenCalled();
  });
  it('rejects missing edit rights and unsafe paths before any file lookup', async () => {
    const deps = dependencies();
    deps.canEditSkill.mockResolvedValue(false);
    await expect(copyUploadToSkill(input, deps)).rejects.toThrow('Berechtigung');
    expect(deps.findFileById).not.toHaveBeenCalled();
    await expect(
      copyUploadToSkill({ ...input, relativePath: '../escape.docx' }, deps),
    ).rejects.toThrow('sicheren Skillpfad');
  });
  it('does not save a reference that fails local inspection', async () => {
    const deps = dependencies();
    (inspectWordTemplate as jest.Mock).mockRejectedValueOnce(Error('unsafe archive'));
    await expect(copyUploadToSkill(input, deps)).rejects.toThrow('unsafe archive');
    expect(deps.saveContent).not.toHaveBeenCalled();
  });
});
