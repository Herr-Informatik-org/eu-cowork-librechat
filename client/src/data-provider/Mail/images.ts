import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { dataService, MutationKeys } from 'librechat-data-provider';
import type { MailWorkspaceImagesRequest, MailWorkspacePreview } from 'librechat-data-provider';

/** Image bytes stay in mounted preview state; mutation caches receive no response data. */
export function useMailImages(id: string, input: MailWorkspaceImagesRequest) {
  const [preview, setPreview] = useState<MailWorkspacePreview>();
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const mutation = useMutation(
    [MutationKeys.mailWorkspace, 'images', id, input.kind, input.revision],
    async () => {
      if (!active.current) return;
      const response = await dataService.loadMailWorkspaceImages(id, input);
      if (active.current) setPreview(response);
    },
    {
      retry: false,
      networkMode: 'always',
      cacheTime: 0,
      onSettled: () => (pending.current = false),
    },
  );
  return {
    preview,
    isLoading: mutation.isLoading,
    isError: mutation.isError,
    load: () => {
      if (pending.current) return;
      pending.current = true;
      mutation.mutate();
    },
    hide: () => setPreview(undefined),
  };
}
