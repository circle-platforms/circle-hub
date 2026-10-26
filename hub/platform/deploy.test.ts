import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';
import { createContext } from './context.ts';
import { deploy, guardSignals, OperationProgress, rollback, runDeploy, runRollback, type DeployHost, type DeploymentEntry } from './deploy.ts';
import { PlatformError } from './errors.ts';
import { ensureLayout, layoutAt } from './layout.ts';
import type { ReleaseRef } from './release.ts';
import { newSettingsFile, OPERATOR_TOKEN_ACCOUNT, settingsPath } from './settings.ts';
import { recordingRunner, removeDir, tempDir } from './test-support.ts';

const release = (id: string): ReleaseRef => ({ id: id.padEnd(12, id.at(-1)), dir: `/data/releases/${id.padEnd(12, id.at(-1))}` });
const V1 = release('a');
const V2 = release('b');

/** In-memory deployment: data is a string the migration changes and a restore puts back. */
class FakeHost implements DeployHost {
  calls: string[] = [];
  events: Record<string, unknown>[] = [];
  current: ReleaseRef | undefined;
  loaded: boolean;
  installed: boolean;
  data = 'data@v1';
  databaseOn: string | undefined;
  backups = new Map<string, string>();
  history: DeploymentEntry[] = [];
  releases = new Map<string, ReleaseRef>();
  failAt = new Set<string>();
  /** Fails a call from its n-th occurrence on. */
  failFrom = new Map<string, number>();
  busyPort = false;
  next: ReleaseRef = V2;
  progress: OperationProgress | undefined;
  saved: OperationProgress[] = [];
  /** A signal arrives while this call runs. */
  signalDuring: string | undefined;
  signal: string | undefined;
  private count = 0;
  private seen = new Map<string, number>();

  constructor(current: ReleaseRef | undefined, loaded = true) {
    this.current = current;
    this.loaded = loaded;
    this.installed = loaded;
    this.databaseOn = current?.id ?? 'own';
    for (const r of [V1, V2]) this.releases.set(r.id, r);
  }

  private hit(name: string): void {
    this.calls.push(name);
    const n = (this.seen.get(name) ?? 0) + 1;
    this.seen.set(name, n);
    if (this.signalDuring === name) this.signal = 'SIGINT';
    const from = this.failFrom.get(name);
    if (this.failAt.has(name) || (from !== undefined && n >= from)) throw new PlatformError(`synthetic failure in ${name}`);
  }

  async log(event: Record<string, unknown>) {
    this.events.push(event);
  }
  async currentRelease() {
    return this.current;
  }
  async findRelease(id: string) {
    return this.releases.get(id);
  }
  async serviceLoaded() {
    return this.loaded;
  }
  async stopService() {
    this.hit('stopService');
    this.loaded = false;
  }
  async unloadService() {
    this.hit('unloadService');
    this.loaded = false;
    this.installed = false;
  }
  async startService(r: ReleaseRef) {
    this.hit(`startService:${r.id}`);
    this.loaded = true;
    this.installed = true;
  }
  async portBusy() {
    this.calls.push('portBusy');
    return this.busyPort;
  }
  async startDatabase(r: ReleaseRef | undefined) {
    this.hit(`startDatabase:${r?.id ?? 'own'}`);
    this.databaseOn = r?.id ?? 'own';
  }
  async stopDatabase(r: ReleaseRef | undefined) {
    this.hit(`stopDatabase:${r?.id ?? 'own'}`);
    this.databaseOn = undefined;
  }
  async backup(label: string, r: ReleaseRef | undefined) {
    this.hit(`backup:${label}:${r?.id ?? 'own'}`);
    const name = `${++this.count}-${label}`;
    this.backups.set(name, this.data);
    return name;
  }
  async verifyBackup(name: string) {
    this.hit('verifyBackup');
    if (!this.backups.has(name)) throw new PlatformError('校验不通过');
  }
  async prepareRelease() {
    this.hit('prepareRelease');
    return this.next;
  }
  async checkRelease(r: ReleaseRef) {
    this.hit(`checkRelease:${r.id}`);
  }
  async switchCurrent(r: ReleaseRef | undefined) {
    this.hit(`switchCurrent:${r?.id ?? 'none'}`);
    this.current = r;
  }
  async migrate(r: ReleaseRef) {
    this.hit(`migrate:${r.id}`);
    this.data = `data@${r.id}`;
  }
  async waitHealthy(r: ReleaseRef) {
    this.hit(`waitHealthy:${r.id}`);
  }
  async setAside(reason: string) {
    this.hit(`setAside:${reason}`);
    return `/data/set-aside/${reason}`;
  }
  async restore(name: string, r: ReleaseRef | undefined) {
    this.hit(`restore:${name}:${r?.id ?? 'own'}`);
    this.data = this.backups.get(name)!;
    this.databaseOn = r?.id ?? 'own';
  }
  async recordDeployment(entry: DeploymentEntry) {
    this.hit('record');
    this.history.push(entry);
  }
  async lastDeployment() {
    return this.history.at(-1);
  }
  async loadProgress() {
    return this.progress === undefined ? undefined : structuredClone(this.progress);
  }
  async saveProgress(progress: OperationProgress) {
    this.progress = OperationProgress.parse(structuredClone(progress));
    this.saved.push(this.progress);
  }
  async clearProgress() {
    this.progress = undefined;
  }
  interrupted() {
    return this.signal;
  }
}

