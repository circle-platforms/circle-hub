import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  execute,
  initialState,
  visibleTasks,
  type Context,
  type DemoState,
} from "./domain.ts";
import {
  maintenanceWork,
  outlineMaterial,
  outlineRows,
  reviewFindings,
  scenarios,
} from "./workflows.ts";
import { buildOutlineWorkbook, bytesToBase64 } from "./workflow-files.ts";
const tester: Context = { role: "tester", environment: "lab", project: "lb" };
const approver: Context = { ...tester, role: "approver" };
const commercial: Context = { ...tester, role: "commercial" };
const task = (s: DemoState, id: string) => s.tasks.find((t) => t.id === id)!;

for (const scenario of scenarios)
  test(`${scenario.title}: creates its own workflow and can reach a scoped demo delivery`, async () => {
    const actor = scenario.id === "commercial" ? commercial : tester;
    let r = execute(initialState(), actor, {
      type: "createTask",
      prompt: scenario.prompt,
      scenarioId: scenario.id,
      agentId: scenario.agentId,
    });
    assert.equal(r.ok, true, r.message);
    const id = r.taskId!;
    let s = r.state;
    assert.equal(task(s, id).workflow, `${scenario.id}-v1-demo`);
    assert.equal(
      task(s, id).session.startsWith("SSH-"),
      scenario.scene === "ssh",
    );
    assert.equal(
      task(s, id).session.startsWith("BROWSER-"),
      scenario.scene === "web",
    );
    assert.equal(
      task(s, id).workflowState?.materials[0].text,
      scenario.materials[0].text,
    );
    for (let guard = 0; guard < 12 && task(s, id).phase !== "done"; guard++) {
      const current = task(s, id);
      if (current.phase === "review")
        r = execute(s, approver, { type: "approve", id });
      else if (current.phase === "waiting" && scenario.clarification)
        r = execute(s, actor, {
          type: "revise",
          id,
          text: "合成澄清回应：按任务资料列出已有条件；缺少的条件仍保持未知。",
        });
      else if (
        scenario.id === "review" &&
        current.step === 3 &&
        !current.workflowState?.appliedRevision
      ) {
        for (const f of reviewFindings) {
          r = execute(s, actor, {
            type: "findingDecision",
            id,
            findingId: f.id,
            choice: "accept",
            reason: "按所引用合成规范修订，未知通过阈值继续保留。",
          });
          assert.equal(r.ok, true, r.message);
          s = r.state;
        }
        r = execute(s, actor, { type: "applyReviewEdits", id });
      } else if (
        scenario.id === "outline" &&
        current.step === 3 &&
        !current.workflowState?.artifactReceipt
      ) {
        const built = await buildOutlineWorkbook(
          current.workflowState!.materials[0].text,
          current.inputRevision,
        );
        r = execute(s, actor, {
          type: "recordWorkbook",
          id,
          receipt: built.receipt,
          base64: bytesToBase64(built.bytes),
        });
      } else r = execute(s, actor, { type: "advance", id });
      assert.equal(r.ok, true, r.message);
      s = r.state;
    }
    assert.equal(task(s, id).phase, "done");
    assert.ok(
      task(s, id).unknowns.some((x) => x.includes("没有在本 demo 中验证")),
    );
    assert.ok(s.audit.some((a) => a.task === id));
  });

