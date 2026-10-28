// Test-file partitions only. Performance bounds keep their original assertions and run without another test worker.
import {globSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const UNIT_PATTERNS=['contracts/**/*.test.ts','hub/**/*.test.ts','packs/**/*.test.ts','scripts/**/*.test.ts','tools/gen-contracts*.test.ts','tools/run-unit-tests.test.ts'];
const PARSER_BOUNDS=new Set([
 'hub/refs/adversarial.test.ts',
 'hub/refs/parsers/html.test.ts',
 'hub/refs/skill-lazy-locate.test.ts',
 'packs/skill/html-format/functions/html.test.ts',
 'packs/skill/mindmap-format/functions/kityminder.test.ts',
 'packs/skill/workbook-format/functions/xlsx.test.ts',
 'packs/skill/xml-format/functions/resource.test.ts',
 'packs/skill/xml-format/functions/xml.test.ts',
]);
export function unitFiles(group='all'):string[]{
 const all=[...new Set(globSync(UNIT_PATTERNS,{cwd:ROOT}))].sort();
 if(group==='all')return all;
 if(group==='regular')return all.filter(file=>!PARSER_BOUNDS.has(file));
 if(group==='parser-bounds')return all.filter(file=>PARSER_BOUNDS.has(file));
 throw new Error('未知的单元测试分组；使用 all、regular 或 parser-bounds');
}
export function unitArguments(group='all'):string[]{
 const files=unitFiles(group);if(!files.length)throw new Error('单元测试分组没有文件，拒绝空运行；检查测试文件声明');
 return ['--test','--test-concurrency='+(group==='parser-bounds'?1:2),...files];
}
if(import.meta.main){
 try{
  if(process.argv.length>3)throw new Error('用法：node tools/run-unit-tests.ts [all|regular|parser-bounds]');
  const result=spawnSync(process.execPath,unitArguments(process.argv[2]),{cwd:ROOT,stdio:'inherit'});
  if(result.error)throw result.error;
  process.exitCode=result.status??1;
 }catch(error){process.stderr.write(String(error)+'\n');process.exitCode=2;}
}
