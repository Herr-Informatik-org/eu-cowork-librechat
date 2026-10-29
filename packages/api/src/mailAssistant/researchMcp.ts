import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHash } from 'node:crypto';
import sanitizeHtml from 'sanitize-html';
import type { MailFetch } from './types';

export interface ResearchProfile {
  id: string;
  label: string;
  kind: 'odoo' | 'ops';
}
export interface ResearchCustomer {
  id: string;
  name: string;
  odooPartnerId?: number;
}
export interface ResearchEvidence {
  id: string;
  source: 'odoo' | 'ops';
  profileId: string;
  customerId: string;
  kind: string;
  title: string;
  fields: { label: string; value: string }[];
  url?: string;
  updatedAt?: string;
}
export interface ResearchSourceResult {
  customer: ResearchCustomer;
  evidence: ResearchEvidence[];
  warnings: string[];
  truncated: boolean;
}
export interface ResearchIdentity {
  id: string;
  role: string;
  email: string;
  profiles: ResearchProfile[];
}
export interface MailResearchMcpDependencies {
  identity(owner: string): Promise<ResearchIdentity>;
  authorizeTool(owner: string, profileId: string, tool: string): Promise<void>;
  audit(owner: string, event: string, profileId: string, tool?: string): Promise<void>;
  fetch?: MailFetch;
  sourceOrigins?: Readonly<Record<string, string>>;
}
export interface ResearchReadOptions {
  topic: string;
  reference?: string;
  lookbackMonths: number;
}
type Guard = () => Promise<void>;
type Row = Record<string, unknown>;
const gateway = 'http://mcp-gateway:3020';
const profilePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const odooTools = ['list_models', 'search_records', 'get_record'];
const opsTools = ['list_modules', 'describe_table', 'query_table'];
const maxRows = 20;
const maximumCalls = 30;
const maximumDuration = 60_000;
const maxResponseBytes = 2_000_000;
class ResearchStopped extends Error {}
const failure = () => new Error('Die freigegebene Recherchequelle ist nicht sicher verfügbar.');
const stopped = () =>
  new ResearchStopped('Die Recherche wurde angehalten oder ist nicht mehr freigegeben.');
const budgetFailure = () =>
  new ResearchStopped('Die Recherchegrenze wurde erreicht. Bitte die Anfrage eingrenzen.');
function object(value: unknown): value is Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
function relation(value: unknown): number | undefined {
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    positive(value[0]) &&
    typeof value[1] === 'string'
  )
    return value[0];
  return positive(value) ? value : undefined;
}
function text(value: unknown, limit = 400): string {
  if (typeof value !== 'string') return '';
  // Source text remains evidence, never executable HTML or model instructions.
  return (
    sanitizeHtml(value.slice(0, 12_000), { allowedTags: [], allowedAttributes: {} })
      // eslint-disable-next-line no-control-regex -- Strip non-printing source characters.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .trim()
      .slice(0, limit)
  );
}
function literal(value: unknown, min = 2): string {
  if (
    typeof value !== 'string' ||
    value.length > 120 ||
    value.trim().length < min ||
    // eslint-disable-next-line no-control-regex -- Search literals must not contain control bytes.
    /[%_*\u0000-\u001f\u007f]/.test(value)
  )
    throw failure();
  return value.trim();
}
function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return text(value) || undefined;
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e15)
    return String(value);
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  if (Array.isArray(value) && relation(value)) return text(value[1], 120) || undefined;
  return undefined;
}
function date(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)
  )
    return;
  const parsed = Date.parse(
    value.includes('T') ? value : value.replace(' ', 'T') + (value.length > 10 ? 'Z' : ''),
  );
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
function checkedProfile(profiles: ResearchProfile[], id: string): ResearchProfile {
  if (!profilePattern.test(id) || !Array.isArray(profiles)) throw failure();
  const matches = profiles.filter((p) => p.id === id);
  if (matches.length !== 1 || !['odoo', 'ops'].includes(matches[0].kind)) throw failure();
  return { id, label: text(matches[0].label, 120) || id, kind: matches[0].kind };
}
function evidence(
  profile: ResearchProfile,
  customer: ResearchCustomer,
  kind: string,
  row: Row,
  fields: readonly [string, string][],
  title: string,
  updatedAt?: string,
  url?: string,
): ResearchEvidence {
  const id = createHash('sha256')
    .update(JSON.stringify([profile.id, customer.id, kind, row.id]))
    .digest('hex')
    .slice(0, 24);
  return {
    id,
    source: profile.kind,
    profileId: profile.id,
    customerId: customer.id,
    kind,
    title: text(title, 240),
    fields: fields.flatMap(([key, label]) => {
      const value = scalar(row[key]);
      return value === undefined ? [] : [{ label, value }];
    }),
    ...(updatedAt && { updatedAt }),
    ...(url && { url }),
  };
}
function sourceUrl(
  origins: MailResearchMcpDependencies['sourceOrigins'],
  profile: string,
  model: string,
  id: number,
): string | undefined {
  const configured = origins?.[profile];
  if (!configured) return;
  try {
    const origin = new URL(configured);
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.port ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      return;
    return `${origin.origin}/odoo/${model}/${id}`;
  } catch {
    return;
  }
}

