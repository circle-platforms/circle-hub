import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolLocalMinute, toolZoneOf } from './tool-time.ts';

test('toolLocalMinute labels the Hub zone and keeps the month-day', () => {
  const sample = '2026-11-14T09:35:00.000Z';
  const shown = toolLocalMinute(sample);
  assert.match(shown, /^\d{2}-\d{2} \d{2}:\d{2}（UTC[+-]\d+(?::\d{2})?）$/);
  assert.equal(shown.includes(toolZoneOf(new Date(sample))), true);
  assert.doesNotMatch(shown, /T\d{2}:|Z$/);
});

test('toolLocalMinute leaves a non-instant string alone', () => {
  assert.equal(toolLocalMinute('not-a-time'), 'not-a-time');
});
