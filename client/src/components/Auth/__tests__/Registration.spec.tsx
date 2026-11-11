import * as reactRouter from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import * as mockDataProvider from 'librechat-data-provider/react-query';
import type { TStartupConfig } from 'librechat-data-provider';
import * as endpointQueries from '~/data-provider/Endpoints/queries';
import { render, waitFor, screen } from 'test/layout-test-utils';
import * as miscDataProvider from '~/data-provider/Misc/queries';
import * as authMutations from '~/data-provider/Auth/mutations';
import * as authQueries from '~/data-provider/Auth/queries';
import Registration from '~/components/Auth/Registration';
import AuthLayout from '~/components/Auth/AuthLayout';

jest.mock('librechat-data-provider/react-query');

beforeEach(() => {
  global.fetch = Object.assign(jest.fn(), { preconnect: jest.fn() });
});

const mockStartupConfig = {
  isFetching: false,
  isLoading: false,
  isError: false,
  data: {
    socialLogins: ['google', 'facebook', 'openid', 'github', 'discord', 'saml'],
    discordLoginEnabled: true,
    facebookLoginEnabled: true,
    githubLoginEnabled: true,
    googleLoginEnabled: true,
    openidLoginEnabled: true,
    openidLabel: 'Test OpenID',
    openidImageUrl: 'http://test-server.com',
    samlLoginEnabled: true,
    samlLabel: 'Test SAML',
    samlImageUrl: 'http://test-server.com',
    registrationEnabled: true,
    socialLoginEnabled: true,
    serverDomain: 'mock-server',
  },
};

const setup = ({
  search = '',
  useGetUserQueryReturnValue = {
    isLoading: false,
    isError: false,
    data: {},
  },
  useRegisterUserMutationReturnValue = {
    isLoading: false,
    isError: false,
    mutate: jest.fn(),
    data: {},
    isSuccess: false,
    error: null as Error | null,
  },
  useRefreshTokenMutationReturnValue = {
    isLoading: false,
    isError: false,
    mutate: jest.fn(),
    data: {
      token: 'mock-token',
      user: {},
    },
  },
  useGetBannerQueryReturnValue = {
    isLoading: false,
    isError: false,
    data: {},
  },
  useGetStartupConfigReturnValue = mockStartupConfig,
} = {}) => {
  jest.spyOn(reactRouter, 'useLocation').mockReturnValue({
    pathname: '/register',
    search,
    hash: '',
    state: null,
    key: 'register',
  });
  const mockUseRegisterUserMutation = jest
    .spyOn(mockDataProvider, 'useRegisterUserMutation')
    //@ts-ignore - we don't need all parameters of the QueryObserverSuccessResult
    .mockReturnValue(useRegisterUserMutationReturnValue);
  const mockUseGetUserQuery = jest
    .spyOn(authQueries, 'useGetUserQuery')
    //@ts-ignore - we don't need all parameters of the QueryObserverSuccessResult
    .mockReturnValue(useGetUserQueryReturnValue);
  const mockUseGetStartupConfig = jest
    .spyOn(endpointQueries, 'useGetStartupConfig')
    //@ts-ignore - we don't need all parameters of the QueryObserverSuccessResult
    .mockReturnValue(useGetStartupConfigReturnValue);
  const mockUseRefreshTokenMutation = jest
    .spyOn(authMutations, 'useRefreshTokenMutation')
    //@ts-ignore - we don't need all parameters of the QueryObserverSuccessResult
    .mockReturnValue(useRefreshTokenMutationReturnValue);
  const mockUseOutletContext = jest.spyOn(reactRouter, 'useOutletContext').mockReturnValue({
    startupConfig: useGetStartupConfigReturnValue.data,
  });
  jest
    .spyOn(miscDataProvider, 'useGetBannerQuery')
    //@ts-ignore - we don't need all parameters of the QueryObserverSuccessResult
    .mockReturnValue(useGetBannerQueryReturnValue);
  const renderResult = render(
    <AuthLayout
      startupConfig={useGetStartupConfigReturnValue.data as TStartupConfig}
      isFetching={useGetStartupConfigReturnValue.isFetching}
      error={null}
      startupConfigError={null}
      header={'Create your account'}
      pathname="register"
    >
      <Registration />
    </AuthLayout>,
  );

  return {
    ...renderResult,
    mockUseGetUserQuery,
    mockUseOutletContext,
    mockUseGetStartupConfig,
    mockUseRegisterUserMutation,
    mockUseRefreshTokenMutation,
  };
};

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  __esModule: true,
  useOutletContext: () => ({
    startupConfig: mockStartupConfig,
  }),
}));

