import { useMemo } from 'react';
import ProposalCard from './ProposalCard';
import { resolveOutcome } from './decisions';

/**
 * The record of a decided proposal after its tool call settled: «Übernommen» or
 * «Verworfen», or «Nur geplant» when the work mode `plan` held the change back.
 * Renders nothing for ordinary tool calls.
 */
export default function ProposalOutcome({
  toolCallId,
  name,
  args,
  output,
}: {
  toolCallId?: string;
  name: string;
  args: unknown;
  output?: string | null;
}) {
  const outcome = useMemo(() => resolveOutcome(toolCallId, output), [toolCallId, output]);
  if (outcome == null) {
    return null;
  }
  return <ProposalCard name={name} args={args} status={outcome} compact={outcome !== 'planned'} />;
}
