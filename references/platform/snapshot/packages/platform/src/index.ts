export * from "./clock.js";
export * from "./result.js";
export * from "./idgen.js";
export * from "./leases.js";
export * from "./tasks.js";
export * from "./operations.js";
export * from "./registry.js";

/**
 * ADR 0011 baseline parameters, collected in one place. They are
 * deployment parameters, not protocol constants: changing them is a
 * configuration change with a record, not a contract change.
 */
export const PLATFORM_PARAMS = {
  dedupeWindowMs: 24 * 3_600_000,
  resultRetentionMs: 7 * 24 * 3_600_000,
  leaseTtlMs: 60_000,
  heartbeatMs: 20_000,
} as const;