test('renders registration form', () => {
  const { getByText, getByTestId, getByRole } = setup();
  expect(getByText(/Create your account/i)).toBeInTheDocument();
  expect(getByRole('textbox', { name: /Full name/i })).toBeInTheDocument();
  expect(getByRole('form', { name: /Registration form/i })).toBeVisible();
  expect(getByRole('textbox', { name: /Username/i })).toBeInTheDocument();
  expect(getByRole('textbox', { name: /Email/i })).toBeInTheDocument();
  expect(getByTestId('password')).toBeInTheDocument();
  expect(getByTestId('confirm_password')).toBeInTheDocument();
  expect(getByRole('button', { name: /Submit registration/i })).toBeInTheDocument();
  expect(getByRole('link', { name: 'Login' })).toBeInTheDocument();
  expect(getByRole('link', { name: 'Login' })).toHaveAttribute('href', '/login');
  expect(getByRole('link', { name: /Continue with Google/i })).toBeInTheDocument();
  expect(getByRole('link', { name: /Continue with Google/i })).toHaveAttribute(
    'href',
    'mock-server/oauth/google',
  );
  expect(getByRole('link', { name: /Continue with Facebook/i })).toBeInTheDocument();
  expect(getByRole('link', { name: /Continue with Facebook/i })).toHaveAttribute(
    'href',
    'mock-server/oauth/facebook',
  );
  expect(getByRole('link', { name: /Continue with Github/i })).toBeInTheDocument();
  expect(getByRole('link', { name: /Continue with Github/i })).toHaveAttribute(
    'href',
    'mock-server/oauth/github',
  );
  expect(getByRole('link', { name: /Continue with Discord/i })).toBeInTheDocument();
  expect(getByRole('link', { name: /Continue with Discord/i })).toHaveAttribute(
    'href',
    'mock-server/oauth/discord',
  );
  expect(getByRole('link', { name: /Test SAML/i })).toBeInTheDocument();
  expect(getByRole('link', { name: /Test SAML/i })).toHaveAttribute(
    'href',
    'mock-server/oauth/saml',
  );
});

test('prefills validated invitation details and submits the original token', async () => {
  const fetch = jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ email: 'invited@example.com', name: 'Invited Person' }),
  } as Response);
  const mutate = jest.fn();
  const { getByTestId, getByRole } = setup({
    search: '?token=synthetic-invitation',
    useRegisterUserMutationReturnValue: {
      isLoading: false,
      isError: false,
      mutate,
      data: {},
      isSuccess: false,
      error: null,
    },
  });
  await waitFor(() => expect(getByTestId('email')).toHaveValue('invited@example.com'));
  expect(getByTestId('email')).toHaveAttribute('readonly');
  expect(getByTestId('name')).toHaveValue('Invited Person');
  expect(getByTestId('password')).toHaveValue('');
  expect(fetch).toHaveBeenCalledWith(
    expect.any(URL),
    expect.objectContaining({
      method: 'POST',
      cache: 'no-store',
      body: JSON.stringify({ token: 'synthetic-invitation' }),
    }),
  );
  await userEvent.type(getByTestId('password'), 'synthetic-password');
  await userEvent.type(getByTestId('confirm_password'), 'synthetic-password');
  await userEvent.click(getByRole('button', { name: /Submit registration/i }));
  await waitFor(() =>
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'invited@example.com',
        name: 'Invited Person',
        token: 'synthetic-invitation',
      }),
    ),
  );
});

