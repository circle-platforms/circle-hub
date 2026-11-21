import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';

export const TEMPLATE_HEADER_ROW = 6;
export const TEMPLATE_LAST_ROW = 80;
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE = 'http://schemas.openxmlformats.org/package/2006';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const text = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const inline = (reference: string, value: string, style = '') => `<c r="${reference}"${style} t="inlineStr"><is><t>${text(value)}</t></is></c>`;
const dataRow = (number: number) => `<row r="${number}">${['3', '4', '4', '5', '5', '5', '5', '5', '5'].map((style, column) => `<c r="${String.fromCharCode(65 + column)}${number}" s="${style}" t="n"></c>`).join('')}</row>`;

export interface TemplateBookFixture { sheet: string; header: string[]; identity_marker: string; range_name: string }
export function templateDocument(book: TemplateBookFixture, runtime: string, identity: string, headerRow = TEMPLATE_HEADER_ROW, lastRow = TEMPLATE_LAST_ROW): { sha256: string; xlsx_base64: string } {
  if (headerRow < 2) throw new Error('headerRow must leave row 1 for the identity marker');
  if (lastRow <= headerRow) throw new Error('lastRow must leave room after the header');
  const header = headerRow;
  const rows = [
    `<row r="1" hidden="1" customHeight="1">${inline('A1', book.identity_marker)}${inline('B1', runtime)}${inline('C1', identity)}${header === 2 ? `${inline('K1', 'widget-seat')}${inline('L1', 'configure')}` : ''}</row>`,
  ];
  if (header > 5) {
    rows.push(
      `<row r="2">${inline('A2', '初始化', ' s="1"')}${inline('D2', '说明文字')}${inline('K2', '对象')}${inline('L2', 'widget-seat')}</row>`,
      `<row r="3">${inline('K3', 'widget-seat')}${inline('L3', 'configure')}</row>`,
      `<row r="4">${inline('K4', 'widget-host')}${inline('L4', 'shell')}</row>`,
      `<row r="5">${inline('A5', '示例', ' s="1"')}</row>`,
    );
  } else if (header > 2) {
    for (let number = 2; number < header; number++) {
      rows.push(`<row r="${number}">${inline(`K${number}`, 'widget-seat')}${inline(`L${number}`, 'configure')}</row>`);
    }
  }
  const headerSide = header === 2 ? `${inline(`K${header}`, 'widget-host')}${inline(`L${header}`, 'shell')}` : '';
  rows.push(`<row r="${header}" ht="30" customHeight="1">${book.header.map((value, column) => inline(`${String.fromCharCode(65 + column)}${header}`, value, ' s="2"')).join('')}${headerSide}</row>`);
  for (let number = header + 1; number <= lastRow; number++) rows.push(dataRow(number));
  const listFrom = header > 5 ? 3 : 1;
  const listTo = header > 5 ? 4 : header;
  const sheet = `<worksheet xmlns="${MAIN}"><dimension ref="A1:L${lastRow}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col width="22" customWidth="1" min="1" max="1"/><col width="48" customWidth="1" min="4" max="4"/></cols><sheetData>${rows.join('')}</sheetData><dataValidations count="1"><dataValidation sqref="E${header + 1}:E${lastRow}" type="list"><formula1>IST_E_VALUES</formula1></dataValidation></dataValidations></worksheet>`;
  const name = book.sheet.replaceAll("'", "''");
  const files: Record<string, string> = {
    '[Content_Types].xml': `${XML}<Types xmlns="${PACKAGE}/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="${PACKAGE}/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    'docProps/app.xml': `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Synthetic</Application></Properties>`,
    'docProps/core.xml': `${XML}<cp:coreProperties xmlns:cp="${PACKAGE}/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Synthetic runner template</dc:title></cp:coreProperties>`,
    'xl/_rels/workbook.xml.rels': `${XML}<Relationships xmlns="${PACKAGE}/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId3" Type="${REL}/theme" Target="theme/theme1.xml"/></Relationships>`,
    'xl/styles.xml': `${XML}<styleSheet xmlns="${MAIN}"><numFmts count="1"><numFmt numFmtId="164" formatCode="@"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>`,
    'xl/theme/theme1.xml': `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Synthetic"/>`,
    'xl/workbook.xml': `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="${text(book.sheet)}" sheetId="1" state="visible" r:id="rId1"/></sheets><definedNames><definedName name="widget-seat">'${name}'!$L$${listFrom}:$L$${listTo}</definedName><definedName name="IST_E_VALUES">'${name}'!$K$${listFrom}:$K$${listTo}</definedName><definedName name="${book.range_name}">'${name}'!$A$${header}:$I$${header}</definedName></definedNames></workbook>`,
    'xl/worksheets/sheet1.xml': sheet,
  };
  const zip = zipSync(Object.fromEntries(Object.entries(files).map(([member, value]) => [member, [Buffer.from(value, 'utf8'), { level: 9, mtime: '1980-01-01T00:00:00' }]])) as never);
  return { sha256: createHash('sha256').update(zip).digest('hex'), xlsx_base64: Buffer.from(zip).toString('base64') };
}
