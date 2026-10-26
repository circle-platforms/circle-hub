// Synthetic source structure only; no real manual text, product versions or platform names.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {compileAdoc} from './index.ts';
import {sha256} from './input.ts';
import {toK1Model} from './k1-model.ts';
import {produceAdocEntries} from './entries.ts';
import {compileGrammar} from '../commands.ts';
import {paragraphSignature} from './inline.ts';
import {SIGNATURE_STRUCTURE} from './structure.ts';
import {load} from './vendor/core.mjs';
import declaration from '../../product.json' with {type:'json'};
const grammar=compileGrammar(['add','del'].map(verb=>({words:['demo','pool',verb],path:'/commands/demo/pool/'+verb,signatures:[{params:[{name:'pool_name',type:'string' as const},{name:'weight',type:'int' as const,optional:true}]}]})));
const compile=async(text:string)=>{const value=await compileAdoc({main:'book.adoc',revision:'42',files:{'book.adoc':{text,revision:'42',sha256:sha256(text)}}});assert.ok(value.ok,JSON.stringify(value));return value;};
const produce=async(text:string)=>{const compiled=await compile(text);const mapped=toK1Model(compiled.model,compiled.composition,'cli');const output=produceAdocEntries(mapped,{name:'cli',catalog:grammar});assert.ok(output.ok,JSON.stringify(output));return {compiled,output};};
test('the product publishes the exact engine paragraph/inline structure for both family producers',()=>{
 for(const producer of declaration.producers.filter(producer=>producer.function.module==='functions/adoc/deployment.ts'))assert.deepEqual(producer.params?.signature_structure,SIGNATURE_STRUCTURE);
});
test('only an engine paragraph with one strong and optional whitespace/emphasis defines a command',async()=>{
 const {compiled,output}=await produce('= Synthetic\n\n== Commands\n\n*demo pool add* _<pool_name> [weight]_\n\nA body mentions *demo pool add* and `missing command`.\n\n*中文标题*\n\n`demo pool add`\n\npass:[<strong>demo pool del</strong>]\n\n*demo pool add* plus prose\n');
 assert.equal(compiled.model.blocks.filter(block=>paragraphSignature(block)).length,2,'the Chinese bold paragraph has the same inline shape but no command lexical parse');
 const definitions=output.entries.filter(entry=>entry.kind==='definition');assert.equal(definitions.length,1);assert.equal(definitions[0].path,'/commands/demo/pool/add');assert.equal(definitions[0].data.parameters_verified,true);
 const body=output.entries.find(entry=>entry.statement.startsWith('A body'))!;assert.deepEqual(body.data.command_mentions,['demo pool add','missing command']);assert.deepEqual(body.data.command_literals,['demo pool add']);
 assert.ok(!output.entries.some(entry=>entry.data.form==='signature_drift'));
 const chinese=output.entries.find(entry=>entry.statement.includes('中文标题'))!;assert.ok(chinese.path?.startsWith('/manual/'));assert.equal(chinese.data.signature_literals,undefined);
});
test('variants bind complete exact paths, lexical missing definitions drift, and parameter mismatches are reported',async()=>{
 const {output}=await produce('= Synthetic\n\n== Commands\n\n*demo pool {add|del}* _<pool_name> [weight]_\n\n*demo pool missing* _<pool_name>_\n\n*demo pool add* _<wrong>_\n');
 assert.deepEqual(output.entries.filter(entry=>entry.kind==='definition').map(entry=>entry.path),['/commands/demo/pool/add','/commands/demo/pool/del','/commands/demo/pool/add']);
 assert.equal(output.entries.filter(entry=>entry.data.form==='signature_drift').length,1);
 assert.ok(output.warnings.some(warning=>warning.includes('参数')&&warning.includes('book.adoc:l/9')));
 assert.equal(output.entries.filter(entry=>entry.kind==='definition').at(-1)?.data.parameters_verified,false);
});
test('an engine-dropped short table row preserves its actual output and reports exact original file, line and lost cell count',async()=>{
 const {compiled,output}=await produce('= Synthetic\n\n== Table\n\n[cols="1,1,1"]\n|===\n|a |b |c\n|d |e\n|===\n\nSurviving text.\0\n');
 assert.deepEqual(compiled.report.dropped_table_cells,[{file:'book.adoc',line:8,cells:2}]);assert.equal(compiled.report.files[0].nul_bytes,1);
 assert.equal(compiled.model.blocks.find(block=>block.kind==='table')!.rows!.body.length,1);
 assert.deepEqual(output.entries.filter(entry=>entry.data.form==='table_row').map(entry=>entry.statement),['| a | b | c |'],'the Markdown compatibility header is not published as an authored row');
 assert.ok(output.entries.some(entry=>entry.statement.includes('Surviving text')));
 const chapter='== Table\n\n[cols="1,1,1"]\n|===\n|a |b |c\n|d |e\n|===\n\nTail.\0\n',main='= Synthetic\n\ninclude::chapters/table.adoc[]\n';
 const nested=await compileAdoc({main:'book.adoc',revision:'42',files:{'book.adoc':{text:main,revision:'42',sha256:sha256(main)},'chapters/table.adoc':{text:chapter,revision:'42',sha256:sha256(chapter)}}});assert.ok(nested.ok,JSON.stringify(nested));
 assert.deepEqual(nested.report.dropped_table_cells,[{file:'chapters/table.adoc',line:6,cells:2}]);assert.equal(nested.report.files.find(file=>file.file==='chapters/table.adoc')!.nul_bytes,1);
 const mixed='= Synthetic\n\n[cols="1,1"]\n|===\n|a |b\n|lost\n|===\n\n[format="invalid"]\n|===\n|x\n|===\n';
 const refused=await compileAdoc({main:'book.adoc',revision:'42',files:{'book.adoc':{text:mixed,revision:'42',sha256:sha256(mixed)}}});assert.ok(!refused.ok&&refused.error.code==='famx.adoc.engine_parse');assert.equal('model'in refused,false,'an unrelated ERROR still refuses the entire group');

});
test('the same source group, engine, attributes and locked tree produce byte-identical models and entries',async()=>{
 const source='= Synthetic\n\n== Commands\n\n*demo pool add* _<pool_name> [weight]_\n\nDescription.\n';assert.equal(JSON.stringify(await produce(source)),JSON.stringify(await produce(source)));
});

