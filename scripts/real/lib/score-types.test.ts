// Synthetic compile-time contract regression: generated vocabulary types must guard the scorer boundary.
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import ts from 'typescript';

test('closure B11 score input fields reject values outside generated vocabulary axes',t=>{
 const directory=mkdtempSync(join(tmpdir(),'score-types-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const file=join(directory,'fixture.mts'), source=fileURLToPath(new URL('./score.ts',import.meta.url));
 writeFileSync(file,`import type {ItemLike} from ${JSON.stringify(source)};\ntype Requirement=ItemLike['requirements'][number];\nconst good:Requirement['layers'][number]['terminal']='pass';\n// @ts-expect-error a terminal must come from the generated axis\nconst terminal:Requirement['layers'][number]['terminal']='invalid_synthetic';\n// @ts-expect-error attribution must come from the generated axis\nconst attribution:Requirement['layers'][number]['attribution']='invalid_synthetic';\n// @ts-expect-error source role must come from the generated axis\nconst qualifier:NonNullable<Requirement['claims'][number]['qualifier']>={source_role:'invalid_synthetic'};\n`);
 const options:ts.CompilerOptions={noEmit:true,strict:true,skipLibCheck:true,allowImportingTsExtensions:true,target:ts.ScriptTarget.ESNext,module:ts.ModuleKind.NodeNext,typeRoots:[resolve(import.meta.dirname,'../../../node_modules/@types')]};
 const program=ts.createProgram([file],options);
 const diagnostics=ts.getPreEmitDiagnostics(program).filter(d=>d.file?.fileName===file);
 assert.deepEqual(diagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,' ')),[]);
});
