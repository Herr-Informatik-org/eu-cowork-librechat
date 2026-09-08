import mongoose from 'mongoose';
import { PermissionTypes } from 'librechat-data-provider';
import roleSchema from './role';

const Role = mongoose.model('WorkspaceRoleSchemaTest', roleSchema);

describe('persisted role visibility', () => {
  it.each([
    PermissionTypes.AGENTS,
    PermissionTypes.MCP_SERVERS,
    PermissionTypes.SKILLS,
    PermissionTypes.PROMPTS,
    PermissionTypes.MEMORIES,
  ])('retains %s VIEW independently from access grants', async (type) => {
    const role = new Role({
      name: 'LAY_USER',
      permissions: { [type]: { USE: true, VIEW: false } },
    });
    await expect(role.validate()).resolves.toBeUndefined();
    expect(role.toObject().permissions?.[type]).toEqual(
      expect.objectContaining({ USE: true, VIEW: false }),
    );
  });

  it('does not migrate visibility on an existing role', () => {
    const role = new Role({ name: 'ADMIN', permissions: { AGENTS: { USE: true, CREATE: true } } });
    expect(role.toObject().permissions?.AGENTS).not.toHaveProperty('VIEW');
  });
});
