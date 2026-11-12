import { useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { MessagesSquare, Mail, LibraryBig } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useKnowledgeStatus } from '~/data-provider/Notebooks';
import { useMailAvailability } from '~/data-provider/Mail';
import { useUserKeyQuery } from 'librechat-data-provider/react-query';
import { getConfigDefaults, getEndpointField } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import type { NavLink } from '~/common';
import ConversationsSection from '~/components/UnifiedSidebar/ConversationsSection';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import useSideNavLinks from '~/hooks/Nav/useSideNavLinks';
import store from '~/store';

const defaultInterface = getConfigDefaults().interface;

export default function useUnifiedSidebarLinks() {
  /** Selector instead of the full conversation atom: the links only depend on
   * the endpoint, so parameter edits and other conversation writes stay out. */
  const navigate = useNavigate();
  const { data: knowledgeStatus } = useKnowledgeStatus();
  const { data: mailStatus } = useMailAvailability();
  const endpoint = useRecoilValue(store.conversationEndpointByIndex(0)) ?? undefined;
  const { data: startupConfig } = useGetStartupConfig();
  const { data: endpointsConfig = {} as TEndpointsConfig } = useGetEndpointsQuery();

  const interfaceConfig = useMemo(
    () => startupConfig?.interface ?? defaultInterface,
    [startupConfig],
  );

  const endpointType = useMemo(
    () => getEndpointField(endpointsConfig, endpoint, 'type'),
    [endpoint, endpointsConfig],
  );

  const userProvidesKey = useMemo(
    () => !!(endpointsConfig?.[endpoint ?? '']?.userProvide ?? false),
    [endpointsConfig, endpoint],
  );

  const { data: keyExpiry = { expiresAt: undefined } } = useUserKeyQuery(endpoint ?? '');

  const keyProvided = useMemo(
    () => (userProvidesKey ? !!(keyExpiry.expiresAt ?? '') : true),
    [keyExpiry.expiresAt, userProvidesKey],
  );

  const sideNavLinks = useSideNavLinks({
    keyProvided,
    endpoint,
    endpointType,
    interfaceConfig,
    endpointsConfig,
    includeHidePanel: false,
  });

  const links = useMemo(() => {
    const conversationLink: NavLink = {
      title: 'com_ui_chat_history',
      label: '',
      icon: MessagesSquare,
      id: 'conversations',
      Component: ConversationsSection,
    };

    const mailLink: NavLink = {
      title: 'com_ui_mail_workspace',
      label: '',
      icon: Mail,
      id: 'mail',
      onClick: () => navigate('/mail'),
    };
    const knowledgeLink: NavLink = { title: 'com_ui_knowledge_title', label: '', icon: LibraryBig, id: 'notebooks', onClick: () => navigate('/wissensraeume') };
    return [conversationLink, ...(mailStatus?.available ? [mailLink] : []), ...(knowledgeStatus?.available ? [knowledgeLink] : []), ...sideNavLinks];
  }, [sideNavLinks, mailStatus?.available, knowledgeStatus?.available, navigate]);

  return links;
}
