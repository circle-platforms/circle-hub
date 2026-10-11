import ExcelJS from "exceljs";
import type { WorkbookRow } from "./compile.js";
import type { UnmappedEntry } from "./ir.js";

export const EXCEL_CONTRACT_LABEL = "Excel 输出契约 V1";
export const MAPPING_RULE_VERSION = "1.0.0";
export const CASE_SHEET = "用例清单";
export const NOTES_SHEET = "说明";
export const CASE_COLUMNS = [
  "编号",
  "一级模块",
  "二级模块",
  "用例标题",
  "备注",
  "层级深度",
  "路径",
] as const;

export interface WorkbookMeta {
  sourceSha256: string;
  inputFormat: string;
  rootTitle: string;
  generatedAtIso: string;
  unmapped: UnmappedEntry[];
}

/** Build the two-sheet workbook exactly per contract §3.1/§3.4. */
export async function buildWorkbook(
  rows: WorkbookRow[],
  meta: WorkbookMeta,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const cases = wb.addWorksheet(CASE_SHEET);
  cases.addRow([...CASE_COLUMNS]);
  for (const r of rows) {
    cases.addRow([r.id, r.level1, r.level2, r.title, r.note, r.depth, r.path]);
  }
  const notes = wb.addWorksheet(NOTES_SHEET);
  notes.addRow(["项", "值"]);
  notes.addRow(["源文件 SHA-256", meta.sourceSha256]);
  notes.addRow(["输入格式", meta.inputFormat]);
  notes.addRow(["契约版本", EXCEL_CONTRACT_LABEL]);
  notes.addRow(["映射规则版本", MAPPING_RULE_VERSION]);
  notes.addRow(["源文件标题", meta.rootTitle]);
  notes.addRow(["生成时间", meta.generatedAtIso]);
  if (meta.unmapped.length > 0) {
    notes.addRow([
      "未映射元素",
      meta.unmapped.map((u) => `${u.path}: ${u.reason}`).join("; "),
    ]);
  }
  const data = await wb.xlsx.writeBuffer();
  return Buffer.from(data);
}

export interface ReadBack {
  sheets: string[];
  caseHeader: string[];
  caseRows: WorkbookRow[];
  notes: Record<string, string>;
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v);
}

/** Round-trip reader used by the verification side of the chain (§3.5). */
export async function readWorkbook(buf: Buffer): Promise<ReadBack> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  const sheets = wb.worksheets.map((w) => w.name);
  const cases = wb.getWorksheet(CASE_SHEET);
  const notesWs = wb.getWorksheet(NOTES_SHEET);
  const caseHeader: string[] = [];
  const caseRows: WorkbookRow[] = [];
  if (cases) {
    cases.eachRow((row, rowNumber) => {
      const values: unknown[] = [];
      for (let c = 1; c <= CASE_COLUMNS.length; c++) {
        values.push(row.getCell(c).value);
      }
      if (rowNumber === 1) {
        values.forEach((v) => caseHeader.push(cellText(v)));
        return;
      }
      caseRows.push({
        id: cellText(values[0]),
        level1: cellText(values[1]),
        level2: cellText(values[2]),
        title: cellText(values[3]),
        note: cellText(values[4]),
        depth: typeof values[5] === "number" ? values[5] : Number(values[5]),
        path: cellText(values[6]),
      });
    });
  }
  const notes: Record<string, string> = {};
  if (notesWs) {
    notesWs.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const key = cellText(row.getCell(1).value);
      if (key) notes[key] = cellText(row.getCell(2).value);
    });
  }
  return { sheets, caseHeader, caseRows, notes };
}
