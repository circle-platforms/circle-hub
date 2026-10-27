import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {unitArguments,unitFiles} from './run-unit-tests.ts';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
test('CI test partitions are disjoint and cover every original tracked unit test',()=>{
 const all=unitFiles(),regular=unitFiles('regular'),parsers=unitFiles('parser-bounds');
 assert.deepEqual([...regular,...parsers].sort(),all);assert.equal(new Set([...regular,...parsers]).size,all.length);
 const owned=new Set(['contracts','hub','packs','scripts']);
 const tracked=execFileSync('git',['ls-files','-z'],{cwd:ROOT}).toString().split('\0').filter(file=>file.endsWith('.test.ts')&&owned.has(file.split('/')[0]));
 for(const file of tracked)assert.ok(all.includes(file),file);
 assert.deepEqual(parsers,[
  'hub/refs/adversarial.test.ts',
  'hub/refs/parsers/html.test.ts',
  'hub/refs/skill-lazy-locate.test.ts',
  'packs/skill/html-format/functions/html.test.ts',
  'packs/skill/mindmap-format/functions/kityminder.test.ts',
  'packs/skill/workbook-format/functions/xlsx.test.ts',
  'packs/skill/xml-format/functions/resource.test.ts',
  'packs/skill/xml-format/functions/xml.test.ts',
 ]);assert.ok(regular.length>0);
});
test('parser bounds retain a single worker and other unit tests retain the two-worker cap',()=>{
 assert.equal(unitArguments('parser-bounds')[1],'--test-concurrency=1');assert.equal(unitArguments('regular')[1],'--test-concurrency=2');
 assert.throws(()=>unitFiles('unknown'),/未知的单元测试分组/);
});
