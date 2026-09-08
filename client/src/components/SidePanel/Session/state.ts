import { atomWithLocalStorage } from '~/store/utils';

export const sessionPanelVisible = atomWithLocalStorage(
  'sessionPanelVisible',
  typeof window !== 'undefined' && window.matchMedia('(min-width: 1024px)').matches,
);
