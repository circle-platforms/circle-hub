// Repository-level synchronization of duplicated pack content. Production functions cannot import another pack.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {RESOURCE_TAGS,TYPE_LABELS} from './functions/tag-table.ts';
import {CANONICAL_TAGS} from './functions/tags.ts';
import {RESOURCE_TAGS as templateTags,CANONICAL_TAGS as templateTypes} from '../template-gap/functions/tags.ts';

test('quality-board and template-gap declare identical exact resource texts and test types', () => {
  assert.deepEqual(RESOURCE_TAGS,templateTags);
  assert.deepEqual(CANONICAL_TAGS, templateTypes);
  const template = JSON.parse(readFileSync(new URL('../template-gap/tables/template-v3.json', import.meta.url), 'utf8')) as { categories: Array<{ id: string; label: string; group: string }> };
  const types = template.categories.filter((category) => category.group === 'test_type');
  assert.deepEqual(types.map((category) => category.id), CANONICAL_TAGS);
  assert.deepEqual(types.map((category) => category.label), CANONICAL_TAGS.map((tag) => TYPE_LABELS[tag]));
});
