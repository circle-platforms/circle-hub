import type { PendingInputResponse } from "@infosec/contracts";
import {
  FakeClock,
  IdGen,
  LeaseManager,
  OperationService,
  Registry,
  TaskService,
  iso,
} from "@infosec/platform";
import { SiteClient } from "./client.js";
import { WebLoginDriver, type LoginStepResult } from "./driver.js";
import { TestSite, WRONG_PASSWORD } from "./site.js";

/**
 * The four SMP-V03-02 scenario scripts against a real local HTTP test
 * site (SMP-V03-01). The harness plays the human: it answers credential
 * and MFA pending inputs, taking MFA codes from the site's out-of-band
 * simulator only.
 */
export interface ScenarioResult {
  id: string;
  checks: { name: string; passed: boolean }[];
}

export interface Stack {
  clock: FakeClock;
  ids: IdGen;
  tasks: TaskService;
  site: TestSite;
  client: SiteClient;
  driver: WebLoginDriver;
  taskId: string;
}

export async function makeStack(): Promise<Stack> {
  const clock = new FakeClock(1_700_000_000_000);
  const ids = new IdGen();
  const leases = new LeaseManager(clock, ids);
  const ops = new OperationService(clock, ids, leases);
  const registry = new Registry(clock, ids);
  void registry;
  const tasks = new TaskService(clock, ids);
  const site = new TestSite(clock);
  await site.start();
  const client = new SiteClient(site.baseUrl);
  const driver = new WebLoginDriver({
    client,
    tasks,
    ops,
    ids,
    ctx: {
      tenantId: "tnt_main",
      scopeId: "scp_demo_a",
      principalId: "prn_alice",
      runId: "run_000001",
    },
  });
  const task = tasks.createTask({
    tenantId: "tnt_main",
    scopeId: "scp_demo_a",
    principalId: "prn_alice",
    title: "本地测试站登录操作",
  });
  tasks.transition(task.taskId, "admitted");
  tasks.transition(task.taskId, "running");
  return { clock, ids, tasks, site, client, driver, taskId: task.taskId };
}

export async function disposeStack(s: Stack): Promise<void> {
  await s.site.stop();
}

function respondWith(
  s: Stack,
  requestId: string,
  inputRevisionId: string,
  decision: unknown,
  key: string,
): PendingInputResponse {
  return {
    requestId,
    inputRevisionId,
    actorId: "act_000001",
    decision,
    respondedAt: iso(s.clock.now()),
    idempotencyKey: key,
  };
}

let attemptSeq = 0;

/** One full credential cycle: request -> human decision -> submit. */
export async function attemptLogin(
  s: Stack,
  username: string,
  password: string,
): Promise<LoginStepResult> {
  attemptSeq += 1;
  const pending = s.driver.beginCredentialRequest(s.taskId);
  if (!pending.ok) throw new Error("credential request failed");
  const task = s.tasks.get(s.taskId);
  if (!task) throw new Error("task missing");
  const result = await s.driver.submitCredentials(
    s.taskId,
    respondWith(
      s,
      pending.value.requestId,
      task.inputRevisionId,
      { username, password },
      `cred-${attemptSeq}`,
    ),
  );
  if (!result.ok) throw new Error(`credential submit failed: ${result.error.code}`);
  return result.value;
}

export async function submitMfaFromSimulator(s: Stack): Promise<LoginStepResult> {
  const sessionId = s.site.sessionIdForCookie(s.client.cookie);
  const code = sessionId ? s.site.simulatorMfaCode(sessionId) : undefined;
  if (!code) throw new Error("simulator has no code for this session");
  const pending = s.driver.beginMfaRequest(s.taskId);
  if (!pending.ok) throw new Error("mfa request failed");
  const task = s.tasks.get(s.taskId);
  if (!task) throw new Error("task missing");
  const result = await s.driver.submitMfa(
    s.taskId,
    respondWith(s, pending.value.requestId, task.inputRevisionId, { code }, `mfa-${attemptSeq}`),
  );
  if (!result.ok) throw new Error("mfa submit failed");
  return result.value;
}

