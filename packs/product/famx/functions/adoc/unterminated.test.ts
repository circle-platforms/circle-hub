// Synthetic sources only. The engine owns recovery and block kinds; the adapter reports its observations.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compileAdoc} from './index.ts';
import {sha256} from './input.ts';
import {toK1Model} from './k1-model.ts';
import {produceAdocEntries} from './entries.ts';
import {compileGrammar} from '../commands.ts';
const group=(files:Record<string,string>,main='book.adoc')=>({main,revision:'17',files:Object.fromEntries(Object.entries(files).map(([file,text])=>[file,{text,revision:'17',sha256:sha256(text)}]))});
const grammar=compileGrammar([{path:'/commands/demo/pool/add',words:['demo','pool','add'],signatures:[{params:[{name:'pool',type:'string'}]}]}]);

test('an unterminated literal chapter retains the engine literal kind and reports its actual extent',async()=>{
 const source=group({'book.adoc':'= Synthetic\n\ninclude::chapters/literal.adoc[]','chapters/literal.adoc':'== Literal chapter\n\n....\n*demo pool add* _<pool>_\ndemo pool add pool-a'});
 const out=await compileAdoc(source);assert.ok(out.ok,JSON.stringify(out));
 assert.deepEqual(out.report.unterminated_blocks,[{file:'chapters/literal.adoc',line:3,kind:'literal',delimiter:'....',end_file:'chapters/literal.adoc',end_line:5}]);
 const literal=out.model.blocks.find(block=>block.kind==='literal');assert.ok(literal);assert.ok(literal.raw.includes('*demo pool add*'));
 const produced=produceAdocEntries(toK1Model(out.model,out.composition,'cli'),{name:'cli',catalog:grammar});assert.ok(produced.ok,JSON.stringify(produced));
 assert.ok(!produced.entries.some(entry=>entry.kind==='definition'),'signature-looking text remains inside a literal block');
});

test('an unterminated example extends through the file and its swallowed content stays example content',async()=>{
 const source=group({'book.adoc':'= Synthetic\n\n== Examples\n\n====\nInside the example.\n\n== Heading swallowed by the example\n\n*demo pool add* _<pool>_'});
 const out=await compileAdoc(source);assert.ok(out.ok,JSON.stringify(out));
 assert.deepEqual(out.report.unterminated_blocks,[{file:'book.adoc',line:5,kind:'example',delimiter:'====',end_file:'book.adoc',end_line:10}]);
 const paragraphs=out.model.blocks.filter(block=>block.kind==='paragraph');assert.ok(paragraphs.length);assert.ok(paragraphs.every(block=>block.example));
 assert.equal(JSON.stringify(out),JSON.stringify(await compileAdoc(source)));
});

test('nested missing delimiters are reported separately and a closed inner block is not another recovery',async()=>{
 const nested=await compileAdoc(group({'book.adoc':'= Synthetic\n\n====\n****\nNested content.'}));assert.ok(nested.ok,JSON.stringify(nested));
 assert.deepEqual(nested.report.unterminated_blocks?.map(block=>[block.kind,block.line,block.end_line]),[['example',3,5],['sidebar',4,5]]);
 const closed=await compileAdoc(group({'book.adoc':'= Synthetic\n\n====\n....\nLiteral content.\n....\n\nExample tail.'}));assert.ok(closed.ok,JSON.stringify(closed));
 assert.equal(closed.report.unterminated_blocks?.length,1);
});

test('an unrelated engine ERROR still refuses a group that also has an unterminated block',async()=>{
 const out=await compileAdoc(group({'book.adoc':'= Synthetic\n\n[format="invalid"]\n|===\n|x\n|===\n\n....\nUnterminated literal.'}));
 assert.ok(!out.ok&&out.error.code==='famx.adoc.engine_parse');assert.equal('model' in out,false);
});

test('a bounded child reader recovers a literal at its container end and retains the following section',async()=>{
 const out=await compileAdoc(group({'book.adoc':'= Synthetic\n\n== Current chapter\n====\n....\nLiteral to chapter end.\n====\n\n== Next chapter\n\nFollowing content.'}));assert.ok(out.ok,JSON.stringify(out));
 assert.deepEqual(out.report.unterminated_blocks,[{file:'book.adoc',line:5,kind:'literal',delimiter:'....',end_file:'book.adoc',end_line:6}]);
 assert.ok(out.model.blocks.some(block=>block.kind==='literal'&&block.raw==='Literal to chapter end.'));
 assert.ok(out.model.blocks.some(block=>block.kind==='paragraph'&&block.raw==='Following content.'));
});

test('a recovery crossing expanded source files names the actual end file without closing the source artificially',async()=>{
 const out=await compileAdoc(group({'book.adoc':'= Synthetic\n\ninclude::chapters/open.adoc[]\ninclude::chapters/tail.adoc[]','chapters/open.adoc':'== Open\n\n....\nLiteral content.','chapters/tail.adoc':'== Tail\n\nSwallowed tail.'}));assert.ok(out.ok,JSON.stringify(out));
 assert.deepEqual(out.report.unterminated_blocks,[{file:'chapters/open.adoc',line:3,kind:'literal',delimiter:'....',end_file:'chapters/tail.adoc',end_line:3}]);
 assert.ok(out.model.blocks.some(block=>block.kind==='literal'&&block.raw.includes('== Tail')));
});

test('reader observation hooks are restored after successful recovery and an unrelated error',async()=>{
 const {load}=await import('./vendor/core.mjs');const doc=await load('= Probe',{parse:false});
 const owner=(name:string)=>{let proto=Object.getPrototypeOf(doc.getReader());while(!Object.hasOwn(proto,name))proto=Object.getPrototypeOf(proto);return proto;};
 const line=owner('readLine'),until=owner('readLinesUntil'),beforeLine=line.readLine,beforeUntil=until.readLinesUntil;
 await compileAdoc(group({'book.adoc':'= Synthetic\n\n....\nLiteral.'}));
 assert.equal(line.readLine,beforeLine);assert.equal(until.readLinesUntil,beforeUntil);
 await compileAdoc(group({'book.adoc':'= Synthetic\n\n[format="invalid"]\n|===\n|x\n|==='}));
 assert.equal(line.readLine,beforeLine);assert.equal(until.readLinesUntil,beforeUntil);
});
