import { useMemo, useCallback, useContext } from 'react';
import { Permissions } from 'librechat-data-provider';
import type { TUser, PermissionTypes } from 'librechat-data-provider';
import { AuthContext } from '~/hooks/AuthContext';

const useHasAccess = ({
  permissionType,
  permission,
}: {
  permissionType: PermissionTypes;
  permission: Permissions;
}) => {
  const authContext = useContext(AuthContext);
  const user = authContext?.user;
  const roles = authContext?.roles;
  const isAuthenticated = authContext?.isAuthenticated || false;

  const checkAccess = useCallback(
    ({
      user,
      permissionType,
      permission,
    }: {
      user?: TUser | null;
      permissionType: PermissionTypes;
      permission: Permissions;
    }) => {
      if (!authContext) {
        return false;
      }

      if (isAuthenticated && user?.role != null && roles && roles[user.role]) {
        const value = roles[user.role]?.permissions?.[permissionType]?.[permission];
        // Older roles have no VIEW bit. Visibility never replaces capability checks.
        return permission === Permissions.VIEW ? value !== false : value === true;
      }
      return false;
    },
    [authContext, isAuthenticated, roles],
  );

  const hasAccess = useMemo(
    () => checkAccess({ user, permissionType, permission }),
    [user, permissionType, permission, checkAccess],
  );

  return hasAccess;
};

export default useHasAccess;
