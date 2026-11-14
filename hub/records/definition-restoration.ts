import { AsyncLocalStorage } from 'node:async_hooks';
import type { Transaction } from './api.ts';

interface Scope { tx: Transaction; owners: ReadonlySet<string>; assignment: { subject: string; environment: string } | null }
const restoration = new AsyncLocalStorage<Scope>();

/** Internal capability only: no caller-supplied flag or ambient permission survives this async operation. */
export function withDefinitionOwners<T>(tx: Transaction, owners: readonly string[], restore: () => Promise<T>): Promise<T> {
  return restoration.run({ tx, owners: new Set(owners), assignment: null }, restore);
}
export function withDefinitionAssignment<T>(tx: Transaction, subject: string, environment: string, restore: () => Promise<T>): Promise<T> {
  return restoration.run({ tx, owners: new Set(), assignment: { subject, environment } }, restore);
}
export function restoresDisabledOwner(tx: Transaction, owner: string): boolean {
  const scope = restoration.getStore();
  return scope?.tx === tx && scope.owners.has(owner);
}
export function restoresDisabledAssignment(tx: Transaction, subject: string, environment: string): boolean {
  const scope = restoration.getStore();
  return scope?.tx === tx && scope.assignment?.subject === subject && scope.assignment.environment === environment;
}
