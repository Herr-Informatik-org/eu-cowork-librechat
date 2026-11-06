import { findLatestPlan, hasOpenPlanSteps } from 'librechat-data-provider';
import type { PlanSourcePart, TNextStep } from 'librechat-data-provider';
import { validateNextSteps } from './validate';
import { BlockSplitter } from './splitter';

interface DeltaPart {
  type?: string;
  text?: string;
}

/** The `on_message_delta` payload the graph dispatches for a text step. */
export interface TextDeltaEvent {
  id?: string;
  delta?: { content?: DeltaPart | DeltaPart[] };
}

/** Sends a (filtered or released) delta through aggregation and emission. */
export type DeltaForwarder<M> = (data: TextDeltaEvent, metadata: M | undefined) => Promise<void>;

interface StepEntry<M> {
  splitter: BlockSplitter;
  metadata: M | undefined;
  order: number;
  hasText: boolean;
}

export interface NextStepsSink<M = unknown> {
  /** Removes block text from a delta; returns null when nothing visible remains. */
  filter<T extends TextDeltaEvent>(data: T, metadata?: M): T | null;
  /** Registers how released text reaches the aggregator and the client. */
  bind(forward: DeltaForwarder<M>): void;
  /** A new run step begins: release held text of other steps; a tool step ends any answer before it. */
  onRunStep(stepId: string | undefined, isToolStep: boolean): Promise<void>;
  /** The run finished: release held text and close unterminated blocks. */
  flush(): Promise<void>;
  /** Validated next steps when the answer ended with a complete block, else undefined. */
  take(request?: string): TNextStep[] | undefined;
}

const textDelta = (id: string, text: string): TextDeltaEvent => ({
  id,
  delta: { content: [{ type: 'text', text }] },
});

/**
 * Per-response filter for `<naechste_schritte>` blocks. Each text step gets its
 * own splitter, so a block split across chunks, steps of other agents, or tool
 * calls never leaks into aggregated content, emitted events, or persistence.
 * Only a block that closes the final text of the answer yields suggestions.
 */
export function createNextStepsSink<M = unknown>(): NextStepsSink<M> {
  const entries = new Map<string, StepEntry<M>>();
  let forward: DeltaForwarder<M> | undefined;
  let counter = 0;
  let lastToolOrder = 0;

  const entryFor = (stepId: string, metadata: M | undefined): StepEntry<M> => {
    const existing = entries.get(stepId);
    if (existing) {
      if (metadata !== undefined) {
        existing.metadata = metadata;
      }
      return existing;
    }
    const created: StepEntry<M> = {
      splitter: new BlockSplitter(),
      metadata,
      order: ++counter,
      hasText: false,
    };
    entries.set(stepId, created);
    return created;
  };

  const send = async (stepId: string, entry: StepEntry<M>, text: string): Promise<void> => {
    if (text === '' || !forward) {
      return;
    }
    entry.hasText = true;
    await forward(textDelta(stepId, text), entry.metadata);
  };

  return {
    filter<T extends TextDeltaEvent>(data: T, metadata?: M): T | null {
      const stepId = data?.id;
      const content = data?.delta?.content;
      if (!stepId || content == null) {
        return data;
      }
      const parts = Array.isArray(content) ? content : [content];
      let touched = false;
      const visible: DeltaPart[] = [];
      for (const part of parts) {
        if (part?.type !== 'text' || typeof part.text !== 'string') {
          visible.push(part);
          continue;
        }
        touched = true;
        const entry = entryFor(stepId, metadata);
        const text = entry.splitter.push(part.text);
        if (text !== '') {
          entry.hasText = true;
          visible.push({ ...part, text });
        }
      }
      if (!touched) {
        return data;
      }
      if (visible.length === 0) {
        return null;
      }
      const nextContent = Array.isArray(content) ? visible : visible[0];
      return { ...data, delta: { ...data.delta, content: nextContent } };
    },

    bind(next: DeltaForwarder<M>): void {
      forward = next;
    },

    async onRunStep(stepId: string | undefined, isToolStep: boolean): Promise<void> {
      for (const [id, entry] of entries) {
        if (id !== stepId) {
          await send(id, entry, entry.splitter.release());
        }
      }
      if (isToolStep) {
        lastToolOrder = ++counter;
      }
    },

    async flush(): Promise<void> {
      for (const [id, entry] of entries) {
        await send(id, entry, entry.splitter.finish());
      }
    },

    take(request = ''): TNextStep[] | undefined {
      let last: StepEntry<M> | undefined;
      for (const entry of entries.values()) {
        if ((entry.hasText || entry.splitter.sawBlock()) && (!last || entry.order > last.order)) {
          last = entry;
        }
      }
      if (!last || lastToolOrder > last.order) {
        return undefined;
      }
      const block = last.splitter.block();
      if (block == null) {
        return undefined;
      }
      const steps = validateNextSteps(block, request);
      return steps.length > 0 ? steps : undefined;
    },
  };
}

export interface ResolveNextStepsParams {
  sink?: NextStepsSink | null;
  /** Aggregated content of the turn. */
  contentParts?: ReadonlyArray<(PlanSourcePart & { type?: string }) | null | undefined> | null;
  /** The person's request text, to drop a suggestion that merely repeats it. */
  request?: string;
  /** The run paused for a question or approval. */
  paused?: boolean;
  /** The run was stopped by the person or halted by a hook. */
  stopped?: boolean;
}

/**
 * Next steps belong only under a complete answer of a finished turn: not after
 * a pause (question, approval), a stop, an error part, or while the visible
 * plan still has open steps after the stop reminder.
 */
export function resolveNextSteps({
  sink,
  contentParts,
  request,
  paused = false,
  stopped = false,
}: ResolveNextStepsParams): TNextStep[] | undefined {
  if (!sink || paused || stopped) {
    return undefined;
  }
  if (contentParts?.some((part) => part?.type === 'error')) {
    return undefined;
  }
  if (hasOpenPlanSteps(findLatestPlan(contentParts))) {
    return undefined;
  }
  return sink.take(request);
}