test('keeps a name entered before the invitation response arrives', async () => {
  let finish: (response: Response) => void = () => {};
  jest.spyOn(global, 'fetch').mockReturnValue(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );
  const { getByTestId } = setup({ search: '?token=synthetic-invitation' });
  await userEvent.type(getByTestId('name'), 'Chosen Name');
  finish({
    ok: true,
    json: async () => ({ email: 'invited@example.com', name: 'Old Name' }),
  } as Response);
  await waitFor(() => expect(getByTestId('email')).toHaveValue('invited@example.com'));
  expect(getByTestId('name')).toHaveValue('Chosen Name');
});

test('does not fill details from an invalid invitation or untrusted URL fields', async () => {
  jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false } as Response);
  const { getByTestId, getByRole, findByText } = setup({
    search: '?token=invalid&email=wrong@example.com',
  });
  await findByText(/Die Einladung ist ungültig/);
  expect(getByTestId('email')).toHaveValue('');
  expect(getByRole('button', { name: /Submit registration/i })).toBeDisabled();
});

// test('calls registerUser.mutate on registration', async () => {
//   const mutate = jest.fn();
//   const { getByTestId, getByRole, history } = setup({
//     // @ts-ignore - we don't need all parameters of the QueryObserverResult
//     useLoginUserReturnValue: {
//       isLoading: false,
//       mutate: mutate,
//       isError: false,
//       isSuccess: true,
//     },
//   });

//   await userEvent.type(getByRole('textbox', { name: /Full name/i }), 'John Doe');
//   await userEvent.type(getByRole('textbox', { name: /Username/i }), 'johndoe');
//   await userEvent.type(getByRole('textbox', { name: /Email/i }), 'test@test.com');
//   await userEvent.type(getByTestId('password'), 'password');
//   await userEvent.type(getByTestId('confirm_password'), 'password');
//   await userEvent.click(getByRole('button', { name: /Submit registration/i }));

//   console.log(history);
//   waitFor(() => {
//     // expect(mutate).toHaveBeenCalled();
//     expect(history.location.pathname).toBe('/c/new');
//   });
// });

test('shows validation error messages', async () => {
  const { getByTestId, getAllByRole, getByRole } = setup();
  await userEvent.type(getByRole('textbox', { name: /Full name/i }), 'J');
  await userEvent.type(getByRole('textbox', { name: /Username/i }), 'j');
  await userEvent.type(getByRole('textbox', { name: /Email/i }), 'test');
  await userEvent.type(getByTestId('password'), 'pass');
  await userEvent.type(getByTestId('confirm_password'), 'password1');
  const alerts = getAllByRole('alert');
  expect(alerts).toHaveLength(6);

  // This first alert is for the theme toggle, which is empty within this test but still picked up by getAllByRole as an alert
  expect(alerts[0]).toHaveTextContent('');

  expect(alerts[1]).toHaveTextContent(/Name must be at least 3 characters/i);
  expect(alerts[2]).toHaveTextContent(/Username must be at least 2 characters/i);
  expect(alerts[3]).toHaveTextContent(/You must enter a valid email address/i);
  expect(alerts[4]).toHaveTextContent(/Password must be at least 8 characters/i);
  expect(alerts[5]).toHaveTextContent(/Passwords do not match/i);
});

test('shows error message when registration fails', async () => {
  const mutate = jest.fn();
  const { getByTestId, getByRole } = setup({
    useRegisterUserMutationReturnValue: {
      isLoading: false,
      isError: true,
      mutate,
      error: new Error('Registration failed'),
      data: {},
      isSuccess: false,
    },
  });

  await userEvent.type(getByRole('textbox', { name: /Full name/i }), 'John Doe');
  await userEvent.type(getByRole('textbox', { name: /Username/i }), 'johndoe');
  await userEvent.type(getByRole('textbox', { name: /Email/i }), 'test@test.com');
  await userEvent.type(getByTestId('password'), 'password');
  await userEvent.type(getByTestId('confirm_password'), 'password');
  await userEvent.click(getByRole('button', { name: /Submit registration/i }));

  waitFor(() => {
    expect(screen.getByTestId('registration-error')).toBeInTheDocument();
    expect(screen.getByTestId('registration-error')).toHaveTextContent(
      /There was an error attempting to register your account. Please try again. Registration failed/i,
    );
  });
});
