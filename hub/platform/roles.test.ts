// Integration: the application role checks of roles.ts on a real cluster from the pinned binaries. Every power beyond
// connecting and using grants is named, the printed fix removes it without touching the grants, the privilege entries
// are exact, and only 42501 counts as a refusal.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ensureLayout, layoutAt } from './layout.ts';
import { createPostgres, databaseOwner, ensureDatabaseRunning, type PostgresControl } from './postgres.ts';
import {
  applicationRoleError,
  assertApplicationRole,
  comparePrivileges,
  grantTables,
  inspectRole,
  roleFixHint,
  rolePrivileges,
  roleProblems,
  tamperingStatements,
  unrefusedStatements,
  unrefusedText,
  type RoleReport,
} from './roles.ts';
import { quoteIdentifier, withSession, type SqlSession } from './sql.ts';
import { removeDir, socketPort, tempDir } from './test-support.ts';

/** What the application role holds in a fresh Hub database. */
const BASELINE = ['database CONNECT', 'schema public USAGE'];

describe('the application role checks on a real cluster', () => {
  let root: string;
  let control: PostgresControl;
  const role = 'circle_hub';
  const owner = <T>(fn: (session: SqlSession) => Promise<T>, database?: string) => withSession(control.connector, database ?? control.target.database, fn);
  const app = <T>(fn: (session: SqlSession) => Promise<T>) => withSession(control.applicationConnector, control.target.database, fn);
  const problems = () => owner((s) => roleProblems(s, role));
  const privileges = () => owner((s) => rolePrivileges(s, role));
  const inspect = () => owner((s) => inspectRole(s, role));

  /** Runs the fix exactly as the hint prints it: every step connected to its database as the superuser role. */
  const applyPrintedFix = async (report: RoleReport) => {
    const hint = roleFixHint(control, report);
    for (const step of report.fix) {
      assert.ok(hint.includes(`在数据库 ${step.database} 执行「${step.statements.map((statement) => `${statement};`).join(' ')}」`), hint);
      await owner(async (s) => {
        for (const statement of step.statements) await s.query(statement);
      }, step.database);
    }
  };

  before(async () => {
    root = await tempDir();
    const layout = layoutAt(root);
    await ensureLayout(layout);
    control = createPostgres({ layout, port: socketPort() });
    await control.initialise();
    await ensureDatabaseRunning(control, { create: true });
  });

  after(async () => {
    await control?.stop().catch(() => {});
    if (root) await removeDir(root);
  });

  test('a fresh Hub database: the application role connects, uses public and has no other power', async () => {
    assert.deepEqual(await problems(), []);
    assert.deepEqual(await privileges(), BASELINE);
    assert.deepEqual(await assertApplicationRole(control), { problems: [], withoutPrivilegeOnly: false, fix: [], stopService: false, regrant: false });
  });

  test('every power beyond connecting and using grants is named, and the printed fix removes it without touching the grants', async () => {
    const admin = quoteIdentifier(control.target.user);
    const db = quoteIdentifier(control.target.database);
    const cases: [string, string[], string][] = [
      // A superuser passes every privilege check as well.
      ['ALTER ROLE circle_hub SUPERUSER', ['是超级用户', '能在 Hub 数据库里建模式', '能在 Hub 数据库里建临时表', '能在模式 public 里建对象'], ''],
      ['ALTER ROLE circle_hub CREATEDB CREATEROLE', ['能建数据库', '能建角色'], ''],
      ['ALTER ROLE circle_hub REPLICATION BYPASSRLS', ['能做复制', '能绕过行级安全'], ''],
      ['GRANT pg_read_all_data TO circle_hub', ['是角色 pg_read_all_data 的成员'], ''],
      [`GRANT CREATE ON DATABASE ${db} TO circle_hub`, ['能在 Hub 数据库里建模式'], ''],
      [`GRANT TEMPORARY ON DATABASE ${db} TO PUBLIC`, ['能在 Hub 数据库里建临时表'], ''],
      ['GRANT CREATE ON SCHEMA public TO circle_hub', ['能在模式 public 里建对象'], ''],
      ['CREATE TABLE handed_over (n int); ALTER TABLE handed_over OWNER TO circle_hub', ['拥有 1 个对象（table handed_over）'], 'DROP TABLE handed_over'],
      ['CREATE DATABASE app_owned OWNER circle_hub', ['拥有 1 个对象（database app_owned）'], 'DROP DATABASE app_owned'],
    ];
    for (const [grant, expected, cleanup] of cases) {
      for (const statement of grant.split('; ')) await owner((s) => s.query(statement));
      try {
        const report = await inspect();
        assert.deepEqual(report.problems, expected, grant);
        assert.equal(report.withoutPrivilegeOnly, false, grant);
        assert.equal(report.stopService, true, grant);
        await assert.rejects(assertApplicationRole(control, '检查时，', { allowWithoutPrivilege: true }), (error: unknown) => {
          assert.equal((error as Error).message, `检查时，应用角色 circle_hub 应当只能连接并按授权读写，现在却${expected.join('、')}：Hub 以它运行，只追加的约束就不成立`);
          assert.equal((error as { hint?: string }).hint, roleFixHint(control, report));
          return true;
        });
        await applyPrintedFix(report);
        assert.deepEqual(await problems(), [], `after the fix of: ${grant}`);
        assert.deepEqual(await privileges(), BASELINE, `the grants are untouched: ${grant}`);
      } finally {
        if (cleanup) await owner((s) => s.query(cleanup), cleanup.startsWith('DROP DATABASE') ? 'postgres' : undefined);
      }
    }
    // The statements are exact: one ALTER ROLE for the attributes, a membership revoked by its grantor.
    await owner((s) => s.query('ALTER ROLE circle_hub CREATEDB BYPASSRLS'));
    await owner((s) => s.query('GRANT pg_read_all_data TO circle_hub'));
    const report = await inspect();
    assert.deepEqual(report.fix, [
      {
        database: control.target.database,
        statements: ['ALTER ROLE "circle_hub" NOCREATEDB NOBYPASSRLS', `REVOKE "pg_read_all_data" FROM "circle_hub" GRANTED BY ${admin}`],
      },
    ]);
    await applyPrintedFix(report);
    assert.deepEqual(await problems(), []);
  });

  test('large objects and default privileges the application role makes without any grant: named, let through only on request, removed by the printed fix', async () => {
    const admin = quoteIdentifier(control.target.user);
    await app(async (s) => {
      await s.query('SELECT lo_create(0)');
      for (const statement of [
        'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC',
        `ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO ${admin} WITH GRANT OPTION`,
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO PUBLIC',
        'ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM circle_hub',
        'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
        'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC',
        'ALTER DEFAULT PRIVILEGES REVOKE USAGE ON TYPES FROM circle_hub',
        'ALTER DEFAULT PRIVILEGES GRANT CREATE ON SCHEMAS TO PUBLIC',
        'ALTER DEFAULT PRIVILEGES GRANT SELECT ON LARGE OBJECTS TO PUBLIC',
      ]) {
        await s.query(statement);
      }
    });
    const [lo] = await owner((s) => s.query('SELECT oid::text AS oid FROM pg_largeobject_metadata'));
    const report = await inspect();
    assert.equal(report.problems.length, 1);
    assert.match(report.problems[0]!, /^拥有 9 个对象（default privileges on new functions belonging to role circle_hub、.* 等）$/);
    assert.deepEqual([report.withoutPrivilegeOnly, report.stopService, report.regrant], [true, false, false]);
    // REASSIGN OWNED alone (the earlier hint) moves the large object but leaves every default-privilege entry.
    assert.equal(report.fix.length, 1);
    assert.equal(report.fix[0]?.statements[0], `REASSIGN OWNED BY "circle_hub" TO ${admin}`);
    assert.ok(report.fix[0]?.statements.includes(`ALTER DEFAULT PRIVILEGES FOR ROLE "circle_hub" REVOKE ALL ON TABLES FROM PUBLIC, "circle_hub", ${admin}`));
    assert.ok(report.fix[0]?.statements.includes('ALTER DEFAULT PRIVILEGES FOR ROLE "circle_hub" IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM PUBLIC, "circle_hub"'));
    assert.ok(report.fix[0]?.statements.includes('ALTER DEFAULT PRIVILEGES FOR ROLE "circle_hub" GRANT EXECUTE ON FUNCTIONS TO PUBLIC'));

    // Every gate refuses them, saying why; serve's check lets them through and returns them for its warning.
    await assert.rejects(assertApplicationRole(control, '备份之前，'), (error: unknown) => {
      assert.equal(
        (error as Error).message,
        `备份之前，应用角色 circle_hub 应当只能连接并按授权读写，现在却${report.problems[0]}：任何角色不需授权都能建这类对象，Hub 自己从不建；它们动不了历史，但有它们的数据库备份后不能按原样恢复`,
      );
      assert.doesNotMatch(String((error as { hint?: string }).hint), /先停掉服务/);
      return true;
    });
    assert.deepEqual((await assertApplicationRole(control, '启动之前，', { allowWithoutPrivilege: true })).problems, report.problems);
    // Together with a real power nothing is let through.
    await owner((s) => s.query('ALTER ROLE circle_hub CREATEDB'));
    await assert.rejects(assertApplicationRole(control, '启动之前，', { allowWithoutPrivilege: true }), /现在却能建数据库、拥有 9 个对象.*Hub 以它运行，只追加的约束就不成立/);
    await applyPrintedFix(await inspect());
    assert.deepEqual(await problems(), []);
    assert.deepEqual(await privileges(), BASELINE, 'the grants are untouched');
    assert.deepEqual(await owner((s) => s.query("SELECT count(*)::int AS n FROM pg_default_acl WHERE defaclrole = 'circle_hub'::regrole")), [{ n: 0 }]);
    // The large object now belongs to the superuser role, which may remove it.
    assert.deepEqual(await owner((s) => s.query(`SELECT pg_get_userbyid(lomowner)::text AS owner FROM pg_largeobject_metadata WHERE oid = ${lo?.oid}`)), [{ owner: control.target.user }]);
    await owner((s) => s.query(`SELECT lo_unlink(${lo?.oid})`));
  });

  test('objects the application role owns in another database name that database; the printed fix there keeps its CONNECT on the Hub database', async () => {
    await owner((s) => s.query('CREATE DATABASE elsewhere'), 'postgres');
    try {
      const ids = await owner(async (s) => {
        await s.query('CREATE TABLE stray (n int)');
        await s.query('ALTER TABLE stray OWNER TO circle_hub');
        await s.query('ALTER DEFAULT PRIVILEGES FOR ROLE circle_hub GRANT SELECT ON TABLES TO PUBLIC');
        const [row] = await s.query("SELECT 'stray'::regclass::oid::text AS stray, (SELECT oid::text FROM pg_default_acl) AS acl");
        return row!;
      }, 'elsewhere');
      const report = await inspect();
      assert.deepEqual(report.problems, [`拥有 2 个对象（数据库 elsewhere 里的 pg_class ${ids.stray}、数据库 elsewhere 里的 pg_default_acl ${ids.acl}）`]);
      assert.equal(report.withoutPrivilegeOnly, false, 'a table counts, wherever it is');
      const admin = quoteIdentifier(control.target.user);
      assert.deepEqual(report.fix, [
        { database: 'elsewhere', statements: [`REASSIGN OWNED BY "circle_hub" TO ${admin}`, 'DROP OWNED BY "circle_hub"'] },
        { database: control.target.database, statements: ['REVOKE ALL ON DATABASE "circle_hub" FROM PUBLIC', 'GRANT CONNECT ON DATABASE "circle_hub" TO "circle_hub"'] },
      ]);
      await applyPrintedFix(report);
      assert.deepEqual(await problems(), []);
      assert.deepEqual(await privileges(), BASELINE, 'DROP OWNED revoked CONNECT on the Hub database; the Hub step granted it again');
      assert.deepEqual(await app((s) => s.query('SELECT 1 AS ok')), [{ ok: 1 }]);
    } finally {
      await owner((s) => s.query('DROP DATABASE elsewhere'), 'postgres');
    }
  });

  test('a database of an earlier platform version (the database and its tables owned by the application role): stop first, fix, then migrate', async () => {
    const db = quoteIdentifier(control.target.database);
    await owner(async (s) => {
      await s.query('CREATE TABLE old_history (n int)');
      await s.query('ALTER TABLE old_history OWNER TO circle_hub');
      await s.query(`ALTER DATABASE ${db} OWNER TO circle_hub`);
    });
    try {
      assert.equal(await databaseOwner(control), 'circle_hub');
      const report = await inspect();
      assert.deepEqual(report.problems, ['能在 Hub 数据库里建模式', '能在 Hub 数据库里建临时表', '能在模式 public 里建对象', '拥有 2 个对象（database circle_hub、table old_history）']);
      assert.deepEqual([report.withoutPrivilegeOnly, report.stopService, report.regrant], [false, true, true]);
      const hint = roleFixHint(control, report);
      assert.match(hint, /^先停掉服务（circle-hub service stop），以本机账户的角色 /);
      assert.match(hint, /部署新发布时迁移会重新授权（circle-hub deploy）$/);
      await applyPrintedFix(report);
      assert.deepEqual(await problems(), []);
      assert.equal(await databaseOwner(control), control.target.user);
      assert.deepEqual(await privileges(), BASELINE, 'no privileges on the old tables until a migration grants them');
    } finally {
      await owner((s) => s.query('DROP TABLE IF EXISTS old_history'));
    }
  });

  test('privileges are listed per table, column, sequence and function; column entries only where the table one is missing', async () => {
    await owner(async (s) => {
      await s.query('CREATE FUNCTION probe_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');
      await s.query('CREATE TABLE probe_users (id text PRIMARY KEY, role text, note text)');
      await s.query('CREATE SEQUENCE probe_seq');
      await grantTables(s, role, ['probe_users'], 'SELECT, INSERT, UPDATE (role)');
      await s.query('GRANT USAGE ON SEQUENCE probe_seq TO circle_hub');
    });
    try {
      assert.deepEqual(await privileges(), [
        'column public.probe_users.role UPDATE',
        'database CONNECT',
        'function public.probe_fn() EXECUTE',
        'schema public USAGE',
        'sequence public.probe_seq USAGE',
        'table public.probe_users INSERT',
        'table public.probe_users SELECT',
      ]);
      const before = await privileges();
      await owner((s) => s.query('REVOKE EXECUTE ON FUNCTION probe_fn() FROM PUBLIC'));
      const after = await privileges();
      assert.deepEqual(comparePrivileges(before, after), ['缺少 function public.probe_fn() EXECUTE']);
      assert.deepEqual(comparePrivileges(after, before), ['多出 function public.probe_fn() EXECUTE']);
      assert.deepEqual(comparePrivileges(after, [...after].reverse()), [], 'order does not matter');
    } finally {
      await owner((s) => s.query('DROP TABLE probe_users; DROP SEQUENCE probe_seq; DROP FUNCTION probe_fn()'));
    }
    await assert.rejects(owner((s) => grantTables(s, role, ['x'], 'ALL; DROP TABLE y')), /看不懂的权限/);
  });

  test('only 42501 counts as a refusal: a statement that ran or failed for another reason is reported', async () => {
    await owner(async (s) => {
      await s.query('CREATE TABLE probe_history (n int)');
      await grantTables(s, role, ['probe_history']);
    });
    try {
      const statements = tamperingStatements('probe_history');
      assert.deepEqual(await app((s) => unrefusedStatements(s, statements)), []);
      const found = await app((s) => unrefusedStatements(s, ['INSERT INTO probe_history VALUES (1)', 'SELECT 1 / 0', ...statements]));
      assert.deepEqual(found, [
        { statement: 'INSERT INTO probe_history VALUES (1)', code: null },
        { statement: 'SELECT 1 / 0', code: '22012' },
      ]);
      assert.deepEqual(unrefusedText(found), ['应用角色执行成功（应被拒绝）：INSERT INTO probe_history VALUES (1)', '应用角色的 SELECT 1 / 0 因 SQLSTATE 22012 失败，不是因为没有权限']);
      assert.equal(Number((await owner((s) => s.query('SELECT count(*) AS n FROM probe_history')))[0]?.n), 0, 'every statement was rolled back');
    } finally {
      await owner((s) => s.query('DROP TABLE probe_history'));
    }
  });

  test('the refusal names the check and the role; the fix names the account role, the socket, each database and its statements', () => {
    const report: RoleReport = {
      problems: ['能建数据库', '拥有 2 个对象（table a、table b）'],
      withoutPrivilegeOnly: false,
      fix: [{ database: 'circle_hub', statements: ['ALTER ROLE "circle_hub" NOCREATEDB', 'REASSIGN OWNED BY "circle_hub" TO "owner"'] }],
      stopService: true,
      regrant: true,
    };
    const error = applicationRoleError(control, report, '迁移之后，');
    assert.equal(error.message, '迁移之后，应用角色 circle_hub 应当只能连接并按授权读写，现在却能建数据库、拥有 2 个对象（table a、table b）：Hub 以它运行，只追加的约束就不成立');
    assert.equal(
      error.hint,
      `先停掉服务（circle-hub service stop），以本机账户的角色 ${control.target.user} 连上 PostgreSQL（套接字目录 ${control.target.socketDir}，端口 ${control.target.port}），` +
        '在数据库 circle_hub 执行「ALTER ROLE "circle_hub" NOCREATEDB; REASSIGN OWNED BY "circle_hub" TO "owner";」；' +
        '表原先属于应用角色（更早的平台版本建的数据根）：这样处理后它对这些表没有权限，部署新发布时迁移会重新授权（circle-hub deploy）',
    );
    assert.match(roleFixHint(control, { problems: ['不存在'], withoutPrivilegeOnly: false, fix: [], stopService: false, regrant: false }), /circle-hub init 或 circle-hub restore/);
  });
});
