import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalType, ResourceType, PermissionBits } from 'librechat-data-provider';
import { tenantStorage } from '@librechat/data-schemas';
import type { Db, Document } from 'mongodb';
import type { IUser, AppConfig } from '@librechat/data-schemas';
import { createOpsPersonalSkillAccess } from './skills';

let server: MongoMemoryServer;
let client: MongoClient;
let database: Db;
const owner = new ObjectId();
const user = { id: String(owner), role: 'USER', emailVerified: true } as IUser;
const deployment = new ObjectId().toHexString();
let originalStrict: string | undefined;
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  database = client.db('synthetic_ops_acl');
  originalStrict = process.env.TENANT_ISOLATION_STRICT;
  process.env.TENANT_ISOLATION_STRICT = 'true';
});
afterAll(async () => {
  await client?.close();
  await server?.stop();
  if (originalStrict === undefined) delete process.env.TENANT_ISOLATION_STRICT;
  else process.env.TENANT_ISOLATION_STRICT = originalStrict;
});
beforeEach(async () => {
  await database.dropDatabase();
});
function access() {
  return createOpsPersonalSkillAccess({
    collection: <T extends Document>(model: 'Group' | 'AclEntry' | 'Skill' | 'Config') =>
      database.collection<T>(model),
    deploymentIds: async () => [deployment],
    isDeploymentSkill: (id) => id === deployment,
    deploymentSkill: async (id) => ({
      id,
      name: 'Deployment',
      body: 'Fixed instructions',
      version: '1',
    }),
  });
}
async function skill(tenantId?: string) {
  const _id = new ObjectId();
  await database.collection('Skill').insertOne({
    _id,
    ...(tenantId ? { tenantId } : {}),
    name: 'Synthetic skill',
    body: 'Synthetic instructions',
    version: 1,
  });
  return _id;
}
async function allow(
  resourceId: ObjectId,
  principalType: PrincipalType,
  principalId?: string | ObjectId,
  tenantId?: string,
) {
  await database.collection('AclEntry').insertOne({
    resourceId,
    resourceType: ResourceType.SKILL,
    principalType,
    principalId,
    permBits: PermissionBits.VIEW,
    ...(tenantId ? { tenantId } : {}),
  });
}
test('base owner only receives base USER, ROLE, PUBLIC and GROUP skills, even inside foreign ALS', async () => {
  const own = await skill();
  const role = await skill();
  const pub = await skill();
  const groupSkill = await skill();
  const foreignPublic = await skill('foreign');
  const foreignRole = await skill('foreign');
  const foreignAcl = await skill();
  const foreignGroupSkill = await skill();
  const foreignLinked = await skill('foreign');
  const baseGroup = new ObjectId();
  const foreignGroup = new ObjectId();
  await database.collection('Group').insertMany([
    { _id: baseGroup, memberIds: [String(owner)] },
    { _id: foreignGroup, memberIds: [String(owner)], tenantId: 'foreign' },
  ]);
  await allow(own, PrincipalType.USER, owner);
  await allow(role, PrincipalType.ROLE, 'USER');
  await allow(pub, PrincipalType.PUBLIC);
  await allow(groupSkill, PrincipalType.GROUP, baseGroup);
  await allow(foreignPublic, PrincipalType.PUBLIC, undefined, 'foreign');
  await allow(foreignRole, PrincipalType.ROLE, 'USER', 'foreign');
  await allow(foreignAcl, PrincipalType.PUBLIC, undefined, 'foreign');
  await allow(foreignGroupSkill, PrincipalType.GROUP, foreignGroup);
  await allow(foreignLinked, PrincipalType.PUBLIC);
  const allowed = access();
  const result = await tenantStorage.run({ tenantId: 'foreign' }, async () => allowed.ids(user));
  expect(result.sort()).toEqual([own, role, pub, groupSkill].map(String).concat(deployment).sort());
  expect(await allowed.get(String(foreignPublic))).toBeNull();
  expect(await allowed.get(String(foreignLinked))).toBeNull();
  expect(await allowed.get(String(own))).toMatchObject({ id: String(own) });
  expect(await allowed.get(deployment)).toMatchObject({ id: deployment });
  await database.collection('Group').updateOne({ _id: baseGroup }, { $set: { memberIds: [] } });
  expect(await allowed.ids(user)).not.toContain(String(groupSkill));
});
test('expired ACLs and foreign owners are denied without waiting for TTL cleanup', async () => {
  const id = await skill();
  await allow(id, PrincipalType.PUBLIC);
  await database
    .collection('AclEntry')
    .updateOne({ resourceId: id }, { $set: { expiredAt: new Date(0) } });
  expect(await access().ids(user)).toEqual([deployment]);
  await expect(access().ids({ ...user, tenantId: 'foreign' } as IUser)).rejects.toMatchObject({
    code: 'skills_forbidden',
  });
});
test('database failures propagate instead of silently returning deployment access', async () => {
  const deployments = jest.fn(async () => [deployment]);
  const allowed = createOpsPersonalSkillAccess({
    collection: () => {
      throw new Error('Synthetic database failure');
    },
    deploymentIds: deployments,
    isDeploymentSkill: () => false,
    deploymentSkill: async () => null,
  });
  await expect(allowed.ids(user)).rejects.toThrow('Synthetic database failure');
  expect(deployments).not.toHaveBeenCalled();
});

test('personal config uses current base-tenant overrides and never falls back on errors', async () => {
  const base = { memory: { disabled: false } } as AppConfig;
  await database.collection('Config').insertMany([
    {
      principalType: PrincipalType.ROLE,
      principalId: 'USER',
      priority: 10,
      isActive: true,
      overrides: { memory: { disabled: true } },
    },
    {
      principalType: PrincipalType.ROLE,
      principalId: 'USER',
      priority: 100,
      isActive: true,
      tenantId: 'foreign',
      overrides: { memory: { disabled: false } },
    },
  ]);
  expect(
    (await tenantStorage.run({ tenantId: 'foreign' }, async () => access().config(user, base)))
      .memory?.disabled,
  ).toBe(true);
  await database
    .collection('Config')
    .updateOne({ tenantId: null }, { $set: { 'overrides.memory.disabled': false } });
  expect((await access().config(user, base)).memory?.disabled).toBe(false);
  const unavailable = createOpsPersonalSkillAccess({
    collection: <T extends Document>(model: 'Group' | 'AclEntry' | 'Skill' | 'Config') => {
      if (model === 'Config') throw new Error('Synthetic config failure');
      return database.collection<T>(model);
    },
    deploymentIds: async () => [],
    isDeploymentSkill: () => false,
    deploymentSkill: async () => null,
  });
  await expect(unavailable.config(user, base)).rejects.toThrow('Synthetic config failure');
});
