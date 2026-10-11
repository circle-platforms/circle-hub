import {
  FakeClock,
  IdGen,
  LeaseManager,
  OperationService,
  Registry,
} from "@infosec/platform";
import { ApvFixture } from "./fixture.js";
import { ApvDriver } from "./driver.js";

/**
 * The four SMP-V02-02 scenario scripts, executed against fresh fixture
 * + platform stacks. Each returns named checks mirroring the sample's
 * "expect" lines so failures point at the exact expectation.
 */
export interface ScenarioResult {
  id: string;
  checks: { name: string; passed: boolean }[];
}

const BASELINE = { "vs.web": "profile=baseline" };
const NEW_VALUE = "profile=upgraded";

export function makeStack() {
  const clock = new FakeClock(1_700_000_000_000);
  const ids = new IdGen();
  const leases = new LeaseManager(clock, ids);
  const ops = new OperationService(clock, ids, leases);
  const registry = new Registry(clock, ids);
  const fixture = new ApvFixture();
  const driver = new ApvDriver({
    fixture,
    ops,
    registry,
    ids,
    ctx: {
      tenantId: "tnt_main",
      scopeId: "scp_demo_a",
      principalId: "prn_alice",
      runId: "run_000001",
    },
  });
  return { clock, ids, ops, registry, fixture, driver };
}

function scenarioS1(): ScenarioResult {
  const { fixture, driver } = makeStack();
  const checks: { name: string; passed: boolean }[] = [];
  const t = (name: string, passed: boolean) => checks.push({ name, passed });

  t("open 会话成功", driver.openSession().ok);
  const base = driver.readConfig("vs.web");
  t("read 基线配置版本 = 1", base.ok && base.value.configVersion === 1);
  t("stage 一项变更成功", driver.stageChange("vs.web", NEW_VALUE).ok);
  const beforeCommit = driver.readConfig("vs.web");
  t(
    "commit 前设备配置不变（stage 不生效）",
    beforeCommit.ok && beforeCommit.value.value === "profile=baseline",
  );
  const commit = driver.commitChange();
  t("commit 成功", commit.ok && commit.value.outcome === "committed");
  const after = driver.readConfig("vs.web");
  t(
    "commit 后生效且版本递增一次（v2）",
    after.ok && after.value.value === NEW_VALUE && after.value.configVersion === 2,
  );
  t("rollback 成功", driver.rollback(1).ok);
  const rolled = driver.readConfig("vs.web");
  t("回滚后内容与基线一致", rolled.ok && rolled.value.value === "profile=baseline");
  t("close 会话成功", driver.closeSession().ok);
  const clean = driver.verifyClean(BASELINE);
  t(
    "清理核验：无会话残留、无暂存残留、配置与基线一致",
    !clean.sessionResidue && !clean.stagedResidue && clean.configMatchesBaseline,
  );
  void fixture;
  return { id: "apv-s1-normal-change", checks };
}

function scenarioS2(): ScenarioResult {
  const { fixture, driver, ops } = makeStack();
  const checks: { name: string; passed: boolean }[] = [];
  const t = (name: string, passed: boolean) => checks.push({ name, passed });

  fixture.arm("INJ-APV-1");
  t("open 会话成功", driver.openSession().ok);
  t("read 基线成功", driver.readConfig("vs.web").ok);
  t("stage 成功", driver.stageChange("vs.web", NEW_VALUE).ok);
  const commit = driver.commitChange();
  t(
    "commit 回执丢失后操作进 unknown",
    commit.ok &&
      commit.value.outcome === "unknown" &&
      commit.value.operationId !== undefined &&
      ops.get(commit.value.operationId)?.state === "unknown",
  );
  const opId = commit.ok ? commit.value.operationId : undefined;
  const reconciled = opId ? driver.reconcileCommit(opId) : { ok: false as const };
  t(
    "reconcile 按设备实际状态确认已生效",
    reconciled.ok && reconciled.value.applied === true,
  );
  t(
    "对账后操作定案 succeeded",
    opId !== undefined && ops.get(opId)?.state === "succeeded",
  );
  t("设备侧变更计数为 1（未盲目重提）", fixture.changeCount === 1);
  t("rollback 成功", driver.rollback(1).ok);
  t("close 会话成功", driver.closeSession().ok);
  const clean = driver.verifyClean(BASELINE);
  t(
    "清理核验：回滚到基线且一致、无残留",
    clean.configMatchesBaseline && !clean.sessionResidue && !clean.stagedResidue,
  );
  return { id: "apv-s2-receipt-loss", checks };
}

function scenarioS3(): ScenarioResult {
  const { fixture, driver } = makeStack();
  const checks: { name: string; passed: boolean }[] = [];
  const t = (name: string, passed: boolean) => checks.push({ name, passed });

  t("open 会话成功", driver.openSession().ok);
  const v = driver.readConfig("vs.web");
  t("read 配置版本 V=1", v.ok && v.value.configVersion === 1);
  fixture.externalAdvance("vs.web", "profile=external");
  const stage = driver.stageChange("vs.web", NEW_VALUE);
  t(
    "基于旧版本的 stage/commit 被拒为 conflict-stale",
    !stage.ok && stage.error.code === "INPUT_REVISION_STALE",
  );
  const snap = fixture.snapshotState();
  t(
    "设备配置保持外部推进后的状态（我方未变更）",
    snap.config["vs.web"] === "profile=external" && fixture.changeCount === 0,
  );
  t("close 会话成功", driver.closeSession().ok);
  const clean = driver.verifyClean({ "vs.web": "profile=external" });
  t("清理核验：无暂存残留、无会话残留", !clean.stagedResidue && !clean.sessionResidue);
  return { id: "apv-s3-version-conflict", checks };
}

function scenarioS4(): ScenarioResult {
  const { fixture, driver } = makeStack();
  const checks: { name: string; passed: boolean }[] = [];
  const t = (name: string, passed: boolean) => checks.push({ name, passed });

  const open = driver.openSession();
  t("open 会话并记录序列号", open.ok && open.value.serial === "EMU-SN-0001");
  t("read 配置成功", driver.readConfig("vs.web").ok);
  t("stage 一项变更", driver.stageChange("vs.web", NEW_VALUE).ok);
  fixture.arm("INJ-APV-3");
  const drifted = driver.readConfig("vs.web");
  t(
    "身份漂移被检出并以 TARGET_IDENTITY_MISMATCH 停手",
    !drifted.ok && drifted.error.code === "TARGET_IDENTITY_MISMATCH" && driver.halted,
  );
  t("漂移证据已登记", driver.driftEvidenceId !== undefined);
  const after = driver.commitChange();
  t("停手后 commit 被拒绝", !after.ok);
  const snap = fixture.snapshotState();
  t(
    "已暂存未提交的变更不生效（配置未变）",
    snap.config["vs.web"] === "profile=baseline" && fixture.changeCount === 0,
  );
  t("close 断开会话（安全动作）成功", driver.closeSession().ok);
  t("断开后无会话残留", !fixture.snapshotState().sessionActive);
  return { id: "apv-s4-identity-drift", checks };
}

export function runAllScenarios(): ScenarioResult[] {
  return [scenarioS1(), scenarioS2(), scenarioS3(), scenarioS4()];
}