const now = () => new Date('2026-10-21T12:00:00Z');
const hintOf = (error: unknown) => String((error as PlatformError).hint);
const after = (host: FakeHost, call: string) => host.calls.slice(host.calls.lastIndexOf(call) + 1);

describe('deploy flow', () => {
  test('success: build and check while the Hub runs, then stop, backup, switch, migrate, start, health, record', async () => {
    const host = new FakeHost(V1);
    const report = await runDeploy(host, now);
    assert.deepEqual(host.calls, [
      'prepareRelease',
      `checkRelease:${V2.id}`,
      'stopService',
      'portBusy',
      `startDatabase:${V1.id}`,
      `backup:pre-deploy:${V1.id}`,
      `stopDatabase:${V1.id}`,
      `switchCurrent:${V2.id}`,
      `startDatabase:${V2.id}`,
      `migrate:${V2.id}`,
      `startService:${V2.id}`,
      `waitHealthy:${V2.id}`,
      'record',
    ]);
    assert.deepEqual(report, { release: V2.id, previous: V1.id, backup: '1-pre-deploy', steps: report.steps });
    assert.equal(report.steps.length, 13);
    assert.deepEqual(host.history, [{ at: '2026-10-21T12:00:00.000Z', release: V2.id, previous: V1.id, backup: '1-pre-deploy' }], 'the backup is recorded by name');
    assert.equal(host.current, V2);
    assert.equal(host.data, `data@${V2.id}`);
    assert.deepEqual(host.events.at(-1), { event: 'deploy', phase: 'done', release: V2.id });
    assert.equal(host.saved[0]?.step, 'stop-service', 'the progress file exists before the first change');
    assert.ok(host.saved.some((p) => p.operation === 'deploy' && p.step === 'migrate' && p.data_touched && p.backup === '1-pre-deploy'));
    assert.equal(host.progress, undefined, 'and is removed at the end');
  });

  test('a failed health check restores the pre-deploy backup, points current back and restarts the previous release', async () => {
    const host = new FakeHost(V1);
    host.failAt.add(`waitHealthy:${V2.id}`);
    await assert.rejects(runDeploy(host, now), (error: unknown) => {
      assert.ok(error instanceof PlatformError);
      assert.match(error.message, /部署在“健康检查”这一步失败：synthetic failure/);
      assert.match(hintOf(error), /已恢复部署前备份 1-pre-deploy/);
      assert.match(hintOf(error), new RegExp(`current 已指回 ${V1.id}`));
      assert.match(hintOf(error), new RegExp(`上一版 ${V1.id} 已重新运行`));
      return true;
    });
    assert.deepEqual(after(host, `waitHealthy:${V2.id}`), [
      'stopService',
      `stopDatabase:${V2.id}`,
      'setAside:failed-deploy',
      `restore:1-pre-deploy:${V1.id}`,
      `switchCurrent:${V1.id}`,
      `startService:${V1.id}`,
      `waitHealthy:${V1.id}`,
    ]);
    assert.equal(host.data, 'data@v1', 'the migration was undone');
    assert.equal(host.current, V1);
    assert.equal(host.databaseOn, V1.id);
    assert.deepEqual(host.history, [], 'a failed deploy is not recorded as a deployment');
    assert.equal(host.progress, undefined, 'a completed recovery leaves nothing to finish');
    assert.ok(host.events.some((event) => event.event === 'deploy' && event.phase === 'failed' && event.step === 'health'));
    assert.ok(host.events.some((event) => event.recovery === 'restore' && event.ok === true));
  });

  test('a failed migration is undone the same way', async () => {
    const host = new FakeHost(V1);
    host.failAt.add(`migrate:${V2.id}`);
    await assert.rejects(runDeploy(host, now), /“迁移”这一步失败/);
    assert.ok(host.calls.includes(`restore:1-pre-deploy:${V1.id}`));
    assert.equal(host.current, V1);
  });

  test('a failed build or check stops nothing: the Hub keeps running and nothing is restarted', async () => {
    for (const failing of ['prepareRelease', `checkRelease:${V2.id}`]) {
      const host = new FakeHost(V1);
      host.failAt.add(failing);
      await assert.rejects(runDeploy(host, now), (error: unknown) => {
        assert.match((error as Error).message, failing === 'prepareRelease' ? /“准备发布”这一步失败/ : /“检查发布”这一步失败/);
        assert.match(hintOf(error), /还没有改动任何东西/);
        return true;
      });
      assert.deepEqual(host.calls, failing === 'prepareRelease' ? ['prepareRelease'] : ['prepareRelease', `checkRelease:${V2.id}`]);
      assert.equal(host.loaded, true, 'the service was never stopped');
      assert.equal(host.progress, undefined);
      assert.equal(host.saved.length, 0);
    }
  });

  test('a failure after the database was stopped for the switch restarts it on the previous binaries', async () => {
    const host = new FakeHost(V1);
    host.failAt.add(`startDatabase:${V2.id}`);
    await assert.rejects(runDeploy(host, now), /用新发布启动数据库/);
    assert.ok(!host.calls.some((call) => call.startsWith('restore')));
    assert.deepEqual(after(host, `startDatabase:${V2.id}`), ['stopService', `switchCurrent:${V1.id}`, `startDatabase:${V1.id}`, `startService:${V1.id}`, `waitHealthy:${V1.id}`]);
  });

  test('a deployment that cannot be recorded is undone too, and named as such', async () => {
    const host = new FakeHost(V1);
    host.failAt.add('record');
    await assert.rejects(runDeploy(host, now), /“记录部署”这一步失败/);
    assert.ok(host.calls.includes(`restore:1-pre-deploy:${V1.id}`));
    assert.equal(host.current, V1);
  });

  test('a busy port stops the deploy before any data or current changes', async () => {
    const host = new FakeHost(V1);
    host.busyPort = true;
    await assert.rejects(runDeploy(host, now), /端口仍有进程应答/);
    assert.ok(!host.calls.some((call) => call.startsWith('backup') || call.startsWith('switchCurrent') || call.startsWith('migrate')));
    assert.equal(host.data, 'data@v1');
    assert.equal(host.current, V1);
  });

  test('a failed first deploy removes current and leaves the service stopped', async () => {
    const host = new FakeHost(undefined, false);
    host.failAt.add(`waitHealthy:${V2.id}`);
    await assert.rejects(runDeploy(host, now), (error: unknown) => {
      assert.match(hintOf(error), /已移除 current/);
      return true;
    });
    assert.ok(host.calls.includes('restore:1-pre-deploy:own'));
    assert.equal(host.current, undefined);
    assert.ok(!after(host, `waitHealthy:${V2.id}`).some((call) => call.startsWith('startService')));
  });

  test('when the restore itself fails the service is unloaded for good and the next deploy finishes the recovery', async () => {
    const host = new FakeHost(V1);
    host.failAt.add(`waitHealthy:${V2.id}`);
    host.failAt.add(`restore:1-pre-deploy:${V1.id}`);
    await assert.rejects(runDeploy(host, now), (error: unknown) => {
      const hint = hintOf(error);
      assert.match(hint, /恢复备份失败/);
      assert.match(hint, /服务已卸下（服务定义已删除，下次登录也不会启动）/);
      assert.match(hint, /数据没有恢复；部署前备份是 1-pre-deploy/);
      assert.match(hint, /运行 circle-hub deploy 或 circle-hub rollback，它们会先完成这次恢复/);
      return true;
    });
    const recovery = after(host, `waitHealthy:${V2.id}`);
    assert.ok(!recovery.some((call) => call.startsWith('startService')));
    assert.ok(recovery.includes(`switchCurrent:${V1.id}`));
    assert.ok(recovery.includes('unloadService'));
    assert.equal(host.installed, false, 'not even the next login starts it');
    assert.equal(host.progress?.operation, 'deploy');
    assert.equal(host.progress?.operation === 'deploy' && host.progress.recovery_failed, true);

    host.failAt.clear();
    host.calls = [];
    await assert.rejects(runDeploy(host, now), (error: unknown) => {
      assert.match((error as Error).message, new RegExp(`上次部署（发布 ${V2.id}）在“健康检查”这一步中断，已完成恢复`));
      assert.match(hintOf(error), /现在可以重新运行 circle-hub deploy/);
      return true;
    });
    assert.ok(!host.calls.includes('prepareRelease'), 'no new deploy starts while recovering');
    assert.ok(host.calls.includes(`restore:1-pre-deploy:${V1.id}`));
    assert.equal(host.data, 'data@v1');
    assert.equal(host.current, V1);
    assert.equal(host.loaded, true, 'the previous release runs again');
    assert.equal(host.progress, undefined);
  });

  test('when the service cannot be stopped during recovery, data and current stay as they are', async () => {
    const host = new FakeHost(V1);
    host.failAt.add(`waitHealthy:${V2.id}`);
    host.failFrom.set('stopService', 2);
    await assert.rejects(runDeploy(host, now), (error: unknown) => {
      assert.match(hintOf(error), /停止服务失败/);
      assert.match(hintOf(error), new RegExp(`发布 ${V2.id} 可能还在运行（launchd 会重启它），所以没有动数据和 current`));
      assert.doesNotMatch(hintOf(error), /已重新运行|已恢复/);
      return true;
    });
    assert.deepEqual(after(host, `waitHealthy:${V2.id}`), ['stopService'], 'no database stop, set-aside, restore or switch');
    assert.equal(host.current, V2);
    assert.equal(host.progress?.operation, 'deploy', 'kept for the next run');

    host.failFrom.clear();
    host.calls = [];
    await assert.rejects(runDeploy(host, now), /已完成恢复/);
    assert.deepEqual(host.calls, [
      'stopService',
      `stopDatabase:${V2.id}`,
      'setAside:failed-deploy',
      `restore:1-pre-deploy:${V1.id}`,
      `switchCurrent:${V1.id}`,
      `startService:${V1.id}`,
      `waitHealthy:${V1.id}`,
    ]);
    assert.equal(host.data, 'data@v1');
    assert.equal(host.progress, undefined);
  });

  test('a stop failure before anything moved changes nothing and leaves the running service alone', async () => {
    const host = new FakeHost(V1);
    host.failAt.add('stopService');
    await assert.rejects(runDeploy(host, now), (error: unknown) => {
      assert.match((error as Error).message, /“停止服务”这一步失败/);
      assert.match(hintOf(error), /服务保持原样；数据与 current 都没有改动/);
      return true;
    });
    assert.ok(!host.calls.some((call) => call.startsWith('startService') || call.startsWith('backup')));
    assert.equal(host.progress, undefined);
  });

  test('a data root whose pinned application role the migration cannot grant is refused before anything runs', async () => {
    const root = await tempDir();
    try {
      const layout = layoutAt(root);
      await ensureLayout(layout);
      // Written by an earlier platform version, before init refused such names.
      const file = newSettingsFile({ environment: 'test' });
      await writeFile(settingsPath(layout), JSON.stringify({ ...file, database: { ...file.database, role: 'hub-app' } }));
      const { runner, calls } = recordingRunner(() => undefined, { real: false });
      const context = createContext({}, { layout, home: root, runner, launchAgentsDir: join(root, 'agents') });
      const host = new FakeHost(V1);
      await assert.rejects(deploy(context, { path: root }, host), (error: unknown) => {
        assert.match((error as Error).message, /^部署设置里的应用角色名 hub-app 不符合要求，不部署：/);
        assert.match(hintOf(error), /ALTER ROLE "hub-app" RENAME TO hub_app/);
        return true;
      });
      assert.deepEqual(host.calls, [], 'the host was never asked to do anything');
      assert.deepEqual(calls, []);
      assert.equal(existsSync(join(layout.run, 'platform.lock')), false, 'not even the lock was taken');
    } finally {
      await removeDir(root);
    }
  });

  test('settings that give the vault master key the operator token\'s account are refused before anything runs, by deploy and by rollback', async () => {
    const root = await tempDir();
    try {
      const layout = layoutAt(root);
      await ensureLayout(layout);
      // Edited by hand, or written by an earlier platform version's init with CIRCLE_HUB_KEYCHAIN_ACCOUNT=operator-token:
      // serve refuses it, so a deploy could only fail after the service stopped, and a rollback after the data moved.
      await writeFile(settingsPath(layout), JSON.stringify({ ...newSettingsFile({ environment: 'test' }), keychain_account: OPERATOR_TOKEN_ACCOUNT }));
      const { runner, calls } = recordingRunner(() => undefined, { real: false });
      const context = createContext({}, { layout, home: root, runner, launchAgentsDir: join(root, 'agents') });
      const deploying = new FakeHost(V1);
      // A recorded deploy with its backup: the rollback would otherwise go ahead.
      const rollingBack = new FakeHost(V2);
      rollingBack.backups.set('1-pre-deploy', 'data@v1');
      rollingBack.history.push({ at: now().toISOString(), release: V2.id, previous: V1.id, backup: '1-pre-deploy' });
      for (const [host, operation] of [
        [deploying, () => deploy(context, { path: root }, deploying)],
        [rollingBack, () => rollback(context, rollingBack)],
      ] as const) {
        await assert.rejects(operation(), (error: unknown) => {
          assert.equal((error as Error).message, `部署设置（${settingsPath(layout)}）里密钥库主密钥的钥匙串账户是 operator-token：这个账户留给操作令牌，两者会成为同一个钥匙串项，不执行`);
          assert.match(hintOf(error), /^把部署设置里的 keychain_account 改成另一个名字（例如 vault-master-key）/);
          return true;
        });
        assert.deepEqual(host.calls, [], 'the host was never asked to do anything');
        assert.deepEqual(host.saved, [], 'no progress was recorded');
      }
      assert.deepEqual(calls, []);
      assert.equal(existsSync(join(layout.run, 'platform.lock')), false, 'not even the lock was taken');
    } finally {
      await removeDir(root);
    }
  });

  test('deploying the release that is already current is refused before anything stops', async () => {
    const host = new FakeHost(V1);
    host.next = V1;
    await assert.rejects(runDeploy(host, now), (error: unknown) => {
      assert.match((error as Error).message, new RegExp(`发布 ${V1.id} 就是当前发布，不重复部署`));
      assert.match(hintOf(error), /service stop/);
      return true;
    });
    assert.deepEqual(host.calls, ['prepareRelease']);
    assert.deepEqual(host.history, []);
  });

  test('a signal lets the running step finish, then the deploy stops and recovers', async () => {
    const host = new FakeHost(V1);
    host.signalDuring = `switchCurrent:${V2.id}`;
    await assert.rejects(runDeploy(host, now), (error: unknown) => {
      assert.match((error as Error).message, /部署被 SIGINT 中断（“切换 current”这一步已完成）/);
      assert.match(hintOf(error), new RegExp(`current 已指回 ${V1.id}`));
      return true;
    });
    assert.ok(!host.calls.includes(`migrate:${V2.id}`), 'no step starts after the signal');
    assert.deepEqual(after(host, `switchCurrent:${V2.id}`), ['stopService', `switchCurrent:${V1.id}`, `startDatabase:${V1.id}`, `startService:${V1.id}`, `waitHealthy:${V1.id}`]);
    assert.equal(host.progress, undefined);
  });

  test('a signal during the build stops before anything changes', async () => {
    const host = new FakeHost(V1);
    host.signalDuring = 'prepareRelease';
    await assert.rejects(runDeploy(host, now), (error: unknown) => {
      assert.match((error as Error).message, /部署被 SIGINT 中断（“准备发布”这一步已完成）/);
      assert.match(hintOf(error), /还没有改动任何东西/);
      return true;
    });
    assert.deepEqual(host.calls, ['prepareRelease']);
  });

  test('a deploy left unfinished by a dead process is undone by the next deploy, which then stops', async () => {
    const host = new FakeHost(V2);
    host.backups.set('1-pre-deploy', 'data@v1');
    host.data = `data@${V2.id}`;
    host.loaded = false;
    host.progress = OperationProgress.parse({
      schema: 'circle-hub-operation@1',
      operation: 'deploy',
      started_at: '2026-10-21T11:00:00.000Z',
      step: 'migrate',
      release: V2.id,
      previous: V1.id,
      backup: '1-pre-deploy',
      service_was_loaded: true,
      data_touched: true,
    });
    await assert.rejects(runDeploy(host, now), (error: unknown) => {
      assert.match((error as Error).message, new RegExp(`上次部署（发布 ${V2.id}）在“迁移”这一步中断，已完成恢复`));
      return true;
    });
    assert.deepEqual(host.calls, [
      'stopService',
      `stopDatabase:${V2.id}`,
      'setAside:failed-deploy',
      `restore:1-pre-deploy:${V1.id}`,
      `switchCurrent:${V1.id}`,
      `startService:${V1.id}`,
      `waitHealthy:${V1.id}`,
    ]);
    assert.equal(host.data, 'data@v1');
    assert.equal(host.current, V1);
    assert.equal(host.progress, undefined);
  });

  test('an unfinished deploy that had in fact been recorded is only cleared; a rollback then undoes a dead deploy', async () => {
    const done = new FakeHost(V2);
    done.history.push({ at: '2026-10-21T11:00:00.000Z', release: V2.id, previous: V1.id, backup: '1-pre-deploy' });
    done.progress = OperationProgress.parse({
      schema: 'circle-hub-operation@1',
      operation: 'deploy',
      started_at: '2026-10-21T11:00:00.000Z',
      step: 'record',
      release: V2.id,
      previous: V1.id,
      backup: '1-pre-deploy',
      service_was_loaded: true,
      data_touched: true,
    });
    await assert.rejects(runDeploy(done, now), /其实已经完成并记录，这次什么也没做/);
    assert.deepEqual(done.calls, []);
    assert.equal(done.progress, undefined);

    const dead = new FakeHost(V1);
    dead.progress = OperationProgress.parse({
      schema: 'circle-hub-operation@1',
      operation: 'deploy',
      started_at: '2026-10-21T11:00:00.000Z',
      step: 'backup',
      release: V2.id,
      previous: V1.id,
      service_was_loaded: true,
      data_touched: false,
    });
    await assert.rejects(runRollback(dead, now), (error: unknown) => {
      assert.match((error as Error).message, /已完成恢复/);
      assert.match(hintOf(error), /已回到这次部署之前的发布与数据，没有再回滚/);
      return true;
    });
    assert.deepEqual(dead.calls, ['stopService', `startDatabase:${V1.id}`, `startService:${V1.id}`, `waitHealthy:${V1.id}`], 'no data was touched, so none is restored');
  });

  test('a deploy is refused while a rollback is unfinished', async () => {
    const host = new FakeHost(V1);
    host.progress = OperationProgress.parse({
      schema: 'circle-hub-operation@1',
      operation: 'rollback',
      started_at: '2026-10-21T11:00:00.000Z',
      step: 'restore',
      from: V2.id,
      to: V1.id,
      target_backup: '1-pre-deploy',
      safety: '2-pre-rollback',
      service_was_loaded: true,
      data_moved: true,
    });
    await assert.rejects(runDeploy(host, now), (error: unknown) => {
      assert.match((error as Error).message, /上次回滚.*在“恢复备份”这一步没有完成/);
      assert.match(hintOf(error), /先运行 circle-hub rollback/);
      return true;
    });
    assert.deepEqual(host.calls, []);
  });
});

