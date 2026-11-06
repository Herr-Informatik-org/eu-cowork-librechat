import { useMemo, useCallback } from 'react';
import { EModelEndpoint } from 'librechat-data-provider';
import {
  useGetAssistantDocsQuery,
  useGetEndpointsQuery,
  useGetStartupConfig,
} from '~/data-provider';
import { useChatContext, useAgentsMapContext, useAssistantsMapContext } from '~/Providers';
import { getIconEndpoint, getEntity, getModelSpec } from '~/utils';
import { insertIntoComposer } from '~/components/Chat/NextSteps';
import { useSubmitMessage, useLocalize } from '~/hooks';
import '~/components/Chat/NextSteps/chips.css';

/** Model cards may list more starters than the agent builder allows (four). */
const MAX_VISIBLE_STARTERS = 6;
const OPEN_ENDING = /\s*(?:…|\.{3})$/;

const ConversationStarters = () => {
  const { conversation } = useChatContext();
  const agentsMap = useAgentsMapContext();
  const assistantMap = useAssistantsMapContext();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const { data: startupConfig } = useGetStartupConfig();

  const endpointType = useMemo(() => {
    let ep = conversation?.endpoint ?? '';
    if (ep === EModelEndpoint.azureOpenAI) {
      ep = EModelEndpoint.openAI;
    }
    return getIconEndpoint({
      endpointsConfig,
      iconURL: conversation?.iconURL,
      endpoint: ep,
    });
  }, [conversation?.endpoint, conversation?.iconURL, endpointsConfig]);

  const { data: documentsMap = new Map() } = useGetAssistantDocsQuery(endpointType, {
    select: (data) => new Map(data.map((dbA) => [dbA.assistant_id, dbA])),
  });

  const { entity, isAgent } = getEntity({
    endpoint: endpointType,
    agentsMap,
    assistantMap,
    agent_id: conversation?.agent_id,
    assistant_id: conversation?.assistant_id,
  });

  const modelSpec = useMemo(
    () => getModelSpec({ specName: conversation?.spec, startupConfig }),
    [conversation?.spec, startupConfig],
  );

  const conversation_starters = useMemo(() => {
    if (entity?.conversation_starters?.length) {
      return entity.conversation_starters;
    }

    if (modelSpec?.conversation_starters?.length) {
      return modelSpec.conversation_starters;
    }

    if (isAgent) {
      return [];
    }

    return documentsMap.get(entity?.id ?? '')?.conversation_starters ?? [];
  }, [documentsMap, isAgent, entity, modelSpec]);

  const localize = useLocalize();
  const { submitMessage } = useSubmitMessage();
  /** A starter ending in «…» needs the person's details: it goes to the composer instead. */
  const sendConversationStarter = useCallback(
    (text: string) => {
      if (OPEN_ENDING.test(text)) {
        insertIntoComposer({ text: text.replace(OPEN_ENDING, ''), needsInput: true });
        return;
      }
      submitMessage({ text });
    },
    [submitMessage],
  );

  if (!conversation_starters.length) {
    return null;
  }

  return (
    <div
      role="group"
      aria-label={localize('com_assistants_conversation_starters')}
      className="mb-8 mt-2 flex w-full flex-wrap items-stretch justify-center gap-2 px-4"
    >
      {conversation_starters.slice(0, MAX_VISIBLE_STARTERS).map((text: string, index: number) => (
        <button
          key={index}
          type="button"
          onClick={() => sendConversationStarter(text)}
          style={{ '--kisuno-stagger': index } as React.CSSProperties}
          className="kisuno-starter flex max-w-[16rem] cursor-pointer items-center justify-center rounded-2xl border border-border-medium bg-surface-secondary px-4 py-2.5 text-center text-sm text-text-secondary shadow-sm hover:border-border-heavy hover:bg-surface-tertiary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
        >
          <span className="line-clamp-2 text-balance break-words">{text}</span>
        </button>
      ))}
    </div>
  );
};

export default ConversationStarters;
