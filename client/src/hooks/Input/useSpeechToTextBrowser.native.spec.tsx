import 'regenerator-runtime/runtime';
import { act, renderHook } from '@testing-library/react';
import SpeechRecognition from 'react-speech-recognition';

jest.mock('react-speech-recognition/lib/NativeSpeechRecognition', () => {
  class NativeRecognition {
    continuous = false;
    lang = '';
    starts = 0;
    stops = 0;
    aborts = 0;
    onend = () => undefined;

    start() {
      this.starts += 1;
    }

    stop() {
      this.stops += 1;
      queueMicrotask(() => this.onend());
    }

    abort() {
      this.aborts += 1;
      queueMicrotask(() => this.onend());
    }
  }
  return { __esModule: true, default: NativeRecognition, isNative: () => true };
});
jest.mock('recoil', () => ({
  useRecoilValue: (atom: string) => ({ autoSendText: -1, languageSTT: 'de-DE', lang: 'de' })[atom],
}));
jest.mock('react-router-dom', () => ({ useLocation: () => ({ key: 'native-test' }) }));
jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: jest.fn() }) }));
jest.mock('librechat-data-provider/react-query', () => ({
  useGetCustomConfigSpeechQuery: () => ({ data: {} }),
}));
jest.mock('./useGetAudioSettings', () => ({
  __esModule: true,
  default: () => ({ speechToTextEndpoint: 'browser' }),
}));
jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/store', () => ({
  __esModule: true,
  default: { autoSendText: 'autoSendText', languageSTT: 'languageSTT', lang: 'lang' },
}));

import useSpeechToTextBrowser from './useSpeechToTextBrowser';

type NativeResult = { isFinal: boolean; 0: { transcript: string; confidence: number } };
type NativeRecognition = {
  continuous: boolean;
  starts: number;
  stops: number;
  aborts: number;
  onend: () => void;
  onresult: (event: { results: NativeResult[]; resultIndex: number }) => void;
};

const result = (transcript: string, isFinal: boolean): NativeResult => ({
  isFinal,
  0: { transcript, confidence: 1 },
});

describe('browser dictation with the installed recognition library', () => {
  it('reconnects after native disconnects, accumulates complete text, and stays stopped after explicit stop', async () => {
    const setText = jest.fn();
    const dictation = renderHook(() => useSpeechToTextBrowser(setText, jest.fn()));
    const native = SpeechRecognition.getRecognition() as NativeRecognition;
    const startsBefore = native.starts;
    await act(async () => {
      await dictation.result.current.startRecording();
    });
    expect(native.continuous).toBe(true);
    expect(native.starts).toBe(startsBefore + 1);
    act(() => native.onresult({ resultIndex: 0, results: [result('Erster Satz.', true)] }));
    act(() =>
      native.onresult({
        resultIndex: 1,
        results: [result('Erster Satz.', true), result('Zweiter', false)],
      }),
    );
    expect(setText).toHaveBeenLastCalledWith('Erster Satz. Zweiter');
    await act(async () => {
      native.onend();
    });
    expect(native.starts).toBe(startsBefore + 2);
    expect(dictation.result.current.isListening).toBe(true);
    act(() => native.onresult({ resultIndex: 0, results: [result('Zweiter Satz.', false)] }));
    act(() => native.onresult({ resultIndex: 0, results: [result('Zweiter Satz.', true)] }));
    expect(setText).toHaveBeenLastCalledWith('Erster Satz. Zweiter Satz.');
    await act(async () => {
      await dictation.result.current.stopRecording();
    });
    expect(native.continuous).toBe(false);
    expect(dictation.result.current.isListening).toBe(false);
    const startsAfterStop = native.starts;
    await act(async () => native.onend());
    expect(native.starts).toBe(startsAfterStop);
    dictation.unmount();
  });

  it('aborts an owned native recorder on unmount without the library reconnecting', async () => {
    const dictation = renderHook(() => useSpeechToTextBrowser(jest.fn(), jest.fn()));
    const native = SpeechRecognition.getRecognition() as NativeRecognition;
    await act(async () => {
      await dictation.result.current.startRecording();
    });
    const starts = native.starts;
    const aborts = native.aborts;
    await act(async () => dictation.unmount());
    expect(native.aborts).toBe(aborts + 1);
    expect(native.starts).toBe(starts);
    expect(native.continuous).toBe(false);
  });

  it('releases the microphone when unmounted during a library reconnect', async () => {
    const dictation = renderHook(() => useSpeechToTextBrowser(jest.fn(), jest.fn()));
    const native = SpeechRecognition.getRecognition() as NativeRecognition;
    await act(async () => {
      await dictation.result.current.startRecording();
    });
    const aborts = native.aborts;
    await act(async () => {
      native.onend();
      dictation.unmount();
    });
    expect(native.aborts).toBe(aborts + 1);
    expect(native.continuous).toBe(false);
    const starts = native.starts;
    await act(async () => native.onend());
    expect(native.starts).toBe(starts);
  });

  it('honours explicit stop during a library reconnect without reopening the microphone', async () => {
    const dictation = renderHook(() => useSpeechToTextBrowser(jest.fn(), jest.fn()));
    const native = SpeechRecognition.getRecognition() as NativeRecognition;
    await act(async () => {
      await dictation.result.current.startRecording();
    });
    await act(async () => {
      native.onend();
      await dictation.result.current.stopRecording();
    });
    expect(dictation.result.current.isListening).toBe(false);
    expect(native.continuous).toBe(false);
    const starts = native.starts;
    await act(async () => native.onend());
    expect(native.starts).toBe(starts);
  });
});
