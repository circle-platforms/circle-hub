import type { Clock } from "./clock.js";
import { fail, ok, type Result } from "./result.js";
import type { IdGen } from "./idgen.js";

/**
 * Resource leases with monotonic fencing tokens (HAND-02, EFF-05).
 * Defaults follow ADR 0011: TTL 60s, heartbeat renewal by the holder.
 * Expiry is observed lazily on access and in bulk via sweepExpired().
 */
export interface Lease {
  leaseId: string;
  resourceId: string;
  holderRunId: string;
  fencingToken: number;
  ttlMs: number;
  acquiredAt: number;
  expiresAt: number;
  released: boolean;
}

export const DEFAULT_LEASE_TTL_MS = 60_000;

export class LeaseManager {
  #clock: Clock;
  #ids: IdGen;
  #leases = new Map<string, Lease>();
  #activeByResource = new Map<string, string>();
  #fencing = new Map<string, number>();
  #swept = new Set<string>();

  constructor(clock: Clock, ids: IdGen) {
    this.#clock = clock;
    this.#ids = ids;
  }

  #isLive(lease: Lease): boolean {
    return !lease.released && lease.expiresAt > this.#clock.now();
  }

  #activeLease(resourceId: string): Lease | undefined {
    const id = this.#activeByResource.get(resourceId);
    if (!id) return undefined;
    const lease = this.#leases.get(id);
    if (!lease || !this.#isLive(lease)) return undefined;
    return lease;
  }

  acquire(
    resourceId: string,
    holderRunId: string,
    ttlMs: number = DEFAULT_LEASE_TTL_MS,
  ): Result<Lease> {
    if (this.#activeLease(resourceId)) {
      return fail("RESOURCE_BUSY", `resource ${resourceId} is leased`);
    }
    const token = (this.#fencing.get(resourceId) ?? 0) + 1;
    this.#fencing.set(resourceId, token);
    const now = this.#clock.now();
    const lease: Lease = {
      leaseId: this.#ids.next("lease"),
      resourceId,
      holderRunId,
      fencingToken: token,
      ttlMs,
      acquiredAt: now,
      expiresAt: now + ttlMs,
      released: false,
    };
    this.#leases.set(lease.leaseId, lease);
    this.#activeByResource.set(resourceId, lease.leaseId);
    return ok(lease);
  }

  renew(leaseId: string, fencingToken: number): Result<Lease> {
    const lease = this.#leases.get(leaseId);
    if (!lease || lease.released) {
      return fail("LEASE_NOT_HELD", `lease ${leaseId} is not held`);
    }
    if (lease.fencingToken !== fencingToken) {
      return fail("FENCING_STALE", "fencing token does not match the lease");
    }
    if (lease.expiresAt <= this.#clock.now()) {
      return fail("LEASE_EXPIRED", `lease ${leaseId} has expired`);
    }
    lease.expiresAt = this.#clock.now() + lease.ttlMs;
    return ok(lease);
  }

  release(leaseId: string, fencingToken: number): Result<{ released: true }> {
    const lease = this.#leases.get(leaseId);
    if (!lease) return fail("LEASE_NOT_HELD", `lease ${leaseId} is not held`);
    if (lease.released) return ok({ released: true }); // idempotent release
    if (lease.fencingToken !== fencingToken) {
      return fail("FENCING_STALE", "fencing token does not match the lease");
    }
    lease.released = true;
    if (this.#activeByResource.get(lease.resourceId) === leaseId) {
      this.#activeByResource.delete(lease.resourceId);
    }
    return ok({ released: true });
  }

  /** True only for the live lease carrying exactly this token. */
  isCurrent(resourceId: string, fencingToken: number): boolean {
    const lease = this.#activeLease(resourceId);
    return !!lease && lease.fencingToken === fencingToken;
  }

  /** Each expired, unreleased lease is reported exactly once. */
  sweepExpired(): Lease[] {
    const now = this.#clock.now();
    const out: Lease[] = [];
    for (const lease of this.#leases.values()) {
      if (
        !lease.released &&
        lease.expiresAt <= now &&
        !this.#swept.has(lease.leaseId)
      ) {
        this.#swept.add(lease.leaseId);
        out.push(lease);
      }
    }
    return out;
  }
}
