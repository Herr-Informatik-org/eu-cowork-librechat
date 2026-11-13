import { renderHook } from '@testing-library/react';
import useGetAudioSettings from './useGetAudioSettings';

let mockEngine = 'browser';
let mockSpeechConfig = { sttManaged: false, sttMaxRecordingSeconds: 120 };
let mockLoading = false;
let mockError = false;
jest.mock('librechat-data-provider/react-query', () => ({
  useGetCustomConfigSpeechQuery: () => ({
    data: mockLoading || mockError ? undefined : mockSpeechConfig,
    isLoading: mockLoading,
    isError: mockError,
    refetch: jest.fn(),
  }),
}));
jest.mock('recoil', () => ({
  useRecoilValue: (key: string) => (key === 'stt' ? mockEngine : 'browser'),
}));
jest.mock('~/store', () => ({ engineSTT: 'stt', engineTTS: 'tts' }));

describe('speech recorder selection', () => {
  it.each([
    ['browser', 'browser'],
    ['external', 'external'],
    ['openai', 'external'],
    ['azureOpenAI', 'external'],
    ['obsolete', 'browser'],
  ])('maps %s to %s', (saved, selected) => {
    mockEngine = saved;
    const { result } = renderHook(() => useGetAudioSettings());
    expect(result.current.speechToTextEndpoint).toBe(selected);
  });
});

describe('managed Whisper default', () => {
  it('selects the server for saved browser preferences', () => {
    mockEngine = 'browser';
    mockSpeechConfig = { sttManaged: true, sttMaxRecordingSeconds: 120 };
    const { result } = renderHook(() => useGetAudioSettings());
    expect(result.current.speechToTextEndpoint).toBe('external');
    expect(result.current.maxRecordingSeconds).toBe(120);
  });
  it('does not record through the browser before policy is known', () => {
    mockLoading = true;
    const { result } = renderHook(() => useGetAudioSettings());
    expect(result.current.speechToTextEndpoint).toBe('pending');
    mockLoading = false;
  });
  it('does not switch to a browser provider when settings fail', () => {
    mockError = true;
    const { result } = renderHook(() => useGetAudioSettings());
    expect(result.current.speechToTextEndpoint).toBe('unavailable');
    mockError = false;
  });
});
