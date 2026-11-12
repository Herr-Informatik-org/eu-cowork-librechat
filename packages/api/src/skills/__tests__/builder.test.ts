import { Readable } from 'stream';
import { Types } from 'mongoose';
import type { ISkill } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types';
import type { SkillPackageDependencies } from '../builder';
import { createBuildSkillTool, readOwnedTemplate, resolveSkillTemplate } from '../builder';
jest.mock('~/files/documents/templates', () => ({
  inspectWordTemplate: jest.fn(async () =>
    JSON.stringify({ format: 'docx', sha256: 'verified', binarySentToModel: false }),
  ),
}));
const user = { id: 'u', _id: new Types.ObjectId() };
const skillId = new Types.ObjectId();
const request = { user } as ServerRequest;
const mockFiles: Awaited<ReturnType<SkillPackageDependencies['listSkillFiles']>> = [];
const mockDeps = {
  updateSkill: jest.fn(async () => ({
    status: 'updated' as const,
    skill: { _id: skillId, name: 'meeting-notes', body: '# Note', version: 1 },
  })),
  canCreateSkill: jest.fn(async () => true),
  getAuthorSkillByName: jest.fn<
    ReturnType<SkillPackageDependencies['getAuthorSkillByName']>,
    Parameters<SkillPackageDependencies['getAuthorSkillByName']>
  >(async () => null),
  createSkill: jest.fn(async () => ({
    skill: { _id: skillId, name: 'meeting-notes', body: '# Note', version: 1 },
  })),
  grantSkillOwner: jest.fn(async () => {}),
  saveSkillFileContent: jest.fn(async (f: { relativePath: string; content: string | Buffer }) => {
    mockFiles.push({
      relativePath: f.relativePath,
      filename: f.relativePath,
      filepath: '/private/' + f.relativePath,
      source: 'local',
      bytes: f.content.length,
    });
    return { bytes: f.content.length, relativePath: f.relativePath };
  }),
  listSkillFiles: jest.fn(async () => mockFiles),
  getStrategyFunctions: jest.fn(() => ({ deleteFile: jest.fn(async () => {}) })),
  findFileById: jest.fn(),
  getSkillById: jest.fn(
    async () =>
      ({ _id: skillId, name: 'meeting-notes', body: '# Note', version: 3 }) as ISkill & {
        _id: Types.ObjectId;
      },
  ),
  deleteSkill: jest.fn(async () => ({ deleted: true })),
  readFile: jest.fn(async () => Readable.from([Buffer.from('PRIVATE-ORIGINAL')])),
};
const deps = mockDeps as Partial<SkillPackageDependencies> as SkillPackageDependencies;
function buildTool() {
  return createBuildSkillTool(request, deps);
}
const input = {
  name: 'meeting-notes',
  description: 'Erstellt nachvollziehbare Sitzungsprotokolle aus bestätigten Notizen.',
  instructions:
    'Auslöser: Sitzungsprotokoll gewünscht. Eingaben: bestätigte Notizen, Datum und Teilnehmende. Ablauf: Fakten ordnen und Entscheide von Pendenzen trennen. Ausgabe: strukturiertes Protokoll mit offenen Punkten. Keine Inhalte erfinden; fehlende Fakten erfragen.',
  examples: [
    {
      prompt: 'Erstelle ein Protokoll aus diesen bestätigten Notizen.',
      expected: 'Entscheide, Pendenzen und offene Punkte werden klar getrennt.',
      should_apply: true,
    },
    {
      prompt: 'Wie ist das Wetter heute?',
      expected: 'Dieser Skill wird für Wetterfragen nicht angewendet.',
      should_apply: false,
    },
  ],
};
beforeEach(() => {
  mockFiles.length = 0;
  jest.clearAllMocks();
  mockDeps.canCreateSkill.mockResolvedValue(true);
  mockDeps.getAuthorSkillByName.mockResolvedValue(null);
  mockDeps.grantSkillOwner.mockResolvedValue(undefined);
});
it('persists a complete general-purpose package without claiming executed model tests', async () => {
  const [text] = await buildTool().func(input);
  const result = JSON.parse(text);
  expect(result.status).toBe('complete');
  expect(result.taskExamplesExecuted).toBe(false);
  expect(mockFiles.map((f) => f.relativePath)).toEqual([
    'examples/acceptance.json',
    'skill-manifest.json',
  ]);
  expect(mockDeps.createSkill).toHaveBeenCalledWith(
    expect.objectContaining({
      name: input.name,
      author: user._id,
      frontmatter: expect.objectContaining({
        'disable-model-invocation': true,
        'user-invocable': false,
      }),
    }),
  );
});
it('denies creation without skill rights before touching private uploads', async () => {
  mockDeps.canCreateSkill.mockResolvedValue(false);
  const [text] = await buildTool().func({
    ...input,
    template_source_file_id: 'stolen',
  });
  expect(text).toContain('Keine Berechtigung');
  expect(mockDeps.findFileById).not.toHaveBeenCalled();
  expect(mockDeps.createSkill).not.toHaveBeenCalled();
});
it('does not overwrite existing skills', async () => {
  mockDeps.getAuthorSkillByName.mockResolvedValue({
    _id: skillId,
    name: 'meeting-notes',
    body: '# Note',
    version: 1,
    fileCount: 0,
  });
  const [text] = await buildTool().func(input);
  expect(text).toContain('existiert bereits');
  expect(mockDeps.createSkill).not.toHaveBeenCalled();
});
it('rejects duplicate and unsafe resource paths before creating anything', async () => {
  for (const path of ['../secret', 'scripts/../secret', 'references/template-profile.json']) {
    const [text] = await buildTool().func({
      ...input,
      files: [{ path, content: 'test' }],
    });
    expect(text).toContain('Paketpfad');
  }
  expect(mockDeps.createSkill).not.toHaveBeenCalled();
});
it('rolls back registration if ownership grant fails', async () => {
  mockDeps.grantSkillOwner.mockRejectedValueOnce(new Error('ACL failed'));
  const [text] = await buildTool().func(input);
  expect(text).toContain('ACL failed');
  expect(mockDeps.deleteSkill).toHaveBeenCalledWith(String(skillId));
});
it('requires both an application example and a counterexample', async () => {
  await expect(
    buildTool().invoke({
      ...input,
      examples: input.examples.map((e) => ({ ...e, should_apply: true })),
    }),
  ).rejects.toThrow();
  expect(mockDeps.createSkill).not.toHaveBeenCalled();
});
it('rejects foreign upload ownership and tenant mismatch', async () => {
  for (const file of [
    { user: 'other', filename: 'Vorlage.docx' },
    { user: 'u', tenantId: 'foreign', filename: 'Vorlage.docx' },
  ]) {
    mockDeps.findFileById.mockResolvedValueOnce(file);
    await expect(readOwnedTemplate(request, 'upload-1', deps)).rejects.toThrow('gehört nicht');
  }
});
it('validates private bytes locally before bundling', async () => {
  mockDeps.findFileById.mockResolvedValueOnce({
    user: 'u',
    filename: 'Vorlage.docx',
    source: 'local',
    filepath: '/private',
  });
  const r = await readOwnedTemplate(request, 'upload-1', deps);
  expect(r.bytes.toString()).toBe('PRIVATE-ORIGINAL');
  expect(r.profile.sha256).toBe('verified');
});
it('rejects a template path outside a registered skill', async () => {
  await expect(resolveSkillTemplate(request, '/etc/passwd', deps)).rejects.toThrow('registrierten');
  await expect(
    resolveSkillTemplate(request, 'skills/a/templates/../secret.docx', deps),
  ).rejects.toThrow('registrierten');
});

it('keeps a failed package disabled and rolls back instead of publishing it', async () => {
  mockDeps.updateSkill.mockRejectedValueOnce(new Error('Aktivierung abgebrochen'));
  const [text] = await buildTool().func(input);
  expect(text).toContain('Aktivierung abgebrochen');
  expect(mockDeps.deleteSkill).toHaveBeenCalledWith(String(skillId));
});

it('bundles an owned spreadsheet as exact private resource bytes', async () => {
  mockDeps.findFileById.mockResolvedValueOnce({
    user: 'u',
    filename: 'Kosten.xlsx',
    source: 'local',
    filepath: '/private',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const [text] = await buildTool().func({
    ...input,
    attachments: [{ path: 'references/Kosten.xlsx', source_file_id: 'upload-2' }],
  });
  expect(JSON.parse(text).status).toBe('complete');
  expect(mockDeps.saveSkillFileContent).toHaveBeenCalledWith(
    expect.objectContaining({
      relativePath: 'references/Kosten.xlsx',
      content: Buffer.from('PRIVATE-ORIGINAL'),
    }),
  );
});
