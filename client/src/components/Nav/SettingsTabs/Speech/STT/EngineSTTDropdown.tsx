import React from 'react';
import { Dropdown } from '@librechat/client';
import { useRecoilState, useRecoilValue } from 'recoil';
import { useLocalize } from '~/hooks';
import store from '~/store';
import useGetAudioSettings from '~/hooks/Input/useGetAudioSettings';

interface EngineSTTDropdownProps {
  external: boolean;
}

const EngineSTTDropdown: React.FC<EngineSTTDropdownProps> = ({ external }) => {
  const localize = useLocalize();
  const [, setEngineSTT] = useRecoilState<string>(store.engineSTT);
  const { speechToTextEndpoint, sttManaged } = useGetAudioSettings();
  const speechToText = useRecoilValue(store.speechToText);

  let endpointOptions = [{ value: 'browser', label: localize('com_nav_browser') }];
  if (sttManaged) {
    endpointOptions = [{ value: 'external', label: 'Whisper large-v3-turbo' }];
  } else if (external) {
    endpointOptions.push({ value: 'external', label: localize('com_nav_external') });
  }

  const handleSelect = (value: string) => {
    setEngineSTT(value);
  };

  const labelId = 'engine-stt-dropdown-label';

  return (
    <div className="flex items-center justify-between">
      <div id={labelId}>{localize('com_nav_engine')}</div>
      <Dropdown
        value={speechToTextEndpoint}
        onChange={handleSelect}
        options={endpointOptions}
        sizeClasses="w-[180px]"
        testId="EngineSTTDropdown"
        className="z-50"
        aria-labelledby={labelId}
        disabled={!speechToText || sttManaged}
      />
    </div>
  );
};

export default EngineSTTDropdown;
