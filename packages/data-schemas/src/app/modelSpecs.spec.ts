import { Types } from 'mongoose';
import { PrincipalModel, PrincipalType } from 'librechat-data-provider';
import type { TModelSpec, TSpecsConfig } from 'librechat-data-provider';
import type { AppConfig, IConfig } from '~/types';
import { mergeConfigOverrides } from './resolution';

const card = (name: string, changes: Partial<TModelSpec> = {}): TModelSpec => ({
  name,
  label: name,
  preset: {
    endpoint: 'OpenRouter',
    model: `${name}-current`,
    promptPrefix: 'Current instructions',
  },
  insight: { processingRegion: 'worldwide', intelligence: 4, tokenCost: 2 },
  ...changes,
});

const specs = (list: TModelSpec[]): TSpecsConfig => ({ list, enforce: true, prioritize: true });
const principalModels = {
  [PrincipalType.ROLE]: PrincipalModel.ROLE,
  [PrincipalType.GROUP]: PrincipalModel.GROUP,
  [PrincipalType.USER]: PrincipalModel.USER,
  [PrincipalType.PUBLIC]: PrincipalModel.ROLE,
};
const config = (
  principalId: string,
  priority: number,
  modelSpecs?: TSpecsConfig,
  principalType = PrincipalType.ROLE,
  tombstones: string[] = [],
): IConfig =>
  ({
    _id: new Types.ObjectId(),
    principalType,
    principalId,
    principalModel: principalModels[principalType],
    priority,
    isActive: true,
    configVersion: 1,
    overrides: modelSpecs ? { modelSpecs } : {},
    tombstones,
  }) as IConfig;

const catalog = [card('luna'), card('sol'), card('astra'), card('auto', { default: true })];
const yaml: AppConfig = { modelSpecs: specs(catalog) } as AppConfig;
const stale = (name: string): TModelSpec =>
  card(name, {
    label: `Old ${name}`,
    preset: { endpoint: 'Old provider', model: 'old-model', promptPrefix: 'Old instructions' },
    insight: { intelligence: 1 },
    skills: ['old-skill'],
  });

describe('central model cards and scoped selections', () => {
  it.each([PrincipalType.ROLE, PrincipalType.GROUP, PrincipalType.USER])(
    'uses the current card definition for a legacy %s selection',
    (type) => {
      const result = mergeConfigOverrides(yaml, [
        config('selection', 20, specs([stale('luna'), stale('auto')]), type),
      ]);
      expect(result.modelSpecs?.list).toEqual([catalog[0], catalog[3]]);
    },
  );

  it('reproduces the GL selection while keeping Astra hidden', () => {
    const base = config('__base__', 10, specs(catalog));
    const role = config('USER', 20, specs([stale('auto')]));
    const group = config(
      'GL',
      30,
      specs([stale('luna'), stale('sol'), stale('auto')]),
      PrincipalType.GROUP,
    );
    const result = mergeConfigOverrides({} as AppConfig, [group, base, role]);
    expect(result.modelSpecs?.list).toEqual([catalog[0], catalog[1], catalog[3]]);
  });

  it('updates an existing selection when only the central card changes', () => {
    const selection = config('GL', 30, specs([stale('luna')]), PrincipalType.GROUP);
    const nextCard = card('luna', {
      description: 'Updated description',
      insight: { processingRegion: 'europe' },
      skills: ['new-skill'],
    });
    const first = mergeConfigOverrides(yaml, [selection]);
    const second = mergeConfigOverrides(yaml, [
      selection,
      config('__base__', 10, specs([nextCard])),
    ]);
    expect(first.modelSpecs?.list?.[0].insight?.processingRegion).toBe('worldwide');
    expect(second.modelSpecs?.list).toEqual([{ ...nextCard, default: true }]);
  });

  it('does not expand a selection when the central configuration has higher priority', () => {
    const result = mergeConfigOverrides(yaml, [
      config('GL', 20, specs([stale('auto')]), PrincipalType.GROUP),
      config('__base__', 40, specs(catalog)),
    ]);
    expect(result.modelSpecs?.list).toEqual([catalog[3]]);
  });

  it('drops removed and renamed cards without restoring saved copies or adding new cards', () => {
    const result = mergeConfigOverrides(yaml, [
      config('GL', 30, specs([stale('luna'), stale('deleted')]), PrincipalType.GROUP),
      config('__base__', 10, specs([card('renamed-luna'), card('new-card')])),
    ]);
    expect(result.modelSpecs?.list).toEqual([]);
  });

  it('does not restore definitions deleted centrally with a tombstone', () => {
    const result = mergeConfigOverrides(yaml, [
      config('__base__', 10, undefined, PrincipalType.ROLE, ['modelSpecs.list']),
      config('GL', 30, specs([stale('luna')]), PrincipalType.GROUP),
    ]);
    expect(result.modelSpecs?.list).toEqual([]);
  });

  it('keeps an explicit empty selection empty', () => {
    expect(mergeConfigOverrides(yaml, [config('USER', 20, specs([]))]).modelSpecs?.list).toEqual(
      [],
    );
  });

  it('preserves a higher-priority tombstone on the selected list', () => {
    const result = mergeConfigOverrides(yaml, [
      config('USER', 20, specs([stale('luna')])),
      config('GL', 30, undefined, PrincipalType.GROUP, ['modelSpecs.list']),
    ]);
    expect(result.modelSpecs?.list).toBeUndefined();
  });

  it('lets a later selection replace a tombstone and resolve against the central catalog', () => {
    const result = mergeConfigOverrides(yaml, [
      config('USER', 20, undefined, PrincipalType.ROLE, ['modelSpecs.list']),
      config('GL', 30, specs([stale('auto')]), PrincipalType.GROUP),
    ]);
    expect(result.modelSpecs?.list).toEqual([catalog[3]]);
  });

  it('keeps central order and chooses a visible default without mutating saved documents', () => {
    const selection = config('USER', 20, specs([stale('sol'), stale('luna'), stale('luna')]));
    const before = structuredClone(selection.overrides);
    const result = mergeConfigOverrides(yaml, [selection]);
    expect(result.modelSpecs?.list).toEqual([{ ...catalog[0], default: true }, catalog[1]]);
    expect(yaml.modelSpecs?.list?.[0].default).toBeUndefined();
    expect(selection.overrides).toEqual(before);
  });

  it('preserves endpoint menus and unrelated scoped configuration', () => {
    const selection = config('USER', 20, { ...specs([stale('auto')]), addedEndpoints: ['agents'] });
    selection.overrides.interface = { modelSelect: false };
    const result = mergeConfigOverrides(yaml, [selection]);
    expect(result.modelSpecs?.addedEndpoints).toEqual(['agents']);
    expect(result.interfaceConfig?.modelSelect).toBe(false);
  });

  it('continues inheriting newly added cards without a scoped selection', () => {
    const result = mergeConfigOverrides(yaml, [
      config('__base__', 10, specs([...catalog, card('new')])),
    ]);
    expect(result.modelSpecs?.list).toEqual([...catalog, card('new')]);
  });
});
