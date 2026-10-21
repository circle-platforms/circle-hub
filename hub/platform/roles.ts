// The application role's place in the cluster (README decision 2). The Hub database and every object in it belong to the
// cluster's superuser role (the operating-system account that runs initdb and the migrations); the application role the
// running server uses connects and holds the grants the migration gave it. It owns nothing, has no role attribute beyond
// LOGIN, is a member of no role and can create nothing, so it cannot drop, truncate, alter or disable the triggers of the
// append-only tables. Its privileges are listed as entries `<kind> [<name>] <PRIVILEGE>`, so a backup can record them and
// a restore can prove them. Every problem found comes with the statements that remove it (inspectRole).
import { PlatformError } from './errors.ts';
import type { PostgresControl } from './postgres.ts';
import { quoteIdentifier, withSession, type SqlSession } from './sql.ts';

const OUTSIDE_SYSTEM = `n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'`;
const RELATION_KINDS = `c.relkind IN ('r', 'p', 'v', 'm', 'f')`;
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
/** MAINTAIN exists from PostgreSQL 17 on. */
const MAINTAIN_FROM = 170000;

const HELD = `
SELECT 'database ' || p AS entry
  FROM unnest(ARRAY['CONNECT', 'CREATE', 'TEMPORARY']) AS p
 WHERE has_database_privilege($1::oid, current_database(), p)
UNION ALL
SELECT 'schema ' || quote_ident(n.nspname) || ' ' || p
  FROM pg_catalog.pg_namespace n, unnest(ARRAY['USAGE', 'CREATE']) AS p
 WHERE ${OUTSIDE_SYSTEM} AND has_schema_privilege($1::oid, n.oid, p)
UNION ALL
SELECT 'table ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || ' ' || p
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace, unnest($2::text[]) AS p
 WHERE ${RELATION_KINDS} AND ${OUTSIDE_SYSTEM} AND has_table_privilege($1::oid, c.oid, p)
UNION ALL
SELECT 'column ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || '.' || quote_ident(a.attname) || ' ' || p
  FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace,
       unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) AS p
 WHERE a.attnum > 0 AND NOT a.attisdropped AND ${RELATION_KINDS} AND ${OUTSIDE_SYSTEM}
   AND has_column_privilege($1::oid, c.oid, a.attnum, p) AND NOT has_table_privilege($1::oid, c.oid, p)
UNION ALL
SELECT 'sequence ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || ' ' || p
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace, unnest(ARRAY['USAGE', 'SELECT', 'UPDATE']) AS p
 WHERE c.relkind = 'S' AND ${OUTSIDE_SYSTEM} AND has_sequence_privilege($1::oid, c.oid, p)
UNION ALL
SELECT 'function ' || quote_ident(n.nspname) || '.' || quote_ident(f.proname) || '(' || pg_catalog.pg_get_function_identity_arguments(f.oid) || ') EXECUTE'
  FROM pg_catalog.pg_proc f JOIN pg_catalog.pg_namespace n ON n.oid = f.pronamespace
 WHERE ${OUTSIDE_SYSTEM} AND has_function_privilege($1::oid, f.oid, 'EXECUTE')`;

/**
 * Every privilege `role` holds in the session's database, directly, through PUBLIC or through a role it belongs to, sorted:
 * `database CONNECT`, `schema public USAGE`, `table public.records INSERT`, `column public.users.role UPDATE` (only when
 * the table-level privilege is not held), `sequence …`, `function public.f() EXECUTE`. The database has no name in its
 * entries, so a restore under another database name compares equal.
 */
export async function rolePrivileges(session: SqlSession, role: string): Promise<string[]> {
  const [found] = await session.query(
    "SELECT r.oid, current_setting('server_version_num')::int AS version FROM pg_catalog.pg_roles r WHERE r.rolname = $1",
    [role],
  );
  if (!found) throw new PlatformError(`数据库角色 ${role} 不存在`);
  const tablePrivileges = Number(found.version) >= MAINTAIN_FROM ? [...TABLE_PRIVILEGES, 'MAINTAIN'] : TABLE_PRIVILEGES;
  const rows = await session.query(HELD, [found.oid, tablePrivileges]);
  return rows.map((row) => String(row.entry)).sort();
}

