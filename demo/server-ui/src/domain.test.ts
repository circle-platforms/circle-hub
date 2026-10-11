import test from "node:test";
import assert from "node:assert/strict";
import {
  execute,
  initialState,
  visibleTasks,
  visibleDocs,
  type Context,
  type DemoState,
} from "./domain.ts";
const tester: Context = { role: "tester", environment: "lab", project: "lb" };
const expert: Context = { role: "expert", environment: "lab", project: "lb" };
const approver: Context = {
  role: "approver",
  environment: "lab",
  project: "lb",
};
function task(state: DemoState, id = "TSK-2084") {
  return state.tasks.find((t) => t.id === id)!;
}

test("observing and platform maintenance do not grant business content or device control", () => {
  const state = initialState();
  for (const role of ["ops", "security", "auditor"] as const) {
    const c = { ...tester, role };
    assert.equal(visibleTasks(state, c).length, 0);
    assert.equal(visibleDocs(state, c).length, 0);
    const denied = execute(state, c, { type: "webStep", id: "TSK-2084" });
    assert.equal(denied.ok, false);
    assert.equal(task(denied.state).browserStep, 2);
    assert.equal(denied.state.audit[0].result, "denied");
  }
  const viewer = execute(
    state,
    { ...tester, role: "viewer" },
    { type: "takeover", id: "TSK-2084" },
  );
  assert.equal(viewer.ok, false);
});
test("project and environment boundaries reject the same task identifier", () => {
  for (const c of [
    { ...tester, project: "fw" },
    { ...tester, environment: "production" as const },
  ]) {
    const r = execute(initialState(), c, { type: "advance", id: "TSK-2084" });
    assert.equal(r.ok, false);
    assert.equal(task(r.state).step, 3);
  }
});
test("editing Agent draft preserves published configuration and all in-flight versions", () => {
  const s = initialState();
  const original = s.agents[0].instructions;
  const r = execute(s, expert, {
    type: "saveAgent",
    id: "AGT-001",
    instructions: "先采集两段握手，再分析原因",
  });
  assert.equal(r.ok, true);
  assert.equal(r.state.agents[0].instructions, original);
  assert.equal(r.state.agents[0].version, "1.3.0");
  assert.equal(task(r.state).agentVersion, "1.3.0");
  assert.equal(s.agents[0].draftRevision, 1);
});
test("current draft requires test and separate approval, editing invalidates that approval", () => {
  let s = initialState();
  assert.equal(
    execute(s, expert, { type: "publishAgent", id: "AGT-001" }).ok,
    false,
  );
  s = execute(s, expert, { type: "evaluateAgent", id: "AGT-001" }).state;
  s = execute(s, approver, { type: "reviewAgent", id: "AGT-001" }).state;
  assert.equal(s.agents[0].reviewed, true);
  s = execute(s, expert, {
    type: "saveAgent",
    id: "AGT-001",
    instructions: "补充新的工作要求",
  }).state;
  assert.equal(s.agents[0].reviewed, false);
  assert.equal(
    execute(s, expert, { type: "publishAgent", id: "AGT-001" }).ok,
    false,
  );
});
test("publishing Agent changes new work only", () => {
  let s = initialState();
  s = execute(s, expert, { type: "evaluateAgent", id: "AGT-001" }).state;
  s = execute(s, approver, { type: "reviewAgent", id: "AGT-001" }).state;
  s = execute(s, expert, { type: "publishAgent", id: "AGT-001" }).state;
  assert.equal(s.agents[0].version, "1.4.0");
  assert.equal(task(s).agentVersion, "1.3.0");
  const created = execute(s, tester, {
    type: "createTask",
    prompt: "检查测试网关",
    agentId: "AGT-001",
  });
  assert.equal(created.ok, true);
  assert.equal(task(created.state, created.taskId).agentVersion, "1.4.0");
});
test("pausing an Agent blocks new requests and does not cancel accepted work", () => {
  const s = execute(initialState(), expert, {
    type: "pauseAgent",
    id: "AGT-001",
  }).state;
  assert.equal(
    execute(s, tester, {
      type: "createTask",
      prompt: "新工作",
      agentId: "AGT-001",
    }).ok,
    false,
  );
  assert.equal(task(s).phase, "review");
});
test("knowledge publication does not silently rebind tasks", () => {
  let s = initialState();
  const original = task(s).snapshot;
  s = execute(s, expert, { type: "syncSource", id: "SRC-01" }).state;
  s = execute(s, expert, { type: "publishSnapshot" }).state;
  assert.notEqual(s.stableSnapshot, original);
  assert.equal(task(s).snapshot, original);
  s = execute(s, approver, { type: "approve", id: "TSK-2084" }).state;
  s = execute(s, tester, { type: "bindSnapshot", id: "TSK-2084" }).state;
  assert.equal(task(s).snapshot, s.stableSnapshot);
  assert.equal(task(s).inputRevision, 4);
  assert.equal(task(s).approvedRevision, undefined);
});
test("new input preserves previous bytes and immutable run bindings", () => {
  let s = initialState();
  const original = task(s).prompt;
  const oldRun = task(s).runId;
  s = execute(s, approver, { type: "approve", id: "TSK-2084" }).state;
  s = execute(s, tester, {
    type: "revise",
    id: "TSK-2084",
    text: "只读调查，不调整配置",
  }).state;
  assert.equal(task(s).approvedRevision, undefined);
  assert.equal(task(s).inputs?.[0].text, original);
  assert.equal(s.runs.find((r) => r.id === oldRun)?.inputRevision, 3);
  assert.equal(s.runs.find((r) => r.id === task(s).runId)?.inputRevision, 4);
  assert.notEqual(task(s).runId, oldRun);
});
test("client disconnect keeps the task, operation, input and evidence", () => {
  const s = initialState();
  const original = structuredClone(task(s));
  const r = execute(s, tester, { type: "disconnect" });
  assert.equal(r.state.connected, false);
  assert.deepEqual(task(r.state), original);
  const restored = execute(r.state, tester, { type: "reconnect" });
  assert.equal(restored.state.connected, true);
  assert.deepEqual(task(restored.state), original);
});
test("requesting stop does not claim observed stopping", () => {
  let s = execute(initialState(), tester, {
    type: "cancel",
    id: "TSK-2081",
  }).state;
  assert.equal(task(s, "TSK-2081").phase, "stopping");
  assert.ok(task(s, "TSK-2081").unknowns.some((x) => x.includes("尚未确认")));
  s = execute(s, tester, { type: "reconcile", id: "TSK-2081" }).state;
  assert.equal(task(s, "TSK-2081").phase, "stopped");
});
test("unknown result is reconciled using the original operation", () => {
  const s = initialState();
  const id = task(s, "TSK-2090").operation;
  const r = execute(s, tester, { type: "reconcile", id: "TSK-2090" });
  assert.equal(r.ok, true);
  assert.equal(task(r.state, "TSK-2090").operation, id);
  assert.equal(r.state.tasks.length, s.tasks.length);
});
test("revoked delegation blocks effects but permits authorized stop observation", () => {
  let s = execute(
    initialState(),
    { ...tester, role: "security" },
    { type: "revoke", id: "TSK-2084" },
  ).state;
  assert.equal(
    execute(s, tester, { type: "webStep", id: "TSK-2084" }).ok,
    false,
  );
  s = execute(s, tester, { type: "reconcile", id: "TSK-2084" }).state;
  assert.equal(task(s).phase, "stopped");
});
test("changed target identity blocks continuing and ordinary reconciliation", () => {
  const s = execute(initialState(), tester, {
    type: "identityChange",
    id: "TSK-2084",
  }).state;
  for (const type of ["webStep", "takeover", "advance", "reconcile"] as const)
    assert.equal(execute(s, tester, { type, id: "TSK-2084" }).ok, false);
  assert.equal(task(s).operation, "OP-4107");
});
test("human control prevents the Agent from concurrently advancing", () => {
  let s = execute(initialState(), approver, {
    type: "approve",
    id: "TSK-2084",
  }).state;
  s = execute(s, tester, { type: "takeover", id: "TSK-2084" }).state;
  assert.equal(
    execute(s, tester, { type: "advance", id: "TSK-2084" }).ok,
    false,
  );
  s = execute(s, tester, { type: "returnControl", id: "TSK-2084" }).state;
  assert.equal(
    execute(s, tester, { type: "advance", id: "TSK-2084" }).ok,
    true,
  );
});
test("schedule pause leaves in-flight work and overlap rejection does not create another task", () => {
  let s = initialState();
  s = execute(s, tester, { type: "scheduleToggle", id: "SCH-102" }).state;
  assert.equal(task(s, "TSK-2081").phase, "running");
  const first = execute(s, tester, { type: "scheduleRun", id: "SCH-101" });
  assert.equal(first.ok, true);
  const second = execute(first.state, tester, {
    type: "scheduleRun",
    id: "SCH-101",
  });
  assert.equal(second.ok, false);
  assert.equal(second.state.tasks.length, first.state.tasks.length);
  assert.equal(task(first.state, first.taskId).methodVersion, "1.4.0");
});
test("a rejected story acceptance does not mutate status", () => {
  const s = initialState();
  const r = execute(s, tester, {
    type: "storyMove",
    id: "CS-101",
    status: "accepted",
  });
  assert.equal(r.ok, false);
  assert.equal(
    r.state.stories.find((x) => x.id === "CS-101")?.status,
    "building",
  );
  assert.equal(r.state.audit[0].result, "denied");
});
test("source credentials are rejected before storing configuration", () => {
  const s = initialState();
  for (const address of [
    "https://user:password@example.test",
    "https://example.test?token=private-value",
  ]) {
    const r = execute(s, expert, {
      type: "addSource",
      title: "新来源",
      sourceType: "Git",
      address,
    });
    assert.equal(r.ok, false);
    assert.equal(r.state.sources.length, s.sources.length);
    assert.ok(!JSON.stringify(r.state.audit[0]).includes("private-value"));
  }
});
test("a complete mock workflow retains unknown real-world outcome", () => {
  let r = execute(initialState(), tester, {
    type: "createTask",
    prompt: "检查测试网关业务",
    agentId: "AGT-001",
  });
  assert.ok(r.taskId);
  const id = r.taskId!;
  let s = r.state;
  for (let i = 0; i < 3; i++)
    s = execute(s, tester, { type: "advance", id }).state;
  assert.equal(task(s, id).phase, "review");
  assert.equal(execute(s, tester, { type: "approve", id }).ok, false);
  s = execute(s, approver, { type: "approve", id }).state;
  for (let i = 0; i < 2; i++)
    s = execute(s, tester, { type: "advance", id }).state;
  assert.equal(task(s, id).phase, "done");
  assert.ok(task(s, id).evidence.length > 0);
  assert.ok(
    task(s, id).unknowns.some((x) => x.includes("没有在本 demo 中验证")),
  );
});
