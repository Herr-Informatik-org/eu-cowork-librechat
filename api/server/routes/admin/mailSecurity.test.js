const mockAuthorizeAdmin = jest.fn();
const mockAuthorizeConfig = jest.fn();
const mockGetUser = jest.fn();
const mockRequireCapability = jest.fn(() => (_req, _res, next) => next());
const mockAuth = jest.fn((_req, _res, next) => next());
const mockBan = jest.fn((_req, _res, next) => next());
let mockDependencies;

jest.mock(
  '@librechat/api',
  () => ({
    MAIL_SECURITY_COLLECTION: 'eucowork_mail_security',
    createMailSecurityAdminRouter: jest.fn((deps) => {
      mockDependencies = deps;
      return require('express').Router();
    }),
  }),
  { virtual: true },
);
jest.mock('@librechat/data-schemas', () => ({
  SystemCapabilities: { ACCESS_ADMIN: 'access:admin' },
}));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: mockAuth,
  checkBan: mockBan,
}));
jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: mockRequireCapability,
  hasCapability: mockAuthorizeAdmin,
  hasConfigCapability: mockAuthorizeConfig,
}));
jest.mock('~/models', () => ({
  getUserById: mockGetUser,
  recordAuditEntry: jest.fn(),
}));

describe('mail security native authorization', () => {
  let router;
  beforeAll(() => {
    router = require('./mailSecurity');
  });
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUser.mockResolvedValue({ role: 'CURRENT_ROLE', idOnTheSource: 'source-id' });
    mockAuthorizeAdmin.mockResolvedValue(true);
    mockAuthorizeConfig.mockResolvedValue(true);
  });
  it('installs authentication and ban checks before the policy handler', () => {
    expect(router.stack[0].handle).toBe(mockAuth);
    expect(router.stack[1].handle).toBe(mockBan);
  });
  it('uses fresh database identity rather than JWT role for both grants', async () => {
    expect(
      await mockDependencies.authorize({ user: { id: 'owner', role: 'STALE_ADMIN' } }),
    ).toEqual({ id: 'owner' });
    const principal = { id: 'owner', role: 'CURRENT_ROLE', idOnTheSource: 'source-id' };
    expect(mockAuthorizeAdmin).toHaveBeenCalledWith(principal, 'access:admin');
    expect(mockAuthorizeConfig).toHaveBeenCalledWith(principal, 'interface');
  });
  it.each([undefined, { tenantId: 'other', id: 'owner' }])(
    'rejects missing or scoped identity %p',
    async (user) => {
      expect(await mockDependencies.authorize({ user })).toBeNull();
      expect(mockGetUser).not.toHaveBeenCalled();
    },
  );
  it.each([null, { role: 'ADMIN', tenantId: 'other' }])(
    'rejects deleted or scoped database identity %p',
    async (user) => {
      mockGetUser.mockResolvedValue(user);
      expect(await mockDependencies.authorize({ user: { id: 'owner' } })).toBeNull();
      expect(mockAuthorizeConfig).not.toHaveBeenCalled();
    },
  );
  it('rejects a revoked admin grant even if interface management remains', async () => {
    mockAuthorizeAdmin.mockResolvedValue(false);
    expect(await mockDependencies.authorize({ user: { id: 'owner' } })).toBeNull();
    expect(mockAuthorizeConfig).not.toHaveBeenCalled();
  });
  it('rejects an admin without interface management', async () => {
    mockAuthorizeConfig.mockResolvedValue(false);
    expect(await mockDependencies.authorize({ user: { id: 'owner' } })).toBeNull();
  });
});
