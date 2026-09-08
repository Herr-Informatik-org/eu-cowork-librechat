import React from 'react';
import { renderHook } from '@testing-library/react';
import { PermissionTypes, Permissions, roleDefaults, SystemRoles } from 'librechat-data-provider';
import type { TAuthContext } from '~/common';
import { AuthContext } from '~/hooks/AuthContext';
import useHasAccess from '../useHasAccess';

jest.mock('~/hooks/AuthContext', () => ({
  AuthContext: jest.requireActual('react').createContext(undefined),
}));

function check(permission: Permissions, view?: boolean, authenticated = true, use = true) {
  const role = roleDefaults[SystemRoles.USER];
  const context: TAuthContext = {
    isAuthenticated: authenticated,
    user: {
      id: 'qa',
      username: 'qa',
      email: 'qa@example.test',
      name: 'QA',
      avatar: '',
      role: 'USER',
      provider: 'local',
      createdAt: '',
      updatedAt: '',
    },
    token: undefined,
    error: undefined,
    login: jest.fn(),
    logout: jest.fn(),
    setError: jest.fn(),
    roles: {
      USER: {
        ...role,
        permissions: {
          ...role.permissions,
          MCP_SERVERS: { ...role.permissions.MCP_SERVERS, USE: use, VIEW: view },
        },
      },
    },
  };
  return renderHook(
    () => useHasAccess({ permissionType: PermissionTypes.MCP_SERVERS, permission }),
    {
      wrapper: ({ children }) => (
        <AuthContext.Provider value={context}>{children}</AuthContext.Provider>
      ),
    },
  ).result.current;
}

describe('sidebar visibility and access grants', () => {
  it('preserves legacy sidebar visibility for an authenticated role', () => {
    expect(check(Permissions.VIEW)).toBe(true);
  });
  it('hides explicit VIEW false without revoking use of approved tools', () => {
    expect(check(Permissions.VIEW, false)).toBe(false);
    expect(check(Permissions.USE, false)).toBe(true);
  });
  it('VIEW true never grants USE', () => {
    expect(check(Permissions.VIEW, true, true, false)).toBe(true);
    expect(check(Permissions.USE, true, true, false)).toBe(false);
  });
  it('does not expose a sidebar area before authentication', () => {
    expect(check(Permissions.VIEW, true, false)).toBe(false);
  });
});
