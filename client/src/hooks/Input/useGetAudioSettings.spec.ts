import { renderHook } from '@testing-library/react';
import useGetAudioSettings from './useGetAudioSettings';

let mockEngine = 'browser';
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
