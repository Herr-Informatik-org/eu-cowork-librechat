import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import Memory from '~/components/Chat/Input/Memory';
import ToolsDropdown from '~/components/Chat/Input/ToolsDropdown';

let mockBrainEnabled: boolean | undefined = true;
let mockOptedOut = false;
const mockChange = jest.fn();
jest.mock('~/data-provider/Brain', () => ({
  useBrainStatusQuery: () => ({ data: { enabled: mockBrainEnabled } }),
}));
jest.mock('~/data-provider', () => ({ useGetStartupConfig: () => ({ data: {} }) }));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: { personalization: { memories: !mockOptedOut } } }),
  useHasMemoryAccess: () => true,
  useHasAccess: () => false,
  useAgentCapabilities: () => ({ memoryEnabled: true }),
}));
jest.mock('~/Providers', () => ({
  useBadgeRowContext: () => ({
    memory: { toggleState: false, isPinned: true, debouncedChange: mockChange },
  }),
}));
jest.mock('~/utils', () => ({ cn: (...classes: string[]) => classes.filter(Boolean).join(' ') }));
jest.mock('~/components/Chat/Input/ArtifactsSubMenu', () => () => null);
jest.mock('~/components/Chat/Input/MCPSubMenu', () => () => null);
jest.mock('@librechat/client', () => ({
  CheckboxButton: ({
    label,
    setValue,
  }: {
    label: string;
    setValue: (value: { value: boolean }) => void;
  }) => <button onClick={() => setValue({ value: true })}>{label}</button>,
  DropdownPopup: ({
    items,
  }: {
    items: { render: (props: object) => ReactNode; onClick?: () => void }[];
  }) => (
    <div>
      {items.map((item, index) => (
        <div key={index} onClick={item.onClick}>
          {item.render({})}
        </div>
      ))}
    </div>
  ),
  TooltipAnchor: () => null,
  PinIcon: () => null,
  VectorIcon: () => null,
}));

beforeEach(() => {
  mockBrainEnabled = true;
  mockOptedOut = false;
});

describe.each([
  ['badge', Memory],
  ['tools menu', ToolsDropdown],
] as const)('legacy memory %s', (_, Component) => {
  test.each([true, undefined])(
    'does not imply that global Brain is off when service status is %s',
    (enabled) => {
      mockBrainEnabled = enabled;
      render(<Component />);
      expect(screen.queryByText('com_ui_memory')).not.toBeInTheDocument();
    },
  );

  test('preserves the legacy memory control on an instance without Brain', () => {
    mockBrainEnabled = false;
    render(<Component />);
    fireEvent.click(screen.getByText('com_ui_memory'));
    expect(mockChange).toHaveBeenCalledWith({ value: true });
  });

  test('continues to respect the global personalization opt-out', () => {
    mockBrainEnabled = false;
    mockOptedOut = true;
    render(<Component />);
    expect(screen.queryByText('com_ui_memory')).not.toBeInTheDocument();
  });
});