/** Entries of `expected` missing from `actual` and entries of `actual` not in `expected`, in Chinese; empty when equal. */
export function comparePrivileges(expected: readonly string[], actual: readonly string[]): string[] {
  const want = new Set(expected);
  const got = new Set(actual);
  return [...[...want].filter((entry) => !got.has(entry)).map((entry) => `缺少 ${entry}`), ...[...got].filter((entry) => !want.has(entry)).map((entry) => `多出 ${entry}`)];
}

const PROFILE = `
SELECT r.oid, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
       current_user::text AS admin, current_database()::text AS database,
       has_database_privilege(r.oid, current_database(), 'CREATE') AS create_database,
       has_database_privilege(r.oid, current_database(), 'TEMPORARY') AS temporary_database,
       ARRAY(SELECT n.nspname::text FROM pg_catalog.pg_namespace n
              WHERE ${OUTSIDE_SYSTEM} AND has_schema_privilege(r.oid, n.oid, 'CREATE') ORDER BY 1) AS create_schemas
  FROM pg_catalog.pg_roles r WHERE r.rolname = $1`;

const MEMBERSHIPS = `
SELECT b.rolname::text AS role, g.rolname::text AS grantor
  FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles b ON b.oid = m.roleid LEFT JOIN pg_catalog.pg_roles g ON g.oid = m.grantor
 WHERE m.member = $1::oid ORDER BY 1, 2`;

/** Objects any role may create without a privilege: large objects, and default privileges for what it creates itself. */
const WITHOUT_PRIVILEGE = `'pg_catalog.pg_largeobject'::regclass, 'pg_catalog.pg_default_acl'::regclass`;

/** Everything the role owns, in every database of the cluster; database is NULL for shared objects (databases). */
const OWNED = `pg_catalog.pg_shdepend s LEFT JOIN pg_catalog.pg_database d ON d.oid = s.dbid
 WHERE s.deptype = 'o' AND s.refclassid = 'pg_catalog.pg_authid'::regclass AND s.refobjid = $1::oid`;

const OWNERSHIP = `
SELECT d.datname::text AS database, s.classid = 'pg_catalog.pg_class'::regclass AS relation,
       s.classid = 'pg_catalog.pg_default_acl'::regclass AS default_acl, s.classid IN (${WITHOUT_PRIVILEGE}) AS without_privilege,
       count(*)::int AS n
  FROM ${OWNED}
 GROUP BY 1, 2, 3, 4`;

/** A few owned objects; only those of this database and shared ones can be described from here. */
const EXAMPLES = `
SELECT o.database, o.catalog, o.objid::text AS object, o.description FROM (
  SELECT d.datname::text AS database, s.classid::regclass::text AS catalog, s.objid,
         CASE WHEN s.dbid = 0 OR d.datname = current_database() THEN pg_catalog.pg_describe_object(s.classid, s.objid, s.objsubid) END AS description
    FROM ${OWNED}) AS o
 ORDER BY o.description IS NULL, o.description, o.database, o.catalog, o.objid
 LIMIT 5`;

/** The role's default privileges in this database, with every role named in them (PUBLIC is not listed). */
const DEFAULT_PRIVILEGES = `
SELECT d.defaclobjtype::text AS kind, n.nspname::text AS schema,
       ARRAY(SELECT DISTINCT g.rolname::text FROM pg_catalog.aclexplode(d.defaclacl) AS a JOIN pg_catalog.pg_roles g ON g.oid = a.grantee ORDER BY 1) AS grantees
  FROM pg_catalog.pg_default_acl d LEFT JOIN pg_catalog.pg_namespace n ON n.oid = d.defaclnamespace
 WHERE d.defaclrole = $1::oid
 ORDER BY 1, 2 NULLS FIRST`;

/** Role attributes beyond LOGIN: column, problem, the ALTER ROLE option that turns it off. */
const ATTRIBUTES: readonly (readonly [string, string, string])[] = [
  ['rolsuper', '是超级用户', 'NOSUPERUSER'],
  ['rolcreatedb', '能建数据库', 'NOCREATEDB'],
  ['rolcreaterole', '能建角色', 'NOCREATEROLE'],
  ['rolreplication', '能做复制', 'NOREPLICATION'],
  ['rolbypassrls', '能绕过行级安全', 'NOBYPASSRLS'],
];

