import { createStorageAtom } from './jotai-utils';

export const chatDebugAtom = createStorageAtom<boolean>('kisunoChatDebug', false);
