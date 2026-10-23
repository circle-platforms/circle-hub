// Synthetic ZIP/XML vectors are generated here; an existing independent writer supplies one interoperability check.
import assert from 'node:assert/strict';
import { crc32, deflateRawSync } from 'node:zlib';
import { test } from 'node:test';
import { ParseError, ParseLimitError } from '../parser.ts';
import { readXlsxArchive, XLSX_ZIP_LIMITS } from './xlsx.ts';

type Member = { name: string; text?: string; bytes?: Buffer; method?: number; flags?: number; size?: number; crc?: number; extra?: Buffer; localExtra?: Buffer; nameBytes?: Buffer; attributes?: number; descriptor?: boolean; compressed?: Buffer };
function zip(members: Member[]): Buffer {
  const local: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const member of members) {
    const name = member.nameBytes ?? Buffer.from(member.name); const bytes = member.bytes ?? Buffer.from(member.text ?? '<synthetic/>');
    const method = member.method ?? 0; const flags = member.flags ?? 0x800; const extra = member.extra ?? Buffer.alloc(0); const localExtra = member.localExtra ?? extra;
    const compressed = member.compressed ?? (method === 8 ? deflateRawSync(bytes) : bytes);
    const crc = member.crc ?? crc32(bytes); const size = member.size ?? bytes.length;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(name.length, 26); header.writeUInt16LE(localExtra.length, 28);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(flags, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(size, 24); directory.writeUInt16LE(name.length, 28); directory.writeUInt16LE(extra.length, 30); directory.writeUInt32LE(member.attributes ?? 0, 38); directory.writeUInt32LE(offset, 42);
    const descriptor = member.descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (member.descriptor) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(size, 12); header.fill(0, 14, 26); }
    local.push(header, name, localExtra, compressed, descriptor); central.push(directory, name, extra); offset += 30 + name.length + localExtra.length + compressed.length + descriptor.length;
  }
  const directory = Buffer.concat(central); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function refuses(bytes: Uint8Array, pattern: RegExp): void {
  assert.throws(() => readXlsxArchive(bytes), (error: unknown) => error instanceof ParseError && error.parser === 'xlsx@1' && pattern.test(error.message));
}