async function scenarioS1(): Promise<ScenarioResult> {
  const s = await makeStack();
  const checks: { name: string; passed: boolean }[] = [];
  const t = (name: string, passed: boolean) => checks.push({ name, passed });
  try {
    const result = await attemptLogin(s, "acct_ok", WRONG_PASSWORD);
    t("分类为凭据错误（不是目标不可达）", result.classification === "credential-error");
    t(
      "失败计数可见递增（=1）",
      result.failCount === 1 && s.site.failCount("acct_ok") === 1,
    );
    const home = await s.driver.openHome();
    t("不得把错误提示误报为登录成功", home.classification === "session-expired");
  } finally {
    await disposeStack(s);
  }
  return { id: "web-s1-wrong-password", checks };
}

async function scenarioS2(): Promise<ScenarioResult> {
  const s = await makeStack();
  const checks: { name: string; passed: boolean }[] = [];
  const t = (name: string, passed: boolean) => checks.push({ name, passed });
  try {
    const classifications: string[] = [];
    for (let i = 0; i < 5; i++) {
      classifications.push((await attemptLogin(s, "acct_ok", WRONG_PASSWORD)).classification);
    }
    t(
      "前 4 次为凭据错误、第 5 次进入锁定态并报告 locked",
      classifications.slice(0, 4).every((c) => c === "credential-error") &&
        classifications[4] === "locked",
    );
    t("站点侧账号处于锁定", s.site.isLocked("acct_ok"));
    const correctWhileLocked = await attemptLogin(s, "acct_ok", "test-pwd-correct");
    t(
      "锁定期间即使口令正确也不声称可登录（仍为 locked）",
      correctWhileLocked.classification === "locked",
    );
    t(
      "locked 分类与凭据错误分类可区分",
      classifications[4] !== classifications[0],
    );
  } finally {
    await disposeStack(s);
  }
  return { id: "web-s2-lockout", checks };
}

async function scenarioS3(): Promise<ScenarioResult> {
  const s = await makeStack();
  const checks: { name: string; passed: boolean }[] = [];
  const t = (name: string, passed: boolean) => checks.push({ name, passed });
  try {
    const login = await attemptLogin(s, "acct_ok", "test-pwd-correct");
    t("正确口令后进入 MFA 等待", login.classification === "awaiting-mfa");
    const pending = s.driver.beginMfaRequest(s.taskId);
    t("MFA 待输入已建立（敏感通道）", pending.ok && s.driver.usedSensitiveChannel);
    s.clock.advance(61_000);
    const polled = await s.driver.pollMfaPage();
    t("超时被分类为 MFA 超时（不是码错误）", polled.classification === "mfa-timeout");
    const home = await s.driver.openHome();
    t("原会话作废，回到 /login", home.classification === "session-expired" && s.site.activeSessionCount() === 0);
    // A late human response is rejected as expired, and the task is
    // closed out (cancelled) instead of waiting forever.
    const task = s.tasks.get(s.taskId);
    if (!pending.ok || !task) throw new Error("pending/task missing");
    const late = s.tasks.respond(
      s.taskId,
      respondWith(s, pending.value.requestId, task.inputRevisionId, { code: "000000" }, "mfa-late-1"),
    );
    t(
      "迟到的 MFA 响应按待输入过期规则被拒",
      late.ok && late.value.outcome === "expired",
    );
    const closed = s.tasks.transition(s.taskId, "cancelled");
    t("任务按超时收束（cancelled），不无限等待", closed.ok && s.tasks.get(s.taskId)?.phase === "cancelled");
  } finally {
    await disposeStack(s);
  }
  return { id: "web-s3-mfa-timeout", checks };
}

async function scenarioS4(): Promise<ScenarioResult> {
  const s = await makeStack();
  const checks: { name: string; passed: boolean }[] = [];
  const t = (name: string, passed: boolean) => checks.push({ name, passed });
  try {
    const login = await attemptLogin(s, "acct_nomfa", "test-pwd-nomfa");
    t("登录成功", login.classification === "logged-in");
    s.client.saveCookie();
    await s.driver.logout();
    t("登出后站点无活动会话", s.site.activeSessionCount() === 0);
    s.client.restoreSavedCookie();
    const home = await s.driver.openHome();
    t(
      "旧 cookie 访问 /home 被重定向回 /login（会话已失效）",
      home.classification === "session-expired",
    );
    s.client.discardSavedCookie();
    t(
      "清理：旧 cookie 已丢弃并记录",
      s.client.cookie === undefined,
    );
  } finally {
    await disposeStack(s);
  }
  return { id: "web-s4-session-residue", checks };
}

export async function runAllScenarios(): Promise<ScenarioResult[]> {
  return [
    await scenarioS1(),
    await scenarioS2(),
    await scenarioS3(),
    await scenarioS4(),
  ];
}
