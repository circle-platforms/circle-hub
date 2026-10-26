import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FUNCTIONS, PRODUCT_LINE } from './api.ts';

describe('api', () => {
  it('names an existing function for every sandbox entry point', async () => {
    for (const [name, target] of Object.entries(FUNCTIONS)) {
      const module = (await import(new URL(`./${target.module}`, import.meta.url).href)) as { [key: string]: unknown };
      assert.equal(typeof module[target.export], 'function', name);
    }
  });

  it('binds one product line with both names', () => {
    assert.deepEqual(PRODUCT_LINE, { id: 'famx', names: ['FAMX', 'FAMY'] });
  });
});