/** ALTER DEFAULT PRIVILEGES keywords by pg_default_acl.defaclobjtype (PostgreSQL 18). */
const DEFAULT_ACL_KINDS: Readonly<Record<string, string>> = { r: 'TABLES', S: 'SEQUENCES', f: 'FUNCTIONS', T: 'TYPES', n: 'SCHEMAS', L: 'LARGE OBJECTS' };
/** What PUBLIC holds in PostgreSQL's built-in default for new objects of a kind; the owner always holds ALL. */
const PUBLIC_DEFAULTS: Readonly<Record<string, string>> = { f: 'EXECUTE', T: 'USAGE' };

/** Statements to run, connected as the superuser role to `database`. */
export interface RoleFixStep {
  database: string;
  statements: string[];
}

export interface RoleReport {
  /** What lets the role do more than connect and use its grants, in Chinese; empty when it is only that. */
  problems: string[];
  /**
   * True when every problem is an object any role may create without a privilege: large objects and default privileges
   * for objects it creates itself. They give it no power over other objects, so `serve` only warns; a backup still
   * refuses them, because a restore could not reproduce them as they were.
   */
  withoutPrivilegeOnly: boolean;
  /** Statements that remove every problem, in order: other databases first, the Hub database last. */
  fix: RoleFixStep[];
  /** Run the fix with the service stopped: it takes away objects or privileges the running server may be using. */
  stopService: boolean;
  /** The role owned tables (a data root of an earlier platform version): afterwards only a migration grants it access again. */
  regrant: boolean;
}

/**
 * Statements that put one default-privilege entry of `role` back to PostgreSQL's built-in default, which deletes the
 * entry; undefined for a kind this code does not know. REASSIGN OWNED leaves these entries alone, and DROP OWNED would
 * also revoke every grant the role holds.
 */
function defaultPrivilegeFix(role: string, entry: Record<string, unknown>): string[] | undefined {
  const kind = DEFAULT_ACL_KINDS[String(entry.kind)];
  if (kind === undefined) return undefined;
  const schema = entry.schema === null || entry.schema === undefined ? undefined : String(entry.schema);
  const target = `ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${schema === undefined ? '' : ` IN SCHEMA ${quoteIdentifier(schema)}`}`;
  const grantees = [...new Set(['PUBLIC', role, ...((entry.grantees as string[] | null) ?? []).map(quoteIdentifier)])];
  const out = [`${target} REVOKE ALL ON ${kind} FROM ${grantees.join(', ')}`];
  // A per-schema entry only adds to the global one: empty is its default. The global one's default is the owner's ALL.
  if (schema === undefined) {
    out.push(`${target} GRANT ALL ON ${kind} TO ${role}`);
    const publicDefault = PUBLIC_DEFAULTS[String(entry.kind)];
    if (publicDefault !== undefined) out.push(`${target} GRANT ${publicDefault} ON ${kind} TO PUBLIC`);
  }
  return out;
}

/**
 * What lets `role` do more than connect and use its grants, and the statements that remove it. Run as the superuser
 * role, connected to the Hub database. Ownership counts in every database of the cluster (pg_shdepend; the initdb role
 * itself is never listed there, so this is for other roles).
 */