/** Closed, read-only adapter. Neither mail content nor model output can select tools, models or columns. */
export function createMailResearchMcp(deps: MailResearchMcpDependencies) {
  const request = deps.fetch ?? fetch;
  async function fresh(owner: string, profileId?: string) {
    try {
      const identity = await deps.identity(owner);
      if (identity.id !== owner || !identity.role || !identity.email) throw stopped();
      return {
        identity,
        profile: profileId ? checkedProfile(identity.profiles, profileId) : undefined,
      };
    } catch {
      throw stopped();
    }
  }
  async function session<T>(
    owner: string,
    profileId: string,
    guard: Guard,
    action: (
      profile: ResearchProfile,
      call: (tool: string, args: Row) => Promise<Row>,
    ) => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + maximumDuration;
    let calls = 0;
    const remaining = () => {
      const value = deadline - Date.now();
      if (value <= 0) throw budgetFailure();
      return value;
    };
    const check = async () => {
      remaining();
      try {
        await guard();
      } catch {
        throw stopped();
      }
      remaining();
      return fresh(owner, profileId);
    };
    const initial = await check();
    const profile = initial.profile!;
    const allowedTools = profile.kind === 'odoo' ? odooTools : opsTools;
    const client = new Client({ name: 'cowork-mail-research', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${gateway}/${profileId}`), {
      requestInit: { redirect: 'error' },
      fetch: async (input, init) => {
        const url = new URL(input.toString());
        if (
          url.origin !== gateway ||
          url.pathname !== `/${profileId}` ||
          url.search ||
          url.hash ||
          url.username ||
          url.password
        )
          throw failure();
        if (++calls > maximumCalls) throw budgetFailure();
        const current = await check();
        if (current.profile?.kind !== profile.kind) throw stopped();
        const headers = new Headers(init?.headers);
        headers.set('X-EUCowork-User-Id', current.identity.id);
        headers.set('X-EUCowork-User-Role', current.identity.role);
        headers.set('X-EUCowork-User-Email', current.identity.email);
        const response = await request(input, {
          ...init,
          headers,
          redirect: 'error',
          signal: AbortSignal.any([
            AbortSignal.timeout(remaining()),
            ...(init?.signal ? [init.signal] : []),
          ]),
        });
        if (!response.body) return response;
        let size = 0;
        const body = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              remaining();
              size += chunk.byteLength;
              if (size > maxResponseBytes) throw failure();
              controller.enqueue(chunk);
            },
          }),
        );
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    });
    try {
      await client.connect(transport, { timeout: remaining() });
      const available = await client.listTools({}, { timeout: remaining() });
      if (
        available.tools.length > 500 ||
        !allowedTools.every((name) => available.tools.some((tool) => tool.name === name))
      )
        throw failure();
      const call = async (tool: string, args: Row): Promise<Row> => {
        if (!allowedTools.includes(tool)) throw failure();
        await check();
        try {
          await deps.authorizeTool(owner, profileId, tool);
          await deps.audit(owner, 'research.read', profileId, tool);
        } catch {
          throw stopped();
        }
        await check();
        const result = await client.callTool({ name: tool, arguments: args }, undefined, {
          timeout: remaining(),
        });
        await check();
        if (result.isError) throw failure();
        let value: unknown = result.structuredContent;
        if (value === undefined) {
          if (!Array.isArray(result.content) || result.content.length !== 1) throw failure();
          const part = result.content[0];
          if (
            !object(part) ||
            part.type !== 'text' ||
            typeof part.text !== 'string' ||
            Buffer.byteLength(part.text) > maxResponseBytes
          )
            throw failure();
          try {
            value = JSON.parse(part.text);
          } catch {
            throw failure();
          }
        }
        if (!object(value)) throw failure();
        return value;
      };
      const value = await action(profile, call);
      await check();
      return value;
    } finally {
      await client.close().catch(() => undefined);
    }
  }
  async function odooCapabilities(call: (tool: string, args: Row) => Promise<Row>) {
    const output = await call('list_models', {});
    if (output.yolo_mode || !Array.isArray(output.models) || output.models.length > 2000)
      throw failure();
    return new Set(
      output.models
        .filter(
          (row) =>
            object(row) &&
            typeof row.model === 'string' &&
            object(row.operations) &&
            row.operations.read === true,
        )
        .map((row) => String(row.model)),
    );
  }
  async function odooSearch(
    call: (tool: string, args: Row) => Promise<Row>,
    model: string,
    domain: unknown[],
    fields: string[],
    limit = maxRows + 1,
    complete = false,
  ) {
    const output = await call('search_records', {
      model,
      domain,
      fields,
      limit,
      offset: 0,
      order: 'id desc',
    });
    if (
      !Array.isArray(output.records) ||
      output.model !== model ||
      output.offset !== 0 ||
      !Number.isSafeInteger(output.total) ||
      Number(output.total) < output.records.length ||
      !positive(output.limit) ||
      output.limit > limit ||
      output.records.length > output.limit ||
      (complete && output.total !== output.records.length) ||
      (limit > maxRows &&
        output.total !== output.records.length &&
        output.records.length <= maxRows) ||
      output.records.length > limit ||
      output.records.some((row) => !object(row) || !positive(row.id))
    )
      throw failure();
    return output.records as Row[];
  }
  async function odooGet(
    call: (tool: string, args: Row) => Promise<Row>,
    model: string,
    recordId: number,
    fields: string[],
  ) {
    const output = await call('get_record', { model, record_id: recordId, fields });
    if (!object(output.record) || output.record.id !== recordId) throw failure();
    return output.record;
  }
  async function opsTables(call: (tool: string, args: Row) => Promise<Row>) {
    const output = await call('list_modules', {});
    if (
      !object(output.access) ||
      output.access.scope !== 'read' ||
      !Array.isArray(output.modules) ||
      output.modules.length > 100
    )
      throw failure();
    const tables = new Set<string>();
    for (const module of output.modules)
      if (object(module) && Array.isArray(module.tables))
        for (const table of module.tables) if (typeof table === 'string') tables.add(table);
    return tables;
  }
  async function opsQuery(
    call: (tool: string, args: Row) => Promise<Row>,
    table: string,
    columns: string[],
    args: Row,
  ) {
    const schema = await call('describe_table', { table });
    const publicColumns = schema.spalten;
    if (
      schema.table !== table ||
      !Array.isArray(publicColumns) ||
      !columns.every((column) =>
        publicColumns.some((entry: unknown) => object(entry) && entry.spalte === column),
      )
    )
      throw failure();
    const output = await call('query_table', {
      table,
      columns: columns.join(','),
      ...args,
      limit: maxRows + 1,
      offset: 0,
      order_by: 'id',
    });
    if (
      output.table !== table ||
      !Array.isArray(output.rows) ||
      output.rows.length > maxRows + 1 ||
      output.rows.some(
        (row) =>
          !object(row) ||
          !(
            positive(row.id) ||
            (typeof row.id === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(row.id))
          ),
      ) ||
      !(
        output.total === null ||
        (Number.isSafeInteger(output.total) && Number(output.total) >= output.rows.length)
      ) ||
      typeof output.has_more !== 'boolean'
    )
      throw failure();
    return {
      rows: output.rows as Row[],
      truncated: output.total === null || output.has_more === true || output.rows.length > maxRows,
    };
  }
  return {
    async profiles(owner: string): Promise<ResearchProfile[]> {
      const { identity } = await fresh(owner);
      const profiles: ResearchProfile[] = [];
      for (const candidate of identity.profiles.slice(0, 32)) {
        try {
          const profile = checkedProfile(identity.profiles, candidate.id);
          for (const tool of profile.kind === 'odoo' ? odooTools : opsTools)
            await deps.authorizeTool(owner, profile.id, tool);
          profiles.push(profile);
        } catch {
          /* An unavailable profile is not offered and is never replaced with another key. */
        }
      }
      return profiles;
    },
    async searchCustomers(
      owner: string,
      profileId: string,
      query: string,
      guard: Guard,
    ): Promise<ResearchCustomer[]> {
      const term = literal(query);
      return session(owner, profileId, guard, async (profile, call) => {
        if (profile.kind === 'odoo') {
          const models = await odooCapabilities(call);
          if (!models.has('res.partner')) throw failure();
          const rows = await odooSearch(
            call,
            'res.partner',
            [
              ['active', '=', true],
              ['name', 'ilike', term],
            ],
            ['id', 'name'],
            maxRows,
          );
          return rows.map((row) => ({
            id: String(row.id),
            name: text(row.name, 200),
            odooPartnerId: row.id as number,
          }));
        }
        const tables = await opsTables(call);
        if (!tables.has('customers')) throw failure();
        const { rows } = await opsQuery(
          call,
          'customers',
          ['id', 'company_name', 'alias', 'odoo_partner_id'],
          { search_column: 'company_name', search_term: term },
        );
        return rows
          .slice(0, maxRows)
          .filter((row) => typeof row.id === 'string' && uuidPattern.test(row.id))
          .map((row) => ({
            id: String(row.id),
            name: text(row.company_name, 200),
            ...(positive(row.odoo_partner_id) && { odooPartnerId: row.odoo_partner_id }),
          }));
      });
    },
    async read(
      owner: string,
      profileId: string,
      customerId: string,
      options: ResearchReadOptions,
      guard: Guard,
    ): Promise<ResearchSourceResult> {
      const topic = literal(options.topic);
      const reference = options.reference ? literal(options.reference, 1) : undefined;
      if (
        !Number.isSafeInteger(options.lookbackMonths) ||
        options.lookbackMonths < 1 ||
        options.lookbackMonths > 36
      )
        throw failure();
      const start = new Date();
      start.setUTCMonth(start.getUTCMonth() - options.lookbackMonths);
      const since = start.toISOString().slice(0, 10);
      return session(owner, profileId, guard, async (profile, call) =>
        profile.kind === 'odoo'
          ? readOdoo(profile, call, customerId, topic, reference, since)
          : readOps(profile, call, customerId, topic),
      );
    },
  };

  async function readOps(
    profile: ResearchProfile,
    call: (tool: string, args: Row) => Promise<Row>,
    customerId: string,
    topic: string,
  ): Promise<ResearchSourceResult> {
    if (!uuidPattern.test(customerId)) throw failure();
    const tables = await opsTables(call);
    if (!tables.has('customers')) throw failure();
    const customerResult = await opsQuery(
      call,
      'customers',
      ['id', 'company_name', 'odoo_partner_id'],
      { filter_column: 'id', filter_value: customerId },
    );
    if (customerResult.rows.length !== 1 || customerResult.rows[0].id !== customerId)
      throw failure();
    const row = customerResult.rows[0];
    const customer: ResearchCustomer = {
      id: customerId,
      name: text(row.company_name, 200),
      ...(positive(row.odoo_partner_id) && { odooPartnerId: row.odoo_partner_id }),
    };
    const result: ResearchSourceResult = { customer, evidence: [], warnings: [], truncated: false };
    if (/veeam/i.test(topic)) {
      result.warnings.push(
        'Die freigegebene OPS-MCP-Schnittstelle bietet keine belegte Veeam-Lizenzquelle. Microsoft-365-Lizenzen sind kein Ersatz.',
      );
      return result;
    }
    const sources: {
      table: string;
      product: string;
      fields: [string, string][];
      updated: string;
    }[] = [
      {
        table: 'm365_subscriptions',
        product: 'product_name',
        updated: 'synced_at',
        fields: [
          ['product_name', 'Produkt'],
          ['total_licenses', 'Anzahl'],
          ['unit_type', 'Einheit'],
          ['status', 'Status'],
          ['billing_cycle', 'Abrechnungszyklus'],
          ['billing_term', 'Laufzeit'],
          ['end_date', 'Periodenende'],
          ['renewal_date', 'Verlängerungsdatum'],
          ['auto_renew', 'Automatische Verlängerung'],
          ['currency', 'Währung'],
          ['synced_at', 'Quellenstand'],
        ],
      },
      {
        table: 'infinigate_current_licenses',
        product: 'description',
        updated: 'invoice_date',
        fields: [
          ['sku', 'SKU'],
          ['description', 'Produkt'],
          ['quantity', 'Anzahl'],
          ['currency_code', 'Währung'],
          ['invoice_number', 'Rechnung'],
          ['invoice_date', 'Rechnungsstand'],
        ],
      },
    ];
    for (const source of sources) {
      if (!tables.has(source.table)) {
        result.warnings.push(
          `Die Lizenzquelle ${source.table} ist für dieses Profil nicht freigegeben.`,
        );
        continue;
      }
      try {
        const output = await opsQuery(
          call,
          source.table,
          ['id', 'customer_id', ...source.fields.map(([key]) => key)],
          {
            filter_column: 'customer_id',
            filter_value: customerId,
            search_column: source.product,
            search_term: topic,
          },
        );
        if (
          output.rows.some(
            (row) =>
              row.customer_id !== customerId ||
              !text(row[source.product], 12_000)
                .toLocaleLowerCase()
                .includes(topic.toLocaleLowerCase()),
          )
        )
          throw failure();
        result.truncated ||= output.truncated;
        for (const row of output.rows.slice(0, maxRows))
          result.evidence.push(
            evidence(
              profile,
              customer,
              source.table,
              row,
              source.fields,
              text(row[source.product]),
              date(row[source.updated]),
            ),
          );
      } catch (error) {
        if (error instanceof ResearchStopped) throw error;
        result.warnings.push(
          `Die Lizenzquelle ${source.table} konnte nicht vollständig und berechtigt gelesen werden.`,
        );
      }
    }
    if (!tables.has('sophos_tenants')) {
      result.warnings.push('Sophos-Kundenzuordnungen sind für dieses Profil nicht verfügbar.');
      return result;
    }
    try {
      const tenants = await opsQuery(call, 'sophos_tenants', ['id', 'customer_id', 'tenant_id'], {
        filter_column: 'customer_id',
        filter_value: customerId,
      });
      if (
        tenants.truncated ||
        tenants.rows.some(
          (row) =>
            row.customer_id !== customerId ||
            typeof row.tenant_id !== 'string' ||
            !uuidPattern.test(row.tenant_id),
        )
      )
        throw failure();
      const ids = tenants.rows.map((row) => String(row.tenant_id));
      if (!ids.length) {
        result.warnings.push('Für diesen Kunden ist keine bestätigte Sophos-Zuordnung vorhanden.');
        return result;
      }
      for (const table of ['sophos_licenses', 'sophos_firewall_licenses']) {
        if (!tables.has(table)) {
          result.warnings.push(
            `Die Lizenzquelle ${table} ist für dieses Profil nicht freigegeben.`,
          );
          continue;
        }
        try {
          const fields: [string, string][] = [
            ['product_name', 'Produkt'],
            ['product_code', 'Produktcode'],
            ['license_type', 'Lizenzart'],
            ['perpetual', 'Unbefristet'],
            ['unlimited', 'Unbegrenzt'],
            ['quantity', 'Anzahl'],
            ['start_date', 'Beginn'],
            ['end_date', 'Ende'],
            ['synced_at', 'Quellenstand'],
          ];
          const output = await opsQuery(
            call,
            table,
            ['id', 'tenant_id', ...fields.map(([key]) => key)],
            {
              in_column: 'tenant_id',
              in_values: ids,
              search_column: 'product_name',
              search_term: topic,
            },
          );
          if (
            output.rows.some(
              (row) =>
                !ids.includes(String(row.tenant_id)) ||
                !text(row.product_name, 12_000)
                  .toLocaleLowerCase()
                  .includes(topic.toLocaleLowerCase()),
            )
          )
            throw failure();
          result.truncated ||= output.truncated;
          for (const row of output.rows.slice(0, maxRows))
            result.evidence.push(
              evidence(
                profile,
                customer,
                table,
                row,
                fields,
                text(row.product_name),
                date(row.synced_at),
              ),
            );
        } catch (error) {
          if (error instanceof ResearchStopped) throw error;
          result.warnings.push(
            `Die Lizenzquelle ${table} konnte nicht vollständig und berechtigt gelesen werden.`,
          );
        }
      }
    } catch (error) {
      if (error instanceof ResearchStopped) throw error;
      result.warnings.push(
        'Die Sophos-Kundenzuordnung ist nicht vollständig lesbar; es werden keine fremden Tenants ersatzweise durchsucht.',
      );
    }
    result.warnings.push(
      'OPS-Lizenzen sind gespeicherte Quellenstände. Automatische Verlängerung und unbekannte Mengen dürfen nicht als Kündigung oder null Lizenzen ausgelegt werden.',
    );
    return result;
  }

  async function readOdoo(
    profile: ResearchProfile,
    call: (tool: string, args: Row) => Promise<Row>,
    customerId: string,
    topic: string,
    reference: string | undefined,
    since: string,
  ): Promise<ResearchSourceResult> {
    if (!/^[1-9][0-9]{0,9}$/.test(customerId) || !positive(Number(customerId))) throw failure();
    const models = await odooCapabilities(call);
    if (!models.has('res.partner')) throw failure();
    const partner = await odooGet(call, 'res.partner', Number(customerId), [
      'id',
      'name',
      'commercial_partner_id',
      'company_id',
    ]);
    const commercialId = relation(partner.commercial_partner_id);
    if (!commercialId) throw failure();
    const customer: ResearchCustomer = {
      id: customerId,
      name: text(partner.name, 200),
      odooPartnerId: Number(customerId),
    };
    const result: ResearchSourceResult = { customer, evidence: [], warnings: [], truncated: false };
    let companyIds: number[] = [];
    if (relation(partner.company_id)) companyIds = [relation(partner.company_id)!];
    else if (models.has('res.company')) {
      const companies = await odooSearch(call, 'res.company', [], ['id'], maxRows + 1, true);
      if (companies.length <= maxRows) companyIds = companies.map((row) => Number(row.id));
    }
    if (!companyIds.length) {
      result.warnings.push(
        'Die berechtigte Odoo-Firma konnte nicht eindeutig begrenzt werden. Belege bleiben gesperrt.',
      );
      return result;
    }
    const partners = await odooSearch(
      call,
      'res.partner',
      [['commercial_partner_id', '=', commercialId]],
      ['id', 'commercial_partner_id', 'company_id'],
      101,
      true,
    );
    if (
      partners.length > 100 ||
      partners.some((row) => relation(row.commercial_partner_id) !== commercialId)
    ) {
      result.warnings.push(
        'Die Kundenkontakte konnten nicht vollständig geprüft werden. Belege bleiben gesperrt.',
      );
      return result;
    }
    const partnerIds = partners
      .filter(
        (row) => row.company_id === false || companyIds.includes(relation(row.company_id) ?? -1),
      )
      .map((row) => Number(row.id));
    if (!partnerIds.includes(Number(customerId))) {
      result.warnings.push('Der gewählte Kunde gehört nicht zur bestätigten Odoo-Firma.');
      return result;
    }
    const sources = [
      {
        model: 'sale.order',
        line: 'sale.order.line',
        relation: 'order_id',
        partner: 'partner_id',
        date: 'date_order',
        qty: 'product_uom_qty',
        title: 'Offerte/Auftrag',
      },
      {
        model: 'account.move',
        line: 'account.move.line',
        relation: 'move_id',
        partner: 'partner_id',
        date: 'invoice_date',
        qty: 'quantity',
        title: 'Rechnung/Gutschrift',
      },
    ];
    for (const source of sources) {
      if (!models.has(source.model) || !models.has(source.line)) {
        result.warnings.push(
          `${source.title}: Die erforderlichen Leserechte sind nicht verfügbar.`,
        );
        continue;
      }
      try {
        const domain: unknown[] = [
          [`${source.relation}.${source.partner}`, 'in', partnerIds],
          ['company_id', 'in', companyIds],
          [`${source.relation}.${source.date}`, '>=', since],
          ['name', 'ilike', topic],
        ];
        if (reference) domain.push([`${source.relation}.name`, 'ilike', reference]);
        if (source.model === 'account.move')
          domain.push(
            ['move_id.move_type', 'in', ['out_invoice', 'out_refund']],
            ['display_type', 'in', ['product', false]],
          );
        const fields = [
          'id',
          'name',
          source.relation,
          'company_id',
          source.qty,
          'price_unit',
          'price_subtotal',
          'currency_id',
        ];
        const lines = await odooSearch(call, source.line, domain, fields);
        result.truncated ||= lines.length > maxRows;
        const selected = lines.slice(0, maxRows);
        if (
          selected.some(
            (line) =>
              !companyIds.includes(relation(line.company_id) ?? -1) ||
              !relation(line[source.relation]) ||
              !text(line.name, 12_000).toLocaleLowerCase().includes(topic.toLocaleLowerCase()),
          )
        )
          throw failure();
        const ids = [...new Set(selected.map((line) => relation(line[source.relation])!))];
        if (!ids.length) continue;
        const documentDomain: unknown[] = [
          ['id', 'in', ids],
          ['partner_id', 'in', partnerIds],
          ['company_id', 'in', companyIds],
          [source.date, '>=', since],
        ];
        if (source.model === 'account.move')
          documentDomain.push(['move_type', 'in', ['out_invoice', 'out_refund']]);
        const docs = await odooSearch(call, source.model, documentDomain, [
          'id',
          'name',
          'partner_id',
          'company_id',
          source.date,
          'state',
          'amount_untaxed',
          'amount_total',
          'currency_id',
          'write_date',
          ...(source.model === 'account.move' ? ['move_type'] : []),
        ]);
        if (
          docs.some(
            (doc) =>
              !ids.includes(Number(doc.id)) ||
              (reference !== undefined &&
                !text(doc.name, 200).toLocaleLowerCase().includes(reference.toLocaleLowerCase())) ||
              !partnerIds.includes(relation(doc.partner_id) ?? -1) ||
              !companyIds.includes(relation(doc.company_id) ?? -1) ||
              !date(doc[source.date]) ||
              date(doc[source.date])!.slice(0, 10) < since ||
              (source.model === 'account.move' &&
                !['out_invoice', 'out_refund'].includes(String(doc.move_type))),
          )
        )
          throw failure();
        for (const doc of docs) {
          result.evidence.push(
            evidence(
              profile,
              customer,
              source.model,
              doc,
              [
                ['name', 'Beleg'],
                [source.date, 'Datum'],
                ['state', 'Status'],
                ['amount_untaxed', 'Netto'],
                ['amount_total', 'Gesamt'],
                ['currency_id', 'Währung'],
                ...(source.model === 'account.move'
                  ? [['move_type', 'Belegart'] as [string, string]]
                  : []),
              ],
              `${source.title}: ${text(doc.name, 160)}`,
              date(doc.write_date),
              sourceUrl(deps.sourceOrigins, profile.id, source.model, Number(doc.id)),
            ),
          );
          for (const line of selected.filter(
            (line) => relation(line[source.relation]) === doc.id,
          )) {
            result.evidence.push(
              evidence(
                profile,
                customer,
                source.line,
                line,
                [
                  ['name', 'Position'],
                  [source.qty, 'Anzahl'],
                  ['price_unit', 'Einzelpreis'],
                  ['price_subtotal', 'Netto'],
                  ['currency_id', 'Währung'],
                ],
                `${text(doc.name, 100)}: ${text(line.name, 120)}`,
              ),
            );
          }
        }
        if (docs.length !== ids.length)
          result.warnings.push(
            `${source.title}: Einige Positionen konnten keinem vollständig berechtigten Beleg zugeordnet werden und fehlen.`,
          );
      } catch (error) {
        if (error instanceof ResearchStopped) throw error;
        result.warnings.push(
          `${source.title}: Die Quelle konnte nicht vollständig und berechtigt gelesen werden.`,
        );
      }
    }
    result.warnings.push(
      'Offerten, bestätigte Aufträge, Rechnungen und Gutschriften sind getrennte Quellen und dürfen nicht als gemeinsamer Umsatz addiert werden.',
    );
    return result;
  }
}