test('table inline mentions keep the engine span text and never become command definitions',async()=>{
 const {output}=await produce('= Synthetic\n\n[cols="1,1"]\n|===\n| *demo pool add* | `missing command`\n|===\n');
 assert.deepEqual(output.entries.filter(entry=>entry.kind==='definition'),[]);
 const row=output.entries.find(entry=>entry.data.form==='table_row'&&entry.statement.includes('demo pool add'))!;
 assert.deepEqual(row.data.command_mentions,['demo pool add','missing command']);assert.deepEqual(row.data.command_literals,['demo pool add']);assert.equal(row.data.signature_literals,undefined);
});
test('a partly missing variant keeps its exact known definition and records only the missing alternatives as drift',async()=>{
 const {output}=await produce('= Synthetic\n\n*demo pool {add|missing}* _<pool_name> [weight]_\n');
 assert.deepEqual(output.entries.filter(entry=>entry.kind==='definition').map(entry=>entry.path),['/commands/demo/pool/add']);
 const drift=output.entries.find(entry=>entry.data.form==='signature_drift')!;assert.deepEqual((drift.data.drift as {missing:string[]}).missing,['demo pool missing']);
 const definition=output.entries.find(entry=>entry.kind==='definition')!;assert.deepEqual(definition.data.signature_literals,[{primary:'demo pool add',alternatives:['demo pool add']}]);
});