test("the catalog covers 18 distinct business goals and 10 management journeys", () => {
  assert.equal(scenarios.length, 18);
  assert.equal(maintenanceWork.length, 10);
  assert.equal(new Set(scenarios.map((s) => s.id)).size, 18);
  for (const s of scenarios)
    assert.ok(
      s.source.path &&
        s.materials.length &&
        s.steps.length &&
        s.deliverables.length,
    );
});
test("review rejects arbitrary new material rather than apply unrelated sample findings", () => {
  let r = execute(initialState(), tester, {
    type: "createTask",
    prompt: "评审新材料",
    agentId: "AGT-003",
    scenarioId: "review",
    materials: [
      {
        name: "other.json",
        text: '[{"id":"OTHER","text":"新用例"}]',
        origin: "local",
      },
    ],
  });
  r = execute(r.state, tester, { type: "advance", id: r.taskId! });
  assert.equal(r.ok, false);
  assert.ok(r.message.includes("不能套用"));
});
test("review cannot complete before decisions, preserves old material, and invalidates decisions on new input", () => {
  let r = execute(initialState(), tester, {
    type: "createTask",
    prompt: "评审用例",
    agentId: "AGT-003",
    scenarioId: "review",
  });
  const id = r.taskId!;
  let s = r.state;
  for (let i = 0; i < 3; i++)
    s = execute(s, tester, { type: "advance", id }).state;
  assert.equal(execute(s, tester, { type: "advance", id }).ok, false);
  const old = s.runs.find((x) => x.taskId === id)!.materials![0].text;
  for (const f of reviewFindings)
    s = execute(s, tester, {
      type: "findingDecision",
      id,
      findingId: f.id,
      choice: "accept",
      reason: "合成规范支持修订",
    }).state;
  s = execute(s, tester, { type: "applyReviewEdits", id }).state;
  assert.equal(task(s, id).inputRevision, 2);
  assert.equal(
    s.runs.find((x) => x.taskId === id && x.inputRevision === 1)!.materials![0]
      .text,
    old,
  );
  assert.notEqual(task(s, id).workflowState!.materials[0].text, old);
  s = execute(s, tester, {
    type: "revise",
    id,
    text: "改用另一份产品规范",
  }).state;
  assert.equal(task(s, id).workflowState!.decisions.length, 0);
  assert.equal(task(s, id).workflowState!.appliedRevision, undefined);
});
test("commercial work is isolated from ordinary business roles at action and view paths", () => {
  assert.equal(
    execute(initialState(), tester, {
      type: "createTask",
      prompt: "报价",
      agentId: "AGT-010",
      scenarioId: "commercial",
    }).ok,
    false,
  );
  const r = execute(initialState(), commercial, {
    type: "createTask",
    prompt: "报价",
    agentId: "AGT-010",
    scenarioId: "commercial",
  });
  assert.equal(
    visibleTasks(r.state, tester).some((t) => t.id === r.taskId),
    false,
  );
  assert.equal(
    execute(r.state, tester, { type: "advance", id: r.taskId! }).ok,
    false,
  );
  assert.equal(
    execute(r.state, commercial, {
      type: "createTask",
      prompt: "操作设备",
      agentId: "AGT-001",
      scenarioId: "network",
    }).ok,
    false,
  );
});
test("outline rows preserve paths, notes, numeric depth and unsupported fields", () => {
  const p = outlineRows(outlineMaterial.text);
  assert.equal(p.rows.length, 4);
  assert.deepEqual(p.rows[0], {
    id: "TC-001",
    level1: "主备切换",
    level2: "主动切换",
    title: "主动切换",
    note: "观察已有连接",
    depth: 2,
    path: "主备切换/主动切换",
  });
  const data = JSON.parse(outlineMaterial.text);
  data.children[0].children[0].attachments = ["unmapped"];
  assert.ok(
    outlineRows(JSON.stringify(data)).unmapped[0].includes("attachments"),
  );
  assert.throws(() => outlineRows('{"title":"","children":[]}'), /标题为空/);
  assert.throws(
    () =>
      outlineRows('[{"rootTopic":{"title":"x"}},{"rootTopic":{"title":"y"}}]'),
    /多 sheet/,
  );
  assert.throws(
    () => outlineRows('{"title":"x","children":false}'),
    /不是列表/,
  );
});
test("generated xlsx is an OOXML workbook, independently inspected by unzip, not renamed JSON", async () => {
  const built = await buildOutlineWorkbook(outlineMaterial.text, 1);
  assert.deepEqual(Array.from(built.bytes.slice(0, 4)), [80, 75, 3, 4]);
  fs.mkdirSync(".tmp", { recursive: true });
  fs.writeFileSync(".tmp/outline-contract.xlsx", built.bytes);
  const xml = (name: string) =>
    execFileSync("unzip", ["-p", ".tmp/outline-contract.xlsx", name], {
      encoding: "utf8",
    });
  const book = xml("xl/workbook.xml");
  assert.ok(book.includes('name="用例清单"'));
  assert.ok(book.includes('name="说明"'));
  const sheet = xml("xl/worksheets/sheet1.xml");
  assert.equal((sheet.match(/<row /g) ?? []).length, 5);
  assert.match(sheet, /<c r="F2"[^>]*><v>2<\/v><\/c>/);
  const strings = xml("xl/sharedStrings.xml");
  assert.ok(strings.includes("主备切换/主动切换"));
  assert.ok(strings.includes(built.receipt.sourceSha256));
  assert.ok(!strings.includes("N/A"));
});
test("new input cannot use the old workbook receipt to finish", async () => {
  let r = execute(initialState(), tester, {
    type: "createTask",
    prompt: "转换脑图",
    agentId: "AGT-006",
    scenarioId: "outline",
  });
  const id = r.taskId!;
  let s = r.state;
  for (let i = 0; i < 3; i++)
    s = execute(s, tester, { type: "advance", id }).state;
  assert.equal(execute(s, tester, { type: "advance", id }).ok, false);
  const built = await buildOutlineWorkbook(outlineMaterial.text, 1);
  s = execute(s, tester, { type: "revise", id, text: "更新材料口径" }).state;
  assert.equal(
    execute(s, tester, {
      type: "recordWorkbook",
      id,
      receipt: built.receipt,
      base64: bytesToBase64(built.bytes),
    }).ok,
    false,
  );
});
