import { renderHook } from '@testing-library/react';
import useSpeechToText from './useSpeechToText';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: jest.fn() }) }));
jest.mock('./useGetAudioSettings', () => () => ({ speechToTextEndpoint: 'external', isSpeechConfigLoading: false }));
jest.mock('./useSpeechToTextBrowser', () => () => ({ isListening: false, isLoading: false }));
jest.mock('./useSpeechToTextExternal', () => () => ({
  isListening: false, isLoading: true, isFinalizing: true, liveDictation: true,
  previewText: 'Noch vorläufig.', elapsedSeconds: 12, levels: [0.3],
  externalStartRecording: jest.fn(), externalStopRecording: jest.fn(), cancelRecording: jest.fn(),
}));

it('keeps the composer in finalizing state after microphone capture has stopped', () => {
  const { result } = renderHook(() => useSpeechToText(jest.fn(), jest.fn()));
  expect(result.current.isListening).toBe(false);
  expect(result.current.isFinalizing).toBe(true);
  expect(result.current.previewText).toBe('Noch vorläufig.');
  expect(typeof result.current.cancelRecording).toBe('function');
});