test('ZIP stored and deflated members preserve bytes without writing files', () => {
  for (const method of [0, 8]) {
    const archive = readXlsxArchive(zip([{ name: 'synthetic.xml', text: '<text>合成 &amp; text</text>', method }]));
    assert.equal(Buffer.from(archive.get('synthetic.xml')!).toString(), '<text>合成 &amp; text</text>');
  }
});
test('ZIP input bytes, member count, declared expansion and compression ratio have separate reasons', () => {
  assert.throws(() => readXlsxArchive(Buffer.alloc(XLSX_ZIP_LIMITS.maxBytes + 1)), (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxBytes');
  refuses(zip(Array.from({ length: XLSX_ZIP_LIMITS.maxMembers + 1 }, (_, i) => ({ name: `member-${i}.xml` }))), /成员数/);
  refuses(zip([{ name: 'large.xml', size: XLSX_ZIP_LIMITS.maxExpandedBytes + 1 }]), /解压后的总量/);
  refuses(zip([{ name: 'bomb.xml', bytes: Buffer.alloc(1024 * 1024, 65), method: 8 }]), /解压比/);
});
test('ZIP rejects unsafe paths, encryption, duplicate members and symbolic links', () => {
  for (const name of ['/absolute.xml', '../escape.xml', 'a/../escape.xml', 'C:/escape.xml', 'a\\escape.xml', 'a//b.xml', './a.xml', 'a\0.xml']) refuses(zip([{ name }]), /路径/);
  for (const flags of [1, 0x40, 0x2000]) refuses(zip([{ name: 'a.xml', flags }]), /加密/);
  refuses(zip([{ name: 'a.xml' }, { name: 'a.xml' }]), /重复/);
  refuses(zip([{ name: 'a.xml', attributes: (0xa000 << 16) >>> 0 }]), /链接|普通文件|特殊文件/);
});
test('ZIP rejects invalid methods, malformed descriptors and multi-disk records', () => {
  refuses(zip([{ name: 'a.xml', method: 99 }]), /压缩方法/);
  refuses(zip([{ name: 'a.xml', flags: 8 }]), /描述符|附加/);
  assert.equal(readXlsxArchive(zip([{ name: 'a.xml', extra: Buffer.alloc(4) }])).size, 1);
  const multi = zip([{ name: 'a.xml' }]); multi.writeUInt16LE(1, multi.length - 18); refuses(multi, /分卷/);
  const zip64 = zip([{ name: 'a.xml', size: 0xffffffff }]); refuses(zip64, /ZIP64/);
});
test('ZIP verifies local headers, central directory, CRC, output size and complete compressed streams', () => {
  refuses(zip([{ name: 'a.xml', crc: 0 }]), /CRC/);
  const mismatch = zip([{ name: 'a.xml' }]); mismatch[6] ^= 1; refuses(mismatch, /加密|不一致/);
  refuses(zip([{ name: 'a.xml', text: 'abc', size: 4 }]), /大小/);
  refuses(zip([{ name: 'a.xml', text: 'abc', method: 8, size: 2 }]), /解压|大小/);
  for (const length of [0, 10, 21, 30]) refuses(zip([{ name: 'a.xml' }]).subarray(0, length), /ZIP/);
  const central = zip([{ name: 'a.xml' }]); central.writeUInt32LE(0xffffffff, central.length - 6); refuses(central, /ZIP64|目录/);
  const offset = zip([{ name: 'a.xml' }]); const start = offset.readUInt32LE(offset.length - 6); offset.writeUInt32LE(1, start + 42); refuses(offset, /本地|连续/);
  refuses(Buffer.concat([zip([{ name: 'a.xml' }]), Buffer.from('trailing')]), /ZIP/);
});


test('ZIP accepts comments, timestamp extras, data descriptors and bounded ZIP64 directories', () => {
  const bytes = zip([{ name: 'a.xml', text: '<synthetic/>', flags: 0x808, method: 8, descriptor: true }]);
  assert.equal(readXlsxArchive(bytes).size, 1);
  const commented = zip([{ name: 'a.xml' }]); commented.writeUInt16LE(7, commented.length - 2);
  assert.equal(readXlsxArchive(Buffer.concat([commented, Buffer.from('comment')])).size, 1);
  const base = zip([{ name: 'a.xml' }]); const end = base.subarray(-22); const at = base.length - 22;
  const record = Buffer.alloc(56); record.writeUInt32LE(0x06064b50); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 14); record.writeBigUInt64LE(1n, 24); record.writeBigUInt64LE(1n, 32); record.writeBigUInt64LE(BigInt(end.readUInt32LE(12)), 40); record.writeBigUInt64LE(BigInt(end.readUInt32LE(16)), 48);
  const locator = Buffer.alloc(20); locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(at), 8); locator.writeUInt32LE(1, 16);
  end.writeUInt16LE(0xffff, 8); end.writeUInt16LE(0xffff, 10); end.writeUInt32LE(0xffffffff, 12); end.writeUInt32LE(0xffffffff, 16);
  assert.equal(readXlsxArchive(Buffer.concat([base.subarray(0, -22), record, locator, end])).size, 1);
});
test('ZIP bounds single and cumulative declarations before allocating expanded output', () => {
  refuses(zip([{ name: 'single.xml', size: XLSX_ZIP_LIMITS.maxMemberBytes + 1 }]), /单个成员解压量/);
  refuses(zip(Array.from({ length: 3 }, (_, i) => ({ name: `large-${i}.xml`, bytes: Buffer.alloc(128 * 1024), size: 12 * 1024 * 1024 }))), /解压后的总量/);
  refuses(zip([{ name: 'a.xml', method: 8, text: 'abc', compressed: Buffer.concat([deflateRawSync(Buffer.from('abc')), Buffer.from('garbage')]) }]), /未消费/);
});

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
function workbook(options: { book?: string; sheet?: string; shared?: string; extra?: Member[]; relations?: string; types?: string } = {}): Buffer {
  return zip([
    { name: '[Content_Types].xml', text: options.types ?? `<Types xmlns="${TYPES}"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="bin" ContentType="application/octet-stream"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>` },
    { name: '_rels/.rels', text: `<Relationships xmlns="${PKG_REL}"><Relationship Id="root" Type="${DOC_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', text: options.book ?? `<workbook xmlns="${MAIN}" xmlns:r="${DOC_REL}"><sheets><sheet name="合成表" sheetId="1" r:id="sheet"/></sheets><definedNames><definedName name="合成区域">'合成表'!$A$1:$B$1</definedName></definedNames></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', text: `<Relationships xmlns="${PKG_REL}"><Relationship Id="sheet" Type="${DOC_REL}/worksheet" Target="worksheets/sheet1.xml"/>${options.shared === undefined ? '' : `<Relationship Id="shared" Type="${DOC_REL}/sharedStrings" Target="sharedStrings.xml"/>`}${options.relations ?? ''}</Relationships>` },
    { name: 'xl/worksheets/sheet1.xml', text: options.sheet ?? `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>合成文本 &amp; 空白 </t></is></c><c r="B1"><v>10.7</v></c></row></sheetData></worksheet>` },
    ...(options.shared === undefined ? [] : [{ name: 'xl/sharedStrings.xml', text: options.shared }]), ...(options.extra ?? []),
  ]);
}
// Kept here to exercise the module directly without extending refs/api.ts beyond this task's paths.
import { xlsxParser } from './xlsx.ts';
const parseWorkbook = (options: Parameters<typeof workbook>[0] = {}) => xlsxParser.parse(workbook(options));
const badWorkbook = (options: Parameters<typeof workbook>[0], reason: RegExp) => assert.throws(() => parseWorkbook(options), (e: unknown) => e instanceof ParseError && e.parser === 'xlsx@1' && reason.test(e.message));

test('xlsx@1 gives cells, member types, names and deterministic selectors without content in its summary', () => {
  const bytes = workbook(); const document = xlsxParser.parse(bytes);
  assert.deepEqual(document.model, xlsxParser.parse(bytes).model);
  assert.equal(document.model.sheets[0].name, '合成表');
  assert.equal(document.model.sheets[0].state, 'visible');
  assert.deepEqual(document.model.sheets[0].rows[0].cells, [
    { reference: 'A1', type: 'inlineStr', text: '合成文本 & 空白 ', formula: false, style: null },
    { reference: 'B1', type: 'n', text: '10.7', formula: false, style: null },
  ]);
  assert.equal(document.model.sheets[0].lastRow, 1);
  assert.deepEqual(document.model.definedNames, [{ name: '合成区域', scope: null, reference: "'合成表'!$A$1:$B$1" }]);
  assert.equal(document.model.members.find((member) => member.name === 'xl/workbook.xml')?.contentType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml');
  assert.equal(document.locate('c/0/A1')?.text, '合成文本 & 空白 ');
  assert.equal(document.locate('n/0')?.text, "'合成表'!$A$1:$B$1");
  assert.equal(document.locate('c/0/A1')?.byteRange, null);
  for (const selector of document.listSelectors()) assert.equal(document.locate(selector)?.selector, selector);
  for (const invalid of ['c/99/A1', 'c/0/Z999', 'n/99', 'c/00/A1', '%zz', 'n/-1', '__proto__', '']) assert.equal(document.locate(invalid), null);
  assert.deepEqual(document.listSelectors('c/', { limit: 1 }), ['c/0/A1']);
  assert.doesNotMatch(JSON.stringify(document.summary()), /合成文本|合成表|合成区域|10\.7/);
});
test('xlsx@1 preserves shared and rich strings, formula flags and cached values, literal equals and cell styles', () => {
  const document = parseWorkbook({
    shared: `<sst xmlns="${MAIN}"><si><r><t>共享</t></r><r><t>文本</t></r><rPh><t>phonetic</t></rPh></si></sst>`,
    sheet: `<worksheet xmlns="${MAIN}"><dimension ref="A1:XFD9999"/><sheetData><row r="2" hidden="1"><c r="A2" t="s" s="3"><v>0</v></c><c r="B2" t="str"><f>SUM(1,2)</f><v>3</v></c><c r="C2" t="inlineStr"><is><t>=合成字面值</t></is></c><c r="D2" t="b"><v>1</v></c><c r="E2" t="e"><v>#N/A</v></c></row><row r="10"><c r="J10" s="4"/></row><row r="100" hidden="false"/></sheetData></worksheet>`,
  });
  assert.deepEqual(document.model.sharedStrings, ['共享文本']);
  const sheet = document.model.sheets[0]; assert.equal(sheet.rows[0].hidden, true); assert.equal(sheet.rows[2].hidden, false);
  assert.equal(sheet.rows[0].cells[0].text, '共享文本'); assert.equal(sheet.rows[0].cells[0].style, 3);
  assert.equal(sheet.rows[0].cells[1].formula, true); assert.equal(sheet.rows[0].cells[1].text, '3');
  assert.equal(sheet.rows[0].cells[2].text, '=合成字面值');
  assert.equal(sheet.lastRow, 10); assert.equal(sheet.rows[1].cells[0].text, '');
  assert.equal(document.summary().formulas, 1); assert.equal(document.summary().hiddenRows, 1);
});
test('xlsx@1 keeps multiple and hidden sheets, local names, opaque parts, macros and external relationships as data', () => {
  const document = parseWorkbook({
    book: `<workbook xmlns="${MAIN}" xmlns:r="${DOC_REL}"><sheets><sheet name="甲" sheetId="1" r:id="sheet" state="hidden"/><sheet name="乙" sheetId="2" r:id="second" state="veryHidden"/></sheets><definedNames><definedName name="区域" localSheetId="0">甲!$A$1</definedName><definedName name="区域" localSheetId="1">乙!$A$1</definedName></definedNames></workbook>`,
    relations: `<Relationship Id="second" Type="${DOC_REL}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="outside" Type="${DOC_REL}/externalLink" Target="http://192.0.2.1/never-follow" TargetMode="External"/>`,
    extra: [{ name: 'xl/worksheets/sheet2.xml', text: `<worksheet xmlns="${MAIN}"><sheetData/></worksheet>` }, { name: 'xl/styles.xml', text: '<opaque/>' }, { name: 'xl/theme/theme1.xml', text: '<opaque/>' }, { name: 'docProps/core.xml', text: '<opaque/>' }, { name: 'xl/vbaProject.bin', bytes: Buffer.from([0, 1, 2, 3]) }],
  });
  assert.deepEqual(document.model.sheets.map((s) => [s.name, s.state, s.lastRow]), [['甲', 'hidden', 1], ['乙', 'veryHidden', 0]]);
  assert.deepEqual(document.model.definedNames.map((n) => n.scope), [0, 1]);
  assert.equal(document.model.members.length, 10); assert.ok(document.model.members.some((m) => m.name.endsWith('vbaProject.bin')));
  assert.ok(document.model.relationships.some((r) => r.external && r.target === 'http://192.0.2.1/never-follow'));
});
test('xlsx@1 refuses missing workbook parts, broken relationships and missing shared strings', () => {
  badWorkbook({ relations: `<Relationship Id="missing" Type="${DOC_REL}/styles" Target="absent.xml"/>` }, /关系.*不存在|断链/);
  badWorkbook({ sheet: `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>` }, /共享字符串/);
  badWorkbook({ types: '<wrong/>' }, /内容类型|部件/);
  const missing = zip([{ name: 'synthetic.xml', text: '<synthetic/>' }]);
  assert.throws(() => xlsxParser.parse(missing), /部件/);
});
test('xlsx@1 refuses XML repairs and entity declarations rather than accepting altered facts', () => {
  badWorkbook({ sheet: `<worksheet xmlns="${MAIN}"><sheetData><row r=1></row></sheetData></worksheet>` }, /修复|不规范/);
  badWorkbook({ sheet: `<worksheet xmlns="${MAIN}"><sheetData><row r="1" r="2"/></sheetData></worksheet>` }, /修复|不规范/);
  badWorkbook({ extra: [{ name: 'xl/styles.xml', text: '<style a="bad\0value"/>' }] }, /修复|不规范/);
  badWorkbook({ extra: [{ name: 'xl/styles.xml', text: '<!DOCTYPE a [<!ENTITY x SYSTEM "http://192.0.2.1/private">]><a>&x;</a>' }] }, /DOCTYPE|实体/);
});


test('xlsx@1 decodes escaped strings once and preserves their whitespace and literal underscore forms', () => {
  const document = parseWorkbook({ sheet: `<worksheet xmlns="${MAIN}"><sheetData><row><c t="inlineStr"><is><t>甲_x000D_乙_x005F_x0041_ &amp; 🧪</t></is></c><c t="str"><v>_xD83D__xDE00_</v></c></row></sheetData></worksheet>` });
  assert.equal(document.model.sheets[0].rows[0].cells[0].text, '甲\r乙_x0041_ & 🧪');
  assert.equal(document.model.sheets[0].rows[0].cells[1].text, '😀');
  assert.equal(document.model.sheets[0].rows[0].number, 1);
  assert.equal(document.model.sheets[0].rows[0].cells[0].reference, 'A1');
  assert.equal(document.model.sheets[0].rows[0].cells[1].reference, 'B1');
});
test('xlsx@1 resolves namespace prefixes and parent-relative package relationships', () => {
  const document = parseWorkbook({ book: `<s:workbook xmlns:s="${MAIN}" xmlns:q="${DOC_REL}"><s:sheets><s:sheet name="前缀" sheetId="1" q:id="sheet"/></s:sheets></s:workbook>`, sheet: `<s:worksheet xmlns:s="${MAIN}"><s:sheetData><s:row r="1"><s:c r="A1" t="inlineStr"><s:is><s:r><s:t>甲</s:t></s:r><s:r><s:t>乙</s:t></s:r></s:is></s:c></s:row></s:sheetData></s:worksheet>`, relations: `<Relationship Id="styles" Type="${DOC_REL}/styles" Target="../styles.xml"/>`, extra: [{ name: 'styles.xml', text: '<opaque/>' }] });
  assert.equal(document.locate('c/0/A1')?.text, '甲乙');
  assert.ok(document.model.relationships.some((r) => r.target === '../styles.xml'));
});
test('xlsx@1 limits XML structure and selectors and refuses undeclared prefixes and out-of-range shared indices', () => {
  assert.throws(() => xlsxParser.parse(workbook(), { maxNodes: 2 }), ParseLimitError);
  assert.throws(() => xlsxParser.parse(workbook(), { maxSelectorChars: 1 }), ParseLimitError);
  assert.throws(() => xlsxParser.parse(workbook(), { maxBytes: 1 }), ParseLimitError);
  badWorkbook({ sheet: '<wrong:worksheet/>' }, /前缀/);
  badWorkbook({ shared: `<sst xmlns="${MAIN}"><si><t>合成</t></si></sst>`, sheet: `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="s"><v>7</v></c></row></sheetData></worksheet>` }, /共享字符串/);
});
test('xlsx@1 retains duplicate coordinate occurrences with unambiguous positional selectors', () => {
  const document = parseWorkbook({ sheet: `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="A1"><v>2</v></c></row></sheetData></worksheet>` });
  assert.deepEqual(document.listSelectors('i/'), ['i/0/0/0', 'i/0/0/1']);
  assert.equal(document.locate('i/0/0/0')?.text, '1'); assert.equal(document.locate('i/0/0/1')?.text, '2');
});

test('xlsx@1 parses a freshly generated workbook from the existing independent ExcelJS writer', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('独立合成');
  sheet.getCell('A1').value = '共享合成文本'; sheet.getCell('B1').value = 10.7;
  sheet.getRow(2).hidden = true; sheet.getCell('C2').value = { formula: '1+2', result: 3 };
  sheet.getCell('A10').font = { bold: true };
  book.addWorksheet('隐藏合成', { state: 'hidden' }); book.definedNames.add("'独立合成'!$A$1", '合成名');
  const bytes = Buffer.from(await book.xlsx.writeBuffer()); const document = xlsxParser.parse(bytes);
  assert.equal(document.locate('c/0/A1')?.text, '共享合成文本'); assert.equal(document.locate('c/0/B1')?.text, '10.7');
  assert.equal(document.model.sheets[0].rows.find((row) => row.number === 2)?.hidden, true);
  assert.equal((document.locate('c/0/C2')?.data as { formula: boolean }).formula, true);
  assert.equal(document.model.sheets[0].lastRow, 10); assert.equal(document.model.sheets[1].state, 'hidden');
  assert.ok(document.model.members.some((member) => member.name === 'xl/styles.xml'));
  assert.ok(document.model.definedNames.some((name) => name.name === '合成名'));
  assert.deepEqual(document.model, xlsxParser.parse(bytes).model);
});
test('xlsx@1 rejects random and corrupted containers only with typed deterministic parse errors', () => {
  let seed = 2197; const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const base = workbook();
  for (let i = 0; i < 800; i++) {
    const bytes = i % 2 ? Buffer.from(base) : Buffer.from(Array.from({ length: random(512) }, () => random(256)));
    if (i % 2) for (let j = 0; j < 1 + random(4); j++) bytes[random(bytes.length)] ^= 1 << random(8);
    try { const document = xlsxParser.parse(bytes); for (const selector of document.listSelectors()) assert.ok(document.locate(selector)); }
    catch (error) { assert.ok(error instanceof ParseError, String(error)); assert.equal(error.parser, 'xlsx@1'); }
  }
});


test('xlsx@1 follows workbook relationships instead of assuming workbook and worksheet part paths', () => {
  const moved = [...readXlsxArchive(workbook())].map(([name, bytes]) => ({
    name: name.replace('xl/workbook.xml', 'data/book.xml').replace('xl/_rels/workbook.xml.rels', 'data/_rels/book.xml.rels').replace('xl/worksheets/', 'data/worksheets/'),
    text: bytes.toString().replaceAll('xl/workbook.xml', 'data/book.xml'),
  }));
  const document = xlsxParser.parse(zip(moved));
  assert.equal(document.model.sheets[0].part, 'data/worksheets/sheet1.xml'); assert.equal(document.locate('c/0/A1')?.text, '合成文本 & 空白 ');
});
test('xlsx@1 accepts Strict namespaces and refuses a worksheet with a foreign namespace', () => {
  const strict = [...readXlsxArchive(workbook())].map(([name, bytes]) => ({ name, text: bytes.toString().replaceAll(MAIN, 'http://purl.oclc.org/ooxml/spreadsheetml/main').replaceAll(DOC_REL, 'http://purl.oclc.org/ooxml/officeDocument/relationships') }));
  assert.equal(xlsxParser.parse(zip(strict)).locate('c/0/B1')?.text, '10.7');
  badWorkbook({ sheet: '<worksheet xmlns="urn:synthetic:foreign"><sheetData/></worksheet>' }, /工作表部件/);
});

test('the registered XLSX parser is selected by upload extension, while non-ZIP bytes are never recognized', async () => {
  const { createDefaultRegistry, recognize } = await import('../api.ts');
  const { mediaTypeFor, structureOf } = await import('../../server/upload.ts');
  const registry = createDefaultRegistry(); const bytes = workbook();
  const mediaType = mediaTypeFor(bytes, undefined, 'synthetic.XLSX');
  assert.equal(mediaType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(registry.get('xlsx@1')?.id, 'xlsx');
  assert.equal(structureOf(registry, bytes, mediaType)?.parser, 'xlsx@1');
  assert.equal(recognize(registry, Buffer.from('not a zip'), mediaType), null);
  assert.equal(mediaTypeFor(bytes, 'application/octet-stream', 'synthetic.xlsx'), 'application/octet-stream');
  assert.equal(mediaTypeFor(bytes, undefined, undefined), 'application/octet-stream');
});

test('xlsx@1 also checks XML declared by a case-insensitive media type with parameters', () => {
  badWorkbook({ types: `<Types xmlns="${TYPES}"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="bin" ContentType="Application/XML; charset=UTF-8"/></Types>`, extra: [{ name: 'opaque.bin', text: '<a x="1" x="2"/>' }] }, /修复|不规范/);
});
test('ZIP legacy filename decoding covers all CP437 byte values without dropping a path character', () => {
  for (let i = 128; i <= 255; i++) {
    const bytes = zip([{ name: 'a.xml', flags: 0 }]); bytes[30] = i; const central = bytes.readUInt32LE(bytes.length - 6); bytes[central + 46] = i;
    const name = [...readXlsxArchive(bytes).keys()][0]; assert.equal(name.length, 5);
    if (i === 0x82) assert.equal(name, 'é.xml'); if (i === 0xff) assert.equal(name, '\u00a0.xml');
  }
});

test('xlsx rejects repeated resolved sheet parts before rebuilding their cell models', () => {
  const book = `<workbook xmlns="${MAIN}" xmlns:r="${DOC_REL}"><sheets>${Array.from({ length: 64 }, (_, i) => `<sheet name="S${i}" sheetId="${i + 1}" r:id="sheet"/>`).join('')}</sheets></workbook>`;
  const sheet = `<worksheet xmlns="${MAIN}"><sheetData><row r="1">${'<c r="A1"><v>1</v></c>'.repeat(256)}</row></sheetData></worksheet>`;
  badWorkbook({ book, sheet }, /工作表.*同一个部件/);
});

test('five thousand sheets sharing one part are refused within a bounded parse time', { timeout: 5000 }, () => {
  const book = `<workbook xmlns="${MAIN}" xmlns:r="${DOC_REL}"><sheets>${Array.from({ length: 5000 }, (_, i) => `<sheet name="S${i}" sheetId="${i + 1}" r:id="sheet"/>`).join('')}</sheets></workbook>`;
  const started = performance.now();
  badWorkbook({ book }, /工作表.*同一个部件/);
  assert.ok(performance.now() - started < 2000);
});

function unicodePath(name: Buffer | string, replacement: string): Buffer {
  const path = Buffer.from(replacement); const field = Buffer.alloc(9 + path.length);
  field.writeUInt16LE(0x7075); field.writeUInt16LE(5 + path.length, 2); field[4] = 1;
  field.writeUInt32LE(crc32(typeof name === 'string' ? Buffer.from(name) : name), 5); path.copy(field, 9); return field;
}
test('Unicode path metadata cannot conceal raw unsafe names, duplicates or a different local-header identity', () => {
  const unsafe = '..\\..\\evil.xml';
  refuses(zip([{ name: unsafe, extra: unicodePath(unsafe, 'safe.xml') }]), /路径/);
  refuses(zip([{ name: 'a.xml' }, { name: 'a.xml', extra: unicodePath('a.xml', 'b.xml') }]), /重复|路径.*不一致/);
  refuses(zip([{ name: 'a.xml', localExtra: unicodePath('a.xml', 'b.xml') }]), /路径.*不一致/);
  assert.equal(readXlsxArchive(zip([{ name: 'a.xml', extra: unicodePath('a.xml', 'a.xml') }])).size, 1);
});

test('resolved shared-string text has a separate aggregate cell-model budget before serialization', { timeout: 5000 }, () => {
  const shared = `<sst xmlns="${MAIN}"><si><t>${'x'.repeat(100000)}</t></si></sst>`;
  const sheet = `<worksheet xmlns="${MAIN}"><sheetData><row r="1">${'<c r="A1" t="s"><v>0</v></c>'.repeat(400)}</row></sheetData></worksheet>`;
  badWorkbook({ shared, sheet }, /模型.*单元格文本.*上限/);
});

test('decoded NULs are removed and counted once at their source in cells, sheet names and defined names', () => {
  const document = parseWorkbook({ book: `<workbook xmlns="${MAIN}" xmlns:r="${DOC_REL}"><sheets><sheet name="S_x0000_" sheetId="1" r:id="sheet"/></sheets><definedNames><definedName name="N_x0000_">S!A1</definedName></definedNames></workbook>`, sheet: `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a_x0000_b</t></is></c></row></sheetData></worksheet>` });
  assert.equal(document.model.sheets[0].name, 'S'); assert.equal(document.model.definedNames[0].name, 'N');
  assert.equal(document.model.sheets[0].rows[0].cells[0].text, 'ab');
  assert.equal(document.model.nulRemoved, 3); assert.equal(document.summary().nulRemoved, 3);
  assert.ok(!JSON.stringify(document.model).includes('\\u0000'));
});
