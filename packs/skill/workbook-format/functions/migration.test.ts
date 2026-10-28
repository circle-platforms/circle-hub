import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { xlsxParser } from './xlsx.ts';
import { originalCore, MIGRATION_TEST } from '../testing/baseline.ts';

type Member = { name: string; text?: string; bytes?: Buffer; method?: number; flags?: number; size?: number; crc?: number; extra?: Buffer; localExtra?: Buffer };

function zip(members: Member[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name);
    const bytes = member.bytes ?? Buffer.from(member.text ?? '<synthetic/>');
    const method = member.method ?? 0;
    const flags = member.flags ?? 0x800;
    const extra = member.extra ?? Buffer.alloc(0);
    const localExtra = member.localExtra ?? extra;
    const compressed = method === 8 ? deflateRawSync(bytes) : bytes;
    const crc = member.crc ?? crc32(bytes);
    const size = member.size ?? bytes.length;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(localExtra.length, 28);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(flags, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(size, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(extra.length, 30);
    directory.writeUInt32LE(0, 38);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, localExtra, compressed);
    central.push(directory, name, extra);
    offset += 30 + name.length + localExtra.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';

function makeWorkbook(options: { book?: string; sheet?: string; shared?: string; extra?: Member[]; relations?: string; types?: string } = {}): Buffer {
  return zip([
    { name: '[Content_Types].xml', text: options.types ?? `<Types xmlns="${TYPES}"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>` },
    { name: '_rels/.rels', text: `<Relationships xmlns="${PKG_REL}"><Relationship Id="root" Type="${DOC_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', text: options.book ?? `<workbook xmlns="${MAIN}" xmlns:r="${DOC_REL}"><sheets><sheet name="合成表" sheetId="1" r:id="sheet"/></sheets><definedNames><definedName name="合成区域">'合成表'!$A$1:$B$1</definedName></definedNames></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', text: `<Relationships xmlns="${PKG_REL}"><Relationship Id="sheet" Type="${DOC_REL}/worksheet" Target="worksheets/sheet1.xml"/>${options.shared === undefined ? '' : `<Relationship Id="shared" Type="${DOC_REL}/sharedStrings" Target="sharedStrings.xml"/>`}${options.relations ?? ''}</Relationships>` },
    { name: 'xl/worksheets/sheet1.xml', text: options.sheet ?? `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>合成文本 &amp; 空白 </t></is></c><c r="B1"><v>10.7</v></c></row></sheetData></worksheet>` },
    ...(options.shared === undefined ? [] : [{ name: 'xl/sharedStrings.xml', text: options.shared }]),
    ...(options.extra ?? []),
  ]);
}

test(MIGRATION_TEST, async (t) => {
  const baseline = await originalCore();
  t.after(() => baseline.close());

  let passed = 0;
  let rejected = 0;

  const check = (bytes: Uint8Array, label: string) => {
    let expected: ReturnType<typeof baseline.parser.parse> | undefined;
    let baselineError: unknown;
    try {
      expected = baseline.parser.parse(bytes);
    } catch (e) {
      baselineError = e;
    }

    let actual: ReturnType<typeof xlsxParser.parse> | undefined;
    let actualError: unknown;
    try {
      actual = xlsxParser.parse(bytes);
    } catch (e) {
      actualError = e;
    }

    if (baselineError) {
      assert.ok(actualError, `${label} should also fail`);
      assert.equal((actualError as Error).name, (baselineError as Error).name, `${label} error name`);
      assert.equal((actualError as Error).message, (baselineError as Error).message, `${label} error message`);
      rejected++;
    } else {
      assert.ok(!actualError, `${label} unexpected error: ${(actualError as Error)?.message}`);
      assert.equal(JSON.stringify(actual!.model), JSON.stringify(expected!.model), `${label} model mismatch`);
      assert.equal(JSON.stringify(actual!.summary()), JSON.stringify(expected!.summary()), `${label} summary mismatch`);
      assert.deepEqual(actual!.listSelectors('', { properties: true }), expected!.listSelectors('', { properties: true }), `${label} selectors mismatch`);
      for (const sel of actual!.listSelectors('')) {
        assert.deepEqual(actual!.locate(sel), expected!.locate(sel), `${label} locate(${sel}) mismatch`);
      }
      passed++;
    }
  };

  // 1. Basic synthetic workbook
  check(makeWorkbook(), 'basic synthetic workbook');

  // 2. Shared strings workbook
  check(makeWorkbook({
    shared: `<sst xmlns="${MAIN}"><si><t>共享第一条</t></si><si><t>共享第二条 &amp; 标点</t></si><si><r><t>富文本</t></r><r><t>片段</t></r></si></sst>`,
    sheet: `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row></sheetData></worksheet>`,
  }), 'shared strings workbook');

  // 3. Multi-sheet with formulas, booleans, errors and custom heights
  check(makeWorkbook({
    book: `<workbook xmlns="${MAIN}" xmlns:r="${DOC_REL}"><sheets><sheet name="表一" sheetId="1" r:id="sheet"/><sheet name="表二" sheetId="2" r:id="s2" state="hidden"/></sheets><definedNames><definedName name="全局名">'表一'!$A$1</definedName><definedName name="局部名" localSheetId="0">'表一'!$B$1</definedName></definedNames></workbook>`,
    relations: `<Relationship Id="s2" Type="${DOC_REL}/worksheet" Target="worksheets/sheet2.xml"/>`,
    sheet: `<worksheet xmlns="${MAIN}"><sheetData><row r="1" ht="28" customHeight="1"><c r="A1"><f>SUM(B1:B2)</f><v>30</v></c><c r="B1" t="b"><v>1</v></c><c r="C1" t="e"><v>#N/A</v></c></row></sheetData></worksheet>`,
    extra: [
      { name: 'xl/worksheets/sheet2.xml', text: `<worksheet xmlns="${MAIN}"><sheetData><row r="1"><c r="A1" t="str"><f t="shared">"公式字串"</f><v>字串值</v></c></row></sheetData></worksheet>` },
    ],
  }), 'multi-sheet workbook');

  // 4. Strict OOXML namespaces
  check(makeWorkbook({
    book: `<workbook xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main" xmlns:r="http://purl.oclc.org/ooxml/officeDocument/relationships"><sheets><sheet name="严格表" sheetId="1" r:id="sheet"/></sheets></workbook>`,
    sheet: `<worksheet xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>严格测试</t></is></c></row></sheetData></worksheet>`,
  }), 'strict OOXML namespace workbook');

  // 5. ExcelJS generated interoperability workbook
  const book = new ExcelJS.Workbook();
  const ws1 = book.addWorksheet('工作表一');
  ws1.addRow(['ID', '名称', '数值', '布尔', '日期']);
  for (let i = 1; i <= 50; i++) {
    ws1.addRow([i, `测试条目 ${i}`, i * 1.5, i % 2 === 0, new Date('2026-10-27T00:00:00Z')]);
  }
  const ws2 = book.addWorksheet('工作表二');
  ws2.addRow(['公式测试', 10, 20]);
  ws2.getCell('A2').value = { formula: 'B1+C1', result: 30 };
  const excelBuffer = Buffer.from(await book.xlsx.writeBuffer());
  check(excelBuffer, 'ExcelJS generated workbook');

  // 6. Large generated workbook
  const largeBook = new ExcelJS.Workbook();
  const largeWs = largeBook.addWorksheet('大表');
  for (let r = 0; r < 200; r++) {
    largeWs.addRow(Array.from({ length: 10 }, (_, c) => `R${r}C${c} 字符 ${c * r}`));
  }
  const largeBuffer = Buffer.from(await largeBook.xlsx.writeBuffer());
  check(largeBuffer, 'large ExcelJS workbook (2000 cells)');

  // 7. Refused / bad vectors equivalence
  check(makeWorkbook({ book: '<workbook><sheets/></workbook>' }), 'rejected missing sheets');
  check(makeWorkbook({ sheet: '<worksheet><sheetData><row r="X"><c r="A1"/></row></sheetData></worksheet>' }), 'rejected invalid row coordinate');
  check(Buffer.from('not a zip'), 'rejected non-zip');
  check(Buffer.alloc(0), 'rejected empty');

  assert.ok(passed >= 6, `expected at least 6 passed workbooks, got ${passed}`);
  assert.ok(rejected >= 4, `expected at least 4 rejected workbooks, got ${rejected}`);
  t.diagnostic(JSON.stringify({ passed_workbooks: passed, rejected_vectors: rejected }));
});
