import React, { useRef, useEffect } from 'react';
import { cn } from '~/utils';

interface ConvoLinkProps {
  isActiveConvo: boolean;
  isPopoverActive: boolean;
  title: string | null;
  onRename: () => void;
  isSmallScreen: boolean;
  localize: (key: any, options?: any) => string;
  children: React.ReactNode;
}

const ConvoLink: React.FC<ConvoLinkProps> = ({
  isActiveConvo,
  isPopoverActive,
  title,
  onRename,
  isSmallScreen,
  localize,
  children,
}) => {
  const viewportRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  const animationRef = useRef<Animation>();
  const stopTitleScroll = () => {
    clearTimeout(timerRef.current);
    animationRef.current?.cancel();
  };
  useEffect(() => stopTitleScroll, [title]);
  const startTitleScroll = () => {
    stopTitleScroll();
    if (
      !window.matchMedia('(hover: hover) and (pointer: fine)').matches ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;
    timerRef.current = setTimeout(() => {
      const text = textRef.current;
      const viewport = viewportRef.current;
      if (!text || !viewport) return;
      const distance = text.scrollWidth - viewport.clientWidth;
      if (distance <= 0) return;
      animationRef.current = text.animate(
        [{ transform: 'translateX(0)' }, { transform: `translateX(-${distance}px)` }],
        { duration: Math.max(600, (distance / 35) * 1000), easing: 'linear', fill: 'forwards' },
      );
    }, 300);
  };
  return (
    <div
      className={cn(
        'flex min-w-0 grow items-center gap-2 overflow-hidden rounded-lg px-2',
        isActiveConvo || isPopoverActive ? 'bg-surface-active-alt' : '',
      )}
      onMouseEnter={startTitleScroll}
      onMouseLeave={stopTitleScroll}
      title={title ?? undefined}
      aria-current={isActiveConvo ? 'page' : undefined}
      style={{ width: '100%' }}
    >
      {children}
      <div
        ref={viewportRef}
        className="conversation-title-viewport relative flex-1 grow overflow-hidden whitespace-nowrap"
        style={{ textOverflow: 'clip' }}
        onDoubleClick={(e) => {
          if (isSmallScreen) {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          onRename();
        }}
        aria-label={title || localize('com_ui_untitled')}
      >
        <span ref={textRef} className="inline-block whitespace-nowrap">
          {title || localize('com_ui_untitled')}
        </span>
        <div
          className={cn(
            'conversation-title-fade pointer-events-none absolute bottom-0 right-0 top-0 w-20 bg-gradient-to-l',
            isActiveConvo || isPopoverActive
              ? 'from-surface-active-alt'
              : 'from-surface-primary-alt from-0% to-transparent group-hover:from-surface-active-alt group-hover:from-0%',
          )}
          aria-hidden="true"
        />
      </div>
    </div>
  );
};

export default ConvoLink;
