import { memo, useMemo, useState, useEffect, useCallback, useRef, useId } from 'react';
import { useAtomValue } from 'jotai';
import { ContentTypes } from 'librechat-data-provider';
import type { MouseEvent, FocusEvent } from 'react';
import { ThinkingContent, ThinkingButton, FloatingThinkingBar } from './Thinking';
import { useLocalize, useExpandCollapse } from '~/hooks';
import { showThinkingAtom } from '~/store/showThinking';
import useSecondTick from '~/hooks/useSecondTick';
import { formatElapsed } from '~/utils/elapsed';
import { useMessageContext } from '~/Providers';
import { cn } from '~/utils';

const SHOW_ELAPSED_AFTER_MS = 2_000;
const LONG_THINKING_MS = 15_000;

/**
 * Thinking time as observed in this browser: counts while the part is live and keeps the
 * final value afterwards. A reloaded message has no observed start, so no duration is
 * claimed for it.
 */
function useThinkingTime(live: boolean) {
  const startedAtRef = useRef<number | null>(live ? Date.now() : null);
  const [measuredMs, setMeasuredMs] = useState<number | null>(null);
  useSecondTick(live);

  useEffect(() => {
    if (live && startedAtRef.current == null) {
      startedAtRef.current = Date.now();
      return;
    }
    if (!live && startedAtRef.current != null) {
      setMeasuredMs(Date.now() - startedAtRef.current);
      startedAtRef.current = null;
    }
  }, [live]);

  const elapsedMs = live && startedAtRef.current != null ? Date.now() - startedAtRef.current : 0;
  return { elapsedMs, measuredMs };
}

type ReasoningProps = {
  reasoning: string;
  isLast: boolean;
};

/**
 * Reasoning Component (MODERN SYSTEM)
 *
 * Used for structured content parts with ContentTypes.THINK type.
 * This handles modern message format where content is an array of typed parts.
 *
 * Pattern: `{ content: [{ type: "think", think: "<think>content</think>" }, ...] }`
 *
 * Used by:
 * - ContentParts.tsx → Part.tsx for structured messages
 * - Agent/Assistant responses (OpenAI Assistants, custom agents)
 * - O-series models (o1, o3) with reasoning capabilities
 * - Modern Claude responses with thinking blocks
 *
 * Key differences from legacy Thinking.tsx:
 * - Works with content parts array instead of plain text
 * - Strips `<think>` tags instead of `:::thinking:::` markers
 * - Each THINK part has its own independent toggle button
 * - Can be interleaved with other content types
 *
 * For legacy text-based messages, see Thinking.tsx component.
 */
const Reasoning = memo(({ reasoning, isLast }: ReasoningProps) => {
  const contentId = useId();
  const localize = useLocalize();
  const showThinking = useAtomValue(showThinkingAtom);
  const [isExpanded, setIsExpanded] = useState(showThinking);
  const [isBarVisible, setIsBarVisible] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { style: expandStyle, ref: expandRef } = useExpandCollapse(isExpanded);
  const { isSubmitting, isLatestMessage, nextType } = useMessageContext();

  // Strip <think> tags from the reasoning content (modern format)
  const reasoningText = useMemo(() => {
    return reasoning
      .replace(/^<think>\s*/, '')
      .replace(/\s*<\/think>$/, '')
      .trim();
  }, [reasoning]);

  const handleClick = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setIsExpanded((prev) => !prev);
  }, []);

  const handleFocus = useCallback(() => {
    setIsBarVisible(true);
  }, []);

  const handleBlur = useCallback((e: FocusEvent) => {
    if (!containerRef.current?.contains(e.relatedTarget as Node)) {
      setIsBarVisible(false);
    }
  }, []);

  const handleMouseEnter = useCallback(() => {
    setIsBarVisible(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (!containerRef.current?.contains(document.activeElement)) {
      setIsBarVisible(false);
    }
  }, []);

  const effectiveIsSubmitting = isLatestMessage ? isSubmitting : false;
  const live = effectiveIsSubmitting === true && isLast;
  const { elapsedMs, measuredMs } = useThinkingTime(live);

  const label = useMemo(() => {
    if (live) {
      return localize(elapsedMs >= LONG_THINKING_MS ? 'com_ui_thinking_long' : 'com_ui_thinking');
    }
    if (measuredMs != null && measuredMs >= SHOW_ELAPSED_AFTER_MS) {
      return localize('com_ui_thought_for', { time: formatElapsed(measuredMs) });
    }
    return localize('com_ui_thoughts');
  }, [live, elapsedMs, measuredMs, localize]);
  const detail = live && elapsedMs >= SHOW_ELAPSED_AFTER_MS ? formatElapsed(elapsedMs) : undefined;

  if (!reasoningText) {
    return null;
  }

  return (
    <div
      ref={containerRef}
      className="group/reasoning"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <div className="group/thinking-container">
        <div className="mb-2 pb-2 pt-2">
          <ThinkingButton
            isExpanded={isExpanded}
            onClick={handleClick}
            label={label}
            live={live}
            detail={detail}
            content={reasoningText}
            contentId={contentId}
          />
        </div>
        <div
          id={contentId}
          role="group"
          aria-label={label}
          aria-hidden={!isExpanded || undefined}
          className={cn(nextType !== ContentTypes.THINK && isExpanded && 'mb-4')}
          style={expandStyle}
        >
          <div className="relative overflow-hidden" ref={expandRef}>
            <ThinkingContent>{reasoningText}</ThinkingContent>
            <FloatingThinkingBar
              isVisible={isBarVisible && isExpanded}
              isExpanded={isExpanded}
              onClick={handleClick}
              content={reasoningText}
              contentId={contentId}
            />
          </div>
        </div>
      </div>
    </div>
  );
});

export default Reasoning;
