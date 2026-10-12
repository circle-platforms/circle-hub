import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {executeTool,toolPackages} from '../../packages/connectors/src/tool-packages.ts';
import {HttpSource} from '../../packages/connectors/src/readonly-sdk.ts';
import {SourceCache} from '../../packages/connectors/src/source-cache.ts';
import {documentTree} from '../fixtures/document-tree.ts';
import {projectSource} from '../../packages/connectors/src/product-projections.ts';

test('Read repairs: mirror refuses an unfiltered table scan before HTTP and keywords require a product',async t=>{
  const fixture=await documentTree(t),profile={origin:fixture.origin};
  for(const args of [{},{keyword:'synthetic'},{assignedTo:'tester'},{product:0,status:'active'},{product:'APV',keyword:'synthetic'},{status:'all'}])await assert.rejects(executeTool('query-mirror','mirror.search',args,profile),(error:any)=>error.code==='INVALID_PAYLOAD'&&error.details.requiredFilters.includes('product'));
  assert.equal(fixture.requests.length,0);
  const schema=toolPackages.find(pack=>pack.id==='query-mirror')!.tools.find(tool=>tool.suffix==='bug_search')!.schema;
  assert.equal(schema.safeParse({keyword:'synthetic'}).success,false);
});

test('Read repairs: filtered mirror requests keep raw JWT, compact pages, and oversized sources are RESULT_TOO_LARGE',async t=>{
  const requests:any[]=[],server=createServer((req,res)=>{
    requests.push({url:req.url,authorization:req.headers.authorization});res.setHeader('content-type','application/json');
    if(req.url==='/plmquery/product/all/'){res.end(JSON.stringify({code:1000,data:[{id:9,name:'Synthetic product'}]}));return;}
    res.end(JSON.stringify({code:1000,data:Array.from({length:230},(_,i)=>({id:i,title:`Synthetic defect ${i}`,status:'active',product:9}))}));
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
  const origin=`http://127.0.0.1:${(server.address() as any).port}`,args={keyword:'defect',product:9,status:'active',page:2,limit:20};
  const result=await executeTool('query-mirror','mirror.search',args,{origin},'synthetic-jwt');
  assert.equal(requests[0].authorization,'synthetic-jwt');assert.match(requests[0].url,/product=9/);assert.doesNotMatch(requests[0].url,/page|limit|keyword/);
  assert.equal(result.result.items.length,20);assert.equal(result.result.items[0].id,20);assert.equal(result.result.total,230);assert.equal(result.result.nextPage,3);assert.ok(result.raw[0].bytes.length>JSON.stringify(result.result).length);
  const products=await executeTool('query-mirror','mirror.products',{}, {origin},'synthetic-jwt');assert.deepEqual(products.result.items,[{id:9,name:'Synthetic product'}]);assert.ok(products.raw[0].sha256);
  const projected=await projectSource('query-mirror',products.raw,{origin});assert.equal(projected.length,1);assert.equal(projected[0].entity.subject,'product:9');assert.equal(projected[0].predicate,'product-observation');
  await assert.rejects(new HttpSource(origin,{maxBytes:200} as any).read('/'),(error:any)=>error.code==='RESULT_TOO_LARGE'&&error.details.bound==='bytes');
});

test('Read repairs: document list uses configured root, pages large directories and rejects the site root with a usable hint',async t=>{
  const fixture=await documentTree(t),root='/webdav/cli/rel_photon_10_8/manuals/',profile={origin:fixture.origin,root};fixture.state.count=1018;
  const first=await executeTool('documents','document.list',{},profile);assert.equal(first.result.root,root);assert.equal(first.result.files.length,20);assert.equal(first.result.total,1018);assert.equal(first.result.nextPage,2);
  const second=await executeTool('documents','document.list',{page:2,limit:20},profile);assert.equal(second.result.files.length,20);assert.ok(!second.result.files.some((file:any)=>first.result.files.some((old:any)=>old.path===file.path)));
  const withoutSlash=await executeTool('documents','document.list',{path:root.slice(0,-1),page:2,limit:20},{...profile,root:'/webdav/'});assert.deepEqual(withoutSlash.result.files,second.result.files);assert.equal(withoutSlash.result.path,root);
  await assert.rejects(executeTool('documents','document.list',{path:'/'},profile),(error:any)=>error.code==='INVALID_PAYLOAD'&&error.details.root===root);
  assert.ok(!fixture.requests.some(req=>req.path==='/'));
  await assert.rejects(executeTool('documents','document.list',{path:`${root}invalid/`},profile),(error:any)=>error.code==='INVALID_PAYLOAD'&&error.details.httpStatus===405&&error.details.root===root);
});

test('Read repairs: spec-sized search resumes bounded pages, caches etags, reports incomplete coverage and detects stale or foreign cursors',async t=>{
  const fixture=await documentTree(t),path='/webdav/cli/rel_photon_10_8/manuals/',profile:any={origin:fixture.origin,root:'/webdav/',documents:fixture.policy},cache=new SourceCache();fixture.state.count=1018;
  const call=(args:any,namespace='owner')=>executeTool('documents','document.search',args,profile,undefined,{cache,cacheNamespace:namespace});
  const first=await call({query:'HTTP',path,limit:20});assert.equal(first.result.hits.length,20);assert.equal(first.result.coverage.totalFiles,1018);assert.equal(first.result.coverage.complete,false);assert.ok(first.result.nextCursor);assert.equal(fixture.requests.filter(req=>req.method==='GET').length,20);
  const second=await call({query:'HTTP',path,limit:20,after:first.result.nextCursor});assert.equal(second.result.hits.length,20);assert.ok(!second.result.hits.some((hit:any)=>first.result.hits.some((old:any)=>old.file===hit.file)));
  const count=fixture.requests.filter(req=>req.method==='GET').length;await call({query:'HTTP',path,limit:20});assert.equal(fixture.requests.filter(req=>req.method==='GET').length,count);
  await assert.rejects(call({query:'HTTP',path,after:first.result.nextCursor},'other'),(error:any)=>error.code==='INVALID_PAYLOAD');
  fixture.state.revision++;await assert.rejects(call({query:'HTTP',path,after:first.result.nextCursor}),(error:any)=>error.code==='INPUT_REVISION_STALE');
  for(const limit of [0,101])await assert.rejects(call({query:'HTTP',path,limit}));
});
