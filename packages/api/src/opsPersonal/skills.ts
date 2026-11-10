import { ObjectId } from 'mongodb';
import { PrincipalType, ResourceType, PermissionBits } from 'librechat-data-provider';
import {
  permissionBitSupersets,
  mergeConfigOverrides,
  BASE_CONFIG_PRINCIPAL_ID,
} from '@librechat/data-schemas';
import type { Collection, Document } from 'mongodb';
import type { IUser, IConfig, Config, AppConfig } from '@librechat/data-schemas';
import type { OpsPersonalSkill } from './types';
import { OpsPersonalError } from './service';

type BaseDocument = { _id: ObjectId; tenantId?: string | null };
type GroupRow = BaseDocument & { memberIds: string[] };
type ConfigRow = BaseDocument & Omit<Config, 'tenantId'>;
type AclRow = BaseDocument & {
  principalType: PrincipalType;
  principalId?: string | ObjectId;
  resourceType: string;
  resourceId: ObjectId;
  permBits: number;
  expiredAt?: Date | null;
};
type SkillRow = BaseDocument & {
  name: string;
  body: string;
  version: number;
  userInvocable?: boolean;
};
export interface OpsPersonalSkillDependencies {
  collection: <T extends Document>(
    model: 'Group' | 'AclEntry' | 'Skill' | 'Config',
  ) => Collection<T>;
  deploymentIds: () => Promise<string[]>;
  deploymentSkill: (id: string) => Promise<OpsPersonalSkill | null>;
  isDeploymentSkill: (id: string) => boolean;
}
export interface OpsPersonalSkillAccess {
  ids(user: IUser): Promise<string[]>;
  config(user: IUser, base: AppConfig): Promise<AppConfig>;
  get(id: string): Promise<OpsPersonalSkill | null>;
}
const MAX_ROWS = 5000;
const READ = { timeoutMS: 5000 };

/** Use native ACL rows and permission bits with explicit base-tenant filters, independent of ALS. */
export function createOpsPersonalSkillAccess(
  deps: OpsPersonalSkillDependencies,
): OpsPersonalSkillAccess {
  async function getPrincipals(
    user: IUser,
  ): Promise<Array<{ principalType: PrincipalType; principalId?: string | ObjectId }>> {
    if (user.tenantId != null || !/^[a-f0-9]{24}$/.test(user.id) || !user.role)
      throw new OpsPersonalError(403, 'skills_forbidden');
    const groups = await deps
      .collection<GroupRow>('Group')
      .find(
        { tenantId: null, memberIds: user.idOnTheSource || user.id },
        { ...READ, projection: { _id: 1 } },
      )
      .limit(MAX_ROWS + 1)
      .toArray();
    if (groups.length > MAX_ROWS) throw new OpsPersonalError(503, 'acl_unavailable');
    return [
      { principalType: PrincipalType.USER, principalId: new ObjectId(user.id) },
      { principalType: PrincipalType.ROLE, principalId: user.role },
      ...groups.map(({ _id }) => ({ principalType: PrincipalType.GROUP, principalId: _id })),
      { principalType: PrincipalType.PUBLIC },
    ];
  }
  return {
    async ids(user) {
      const principals = await getPrincipals(user);
      const entries = await deps
        .collection<AclRow>('AclEntry')
        .find(
          {
            tenantId: null,
            resourceType: ResourceType.SKILL,
            permBits: { $in: permissionBitSupersets(PermissionBits.VIEW) },
            $and: [
              { $or: principals },
              { $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }] },
            ],
          },
          { ...READ, projection: { resourceId: 1 } },
        )
        .limit(MAX_ROWS + 1)
        .toArray();
      if (entries.length > MAX_ROWS) throw new OpsPersonalError(503, 'acl_unavailable');
      const rows = await deps
        .collection<SkillRow>('Skill')
        .find(
          {
            tenantId: null,
            _id: { $in: entries.map((entry) => entry.resourceId) },
          },
          { ...READ, projection: { _id: 1 } },
        )
        .limit(MAX_ROWS + 1)
        .toArray();
      return [...new Set([...rows.map(({ _id }) => String(_id)), ...(await deps.deploymentIds())])];
    },
    async config(user, base) {
      const principals = await getPrincipals(user);
      const selected = [
        { principalType: PrincipalType.ROLE, principalId: BASE_CONFIG_PRINCIPAL_ID },
        ...principals
          .filter((entry) => entry.principalId !== undefined)
          .map((entry) => ({
            principalType: entry.principalType,
            principalId: String(entry.principalId),
          })),
      ];
      const configs = await deps
        .collection<ConfigRow>('Config')
        .find({ tenantId: null, isActive: true, $or: selected }, READ)
        .sort({ priority: 1 })
        .limit(MAX_ROWS + 1)
        .toArray();
      if (configs.length > MAX_ROWS) throw new OpsPersonalError(503, 'config_unavailable');
      // The native merger consumes plain config fields; it does not use Mongoose document methods.
      return mergeConfigOverrides(base, configs as IConfig[]);
    },
    async get(id) {
      if (deps.isDeploymentSkill(id)) return deps.deploymentSkill(id);
      if (!/^[a-f0-9]{24}$/.test(id)) return null;
      const skill = await deps
        .collection<SkillRow>('Skill')
        .findOne({ _id: new ObjectId(id), tenantId: null }, READ);
      return skill
        ? {
            id: String(skill._id),
            name: skill.name,
            body: skill.body,
            version: String(skill.version),
            userInvocable: skill.userInvocable,
          }
        : null;
    },
  };
}
