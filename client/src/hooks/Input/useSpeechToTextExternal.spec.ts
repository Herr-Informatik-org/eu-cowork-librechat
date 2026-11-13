import { act, renderHook } from '@testing-library/react';
import useSpeechToTextExternal from './useSpeechToTextExternal';

const mockToast = jest.fn();
const mockProcessAudio = jest.fn();
const mockPreviewAudio = jest.fn();
let mockManaged = false;
jest.mock('librechat-data-provider', () => ({
  dataService: { speechToText: (...args: unknown[]) => mockPreviewAudio(...args) },
}));
const mockLocalize = jest.fn((key: string) => key);
jest.mock('~/hooks', () => ({ useLocalize: () => mockLocalize }));
let mockLocation = 'first';
const mockSettings = {
  decibelValue: -45,
  autoSendText: -1,
  languageSTT: '',
  lang: 'de',
  speechToText: true,
  autoTranscribeAudio: false,
};
jest.mock('recoil', () => ({
  useRecoilValue: (atom: keyof typeof mockSettings) => mockSettings[atom],
}));
jest.mock('~/store', () => ({
  decibelValue: 'decibelValue',
  autoSendText: 'autoSendText',
  languageSTT: 'languageSTT',
  lang: 'lang',
  speechToText: 'speechToText',
  autoTranscribeAudio: 'autoTranscribeAudio',
}));
jest.mock('react-router-dom', () => ({ useLocation: () => ({ key: mockLocation }) }));
jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: mockToast }) }));
jest.mock('~/data-provider', () => ({
  useSpeechToTextMutation: () => ({ mutateAsync: mockProcessAudio }),
}));
jest.mock('./useGetAudioSettings', () => () => ({
  speechToTextEndpoint: 'external',
  sttManaged: mockManaged,
}));

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = jest.fn((type) => type === 'audio/mp4');
  state = 'inactive';
  mimeType = '';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start = jest.fn(() => {
    this.state = 'recording';
  });

  stop = jest.fn(() => {
    this.state = 'inactive';
    setTimeout(() => {
      this.ondataavailable?.({ data: new Blob(['final-audio'], { type: this.mimeType }) });
      this.onstop?.();
    }, 0);
  });

  constructor(_stream: MediaStream, options?: { mimeType: string }) {
    this.mimeType = options?.mimeType || 'audio/webm';
    FakeRecorder.instances.push(this);
  }
}

const track: Pick<MediaStreamTrack, 'stop' | 'onended'> = { stop: jest.fn(), onended: null };
const stream = {
  getTracks: () => [track],
  getAudioTracks: () => [track],
} as unknown as MediaStream;
const mockGetUserMedia = jest.fn();
const mockCloseContext = jest.fn(() => Promise.resolve());
class FakeAudioContext {
  close = mockCloseContext;
  createMediaStreamSource() {
    return { connect: jest.fn() };
  }

  createAnalyser() {
    return {
      minDecibels: -45,
      frequencyBinCount: 16,
      getByteFrequencyData: (data: Uint8Array) => data.fill(0),
    };
  }
}

const mount = () => {
  const setText = jest.fn();
  const complete = jest.fn();
  const started = jest.fn();
  const hook = renderHook(() => useSpeechToTextExternal(setText, complete, started));
  return { ...hook, setText, complete, started };
};
async function drainStop() {
  await act(async () => {
    jest.advanceTimersByTime(0);
    await Promise.resolve();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  FakeRecorder.instances = [];
  mockLocation = 'first';
  mockManaged = false;
  mockPreviewAudio.mockResolvedValue({ text: 'Eine vorläufige Vorschau.' });
  Object.assign(mockSettings, {
    autoSendText: -1,
    languageSTT: '',
    lang: 'de',
    speechToText: true,
    autoTranscribeAudio: false,
  });
  mockGetUserMedia.mockResolvedValue(stream);
  mockProcessAudio.mockResolvedValue({ text: 'Guten Tag. Der Betrag ist 1’234.50 Franken.' });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: mockGetUserMedia },
  });
  Object.defineProperty(window, 'MediaRecorder', {
    configurable: true,
    writable: true,
    value: FakeRecorder,
  });
  Object.defineProperty(window, 'AudioContext', {
    configurable: true,
    writable: true,
    value: FakeAudioContext,
  });
});
afterEach(() => {
  jest.useRealTimers();
});

