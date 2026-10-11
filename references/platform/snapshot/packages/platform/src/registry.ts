import type { Clock } from "./clock.js";
import { fail, ok, type Result } from "./result.js";
import type { IdGen } from "./idgen.js";

/**
 * Evidence / artifact registration partitioned by (tenantId, scopeId)
 * (ADR 0012): items are only visible inside their own partition; a lookup
 * from another partition is FORBIDDEN_SCOPE, never a silent miss that
 * could leak existence across scopes... except the id itself: callers
 * learn "forbidden", matching the frozen error semantics.
 */
export interface RegisteredItem {
  id: string;
  tenantId: string;
  scopeId: string;
  kind: "evidence" | "artifact";
  sha256: string;
  label: string;
  bindings: Record<string, string>;
  registeredAt: number;
}

export class Registry {
  #clock: Clock;
  #ids: IdGen;
  #items = new Map<string, RegisteredItem>();

  constructor(clock: Clock, ids: IdGen) {
    this.#clock = clock;
    this.#ids = ids;
  }

  register(input: Omit<RegisteredItem, "id" | "registeredAt">): RegisteredItem {
    const item: RegisteredItem = {
      ...input,
      id: this.#ids.next(input.kind === "evidence" ? "evd" : "art"),
      registeredAt: this.#clock.now(),
    };
    this.#items.set(item.id, item);
    return item;
  }

  get(
    id: string,
    tenantId: string,
    scopeId: string,
  ): Result<RegisteredItem> {
    const item = this.#items.get(id);
    if (!item) return fail("TARGET_NOT_FOUND", `registered item ${id} not found`);
    if (item.tenantId !== tenantId || item.scopeId !== scopeId) {
      return fail(
        "FORBIDDEN_SCOPE",
        "registered items are not visible across (tenant, scope) partitions",
      );
    }
    return ok(item);
  }

  list(tenantId: string, scopeId: string): RegisteredItem[] {
    return [...this.#items.values()].filter(
      (i) => i.tenantId === tenantId && i.scopeId === scopeId,
    );
  }
}