export async function inspectRole(session: SqlSession, role: string): Promise<RoleReport> {
  const [row] = await session.query(PROFILE, [role]);
  if (!row) return { problems: ['不存在'], withoutPrivilegeOnly: false, fix: [], stopService: false, regrant: false };
  const r = quoteIdentifier(role);
  const admin = quoteIdentifier(String(row.admin));
  const database = String(row.database);
  const problems: string[] = [];
  const here: string[] = [];

  const attributes = ATTRIBUTES.filter(([column]) => row[column] === true);
  for (const [, text] of attributes) problems.push(text);
  if (attributes.length > 0) here.push(`ALTER ROLE ${r} ${attributes.map(([, , off]) => off).join(' ')}`);
  const memberships = await session.query(MEMBERSHIPS, [row.oid]);
  const memberOf = [...new Set(memberships.map((membership) => String(membership.role)))];
  if (memberOf.length > 0) problems.push(`是角色 ${memberOf.join('、')} 的成员`);
  for (const membership of memberships) {
    here.push(`REVOKE ${quoteIdentifier(String(membership.role))} FROM ${r}${membership.grantor === null ? '' : ` GRANTED BY ${quoteIdentifier(String(membership.grantor))}`}`);
  }
  const createDatabase = row.create_database === true;
  // ensureDatabase revokes it from PUBLIC; a restore recreates the database that way, so a backup that had it could not match.
  const temporary = row.temporary_database === true;
  if (createDatabase) problems.push('能在 Hub 数据库里建模式');
  if (temporary) problems.push('能在 Hub 数据库里建临时表');
  const schemas = (row.create_schemas as string[] | null) ?? [];
  if (schemas.length > 0) problems.push(`能在模式 ${schemas.join('、')} 里建对象`);

  const groups = (await session.query(OWNERSHIP, [row.oid])).map((group) => ({
    database: group.database === null ? undefined : String(group.database),
    relation: group.relation === true,
    defaultAcl: group.default_acl === true,
    withoutPrivilege: group.without_privilege === true,
    n: Number(group.n),
  }));
  const owned = groups.reduce((sum, group) => sum + group.n, 0);
  if (owned > 0) {
    const examples = (await session.query(EXAMPLES, [row.oid])).map((example) =>
      example.description !== null
        ? String(example.description)
        : `${example.database === null || example.database === database ? '' : `数据库 ${String(example.database)} 里的 `}${String(example.catalog)} ${String(example.object)}`,
    );
    problems.push(`拥有 ${owned} 个对象（${examples.join('、')}${owned > examples.length ? ' 等' : ''}）`);
  }
  // Shared objects (databases) are reassigned from here too.
  const inHub = (group: (typeof groups)[number]) => group.database === undefined || group.database === database;
  // Other databases first. DROP OWNED there removes default privileges, which REASSIGN OWNED leaves; it also revokes the
  // role's privileges on shared objects, its CONNECT on the Hub database among them, which the Hub step grants again.
  const fix: RoleFixStep[] = [...new Set(groups.filter((group) => !inHub(group)).map((group) => group.database!))].sort().map((name) => ({
    database: name,
    statements: [`REASSIGN OWNED BY ${r} TO ${admin}`, ...(groups.some((group) => group.database === name && group.defaultAcl) ? [`DROP OWNED BY ${r}`] : [])],
  }));
  const droppedElsewhere = fix.some((step) => step.statements.length > 1);
  if (groups.some((group) => inHub(group) && !group.defaultAcl)) here.push(`REASSIGN OWNED BY ${r} TO ${admin}`);
  let regrant = groups.some((group) => group.database === database && group.relation);
  let unknownKind = false;
  if (groups.some((group) => inHub(group) && group.defaultAcl)) {
    for (const entry of await session.query(DEFAULT_PRIVILEGES, [row.oid])) {
      const statements = defaultPrivilegeFix(r, entry);
      if (statements === undefined) unknownKind = true;
      else here.push(...statements);
    }
  }
  if (unknownKind) {
    // Only DROP OWNED removes an entry of a kind this code does not know; it revokes the role's grants as well.
    here.push(`DROP OWNED BY ${r}`);
    regrant = true;
  }
  for (const schema of schemas) here.push(`REVOKE CREATE ON SCHEMA ${quoteIdentifier(schema)} FROM PUBLIC, ${r}`);
  if (createDatabase || temporary || droppedElsewhere || unknownKind) {
    const db = quoteIdentifier(database);
    here.push(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    if (createDatabase || temporary) here.push(`REVOKE CREATE, TEMPORARY ON DATABASE ${db} FROM ${r}`);
    here.push(`GRANT CONNECT ON DATABASE ${db} TO ${r}`);
  }
  if (here.length > 0) fix.push({ database, statements: here });
  const powers = attributes.length > 0 || memberOf.length > 0 || createDatabase || temporary || schemas.length > 0;
  const withoutPrivilegeOnly = owned > 0 && !powers && groups.every((group) => group.withoutPrivilege);
  // DROP OWNED in another database briefly removes the server's CONNECT; a regrant means it has lost its table grants.
  return { problems, withoutPrivilegeOnly, fix, stopService: problems.length > 0 && (!withoutPrivilegeOnly || droppedElsewhere || regrant), regrant };
}

/** What lets `role` do more than connect and use its grants, in Chinese; empty when it is only that (see inspectRole). */
export async function roleProblems(session: SqlSession, role: string): Promise<string[]> {
  return (await inspectRole(session, role)).problems;
}

/** How to remove the problems of `report`: the statements to run, where, and what has to follow. */
export function roleFixHint(control: PostgresControl, report: RoleReport): string {
  if (report.fix.length === 0) return '应用角色由 circle-hub init 或 circle-hub restore 建立；检查部署设置里的数据库角色名（database.role）';
  const { user: admin, socketDir, port } = control.target;
  const steps = report.fix.map((step) => `在数据库 ${step.database} 执行「${step.statements.map((statement) => `${statement};`).join(' ')}」`);
  const parts = [`${report.stopService ? '先停掉服务（circle-hub service stop），' : ''}以本机账户的角色 ${admin} 连上 PostgreSQL（套接字目录 ${socketDir}，端口 ${port}），${steps.join('，然后')}`];
  if (report.regrant) parts.push('表原先属于应用角色（更早的平台版本建的数据根）：这样处理后它对这些表没有权限，部署新发布时迁移会重新授权（circle-hub deploy）');
  return parts.join('；');
}

/** The refusal for an application role with the problems of `report`; `when` prefixes the message (for example 迁移之后，). */
export function applicationRoleError(control: PostgresControl, report: RoleReport, when = ''): PlatformError {
  const role = control.application.user;
  const why = report.withoutPrivilegeOnly
    ? '任何角色不需授权都能建这类对象，Hub 自己从不建；它们动不了历史，但有它们的数据库备份后不能按原样恢复'
    : 'Hub 以它运行，只追加的约束就不成立';
  return new PlatformError(`${when}应用角色 ${role} 应当只能连接并按授权读写，现在却${report.problems.join('、')}：${why}`, roleFixHint(control, report));
}

/**
 * Refuses unless the application role only connects and holds grants; with `allowWithoutPrivilege`, objects any role may
 * create without a privilege are let through (the caller warns). `when` prefixes the message (for example 迁移之后，).
 * Connects as the superuser role to the Hub database; returns what it found.
 */
export async function assertApplicationRole(control: PostgresControl, when = '', options: { allowWithoutPrivilege?: boolean } = {}): Promise<RoleReport> {
  const role = control.application.user;
  const report = await withSession(control.connector, control.target.database, (session) => inspectRole(session, role));
  if (report.problems.length > 0 && !(options.allowWithoutPrivilege === true && report.withoutPrivilegeOnly)) throw applicationRoleError(control, report, when);
  return report;
}

/** What the records migration gives the runtime role on its history tables; synthetic tables get the same. */
export const APPLICATION_TABLE_PRIVILEGES = 'SELECT, INSERT';

/** Grants `role` `privileges` on `tables`, run as their owner (the superuser role), as the records migration does. */
export async function grantTables(session: SqlSession, role: string, tables: readonly string[], privileges: string = APPLICATION_TABLE_PRIVILEGES): Promise<void> {
  if (!/^[A-Z]+(?:\s*\([a-z_, ]+\))?(?:,\s*[A-Z]+(?:\s*\([a-z_, ]+\))?)*$/.test(privileges)) throw new PlatformError(`看不懂的权限：${privileges}`);
  await session.query(`GRANT ${privileges} ON TABLE ${tables.map(quoteIdentifier).join(', ')} TO ${quoteIdentifier(role)}`);
}

/** Statements that remove or rewrite history, or create objects; each must be refused to the application role (42501). */
export function tamperingStatements(table: string): string[] {
  const t = quoteIdentifier(table);
  return [
    `DELETE FROM ${t}`,
    `TRUNCATE ${t}`,
    `DROP TABLE ${t}`,
    `ALTER TABLE ${t} ADD COLUMN circle_hub_probe integer`,
    `ALTER TABLE ${t} DISABLE TRIGGER ALL`,
    'CREATE TABLE circle_hub_probe (n integer)',
  ];
}

export interface Unrefused {
  statement: string;
  /** SQLSTATE of a refusal for another reason (which proves nothing), or null when the statement ran. */
  code: string | null;
}

/**
 * Runs each statement in its own transaction, always rolled back, and returns those that were not refused with 42501
 * (insufficient_privilege). An empty result proves the session's role may run none of them.
 */
export async function unrefusedStatements(session: SqlSession, statements: readonly string[]): Promise<Unrefused[]> {
  const out: Unrefused[] = [];
  for (const statement of statements) {
    await session.query('BEGIN');
    try {
      await session.query(statement);
      out.push({ statement, code: null });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== '42501') out.push({ statement, code: typeof code === 'string' ? code : '?' });
    } finally {
      await session.query('ROLLBACK');
    }
  }
  return out;
}

/** One Chinese line per statement that was not refused. */
export function unrefusedText(found: readonly Unrefused[]): string[] {
  return found.map((item) => (item.code === null ? `应用角色执行成功（应被拒绝）：${item.statement}` : `应用角色的 ${item.statement} 因 SQLSTATE ${item.code} 失败，不是因为没有权限`));
}
