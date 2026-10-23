// Repository-level synchronization of duplicated pack content. Production functions cannot import another pack.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { TAG_SPELLINGS as goldSpellings, TYPE_LABELS as goldLabels } from '../../../scripts/real/gold/board.ts';
import { TAG_SPELLINGS, TYPE_LABELS } from './functions/tag-table.ts';
import { CANONICAL_TAGS } from './functions/tags.ts';
import { TAG_SPELLINGS as templateSpellings, CANONICAL_TAGS as templateTypes } from '../template-gap/functions/tags.ts';

test('quality-board and template-gap declare identical test types, labels and aliases', () => {
  assert.deepEqual(TAG_SPELLINGS, templateSpellings);
  assert.deepEqual(goldSpellings, templateSpellings);
  assert.deepEqual(goldLabels, TYPE_LABELS);
  assert.deepEqual(CANONICAL_TAGS, templateTypes);
  const template = JSON.parse(readFileSync(new URL('../template-gap/tables/template-v3.json', import.meta.url), 'utf8')) as { categories: Array<{ label: string; group: string; tags?: string[] }> };
  const types = template.categories.filter((category) => category.group === 'test_type');
  assert.deepEqual(types.map((category) => category.tags), CANONICAL_TAGS.map((tag) => [tag]));
  assert.deepEqual(types.map((category) => category.label), CANONICAL_TAGS.map((tag) => TYPE_LABELS[tag]));
});
