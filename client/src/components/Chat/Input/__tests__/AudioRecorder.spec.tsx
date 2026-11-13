import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ChatFormValues } from '~/common';

const mockStartRecording = jest.fn();
const mockStopRecording = jest.fn();
const mockShowToast = jest.fn();
let mockSetText: (text: string) => void;
let mockComplete: (text: string) => boolean | void;
let mockOnStart: (() => void) | undefined;
let mockIsLoading = false;
let mockLive = false;
const mockCancelRecording = jest.fn();

const mockUseSpeechToText = jest.fn(
  (
    setText: (text: string) => void,
    onComplete: (text: string) => boolean | void,
    onStart?: () => void,
  ) => {
    const [isListening, setIsListening] = useState(false);
    mockSetText = setText;
    mockComplete = onComplete;
    mockOnStart = onStart;
    return {
      isListening,
      isLoading: mockIsLoading,
      liveDictation: mockLive,
      isFinalizing: mockIsLoading,
      elapsedSeconds: 18,
      levels: [0, 0.4, 0.8, 0.2],
      previewText: 'Ein vorläufiger Satz.',
      cancelRecording: () => { mockCancelRecording(); setIsListening(false); },
      startRecording: async () => {
        mockStartRecording();
        onStart?.();
        setIsListening(true);
      },
      stopRecording: async () => {
        await mockStopRecording();
        setIsListening(false);
      },
    };
  },
);

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useSpeechToText: (
    setText: (text: string) => void,
    onComplete: (text: string) => boolean | void,
    onStart?: () => void,
  ) => mockUseSpeechToText(setText, onComplete, onStart),
}));
jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
  TooltipAnchor: ({ render: element }: { render: React.ReactNode }) => element,
  ListeningIcon: () => null,
  Spinner: () => null,
}));
jest.mock('~/common', () => ({ globalAudioId: 'dictation-audio' }));
jest.mock('~/Providers', () => ({}));
jest.mock('~/utils', () => ({ cn: (...names: string[]) => names.join(' ') }));

import AudioRecorder from '../AudioRecorder';

const renderRecorder = (initialText = 'Bitte prüfe:', isSubmitting = false) => {
  const form = renderHook(() => useForm<ChatFormValues>({ defaultValues: { text: initialText } }));
  const ask = jest.fn();
  const view = render(
    <AudioRecorder
      methods={form.result.current}
      ask={ask}
      disabled={false}
      isSubmitting={isSubmitting}
    />,
  );
  return { ...view, methods: form.result.current, ask };
};

const clickMicrophone = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_use_micrphone' }));
  });
};

beforeEach(() => {
  mockIsLoading = false;
  mockLive = false;
  mockCancelRecording.mockClear();
  mockStopRecording.mockResolvedValue(undefined);
});

describe('AudioRecorder transcript composition', () => {
  it('prepends typed text once while the cumulative browser transcript changes', async () => {
    const recorder = renderRecorder();
    await clickMicrophone();
    act(() => mockSetText('Erster Satz.'));
    act(() => mockSetText('Erster Satz. Zweiter Satz.'));
    expect(recorder.methods.getValues('text')).toBe('Bitte prüfe: Erster Satz. Zweiter Satz.');
    expect(mockStartRecording).toHaveBeenCalledTimes(1);
  });

  it('preserves the prefix through delayed final results after a stop click', async () => {
    let finishStop: () => void = () => undefined;
    mockStopRecording.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    const recorder = renderRecorder();
    await clickMicrophone();
    act(() => fireEvent.click(screen.getByRole('button', { name: 'com_ui_use_micrphone' })));
    act(() => mockSetText('Der letzte Satz.'));
    expect(recorder.methods.getValues('text')).toBe('Bitte prüfe: Der letzte Satz.');
    await act(async () => finishStop());
    act(() => mockSetText('Der letzte Satz. Mit Nachtrag.'));
    expect(recorder.methods.getValues('text')).toBe('Bitte prüfe: Der letzte Satz. Mit Nachtrag.');
  });

  it('captures typed text for keyboard-started recordings through the same session callback', () => {
    const recorder = renderRecorder();
    act(() => mockOnStart?.());
    act(() => mockSetText('Mit der Tastatur diktiert.'));
    expect(recorder.methods.getValues('text')).toBe('Bitte prüfe: Mit der Tastatur diktiert.');
  });

  it('includes the typed prefix in browser auto-send and clears the successful draft', async () => {
    const recorder = renderRecorder();
    await clickMicrophone();
    act(() => {
      expect(mockComplete('Der Betrag ist 3,14.')).toBe(true);
    });
    expect(recorder.ask).toHaveBeenCalledWith({ text: 'Bitte prüfe: Der Betrag ist 3,14.' });
    expect(recorder.methods.getValues('text')).toBe('');
  });

  it('starts a second recording from the latest draft without duplicating old transcript segments', async () => {
    const recorder = renderRecorder();
    await clickMicrophone();
    act(() => mockSetText('Erster Satz.'));
    await clickMicrophone();
    await clickMicrophone();
    act(() => mockSetText('Zweiter Satz.'));
    expect(recorder.methods.getValues('text')).toBe('Bitte prüfe: Erster Satz. Zweiter Satz.');
  });

  it('keeps the draft when submission is rejected', async () => {
    const recorder = renderRecorder();
    recorder.ask.mockReturnValue(false);
    await clickMicrophone();
    act(() => mockSetText('Ein Satz.'));
    act(() => {
      expect(mockComplete('Ein Satz.')).toBe(false);
    });
    expect(recorder.methods.getValues('text')).toBe('Bitte prüfe: Ein Satz.');
  });

  it('does not submit or clear a draft while another request is being submitted', async () => {
    const recorder = renderRecorder('Vorhandener Entwurf.', true);
    await clickMicrophone();
    act(() => {
      expect(mockComplete('Ein Satz.')).toBe(false);
    });
    expect(recorder.ask).not.toHaveBeenCalled();
    expect(recorder.methods.getValues('text')).toBe('Vorhandener Entwurf.');
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_speech_while_submitting',
      status: 'error',
    });
  });

  it('disables the microphone while recording is being finalized', () => {
    mockIsLoading = true;
    renderRecorder();
    expect(screen.getByRole('button', { name: 'com_ui_use_micrphone' })).toBeDisabled();
  });
});


it('shows elapsed time, actual level bars and separate finish/cancel controls for managed dictation', async () => {
  mockLive = true;
  const recorder = renderRecorder();
  await clickMicrophone();
  expect(screen.getByLabelText('com_ui_dictation_elapsed')).toHaveTextContent('0:18');
  expect(screen.getByTestId('dictation-waveform').children).toHaveLength(4);
  expect(screen.getByTestId('dictation-waveform').children[2]).toHaveStyle({height:'18px'});
  fireEvent.click(screen.getByRole('button',{name:'com_ui_dictation_cancel'}));
  expect(mockCancelRecording).toHaveBeenCalledTimes(1);
  expect(recorder.methods.getValues('text')).toBe('Bitte prüfe:');
  expect(recorder.ask).not.toHaveBeenCalled();
});
