import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FakeClock,
  IdGen,
  LeaseManager,
  OperationService,
  Registry,
  TaskService,
} from "@infosec/platform";
import {
  CASE_COLUMNS,
  compileMindmap,
  readWorkbook,
  sha256Hex,
  type WorkbookRow,
} from "../src/index.js";

const SAMPLES_DIR =
  process.env.V05_SAMPLES_DIR ??
  fileURLToPath(new URL("../../../samples/v05/", import.meta.url));

function loadSample(name: string): { text: string; json: unknown; sha256: string } {
  const text = readFileSync(`${SAMPLES_DIR}${name}`, "utf8");
  return { text, json: JSON.parse(text), sha256: sha256Hex(text) };
}

const expected = loadSample("smp-v05-02.json").json as {
  expectedRows: Record<string, unknown>[];
};

function toExpectedShape(rows: WorkbookRow[]): Record<string, unknown>[] {
  return rows.map((r) => ({
    编号: r.id,
    一级模块: r.level1,
    二级模块: r.level2,
    用例标题: r.title,
    备注: r.note,
    层级深度: r.depth,
    路径: r.path,
  }));
}

describe("V05 conformance against the frozen samples (contract §4)", () => {
  it("topic-tree input compiles to exactly the 8 expected rows", async () => {
    const sample = loadSample("smp-v05-01-topic-tree.json");
    const result = await compileMindmap({
      data: sample.json,
      format: "topic-tree",
      sourceSha256: sample.sha256,
      generatedAtIso: "2026-10-10T00:00:00.000Z",
    });
    expect(result.status).toBe("succeeded");
    expect(result.unmapped).toEqual([]);
    expect(toExpectedShape(result.rows ?? [])).toEqual(expected.expectedRows);
  });

  it("XMind content.json input yields the identical IR and rows", async () => {
    const tree = loadSample("smp-v05-01-topic-tree.json");
    const content = loadSample("smp-v05-01-content.json");
    const fromTree = await compileMindmap({
      data: tree.json,
      format: "topic-tree",
      sourceSha256: tree.sha256,
    });
    const fromContent = await compileMindmap({
      data: content.json,
      format: "xmind-content",
      sourceSha256: content.sha256,
    });
    expect(fromContent.status).toBe("succeeded");
    expect(fromContent.irHash).toBe(fromTree.irHash);
    expect(toExpectedShape(fromContent.rows ?? [])).toEqual(expected.expectedRows);
  });

  it("the workbook round-trips: sheets, header, rows, and 说明 metadata", async () => {
    const sample = loadSample("smp-v05-01-topic-tree.json");
    const result = await compileMindmap({
      data: sample.json,
      format: "topic-tree",
      sourceSha256: sample.sha256,
      generatedAtIso: "2026-10-10T00:00:00.000Z",
    });
    if (!result.workbook) throw new Error("no workbook produced");
    const back = await readWorkbook(result.workbook);
    expect(back.sheets).toEqual(["用例清单", "说明"]);
    expect(back.caseHeader).toEqual([...CASE_COLUMNS]);
    expect(toExpectedShape(back.caseRows)).toEqual(expected.expectedRows);
    expect(back.caseRows.every((r) => typeof r.depth === "number")).toBe(true);
    expect(back.notes["源文件 SHA-256"]).toBe(sample.sha256);
    expect(back.notes["契约版本"]).toBe("Excel 输出契约 V1");
    expect(back.notes["映射规则版本"]).toBe("1.0.0");
    expect(back.notes["源文件标题"]).toBe("LBX-200 7.1 升级验证");
  });

  it("determinism: same IR + same metadata inputs give identical rows and notes", async () => {
    const sample = loadSample("smp-v05-01-topic-tree.json");
    const a = await compileMindmap({
      data: sample.json,
      format: "topic-tree",
      sourceSha256: sample.sha256,
      generatedAtIso: "2026-10-10T00:00:00.000Z",
    });
    const b = await compileMindmap({
      data: sample.json,
      format: "topic-tree",
      sourceSha256: sample.sha256,
      generatedAtIso: "2026-10-10T00:00:00.000Z",
    });
    expect(a.irHash).toBe(b.irHash);
    const backA = await readWorkbook(a.workbook as Buffer);
    const backB = await readWorkbook(b.workbook as Buffer);
    expect(backA.caseRows).toEqual(backB.caseRows);
    expect(backA.notes).toEqual(backB.notes);
  });
});