describe('server dictation recording lifecycle', () => {
  it('records through long pauses and drains the final audio before transcribing', async () => {
    const hook = mount();
    await act(async () => {
      await hook.result.current.externalStartRecording();
      await hook.result.current.externalStartRecording();
    });
    expect(mockGetUserMedia).toHaveBeenCalledTimes(1);
    expect(hook.started).toHaveBeenCalledTimes(1);
    act(() => {
      jest.advanceTimersByTime(90000);
    });
    expect(hook.result.current.isListening).toBe(true);
    expect(mockProcessAudio).not.toHaveBeenCalled();
    act(() => {
      hook.result.current.externalStopRecording();
      hook.result.current.externalStopRecording();
    });
    await drainStop();
    expect(FakeRecorder.instances[0].stop).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalled();
    const form = mockProcessAudio.mock.calls[0][0] as FormData;
    expect((form.get('audio') as File).name).toBe('audio.m4a');
    expect((form.get('audio') as File).size).toBeGreaterThan(0);
    expect(form.get('language')).toBe('de');
    expect(hook.setText).toHaveBeenCalledWith('Guten Tag. Der Betrag ist 1’234.50 Franken.');
    expect(hook.complete).not.toHaveBeenCalled();
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('respects an explicitly selected language', async () => {
    mockSettings.languageSTT = 'fr-CH';
    const hook = mount();
    await act(async () => {
      await hook.result.current.externalStartRecording();
    });
    act(() => {
      hook.result.current.externalStopRecording();
    });
    await drainStop();
    expect(mockProcessAudio.mock.calls[0][0].get('language')).toBe('fr-CH');
  });

  it('allows only one composer to own a microphone session', async () => {
    const first = mount();
    const second = mount();
    await act(async () => {
      await first.result.current.externalStartRecording();
      await second.result.current.externalStartRecording();
    });
    expect(mockGetUserMedia).toHaveBeenCalledTimes(1);
    second.unmount();
    expect(first.result.current.isListening).toBe(true);
    expect(track.stop).not.toHaveBeenCalled();
    first.unmount();
    await drainStop();
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('releases a microphone granted after navigation without transcribing', async () => {
    let grant!: (value: MediaStream) => void;
    mockGetUserMedia.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    const hook = mount();
    act(() => {
      void hook.result.current.externalStartRecording();
    });
    mockLocation = 'second';
    hook.rerender();
    await act(async () => {
      grant(stream);
    });
    expect(track.stop).toHaveBeenCalled();
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(mockProcessAudio).not.toHaveBeenCalled();
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('can stop while the permission prompt is open', async () => {
    let grant!: (value: MediaStream) => void;
    mockGetUserMedia.mockReturnValue(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    const hook = mount();
    act(() => {
      void hook.result.current.externalStartRecording();
    });
    act(() => {
      hook.result.current.externalStopRecording();
    });
    await act(async () => {
      grant(stream);
    });
    expect(track.stop).toHaveBeenCalled();
    expect(FakeRecorder.instances).toHaveLength(0);
  });

  it('discards delayed transcription after a chat change', async () => {
    let finish!: (value: { text: string }) => void;
    mockProcessAudio.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const hook = mount();
    await act(async () => {
      await hook.result.current.externalStartRecording();
    });
    act(() => {
      hook.result.current.externalStopRecording();
    });
    await drainStop();
    expect(hook.result.current.isLoading).toBe(true);
    mockLocation = 'second';
    hook.rerender();
    await act(async () => {
      finish({ text: 'Alter Chat.' });
    });
    expect(hook.setText).not.toHaveBeenCalled();
    expect(hook.complete).not.toHaveBeenCalled();
  });

  it('releases the microphone on unmount without sending the abandoned audio', async () => {
    const hook = mount();
    await act(async () => {
      await hook.result.current.externalStartRecording();
    });
    hook.unmount();
    await drainStop();
    expect(track.stop).toHaveBeenCalled();
    expect(mockProcessAudio).not.toHaveBeenCalled();
  });

  it('keeps the composer intact when transcription fails', async () => {
    mockProcessAudio.mockRejectedValue(new Error('unavailable'));
    const hook = mount();
    await act(async () => {
      await hook.result.current.externalStartRecording();
    });
    act(() => {
      hook.result.current.externalStopRecording();
    });
    await drainStop();
    expect(hook.setText).not.toHaveBeenCalled();
    expect(hook.result.current.isLoading).toBe(false);
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('ends the recording on pagehide without uploading audio or leaving a busy button', async () => {
    const hook = mount();
    await act(async () => {
      await hook.result.current.externalStartRecording();
    });
    act(() => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await drainStop();
    expect(track.stop).toHaveBeenCalled();
    expect(mockProcessAudio).not.toHaveBeenCalled();
    expect(hook.result.current.isListening).toBe(false);
    expect(hook.result.current.isLoading).toBe(false);
  });

  it('keeps the composer intact on empty results', async () => {
    mockProcessAudio.mockResolvedValue({ text: ' ' });
    const hook = mount();
    await act(async () => {
      await hook.result.current.externalStartRecording();
    });
    act(() => {
      hook.result.current.externalStopRecording();
    });
    await drainStop();
    expect(hook.setText).not.toHaveBeenCalled();
    expect(mockToast).toHaveBeenCalledWith(expect.objectContaining({ status: 'warning' }));
  });

  it('cancels automatic sending on navigation', async () => {
    mockSettings.autoSendText = 3;
    const hook = mount();
    await act(async () => {
      await hook.result.current.externalStartRecording();
    });
    act(() => {
      hook.result.current.externalStopRecording();
    });
    await drainStop();
    mockLocation = 'second';
    hook.rerender();
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(hook.complete).not.toHaveBeenCalled();
  });

  it('only sends automatically when the user explicitly enabled it', async () => {
    mockSettings.autoSendText = 3;
    const hook = mount();
    await act(async () => {
      await hook.result.current.externalStartRecording();
    });
    act(() => {
      hook.result.current.externalStopRecording();
    });
    await drainStop();
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(hook.complete).toHaveBeenCalledTimes(1);
  });

  it('releases AudioContext and tolerates ten-second pauses in automatic mode', async () => {
    mockSettings.autoTranscribeAudio = true;
    const hook = mount();
    await act(async () => {
      await hook.result.current.externalStartRecording();
    });
    act(() => {
      jest.advanceTimersByTime(10000);
    });
    expect(hook.result.current.isListening).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(5100);
    });
    expect(FakeRecorder.instances[0].stop).toHaveBeenCalledTimes(1);
    expect(mockCloseContext).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalled();
  });

  it('finishes at the bounded ten-minute limit', async () => {
    const hook = mount();
    await act(async () => {
      await hook.result.current.externalStartRecording();
    });
    await act(async () => {
      jest.advanceTimersByTime(600001);
    });
    expect(FakeRecorder.instances[0].stop).toHaveBeenCalledTimes(1);
    expect(mockProcessAudio).toHaveBeenCalledTimes(1);
  });

  it('handles microphone denial without leaving the recorder busy', async () => {
    mockGetUserMedia.mockRejectedValue(new Error('denied'));
    const hook = mount();
    await act(async () => {
      await hook.result.current.externalStartRecording();
    });
    expect(hook.result.current.isLoading).toBe(false);
    expect(hook.result.current.isListening).toBe(false);
    expect(mockProcessAudio).not.toHaveBeenCalled();
  });
});

describe('managed live preview', () => {
  it('keeps preview out of the form and uses the complete primary recording for the final text', async () => {
    mockManaged = true;
    const hook = mount();
    await act(async () => {
      await hook.result.current.externalStartRecording();
    });
    expect(mockGetUserMedia).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(6000);
      await Promise.resolve();
    });
    expect(mockPreviewAudio).toHaveBeenCalledTimes(1);
    expect(hook.result.current.previewText).toBe('Eine vorläufige Vorschau.');
    expect(hook.setText).not.toHaveBeenCalled();
    expect(FakeRecorder.instances[0].state).toBe('recording');
    act(() => hook.result.current.externalStopRecording());
    await drainStop();
    expect(mockProcessAudio).toHaveBeenCalledTimes(1);
    expect(hook.setText).toHaveBeenCalledWith('Guten Tag. Der Betrag ist 1’234.50 Franken.');
    expect(hook.complete).not.toHaveBeenCalled();
    hook.unmount();
  });
  it('shows elapsed time even if the sound analyser is unavailable', async () => {
    mockManaged = true;
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: undefined });
    const hook = mount();
    await act(async () => {
      await hook.result.current.externalStartRecording();
    });
    act(() => {
      jest.advanceTimersByTime(3250);
    });
    expect(hook.result.current.elapsedSeconds).toBe(3);
    expect(hook.result.current.isListening).toBe(true);
    act(() => hook.result.current.cancelRecording());
    expect(hook.setText).not.toHaveBeenCalled();
    hook.unmount();
  });
  it('preserves a provisional draft with an explicit warning if final recognition fails', async () => {
    mockManaged = true;
    mockProcessAudio.mockRejectedValue(new Error('temporarily unavailable'));
    const hook = mount();
    await act(async () => {
      await hook.result.current.externalStartRecording();
    });
    await act(async () => {
      jest.advanceTimersByTime(6000);
      await Promise.resolve();
    });
    act(() => hook.result.current.externalStopRecording());
    await drainStop();
    expect(hook.setText).toHaveBeenCalledWith('Eine vorläufige Vorschau.');
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_ui_dictation_preview_saved' }),
    );
    hook.unmount();
  });
});