test('an exact declared non-Latin tree path is accepted; script appearance alone never establishes identity',async()=>{
 const source='= Synthetic\n\n*查看 状态* _<名称>_\n';const compiled=await compile(source),mapped=toK1Model(compiled.model,compiled.composition,'cli');
 const native=compileGrammar([{path:'/commands/查看/状态',words:['查看','状态'],signatures:[{params:[{name:'名称',type:'string'}]}]}]);
 const known=produceAdocEntries(mapped,{name:'cli',catalog:native});assert.ok(known.ok);assert.equal(known.entries.find(entry=>entry.kind==='definition')?.path,'/commands/查看/状态');assert.equal(known.entries.find(entry=>entry.kind==='definition')?.data.parameters_verified,true);
 const unknown=produceAdocEntries(mapped,{name:'cli',catalog:grammar});assert.ok(unknown.ok);assert.ok(unknown.entries.every(entry=>entry.path?.startsWith('/manual/cli')));assert.ok(!unknown.entries.some(entry=>entry.data.form==='signature_drift'));
});

test('only actual inline nodes establish structure, including when passthrough markup encloses a real quoted node',async()=>{
 const source='= Synthetic\n\n== Body\n\npass:[<strong title=" ] *demo pool add* pass:[ ">missing command</strong>]\n\n*demo pool add* _<pool_name> [weight]_\n';
 const native=await load(source,{safe:'secure',sourcemap:true,attributes:{webfonts:false,reproducible:'',docfile:'book.adoc'}});
 const expected=await Promise.all(native.findBy({context:'paragraph'}).map(node=>node.getContent!()));
 const {compiled,output}=await produce(source);
 assert.deepEqual(compiled.model.blocks.filter(block=>block.kind==='paragraph').map(block=>block.converted),expected,'observing inline nodes does not change engine rendering');
 assert.deepEqual(compiled.model.blocks.filter(block=>block.kind==='section').map(block=>block.id),native.findBy({context:'section'}).map(node=>node.getId()??null));
 assert.ok(!JSON.stringify(compiled).includes('data-hub-inline'),'private observation identities never enter source, model or report');
 assert.deepEqual(output.entries.filter(entry=>entry.kind==='definition').map(entry=>entry.path),['/commands/demo/pool/add']);
 assert.ok(!output.entries.some(entry=>entry.data.form==='signature_drift'));
});

test('engine typography is preserved for display and never guessed back into a command identity',async()=>{
 const source='= Synthetic\n\n*demo -- flag*\n';const compiled=await compile(source),mapped=toK1Model(compiled.model,compiled.composition,'cli');
 const native=compileGrammar([{path:'/commands/demo/--/flag',words:['demo','--','flag'],signatures:[{params:[]}]}]);
 const produced=produceAdocEntries(mapped,{name:'cli',catalog:native});assert.ok(produced.ok);assert.equal(produced.entries.find(entry=>entry.kind==='definition')?.path,'/commands/demo/--/flag');
 const span=compiled.model.blocks.find(block=>block.kind==='paragraph')!.inline![0];assert.equal(span.text,'demo -- flag');assert.notEqual(span.rendered,span.text);
});

test('a signature uses whole-paragraph structure across whitespace and source boundaries with every original range cited once',async()=>{
 const main='= Synthetic\n\ninclude::command.adoc[]\ninclude::parameters.adoc[]\n',files={'book.adoc':main,'command.adoc':'*demo pool add*\n','parameters.adoc':'_<pool_name> [weight]_\n'};
 const compiled=await compileAdoc({main:'book.adoc',revision:'42',files:Object.fromEntries(Object.entries(files).map(([name,text])=>[name,{text,revision:'42',sha256:sha256(text)}]))});assert.ok(compiled.ok,JSON.stringify(compiled));
 const mapped=toK1Model(compiled.model,compiled.composition,'cli'),produced=produceAdocEntries(mapped,{name:'cli',catalog:grammar});assert.ok(produced.ok);
 const definitions=produced.entries.filter(entry=>entry.kind==='definition');assert.equal(definitions.length,1);assert.equal(definitions[0].path,'/commands/demo/pool/add');
 assert.deepEqual(definitions[0].fragments.map(fragment=>[fragment.source,fragment.selector]),[[sha256(files['command.adoc']),'l/1'],[sha256(files['parameters.adoc']),'l/1']]);
 assert.equal(produced.entries.length,1,'source splitting neither duplicates a definition nor drops its second source');
});
