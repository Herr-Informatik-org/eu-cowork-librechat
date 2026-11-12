import { defaultUploadRoute } from '~/utils/defaultUploadRoute';
import React, { useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { OGDialog, OGDialogTemplate } from '@librechat/client';
import {
  FileSearch,
  ImageUpIcon,
  FileType2Icon,
  FileImageIcon,
  TerminalSquareIcon,
} from 'lucide-react';
import {
  Constants,
  Providers,
  EToolResources,
  EModelEndpoint,
  isDocumentSupportedProvider,
} from 'librechat-data-provider';
import {
  useLocalize,
  useUploadOptions,
  useFileUploadRouter,
  useAgentToolPermissions,
} from '~/hooks';
import { useDragDropContext, useUploadModalContext } from '~/Providers';
import { ephemeralAgentByConvoId } from '~/store';

const DragDropModal = () => {
  const localize = useLocalize();
  const { isVisible, files, closeModal } = useUploadModalContext();
  const { conversationId, agentId, endpoint, endpointType, useResponsesApi } = useDragDropContext();
  const ephemeralAgent = useRecoilValue(
    ephemeralAgentByConvoId(conversationId ?? Constants.NEW_CONVO),
  );
  const { provider } = useAgentToolPermissions(agentId, ephemeralAgent);
  const { getOptions } = useUploadOptions();
  const routeFiles = useFileUploadRouter();

  const isProviderDocSupported = useMemo(() => {
    let currentProvider = (provider || endpoint) ?? '';
    if (currentProvider.toLowerCase() === Providers.OPENROUTER) {
      currentProvider = Providers.OPENROUTER;
    }
    const isAzureWithResponsesApi =
      (currentProvider === EModelEndpoint.azureOpenAI ||
        endpointType === EModelEndpoint.azureOpenAI) &&
      useResponsesApi === true;
    return (
      isDocumentSupportedProvider(endpointType) ||
      isDocumentSupportedProvider(currentProvider) ||
      isAzureWithResponsesApi
    );
  }, [provider, endpoint, endpointType, useResponsesApi]);

  const getOptionMeta = (value: EToolResources | undefined) => {
    switch (value) {
      case EToolResources.file_search:
        return {
          label: localize('com_ui_upload_file_search'),
          description: localize('com_ui_upload_search_description'),
          icon: <FileSearch className="icon-md" />,
        };
      case EToolResources.execute_code:
        return {
          label:
            files.length > 0 && files.every((file) => /\.docx$/i.test(file.name))
              ? localize('com_ui_upload_word_template')
              : localize('com_ui_upload_code_environment'),
          description:
            files.length > 0 && files.every((file) => /\.docx$/i.test(file.name))
              ? localize('com_ui_upload_word_template_description')
              : localize('com_ui_upload_code_description'),
          icon: <TerminalSquareIcon className="icon-md" />,
        };
      case EToolResources.context:
        return {
          label: localize('com_ui_upload_ocr_text'),
          description: localize('com_ui_upload_text_description'),
          icon: <FileType2Icon className="icon-md" />,
        };
      default:
        return isProviderDocSupported
          ? {
              label: localize('com_ui_upload_provider'),
              description: localize('com_ui_upload_provider_description'),
              icon: <FileImageIcon className="icon-md" />,
            }
          : {
              label: localize('com_ui_upload_image_input'),
              description: localize('com_ui_upload_image_description'),
              icon: <ImageUpIcon className="icon-md" />,
            };
    }
  };

  const options = useMemo(() => getOptions(files), [getOptions, files]);

  if (!isVisible) {
    return null;
  }

  return (
    <OGDialog open={isVisible} onOpenChange={(open) => !open && closeModal()}>
      <OGDialogTemplate
        title={localize('com_ui_upload_add_files')}
        className="w-11/12 sm:w-[440px] md:w-[400px] lg:w-[360px]"
        main={
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => {
                routeFiles(files, defaultUploadRoute(files, options));
                closeModal();
              }}
              className="rounded-lg border border-border-heavy bg-surface-active-alt p-3 text-left"
            >
              <span className="block font-medium">{localize('com_ui_upload_use_in_chat')}</span>
              <span className="mt-1 block text-xs text-text-secondary">
                {localize('com_ui_upload_auto_description')}
              </span>
            </button>
            <details className="rounded-lg border border-border-light p-2">
              <summary className="cursor-pointer text-sm">
                {localize('com_ui_upload_advanced')}
              </summary>
              <div className="mt-2 flex flex-col gap-2">
                {options.map((value) => {
                  const { label, description, icon } = getOptionMeta(value);
                  return (
                    <button
                      key={value ?? 'provider'}
                      onClick={() => {
                        routeFiles(files, value);
                        closeModal();
                      }}
                      className="flex items-start gap-2 rounded-lg p-2 text-left hover:bg-surface-active-alt"
                    >
                      <span className="mt-0.5 shrink-0" aria-hidden="true">
                        {icon}
                      </span>
                      <span className="flex flex-col gap-1">
                        <span>{label}</span>
                        <span className="text-xs leading-relaxed text-text-secondary">
                          {description}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </details>
          </div>
        }
      />
    </OGDialog>
  );
};

export default DragDropModal;
