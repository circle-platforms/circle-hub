import { describe, expect, it } from "vitest";
import { FakeClock, IdGen } from "@infosec/platform";
import { KnowledgeStore } from "../src/index.js";

function makeStore() {
  const clock = new FakeClock(1_700_000_000_000);
  const ids = new IdGen();
  return { store: new KnowledgeStore(clock, ids) };
}

const A = { tenantId: "tnt_main", scopeId: "scp_a" };

describe("KnowledgeStore", () => {
  it("pins snapshot membership and hashes content", () => {
    const { store } = makeStore();
    expect(
      store.addRevision({ ...A, sourceRevisionId: "src_1", content: "alpha" }).ok,
    ).toBe(true);
    expect(
      store.addRevision({ ...A, sourceRevisionId: "src_2", content: "beta" }).ok,
    ).toBe(true);
    const snap = store.createSnapshot({
      ...A,
      sourceRevisionIds: ["src_1", "src_2"],
      snapshotId: "snap_1",
    });
    expect(snap.ok).toBe(true);
    if (!snap.ok) return;
    expect(snap.value.sourceRevisionIds).toEqual(["src_1", "src_2"]);
    expect(() => {
      (snap.value.sourceRevisionIds as string[]).push("src_3");
    }).toThrow();
    const rev = store.getRevision(A.tenantId, A.scopeId, "src_1");
    expect(rev.ok && rev.value.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a snapshot cannot include another partition's revisions", () => {
    const { store } = makeStore();
    store.addRevision({ ...A, sourceRevisionId: "src_1", content: "alpha" });
    const snap = store.createSnapshot({
      tenantId: "tnt_main",
      scopeId: "scp_b",
      sourceRevisionIds: ["src_1"],
    });
    expect(!snap.ok && snap.error.code).toBe("FORBIDDEN_SCOPE");
  });

  it("withdrawal after snapshot creation is honoured live", () => {
    const { store } = makeStore();
    store.addRevision({ ...A, sourceRevisionId: "src_1", content: "alpha" });
    const snap = store.createSnapshot({
      ...A,
      sourceRevisionIds: ["src_1"],
      snapshotId: "snap_1",
    });
    if (!snap.ok) throw new Error("snapshot failed");
    expect(store.revisionsOf(snap.value)[0]?.status).toBe("active");
    store.setStatus(A.tenantId, A.scopeId, "src_1", "withdrawn");
    expect(store.revisionsOf(snap.value)[0]?.status).toBe("withdrawn");
  });
});
