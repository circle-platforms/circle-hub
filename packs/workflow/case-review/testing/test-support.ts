// Helpers for the tests of the case-review functions (not used by the functions): fixtures parsed by the real kityminder@1
// parser, the pack tables, and narrowing of results.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { kityminderParser, type KityMinderModel, type ParsedDocument } from '../../../../hub/refs/api.ts';
import { compactText, largeDocument } from '../../../../tests/fixtures/mindmaps/documents.ts';
import { fixtureBytes, type MindmapFixture } from '../../../../tests/fixtures/mindmaps/index.ts';
import { projectItems } from '../functions/project.ts';
import type { Failure, ProjectionResult } from '../functions/types.ts';

export function parseFixture(name: MindmapFixture): ParsedDocument<KityMinderModel> {
  return kityminderParser.parse(fixtureBytes(name));
}

export function parseText(text: string): ParsedDocument<KityMinderModel> {
  return kityminderParser.parse(new TextEncoder().encode(text));
}

let large: ParsedDocument<KityMinderModel> | undefined;
export function parseLarge(): ParsedDocument<KityMinderModel> {
  large ??= parseText(compactText(largeDocument()));
  return large;
}

export function table(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../tables/${name}`, import.meta.url), 'utf8'));
}

export function isFailure(value: unknown): value is Failure {
  return typeof value === 'object' && value !== null && 'error' in value;
}

export function succeeded<T extends object>(value: T | Failure): T {
  if (isFailure(value)) assert.fail(`expected a result, got ${JSON.stringify(value.error)}`);
  return value as T;
}

export function project(model: KityMinderModel, documentId = '880001', parameters?: unknown, limits?: unknown): ProjectionResult {
  return succeeded(projectItems({ documents: [{ slot: 'mindmap', documentId, model }], parameters, limits }));
}

/** The review fixture projected once (plain form). */
let review: ProjectionResult | undefined;
export function reviewProjection(): ProjectionResult {
  review ??= project(parseFixture('review-150.km.json').model);
  return review;
}

/** A JSON value survives a JSON round trip unchanged (no undefined, NaN or non-plain objects). */
export function assertJson(value: unknown): void {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
}
