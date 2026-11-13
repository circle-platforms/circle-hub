import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONTENT_SCANNER, scanContent } from './content-scan.ts';

test('retaining content without scanning never claims an inspection or a clean result', () => {
  for (const bytes of [new Uint8Array(), Buffer.from('synthetic content'), Uint8Array.of(0, 255, 1)]) {
    assert.deepEqual(scanContent(bytes), { scanner: CONTENT_SCANNER, inspected: false, clean: false, findings: [], truncated: false });
  }
});
