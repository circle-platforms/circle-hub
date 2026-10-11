import { createHash } from "node:crypto";
import { fail, ok, type Result } from "@infosec/platform";

/**
 * Object B minimum: SourceRevision and KnowledgeSnapshot (ADR 0003).
 * A snapshot pins membership (the revision id list never changes after
 * creation); a revision's withdrawal status is read live, so withdrawing
 * a source after a snapshot was taken still blocks its use as evidence.
 */
export interface SourceRevision {
  sourceRevisionId: string;
  tenantId: string;
  scopeId: string;
  content: string;
  contentSha256: string;
  product?: string;
  version?: string;
  status: "active" | "withdrawn";
  createdAt: number;
}

export interface KnowledgeSnapshot {
  snapshotId: string;
  tenantId: string;
  scopeId: string;
  sourceRevisionIds: readonly string[];
  createdAt: number;
}

interface ClockLike {
  now(): number;
}
interface IdGenLike {
  next(prefix: string): string;
}

export class KnowledgeStore {
  #clock: ClockLike;
  #ids: IdGenLike;
  #revisions = new Map<string, SourceRevision>();
  #snapshots = new Map<string, KnowledgeSnapshot>();

  constructor(clock: ClockLike, ids: IdGenLike) {
    this.#clock = clock;
    this.#ids = ids;
  }

  #key(tenantId: string, scopeId: string, id: string): string {
    return `${tenantId}/${scopeId}/${id}`;
  }

  addRevision(input: {
    sourceRevisionId: string;
    tenantId: string;
    scopeId: string;
    content: string;
    product?: string;
    version?: string;
    status?: "active" | "withdrawn";
  }): Result<SourceRevision> {
    const key = this.#key(input.tenantId, input.scopeId, input.sourceRevisionId);
    if (this.#revisions.has(key)) {
      return fail(
        "DECISION_CONFLICT",
        `source revision ${input.sourceRevisionId} already exists in this partition`,
      );
    }
    const revision: SourceRevision = {
      sourceRevisionId: input.sourceRevisionId,
      tenantId: input.tenantId,
      scopeId: input.scopeId,
      content: input.content,
      contentSha256: createHash("sha256").update(input.content).digest("hex"),
      ...(input.product ? { product: input.product } : {}),
      ...(input.version ? { version: input.version } : {}),
      status: input.status ?? "active",
      createdAt: this.#clock.now(),
    };
    this.#revisions.set(key, revision);
    return ok(revision);
  }

  setStatus(
    tenantId: string,
    scopeId: string,
    sourceRevisionId: string,
    status: "active" | "withdrawn",
  ): Result<SourceRevision> {
    const revision = this.#revisions.get(
      this.#key(tenantId, scopeId, sourceRevisionId),
    );
    if (!revision) {
      return fail("TARGET_NOT_FOUND", `source revision ${sourceRevisionId} not found`);
    }
    revision.status = status;
    return ok(revision);
  }

  getRevision(
    tenantId: string,
    scopeId: string,
    sourceRevisionId: string,
  ): Result<SourceRevision> {
    const revision = this.#revisions.get(
      this.#key(tenantId, scopeId, sourceRevisionId),
    );
    if (!revision) {
      // Existence in another partition is reported as forbidden, not found.
      const elsewhere = [...this.#revisions.values()].find(
        (r) => r.sourceRevisionId === sourceRevisionId,
      );
      if (elsewhere) {
        return fail(
          "FORBIDDEN_SCOPE",
          "source revision belongs to another (tenant, scope) partition",
        );
      }
      return fail("TARGET_NOT_FOUND", `source revision ${sourceRevisionId} not found`);
    }
    return ok(revision);
  }

  createSnapshot(input: {
    tenantId: string;
    scopeId: string;
    sourceRevisionIds: string[];
    snapshotId?: string;
  }): Result<KnowledgeSnapshot> {
    for (const id of input.sourceRevisionIds) {
      const found = this.getRevision(input.tenantId, input.scopeId, id);
      if (!found.ok) return found;
    }
    const snapshot: KnowledgeSnapshot = {
      snapshotId: input.snapshotId ?? this.#ids.next("snap"),
      tenantId: input.tenantId,
      scopeId: input.scopeId,
      sourceRevisionIds: Object.freeze([...input.sourceRevisionIds]),
      createdAt: this.#clock.now(),
    };
    this.#snapshots.set(
      this.#key(input.tenantId, input.scopeId, snapshot.snapshotId),
      snapshot,
    );
    return ok(snapshot);
  }

  getSnapshot(
    tenantId: string,
    scopeId: string,
    snapshotId: string,
  ): Result<KnowledgeSnapshot> {
    const snapshot = this.#snapshots.get(
      this.#key(tenantId, scopeId, snapshotId),
    );
    if (!snapshot) {
      const elsewhere = [...this.#snapshots.values()].find(
        (s) => s.snapshotId === snapshotId,
      );
      if (elsewhere) {
        return fail(
          "FORBIDDEN_SCOPE",
          "snapshot belongs to another (tenant, scope) partition",
        );
      }
      return fail("TARGET_NOT_FOUND", `snapshot ${snapshotId} not found`);
    }
    return ok(snapshot);
  }

  /** Member revisions of a snapshot, with their live status. */
  revisionsOf(snapshot: KnowledgeSnapshot): SourceRevision[] {
    const out: SourceRevision[] = [];
    for (const id of snapshot.sourceRevisionIds) {
      const found = this.getRevision(snapshot.tenantId, snapshot.scopeId, id);
      if (found.ok) out.push(found.value);
    }
    return out;
  }
}
