import assert from 'node:assert/strict';
import {test} from 'node:test';
import {zipSync,strToU8,type ZipOptions,type Zippable} from 'fflate';
import {verifiedContent} from './content.ts';
import {sha256Hex,scanForCredentials} from '../records/api.ts';
function workbook(extra:Record<string,Uint8Array>={},options:ZipOptions={},memberOptions?:ZipOptions){
 const s='http://schemas.openxmlformats.org/spreadsheetml/2006/main',r='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
 const files:Zippable=Object.fromEntries(Object.entries({'[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>','_rels/.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="book" Type="${r}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,'xl/workbook.xml':`<workbook xmlns="${s}" xmlns:r="${r}"><sheets><sheet name="Synthetic" sheetId="1" r:id="sheet"/></sheets></workbook>`,'xl/_rels/workbook.xml.rels':`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="sheet" Type="${r}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,'xl/worksheets/sheet1.xml':`<worksheet xmlns="${s}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>synthetic safe value</t></is></c></row></sheetData></worksheet>`}).map(([key,value]):[string,Uint8Array]=>[key,strToU8(value)]).concat(Object.entries(extra)));
 if(memberOptions)for(const name of Object.keys(files))files[name]=[files[name] as Uint8Array,memberOptions];
 return zipSync(files,{level:6,...options});
}
test('an uninspected XLSX is fully parsed and every member checked before it passes',()=>{const bytes=workbook();assert.equal(scanForCredentials(bytes).inspected,false);assert.equal(verifiedContent(bytes,sha256Hex(bytes),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),true);assert.equal(verifiedContent(bytes,'f'.repeat(64),'application/octet-stream'),false);});
test('opaque XML credentials and uninspectable binary members are not hidden by the workbook model',()=>{for(const extra of ([{'docProps/opaque.xml':strToU8('<note>password&#61;SyntheticOpaqueKey83642</note>')},{'xl/media/opaque.bin':new Uint8Array([0,1,2,3,4,5,6,7,8,9])}] as Record<string,Uint8Array>[])){const bytes=workbook(extra);assert.equal(verifiedContent(bytes,sha256Hex(bytes),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),false);}});

for(const place of ['archive comment','member comment','extra field'])test(`outbound container rejects opaque ${place} while ordinary parsing remains available`,async()=>{
 const text='password=SyntheticContainerMetadata83642';
 const bytes=place==='archive comment'?workbook({}, {comment:text}):place==='member comment'?workbook({}, {}, {comment:text}):workbook({}, {}, {extra:{65534:strToU8(text)}});
 const {recognize,createDefaultRegistry}=await import('../refs/api.ts');assert.ok(recognize(createDefaultRegistry(),bytes,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
 assert.equal(verifiedContent(bytes,sha256Hex(bytes),'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),false);
});
