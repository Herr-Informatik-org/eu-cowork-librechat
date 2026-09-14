import React from 'react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { render, screen } from '@testing-library/react';
import type { TModelProcessingRegion } from 'librechat-data-provider';
import translations from '~/locales/de/translation.json';
import ModelInsight from '../ModelInsight';

jest.unmock('react-i18next');

const i18n = createInstance();

beforeAll(async () => {
  await i18n.init({
    lng: 'de',
    resources: { de: { translation: translations } },
    initImmediate: false,
  });
});

function show(region?: TModelProcessingRegion) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ModelInsight
        insight={{
          intelligence: 3,
          tokenCost: 2,
          inputs: ['text', 'image'],
          processingRegion: region,
        }}
      />
    </I18nextProvider>,
  );
}

describe('model card processing region', () => {
  it.each([
    ['switzerland', 'Schweiz'],
    ['europe', 'Europa'],
    ['worldwide', 'Weltweit'],
    ['variable', 'Je nach Modell'],
    ['unknown', 'Unbekannt'],
  ] as const)('shows %s without losing ratings or modalities', (region, label) => {
    show(region);
    expect(screen.getByLabelText(`Verarbeitung: ${label}`)).toBeInTheDocument();
    expect(screen.getByLabelText('Intelligenz: 3 von 5')).toBeInTheDocument();
    expect(screen.getByLabelText('Tokenkosten: 2 von 5')).toBeInTheDocument();
    expect(screen.getByLabelText('Eingaben: Text, Bilder')).toBeInTheDocument();
  });

  it('shows missing metadata as unknown, including cards without any insight', () => {
    const result = show();
    expect(screen.getByLabelText('Verarbeitung: Unbekannt')).toHaveAttribute(
      'title',
      translations.com_ui_processing_unknown_hint,
    );
    result.rerender(
      <I18nextProvider i18n={i18n}>
        <ModelInsight />
      </I18nextProvider>,
    );
    expect(screen.getByLabelText('Verarbeitung: Unbekannt')).toBeInTheDocument();
  });

  it.each(['switzerland', 'europe'] as const)(
    'uses the approved intrinsic-color 14px asset for %s',
    (region) => {
      show(region);
      const image = screen
        .getByLabelText(`Verarbeitung: ${region === 'europe' ? 'Europa' : 'Schweiz'}`)
        .querySelector('img');
      expect(image).toHaveAttribute('width', '14');
      expect(image).toHaveAttribute('height', '14');
      expect(image).toHaveAttribute('alt', '');
      expect(image).toHaveAttribute('aria-hidden', 'true');
    },
  );

  it('explains the scope instead of promising storage or tool residency', () => {
    show('switzerland');
    expect(screen.getByLabelText('Verarbeitung: Schweiz')).toHaveAttribute(
      'title',
      translations.com_ui_processing_region_hint,
    );
  });
});