describe("V05 partial and failure behaviour (contract §3.5)", () => {
  it("unmappable elements produce partial, are listed, and are never dropped silently", async () => {
    const data = {
      title: "Root",
      children: [
        {
          title: "Module",
          children: [
            { title: "Case A" },
            "not-a-topic",
            { title: "   " },
            { title: "Case B", note: 42 },
          ],
        },
      ],
    };
    const result = await compileMindmap({
      data,
      format: "topic-tree",
      sourceSha256: "0".repeat(64),
    });
    expect(result.status).toBe("partial");
    expect(result.rows?.map((r) => r.title)).toEqual(["Case A", "Case B"]);
    expect(result.unmapped.length).toBe(3);
    const back = await readWorkbook(result.workbook as Buffer);
    expect(back.notes["未映射元素"]).toContain("not an object");
  });

  it("an unparseable input fails as a whole with no workbook", async () => {
    const result = await compileMindmap({
      data: { hello: "world" },
      format: "topic-tree",
      sourceSha256: "0".repeat(64),
    });
    expect(result.status).toBe("failed");
    expect(result.workbook).toBeUndefined();
    expect(result.error?.code).toBe("INVALID_PAYLOAD");
  });

  it("a second sheet in content.json is reported, not compiled", async () => {
    const sheet = {
      id: "s1",
      rootTopic: {
        id: "r",
        title: "Root",
        children: {
          attached: [
            {
              id: "m",
              title: "Module",
              children: { attached: [{ id: "c", title: "Case" }] },
            },
          ],
        },
      },
    };
    const result = await compileMindmap({
      data: [sheet, sheet],
      format: "xmind-content",
      sourceSha256: "0".repeat(64),
    });
    expect(result.status).toBe("partial");
    expect(result.unmapped.some((u) => u.reason.includes("additional sheets"))).toBe(true);
    expect(result.rows).toHaveLength(1);
  });
});

describe("V05 vertical slice on the platform core", () => {
  it("task + registry + completion gate deliver a compiled workbook", async () => {
    const clock = new FakeClock(1_700_000_000_000);
    const ids = new IdGen();
    const leases = new LeaseManager(clock, ids);
    const tasks = new TaskService(clock, ids);
    const ops = new OperationService(clock, ids, leases);
    void ops;
    const registry = new Registry(clock, ids);

    const task = tasks.createTask({
      tenantId: "tnt_main",
      scopeId: "scp_a",
      principalId: "prn_alice",
      title: "编译 SMP-V05-01",
    });
    tasks.transition(task.taskId, "admitted");
    tasks.transition(task.taskId, "running");

    const sample = loadSample("smp-v05-01-topic-tree.json");
    const result = await compileMindmap({
      data: sample.json,
      format: "topic-tree",
      sourceSha256: sample.sha256,
    });
    expect(result.status).toBe("succeeded");
    if (!result.workbook || !result.workbookSha256) throw new Error("no workbook");

    const artifact = registry.register({
      tenantId: "tnt_main",
      scopeId: "scp_a",
      kind: "artifact",
      sha256: result.workbookSha256,
      label: "SMP-V05-01 编译工作簿",
      bindings: { taskId: task.taskId, sourceSha256: sample.sha256 },
    });
    expect(registry.get(artifact.id, "tnt_main", "scp_b").ok).toBe(false);

    expect(
      tasks.attachChecklist(task.taskId, {
        taskId: task.taskId,
        inputRevisionId: task.inputRevisionId,
        items: [
          { itemId: "v05-source-hash", kind: "verification", refId: artifact.id, required: true, satisfied: true },
          { itemId: "v05-ir-coverage", kind: "verification", refId: artifact.id, required: true, satisfied: true },
          { itemId: "v05-roundtrip", kind: "verification", refId: artifact.id, required: true, satisfied: true },
          { itemId: "v05-human-acceptance", kind: "human-decision", refId: artifact.id, required: false, satisfied: false },
        ],
      }).ok,
    ).toBe(true);
    tasks.transition(task.taskId, "under-review");
    const delivered = tasks.deliver(task.taskId);
    expect(delivered.ok && delivered.value.phase).toBe("delivered");
  });
});
