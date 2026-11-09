import { ContentTypes, isPlanToolPart, findLatestPlan } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { GroupedPart } from '~/utils/groupToolCalls';
import type { PartWithIndex } from './ParallelContent';
import { getActivityLabelPart, getActivityLabelText } from '~/utils/activityLabels';

/** Consecutive reasoning parts rendered as one block; `text` holds every segment in order. */
export type ThoughtRun = { type: 'thoughts'; parts: PartWithIndex[]; text: string };

type ContentList = ReadonlyArray<TMessageContentParts | undefined> | undefined;

const SUMMARY_HEADING = /^[ \t]*\*\*([^*\n]+?)\*\*[ \t]*$/gm;

const textOf = (value: string | { value?: string } | undefined): string =>
  typeof value === 'string' ? value : (value?.value ?? '');

/** Reasoning text of a THINK part without `<think>` wrappers. */
export function thoughtText(part: TMessageContentParts | undefined): string {
  if (part?.type !== ContentTypes.THINK) {
    return '';
  }
  return textOf(part.think)
    .replace(/^<think>\s*/, '')
    .replace(/\s*<\/think>$/, '')
    .trim();
}

/**
 * Parts that render nothing in the sequential flow: plan updates (shown in the
 * docked plan bar), blank activity-label reservations, empty text parts and
 * reasoning parts whose text has not arrived yet. Reasoning separated only by
 * such parts is one continuous stretch of thinking.
 */
export function isHiddenPart(part: TMessageContentParts | undefined): boolean {
  if (part == null || isPlanToolPart(part)) {
    return true;
  }
  if (part.type === ContentTypes.THINK) {
    return thoughtText(part).length === 0;
  }
  if (part.type === ContentTypes.ACTIVITY_LABEL) {
    return getActivityLabelText(getActivityLabelPart(part)).length === 0;
  }
  if (part.type === ContentTypes.TEXT) {
    return textOf(part.text).trim().length === 0;
  }
  return false;
}

/** Index of the last part that renders something, or -1 while nothing visible has arrived. */
export function lastShownIdx(content: ContentList): number {
  const parts = content ?? [];
  for (let i = parts.length - 1; i >= 0; i--) {
    if (!isHiddenPart(parts[i])) {
      return i;
    }
  }
  return -1;
}

const isThoughtGroup = (group: GroupedPart): group is { type: 'single'; part: PartWithIndex } =>
  group.type === 'single' && group.part.part?.type === ContentTypes.THINK;

const isHiddenGroup = (group: GroupedPart): boolean =>
  group.type === 'single' && isHiddenPart(group.part.part);

const toRun = (parts: PartWithIndex[]): ThoughtRun => ({
  type: 'thoughts',
  parts,
  text: parts
    .map(({ part }) => thoughtText(part))
    .filter((text) => text.length > 0)
    .join('\n\n'),
});

/**
 * Collapses standalone reasoning parts into runs. Hidden parts between two
 * reasoning parts are dropped (they render nothing); hidden parts after the
 * last reasoning part of a run keep their place. Any visible part, including
 * a visible tool call, ends the run. Grouped tool blocks pass through as is.
 */
export function mergeThoughtRuns<G extends GroupedPart>(
  groups: readonly G[],
): Array<G | ThoughtRun> {
  const result: Array<G | ThoughtRun> = [];
  let run: PartWithIndex[] = [];
  let trailing: G[] = [];

  const flush = () => {
    if (run.length > 0) {
      result.push(toRun(run));
    }
    result.push(...trailing);
    run = [];
    trailing = [];
  };

  for (const group of groups) {
    if (isThoughtGroup(group)) {
      run.push(group.part);
      trailing = [];
      continue;
    }
    if (run.length > 0 && isHiddenGroup(group)) {
      trailing.push(group);
      continue;
    }
    flush();
    result.push(group);
  }
  flush();
  return result;
}

/**
 * Last content index of the reasoning run that closes the rendered content,
 * looking past trailing hidden parts; -1 when visible output follows the last
 * run. While a response streams, that run is the one still thinking.
 */
export function tailThoughtIdx(groups: ReadonlyArray<GroupedPart | ThoughtRun>): number {
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i];
    if (group.type === 'thoughts') {
      return group.parts[group.parts.length - 1]?.idx ?? -1;
    }
    if (!isHiddenGroup(group)) {
      return -1;
    }
  }
  return -1;
}

/** The plan step marked as running in the newest plan update of the message. */
export function runningPlanStep(content: ContentList): string | undefined {
  const plan = findLatestPlan(content);
  return plan?.steps.find((step) => step.status === 'laeuft')?.text;
}

/**
 * Newest summary heading in streamed reasoning. Reasoning summaries open each
 * section with a bold line (`**Checking the data**`); the last complete one
 * names what the model is working on right now.
 */
export function latestThoughtHeading(text: string): string | undefined {
  let heading: string | undefined;
  for (const match of text.matchAll(SUMMARY_HEADING)) {
    heading = match[1];
  }
  const collapsed = heading?.replace(/\s+/g, ' ').trim();
  return collapsed ? collapsed : undefined;
}