describe('rollback flow', () => {
  const deployed = async () => {
    const host = new FakeHost(V1);
    await runDeploy(host, now);
    host.calls = [];
    host.saved = [];
    return host;
  };

  test('rollback restores the backup taken before the last deploy and runs the previous release', async () => {
    const host = await deployed();
    const report = await runRollback(host, now);
    assert.deepEqual(host.calls, [
      'verifyBackup',
      'stopService',
      `startDatabase:${V2.id}`,
      `backup:pre-rollback:${V2.id}`,
      `stopDatabase:${V2.id}`,
      'setAside:rollback',
      `restore:1-pre-deploy:${V1.id}`,
      `switchCurrent:${V1.id}`,
      `startService:${V1.id}`,
      `waitHealthy:${V1.id}`,
      'record',
    ]);
    assert.deepEqual(report, { release: V1.id, previous: V2.id, backup: '2-pre-rollback', steps: report.steps });
    assert.equal(host.data, 'data@v1');
    assert.equal(host.current, V1);
    assert.deepEqual(host.history.at(-1), { at: '2026-10-21T12:00:00.000Z', release: V1.id, previous: V2.id, backup: '2-pre-rollback', rollback: true });
    assert.ok(host.saved.some((p) => p.operation === 'rollback' && p.data_moved && p.safety === '2-pre-rollback'));
    assert.equal(host.progress, undefined);
  });

  test('rollback is refused without a recorded deploy with a previous release, or with a bad backup, before any change', async () => {
    await assert.rejects(runRollback(new FakeHost(undefined), now), /还没有部署过/);
    await assert.rejects(runRollback(new FakeHost(V1), now), /找不到把当前发布/);
    const first = new FakeHost(undefined, false);
    await runDeploy(first, now);
    await assert.rejects(runRollback(first, now), /找不到把当前发布/);
    const host = await deployed();
    host.backups.clear();
    await assert.rejects(runRollback(host, now), /校验不通过/);
    assert.deepEqual(host.calls, ['verifyBackup']);
    host.releases.delete(V1.id);
    await assert.rejects(runRollback(host, now), /已不在 releases/);
  });

  test('a record whose previous release is the current one (an old same-release redeploy) is not rolled back', async () => {
    const host = new FakeHost(V2);
    host.backups.set('1-pre-deploy', 'data@v1');
    host.history.push({ at: '2026-10-21T11:00:00.000Z', release: V2.id, previous: V2.id, backup: '1-pre-deploy' });
    await assert.rejects(runRollback(host, now), /同一个发布部署了两次/);
    assert.deepEqual(host.calls, []);
    assert.equal(host.current, V2);
  });

  test('a rollback that fails before the data moved restarts the current release with its data unchanged', async () => {
    const host = await deployed();
    host.failAt.add(`backup:pre-rollback:${V2.id}`);
    await assert.rejects(runRollback(host, now), (error: unknown) => {
      assert.match((error as Error).message, /回滚在“备份”这一步失败/);
      assert.match(hintOf(error), /已重新运行，数据没有改动/);
      return true;
    });
    assert.equal(host.current, V2);
    assert.equal(host.progress, undefined);
  });

  for (const failing of ['restore', 'switch-current', 'start-service', 'health', 'record'] as const) {
    test(`a rollback failing at ${failing} stops and unloads the service, says so, and the next rollback finishes it`, async () => {
      const host = await deployed();
      const call = { restore: `restore:1-pre-deploy:${V1.id}`, 'switch-current': `switchCurrent:${V1.id}`, 'start-service': `startService:${V1.id}`, health: `waitHealthy:${V1.id}`, record: 'record' }[failing];
      host.failAt.add(call);
      await assert.rejects(runRollback(host, now), (error: unknown) => {
        const hint = hintOf(error);
        assert.match(hint, /服务已停止并卸下（服务定义已删除，下次登录也不会启动）/);
        assert.match(hint, /回滚前的数据在 \/data\/set-aside\/rollback/);
        assert.match(hint, /回滚前的备份是 2-pre-rollback/);
        assert.match(hint, /再运行 circle-hub rollback，它从这里继续完成回滚/);
        return true;
      });
      assert.equal(after(host, call)[0], 'unloadService', 'the service is stopped right after the failure');
      assert.equal(host.loaded, false);
      assert.equal(host.installed, false);
      assert.equal(host.progress?.operation === 'rollback' && host.progress.data_moved, true, 'kept for the next run');

      host.failAt.clear();
      host.calls = [];
      const report = await runRollback(host, now);
      assert.deepEqual(host.calls, [
        'verifyBackup',
        'stopService',
        `stopDatabase:${V1.id}`,
        'setAside:rollback-retry',
        `restore:1-pre-deploy:${V1.id}`,
        `switchCurrent:${V1.id}`,
        `startService:${V1.id}`,
        `waitHealthy:${V1.id}`,
        'record',
      ]);
      assert.deepEqual(report, { release: V1.id, previous: V2.id, backup: '2-pre-rollback', steps: report.steps });
      assert.equal(host.data, 'data@v1');
      assert.equal(host.current, V1);
      assert.equal(host.history.filter((entry) => entry.rollback).length, 1);
      assert.equal(host.progress, undefined);
    });
  }

  test('a rollback whose service cannot be stopped after a late failure never claims it is stopped', async () => {
    const host = await deployed();
    host.failAt.add(`waitHealthy:${V1.id}`);
    host.failAt.add('unloadService');
    await assert.rejects(runRollback(host, now), (error: unknown) => {
      const hint = hintOf(error);
      assert.match(hint, /服务可能还在运行（launchd 会重启它）：先运行 circle-hub service stop/);
      assert.doesNotMatch(hint, /服务已停止|服务保持停止/);
      return true;
    });
  });

  test('a rollback left unfinished before its data moved is started again from the beginning', async () => {
    const host = await deployed();
    host.progress = OperationProgress.parse({
      schema: 'circle-hub-operation@1',
      operation: 'rollback',
      started_at: '2026-10-21T11:00:00.000Z',
      step: 'backup',
      from: V2.id,
      to: V1.id,
      target_backup: '1-pre-deploy',
      service_was_loaded: true,
      data_moved: false,
    });
    const report = await runRollback(host, now);
    assert.equal(report.release, V1.id);
    assert.equal(host.calls[0], 'verifyBackup');
    assert.ok(host.calls.includes(`backup:pre-rollback:${V2.id}`));
    assert.equal(host.progress, undefined);
  });

  test('a signal during a rollback after its data moved stops it; the next rollback completes it', async () => {
    const host = await deployed();
    host.signalDuring = 'setAside:rollback';
    await assert.rejects(runRollback(host, now), /回滚被 SIGINT 中断（“移开当前数据”这一步已完成）/);
    assert.ok(!host.calls.some((call) => call.startsWith('restore')));
    assert.equal(host.progress?.operation, 'rollback');
    host.signal = undefined;
    host.signalDuring = undefined;
    const report = await runRollback(host, now);
    assert.equal(report.release, V1.id);
    assert.equal(host.current, V1);
    assert.equal(host.data, 'data@v1');
  });
});

describe('signal guard', () => {
  test('while held, SIGINT does not end the process and is recorded once; released, the listeners are gone', async () => {
    const before = process.listenerCount('SIGINT');
    const beforeTerm = process.listenerCount('SIGTERM');
    const lines: string[] = [];
    const guard = guardSignals((line) => lines.push(line));
    try {
      assert.equal(guard.received(), undefined);
      process.kill(process.pid, 'SIGINT');
      for (let n = 0; n < 100 && guard.received() === undefined; n++) await delay(10);
      assert.equal(guard.received(), 'SIGINT');
      process.kill(process.pid, 'SIGTERM');
      for (let n = 0; n < 100 && lines.length < 2; n++) await delay(10);
      assert.equal(guard.received(), 'SIGINT', 'the first signal is the one reported');
      assert.match(lines[0] ?? '', /等当前这一步做完就停下并恢复/);
      assert.match(lines[1] ?? '', /正在停下并恢复/);
    } finally {
      guard.release();
    }
    assert.equal(process.listenerCount('SIGINT'), before);
    assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
  });
});
