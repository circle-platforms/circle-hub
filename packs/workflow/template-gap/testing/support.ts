// Helpers for the tests of the template-gap functions (not part of the pack): documents parsed by the real kityminder@1
// parser and bound the way the run engine binds an input (BoundInput of projection-input@1), the pack's tables, narrowing.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BoundInput } from '../../../../contracts/src/pack.ts';
import { kityminderParser, type KityMinderModel, type ParsedDocument } from '../../../../hub/refs/api.ts';
import { isFailure } from '../functions/common.ts';
import { projectDocuments, type ProjectOptions } from '../functions/project.ts';
import type { DocumentItem, PackFailure, ProjectionResult } from '../functions/types.ts';
import { bytesOf, type DocumentSpec } from './mindmap.ts';

export { isFailure };

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function parse(bytes: Uint8Array): ParsedDocument<KityMinderModel> {
  return kityminderParser.parse(bytes);
}

export interface BindOptions {
  /** `agile:mindmap:<id>`, with an optional revision; absent for an upload. */
  external?: string | null;
  meta?: Record<string, unknown> | null;
  slot?: string;
}

/** A document (synthetic spec or bytes) bound as the engine binds it: parsed, with its SHA-256 and the reader's meta. */
export function bind(document: DocumentSpec | Uint8Array, options: BindOptions = {}): BoundInput {
  const bytes = document instanceof Uint8Array ? document : bytesOf(document);
  return {
    slot: options.slot ?? 'documents',
    external: options.external ?? null,
    sha256: sha256(bytes),
    media_type: 'application/json',
    parser: 'kityminder@1',
    model: parse(bytes).model,
    meta: options.meta ?? null,
  };
}

export const CONTEXT = { product: null, names: [], line: null, build: null, root: null, parameters: {}, groups: [] };

export function projectionInput(inputs: BoundInput[], parameters: Record<string, unknown> = {}): { inputs: BoundInput[]; parameters: Record<string, unknown>; context: typeof CONTEXT } {
  return { inputs, parameters, context: { ...CONTEXT, parameters } };
}

/** Projects and expects items. */
export function project(inputs: BoundInput[], parameters: Record<string, unknown> = {}, options: ProjectOptions = {}): ProjectionResult {
  const out = projectDocuments(projectionInput(inputs, parameters), options);
  if (isFailure(out)) assert.fail(`expected items, got ${JSON.stringify(out.error)}`);
  return out;
}

/** Projects and expects a refusal. */
export function refuse(inputs: BoundInput[], parameters: Record<string, unknown> = {}, options: ProjectOptions = {}): PackFailure {
  const out = projectDocuments(projectionInput(inputs, parameters), options);
  if (!isFailure(out)) assert.fail(`expected a refusal, got ${out.items.length} items`);
  return out;
}

/** The one item of a one-document projection. */
export function itemOf(document: DocumentSpec | Uint8Array, options: BindOptions = {}, parameters: Record<string, unknown> = {}): DocumentItem {
  const out = project([bind(document, options)], parameters);
  assert.equal(out.items.length, 1);
  return out.items[0];
}

export function table(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../tables/${name}`, import.meta.url), 'utf8'));
}

export function packJson(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8'));
}

/** A JSON value survives a JSON round trip unchanged (no undefined, NaN or non-plain objects). */
export function assertJson(value: unknown): void {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
}
