import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { OGDialog, OGDialogContent, OGDialogTitle, OGDialogDescription } from '@librechat/client';
import type { ReactNode, MutableRefObject } from 'react';
import { useAuthContext } from '~/hooks/AuthContext';
import useLocalize from '~/hooks/useLocalize';
import Workspace from './Workspace';
import './brain.css';

const BrainDialogContext = createContext<{
  showBrain: (id?: string) => void;
  triggerRef: MutableRefObject<HTMLButtonElement | null>;
} | null>(null);

export function useBrainDialog() {
  const context = useContext(BrainDialogContext);
  if (!context) throw new Error('BrainDialogProvider is required');
  return context;
}

function DialogHost({ children }: { children: ReactNode }) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const showBrain = useCallback((id?: string) => {
    setSelectedId(id ?? null);
    setOpen(true);
  }, []);
  const context = useMemo(() => ({ showBrain, triggerRef }), [showBrain]);
  return (
    <BrainDialogContext.Provider value={context}>
      {children}
      <OGDialog open={open} onOpenChange={setOpen} triggerRef={triggerRef}>
        <OGDialogContent
          className="brain-dialog"
          overlayClassName="brain-dialog-overlay"
          showCloseButton={false}
        >
          <OGDialogTitle className="sr-only">{localize('com_ui_brain_title')}</OGDialogTitle>
          <OGDialogDescription className="sr-only">
            {localize('com_ui_brain_subtitle')}
          </OGDialogDescription>
          {open && <Workspace initialSelectedId={selectedId} onClose={() => setOpen(false)} />}
        </OGDialogContent>
      </OGDialog>
    </BrainDialogContext.Provider>
  );
}

/** The stable host survives sidebar breakpoint remounts; an account change destroys its drafts. */
export function BrainDialogProvider({ children }: { children: ReactNode }) {
  const { user } = useAuthContext();
  return <DialogHost key={user?.id ?? 'signed-out'}>{children}</DialogHost>;
}
