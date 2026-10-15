import assert from 'node:assert/strict';
import {test} from 'node:test';
import ExcelJS from 'exceljs';
import {compileMindmap} from '../../packs/apv/methods/mindmap.ts';
import {parseMindmap} from '../../packs/apv/methods/mindmap.ts';
import {verifyMindmapWorkbook} from '../../packs/apv/methods/mindmap-verify.ts';
import {boundedUnzip} from '../../packages/knowledge/src/zip.ts';
import {sha256} from '../../packages/contracts/src/index.ts';
import {zipSync,strFromU8,strToU8} from 'fflate';

test('The compatible compiler writes hub branding into the actual workbook bytes',async()=>{
 const original=Buffer.from(JSON.stringify([{rootTopic:{title:'Synthetic root',children:{attached:[{title:'Synthetic case'}]}}}]));
 const compiled=await compileMindmap(original,'synthetic.json');
 const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(compiled.workbook as any);
 assert.equal(workbook.creator,'circle-hub mindmap-compile');
});

test('Correct workbook rows cannot hide old, missing or ambiguous compiler identity',async()=>{
 const original=Buffer.from(JSON.stringify([{rootTopic:{title:'Synthetic root',children:{attached:[{title:'Synthetic group',children:{attached:[{title:'Synthetic case'}]}}]}}}]));
 const compiled=await compileMindmap(original,'synthetic.json'),source=parseMindmap(original,'synthetic.json');
 const parts=boundedUnzip(compiled.workbook,{maxBytes:64*1024*1024,maxEntries:512}),core=strFromU8(parts['docProps/core.xml']);
 const variants=[
  core.replace('circle-hub mindmap-compile','circle-server mindmap-compile'),
  core.replace(/<dc:creator>.*?<\/dc:creator>/,'<dc:creator>circle-hub mindmap-compile</dc:creator><dc:creator>circle-hub mindmap-compile</dc:creator>'),
  core.replace('circle-hub mindmap-compile','<nested>circle-hub mindmap-compile</nested>'),
  core.replace(/<\?xml[^?]*\?>/,'$&<!DOCTYPE cp:coreProperties []>'),
  undefined,
 ];
 for(const metadata of variants){
  const changed={...parts};if(metadata===undefined)delete changed['docProps/core.xml'];else changed['docProps/core.xml']=strToU8(metadata);
  await assert.rejects(verifyMindmapWorkbook(Buffer.from(zipSync(changed)),source,sha256(original)),(error:any)=>error.code==='ARTIFACT_VERIFICATION_FAILED');
 }
});
