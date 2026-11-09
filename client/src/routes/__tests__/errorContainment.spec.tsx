import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router-dom';
import type { RouteObject } from 'react-router-dom';

const mockAuthMounts = { count: 0 };

jest.mock('~/components/Auth', () => ({
  Login: () => null,
  VerifyEmail: () => null,
  Registration: () => null,
  ResetPassword: () => null,
  ApiErrorWatcher: () => null,
  TwoFactorScreen: () => null,
  RequestPasswordReset: () => null,
}));
jest.mock('~/components/Agents/MarketplaceContext', () => ({
  MarketplaceProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('~/components/Agents/Marketplace', () => () => null);
jest.mock('~/components/OAuth', () => ({
  OAuthSuccess: () => null,
  OAuthError: () => null,
}));
jest.mock('~/lib/rum/WithRum', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('~/hooks/AuthContext', () => ({
  /** Stands in for the provider whose remount re-bootstraps authentication. */
  AuthContextProvider: function AuthContextProvider({ children }: { children: React.ReactNode }) {
    const { useEffect } = jest.requireActual<typeof import('react')>('react');
    useEffect(() => {
      mockAuthMounts.count += 1;
    }, []);
    return children;
  },
}));
jest.mock('../RouteErrorBoundary', () => ({
  __esModule: true,
  default: () => <div role="alert">{'route error'}</div>,
}));
jest.mock('../Layouts/Startup', () => () => null);
jest.mock('../Layouts/Login', () => () => null);
jest.mock('../Dashboard', () => ({
  __esModule: true,
  default: { path: 'dashboard', element: null },
}));
jest.mock('../ShareRoute', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../Search', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../Root', () => {
  const { Outlet } = jest.requireActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    __esModule: true,
    default: () => (
      <>
        <nav aria-label="sidebar" />
        <Outlet />
      </>
    ),
  };
});
jest.mock('../ChatRoute', () => ({
  __esModule: true,
  default: function ChatRoute() {
    const { useParams } = jest.requireActual<typeof import('react-router-dom')>('react-router-dom');
    const { conversationId } = useParams();
    if (conversationId === 'broken') {
      throw new TypeError("Cannot read properties of undefined (reading 'messageId')");
    }
    return <main>{`chat ${conversationId}`}</main>;
  },
}));

import { router } from '../index';

const renderAt = (path: string) => {
  const memoryRouter = createMemoryRouter(router.routes as RouteObject[], {
    initialEntries: [path],
  });
  render(<RouterProvider router={memoryRouter} />);
  return memoryRouter;
};

describe('route error containment', () => {
  beforeEach(() => {
    mockAuthMounts.count = 0;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('keeps a failing chat inside the main pane next to the sidebar', () => {
    renderAt('/c/broken');

    expect(screen.getByRole('alert')).toHaveTextContent('route error');
    expect(screen.getByRole('navigation', { name: 'sidebar' })).toBeInTheDocument();
    expect(mockAuthMounts.count).toBe(1);
  });

  it('recovers on the next navigation without remounting authentication', async () => {
    const memoryRouter = renderAt('/c/running');
    expect(mockAuthMounts.count).toBe(1);

    await act(async () => {
      await memoryRouter.navigate('/c/broken');
    });
    expect(screen.getByRole('alert')).toHaveTextContent('route error');
    expect(screen.getByRole('navigation', { name: 'sidebar' })).toBeInTheDocument();

    await act(async () => {
      await memoryRouter.navigate('/c/new');
    });

    expect(screen.getByRole('main')).toHaveTextContent('chat new');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'sidebar' })).toBeInTheDocument();
    expect(mockAuthMounts.count).toBe(1);
  });
});
