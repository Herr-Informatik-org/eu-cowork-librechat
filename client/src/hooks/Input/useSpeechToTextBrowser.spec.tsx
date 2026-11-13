import { act, renderHook } from '@testing-library/react';

const mockStartListening = jest.fn();
const mockStopListening = jest.fn();
const mockAbortListening = jest.fn();
const mockResetTranscript = jest.fn();
const mockShowToast = jest.fn();
const mockRecognition = { continuous: false };
const mockManager = { listening: false };
const mockSpeech = {
  transcript: '',
  finalTranscript: '',
  interimTranscript: '',
  resetTranscript: mockResetTranscript,
  isMicrophoneAvailable: true,
  browserSupportsSpeechRecognition: true,
};
const mockUseSpeechRecognition = jest.fn((_options: { transcribing: boolean }) => mockSpeech);
let mockEndpoint = 'browser';
let mockLocationKey = 'first-chat';
let mockAutoSendText = -1;
let mockLanguageSTT = '';
let mockAppLanguage = 'de';

jest.mock('react-speech-recognition', () => ({
  __esModule: true,
  default: {
    startListening: (options: { language: string; continuous: boolean }) =>
      mockStartListening(options),
    stopListening: () => mockStopListening(),
    abortListening: () => mockAbortListening(),
    getRecognition: () => mockRecognition,
    getRecognitionManager: () => mockManager,
  },
  useSpeechRecognition: (options: { transcribing: boolean }) => mockUseSpeechRecognition(options),
}));
jest.mock('recoil', () => ({
  useRecoilValue: (atom: string) => {
    if (atom === 'autoSendText') return mockAutoSendText;
    if (atom === 'languageSTT') return mockLanguageSTT;
    if (atom === 'lang') return mockAppLanguage;
    return undefined;
  },
}));
jest.mock('react-router-dom', () => ({ useLocation: () => ({ key: mockLocationKey }) }));
jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: mockShowToast }) }));
jest.mock('librechat-data-provider/react-query', () => ({
  useGetCustomConfigSpeechQuery: () => ({ data: { sttExternal: true } }),
}));
jest.mock('./useGetAudioSettings', () => ({
  __esModule: true,
  default: () => ({ speechToTextEndpoint: mockEndpoint }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/store', () => ({
  __esModule: true,
  default: { autoSendText: 'autoSendText', languageSTT: 'languageSTT', lang: 'lang' },
}));

import useSpeechToTextBrowser from './useSpeechToTextBrowser';

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

const renderDictation = () => {
  const setText = jest.fn();
  const onComplete = jest.fn();
  const onStart = jest.fn();
  return {
    ...renderHook(() => useSpeechToTextBrowser(setText, onComplete, onStart)),
    setText,
    onComplete,
    onStart,
  };
};

type Dictation = ReturnType<typeof renderDictation>;

const start = async (dictation: Dictation) => {
  await act(async () => {
    await dictation.result.current.startRecording();
  });
};

const emit = (dictation: Dictation, finalTranscript: string, interimTranscript = '') => {
  mockSpeech.finalTranscript = finalTranscript;
  mockSpeech.interimTranscript = interimTranscript;
  mockSpeech.transcript = [finalTranscript, interimTranscript].filter(Boolean).join(' ');
  dictation.rerender();
};

beforeEach(() => {
  jest.useFakeTimers();
  mockEndpoint = 'browser';
  mockLocationKey = 'first-chat';
  mockAutoSendText = -1;
  mockLanguageSTT = '';
  mockAppLanguage = 'de';
  mockManager.listening = false;
  mockRecognition.continuous = false;
  Object.assign(mockSpeech, {
    transcript: '',
    finalTranscript: '',
    interimTranscript: '',
    isMicrophoneAvailable: true,
    browserSupportsSpeechRecognition: true,
  });
  mockStartListening.mockImplementation(async (options: { continuous: boolean }) => {
    mockRecognition.continuous = options.continuous;
    mockManager.listening = true;
  });
  mockStopListening.mockImplementation(async () => {
    mockManager.listening = false;
  });
  mockAbortListening.mockImplementation(async () => {
    mockManager.listening = false;
  });
  mockResetTranscript.mockImplementation(() => {
    Object.assign(mockSpeech, { transcript: '', finalTranscript: '', interimTranscript: '' });
  });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('browser dictation', () => {
  it('starts continuous recognition with a German UI fallback and an explicit session boundary', async () => {
    const dictation = renderDictation();
    await start(dictation);
    expect(mockStartListening).toHaveBeenCalledWith({ language: 'de-DE', continuous: true });
    expect(mockResetTranscript).toHaveBeenCalledTimes(1);
    expect(dictation.onStart).toHaveBeenCalledTimes(1);
    expect(dictation.result.current.isListening).toBe(true);
  });

  it('preserves an explicit recognition language', async () => {
    mockLanguageSTT = 'fr-CH';
    const dictation = renderDictation();
    await start(dictation);
    expect(mockStartListening).toHaveBeenCalledWith({ language: 'fr-CH', continuous: true });
  });

  it('uses the browser language when the UI language is automatic', async () => {
    mockAppLanguage = 'auto';
    const dictation = renderDictation();
    await start(dictation);
    expect(mockStartListening).toHaveBeenCalledWith({
      language: navigator.language,
      continuous: true,
    });
  });

  it('makes start and stop idempotent without starting an idle microphone', async () => {
    const dictation = renderDictation();
    await act(async () => {
      await dictation.result.current.stopRecording();
    });
    expect(mockStartListening).not.toHaveBeenCalled();
    await start(dictation);
    await start(dictation);
    expect(mockStartListening).toHaveBeenCalledTimes(1);
    await act(async () => {
      await Promise.all([
        dictation.result.current.stopRecording(),
        dictation.result.current.stopRecording(),
      ]);
      await dictation.result.current.stopRecording();
    });
    expect(mockStopListening).toHaveBeenCalledTimes(1);
    expect(mockRecognition.continuous).toBe(false);
    expect(dictation.result.current.isListening).toBe(false);
  });

  it('keeps finalized text while interim words are revised and preserves punctuation and numbers', async () => {
    const dictation = renderDictation();
    await start(dictation);
    emit(dictation, 'Am 13.11.2026 kostet es 1.234,56.', 'Passt');
    expect(dictation.setText).toHaveBeenLastCalledWith('Am 13.11.2026 kostet es 1.234,56. Passt');
    emit(dictation, 'Am 13.11.2026 kostet es 1.234,56.', 'Passt das?');
    expect(dictation.setText).toHaveBeenLastCalledWith(
      'Am 13.11.2026 kostet es 1.234,56. Passt das?',
    );
    emit(dictation, 'Am 13.11.2026 kostet es 1.234,56. Passt das?');
    expect(dictation.setText).toHaveBeenLastCalledWith(
      'Am 13.11.2026 kostet es 1.234,56. Passt das?',
    );
  });

  it('accepts asynchronous final results while an explicit stop completes', async () => {
    const stopped = deferred();
    mockStopListening.mockImplementation(() => stopped.promise);
    const dictation = renderDictation();
    await start(dictation);
    let operation = Promise.resolve();
    await act(async () => {
      operation = dictation.result.current.stopRecording();
      await Promise.resolve();
    });
    expect(dictation.result.current.isLoading).toBe(true);
    emit(dictation, 'Der letzte Satz.');
    expect(dictation.setText).toHaveBeenLastCalledWith('Der letzte Satz.');
    await act(async () => {
      mockManager.listening = false;
      stopped.resolve();
      await operation;
    });
    expect(dictation.result.current.isListening).toBe(false);
  });

  it('resets the previous session and accepts the same words again without duplication', async () => {
    const dictation = renderDictation();
    await start(dictation);
    emit(dictation, 'Noch einmal.');
    await act(async () => {
      await dictation.result.current.stopRecording();
    });
    await start(dictation);
    emit(dictation, 'Noch einmal.');
    expect(dictation.setText.mock.calls).toEqual([['Noch einmal.'], ['Noch einmal.']]);
    expect(mockResetTranscript).toHaveBeenCalledTimes(2);
  });

  it('does not auto-send by default', async () => {
    const dictation = renderDictation();
    await start(dictation);
    emit(dictation, 'Ein Satz.');
    act(() => jest.advanceTimersByTime(60_000));
    expect(dictation.onComplete).not.toHaveBeenCalled();
  });

  it('cancels auto-send when new interim speech arrives and waits for its final result', async () => {
    mockAutoSendText = 3;
    const dictation = renderDictation();
    await start(dictation);
    emit(dictation, 'Erster Satz.');
    act(() => jest.advanceTimersByTime(2_000));
    emit(dictation, 'Erster Satz.', 'Zweiter');
    act(() => jest.advanceTimersByTime(10_000));
    expect(dictation.onComplete).not.toHaveBeenCalled();
    emit(dictation, 'Erster Satz. Zweiter Satz.');
    act(() => jest.advanceTimersByTime(2_999));
    expect(dictation.onComplete).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1));
    expect(dictation.onComplete).toHaveBeenCalledTimes(1);
    expect(dictation.onComplete).toHaveBeenCalledWith('Erster Satz. Zweiter Satz.');
  });

  it('cancels a pending auto-send on explicit stop', async () => {
    mockAutoSendText = 3;
    const dictation = renderDictation();
    await start(dictation);
    emit(dictation, 'Ein Satz.');
    await act(async () => {
      await dictation.result.current.stopRecording();
    });
    emit(dictation, 'Ein letzter Satz.');
    act(() => jest.advanceTimersByTime(10_000));
    expect(dictation.onComplete).not.toHaveBeenCalled();
  });

  it('keeps the recognition transcript when auto-send is rejected and includes it in subsequent speech', async () => {
    mockAutoSendText = 3;
    const dictation = renderDictation();
    dictation.onComplete.mockReturnValueOnce(false);
    await start(dictation);
    emit(dictation, 'Noch nicht senden.');
    act(() => jest.advanceTimersByTime(3_000));
    expect(mockResetTranscript).toHaveBeenCalledTimes(1);
    expect(mockSpeech.finalTranscript).toBe('Noch nicht senden.');
    emit(dictation, 'Noch nicht senden.', 'Ein Nachtrag');
    expect(dictation.setText).toHaveBeenLastCalledWith('Noch nicht senden. Ein Nachtrag');
    emit(dictation, 'Noch nicht senden. Ein Nachtrag.');
    act(() => jest.advanceTimersByTime(3_000));
    expect(dictation.onComplete).toHaveBeenLastCalledWith('Noch nicht senden. Ein Nachtrag.');
    expect(mockResetTranscript).toHaveBeenCalledTimes(2);
  });

  it.each(['navigation', 'endpoint', 'pagehide', 'unmount'])(
    'cancels recording and timers on %s',
    async (change) => {
      mockAutoSendText = 3;
      const dictation = renderDictation();
      await start(dictation);
      emit(dictation, 'Ein Satz.');
      dictation.setText.mockClear();
      if (change === 'navigation') {
        mockLocationKey = 'another-chat';
        dictation.rerender();
      } else if (change === 'endpoint') {
        mockEndpoint = 'external';
        dictation.rerender();
      } else if (change === 'pagehide') {
        act(() => window.dispatchEvent(new Event('pagehide')));
      } else {
        dictation.unmount();
      }
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockAbortListening).toHaveBeenCalledTimes(1);
      expect(mockRecognition.continuous).toBe(false);
      if (change !== 'unmount') emit(dictation, 'Verspätetes Ergebnis.');
      act(() => jest.advanceTimersByTime(10_000));
      expect(dictation.onComplete).not.toHaveBeenCalled();
      expect(dictation.setText).not.toHaveBeenCalled();
      expect(mockStartListening).toHaveBeenCalledTimes(1);
    },
  );

  it('aborts a late microphone start after the component has unmounted', async () => {
    const started = deferred();
    mockStartListening.mockImplementation(async () => {
      await started.promise;
      mockManager.listening = true;
    });
    const dictation = renderDictation();
    let operation = Promise.resolve();
    act(() => {
      operation = dictation.result.current.startRecording();
    });
    dictation.unmount();
    await act(async () => {
      started.resolve();
      await operation;
    });
    expect(mockAbortListening).toHaveBeenCalledTimes(1);
    expect(mockManager.listening).toBe(false);
  });

  it('waits for a pending start before stopping once', async () => {
    const started = deferred();
    mockStartListening.mockImplementation(async () => {
      await started.promise;
      mockManager.listening = true;
    });
    const dictation = renderDictation();
    let starting = Promise.resolve();
    let stopping = Promise.resolve();
    act(() => {
      starting = dictation.result.current.startRecording();
      stopping = dictation.result.current.stopRecording();
    });
    await act(async () => {
      started.resolve();
      await Promise.all([starting, stopping]);
    });
    expect(mockStopListening).toHaveBeenCalledTimes(1);
    expect(dictation.result.current.isListening).toBe(false);
  });

  it('handles a failed start without leaving recording active', async () => {
    mockStartListening.mockRejectedValue(new Error('Permission denied'));
    const dictation = renderDictation();
    await start(dictation);
    expect(dictation.result.current.isListening).toBe(false);
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_microphone_unavailable',
      status: 'error',
    });
  });

  it('shows an error for unavailable microphones without starting', async () => {
    mockSpeech.isMicrophoneAvailable = false;
    const dictation = renderDictation();
    await start(dictation);
    expect(mockStartListening).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_microphone_unavailable',
      status: 'error',
    });
  });

  it('falls back to abort if the native stop fails and resolves the public stop operation', async () => {
    mockStopListening.mockRejectedValueOnce(new Error('Native stop failed'));
    const dictation = renderDictation();
    await start(dictation);
    await act(async () => {
      await dictation.result.current.stopRecording();
    });
    expect(mockAbortListening).toHaveBeenCalledTimes(1);
    expect(dictation.result.current.isListening).toBe(false);
    expect(mockRecognition.continuous).toBe(false);
  });

  it('does not start on unsupported browsers and suggests the configured external option', async () => {
    mockSpeech.browserSupportsSpeechRecognition = false;
    const dictation = renderDictation();
    await start(dictation);
    expect(mockStartListening).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith({
      message: 'com_ui_speech_not_supported_use_external',
      status: 'error',
    });
  });

  it('toggles only the browser engine with the keyboard and ignores held-key repeats', async () => {
    const dictation = renderDictation();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyL', altKey: true, shiftKey: true }),
      );
    });
    expect(mockStartListening).toHaveBeenCalledTimes(1);
    expect(dictation.onStart).toHaveBeenCalledTimes(1);
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyL', altKey: true, shiftKey: true, repeat: true }),
      );
    });
    expect(mockStopListening).not.toHaveBeenCalled();
    mockEndpoint = 'external';
    dictation.rerender();
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyL', altKey: true, shiftKey: true }),
      );
    });
    expect(mockStartListening).toHaveBeenCalledTimes(1);
    expect(mockUseSpeechRecognition).toHaveBeenLastCalledWith({ transcribing: false });
  });

  it('assigns the shared recognizer to one composer and leaves it running when another unmounts', async () => {
    const first = renderDictation();
    const second = renderDictation();
    await start(first);
    await start(second);
    expect(mockStartListening).toHaveBeenCalledTimes(1);
    emit(first, 'Nur im ersten Chat.');
    second.rerender();
    expect(first.setText).toHaveBeenCalledWith('Nur im ersten Chat.');
    expect(second.setText).not.toHaveBeenCalled();
    second.unmount();
    expect(mockAbortListening).not.toHaveBeenCalled();
  });

  it('keeps results assigned to the latest composer after both recordings have stopped', async () => {
    const first = renderDictation();
    const second = renderDictation();
    await start(first);
    emit(first, 'Erster Chat.');
    await act(async () => {
      await first.result.current.stopRecording();
    });
    first.setText.mockClear();
    await start(second);
    emit(second, 'Zweiter Chat.');
    await act(async () => {
      await second.result.current.stopRecording();
    });
    emit(second, 'Zweiter Chat. Letztes Ergebnis.');
    first.rerender();
    expect(first.setText).not.toHaveBeenCalled();
    expect(second.setText).toHaveBeenLastCalledWith('Zweiter Chat. Letztes Ergebnis.');
  });

  it('keeps the shared recognizer reserved until a cancelled pending start has been released', async () => {
    const started = deferred();
    mockStartListening.mockImplementationOnce(async () => {
      await started.promise;
      mockManager.listening = true;
    });
    const first = renderDictation();
    const second = renderDictation();
    let operation = Promise.resolve();
    act(() => {
      operation = first.result.current.startRecording();
    });
    first.unmount();
    await start(second);
    expect(mockStartListening).toHaveBeenCalledTimes(1);
    await act(async () => {
      started.resolve();
      await operation;
    });
    expect(mockManager.listening).toBe(false);
    await start(second);
    expect(mockStartListening).toHaveBeenCalledTimes(2);
    expect(second.result.current.isListening).toBe(true);
  });
});
