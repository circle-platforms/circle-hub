// Local structural contract for the existing xlsx@1 parsed model. No ZIP or XML parsing occurs in this pack.
import { isRecord } from './text.ts';
export interface WorkbookCell { reference: string; type: string; text: string; formula: boolean; style: number | null }
export interface WorkbookRow { number: number; hidden: boolean; cells: WorkbookCell[] }
export interface WorkbookSheet { relationshipType: string; name: string; state: string; part: string; rows: WorkbookRow[]; lastRow: number }
export interface WorkbookModel {
  nulRemoved: number;
  members: Array<{ name: string; size: number; contentType: string | null }>;
  relationships: Array<{ source: string; id: string; type: string; target: string; external: boolean }>;
  sheets: WorkbookSheet[];
  sharedStrings: string[];
  definedNames: Array<{ name: string; scope: number | null; reference: string }>;
}
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const list = (v: unknown, valid: (v: Record<string, unknown>) => boolean): boolean => Array.isArray(v) && v.every((item) => isRecord(item) && valid(item));
export function readWorkbookModel(value: unknown): WorkbookModel | null {
  if (!isRecord(value) || !count(value.nulRemoved) || !list(value.members, (v) => typeof v.name === 'string' && count(v.size) && (v.contentType === null || typeof v.contentType === 'string')) || !list(value.relationships, (v) => ['source', 'id', 'type', 'target'].every((key) => typeof v[key] === 'string') && typeof v.external === 'boolean') || !Array.isArray(value.sharedStrings) || value.sharedStrings.some((v) => typeof v !== 'string') || !list(value.definedNames, (v) => typeof v.name === 'string' && typeof v.reference === 'string' && (v.scope === null || count(v.scope)))) return null;
  if (!list(value.sheets, (sheet) => typeof sheet.relationshipType === 'string' && typeof sheet.name === 'string' && typeof sheet.state === 'string' && typeof sheet.part === 'string' && count(sheet.lastRow) && list(sheet.rows, (row) => count(row.number) && row.number !== 0 && typeof row.hidden === 'boolean' && list(row.cells, (cell) => typeof cell.reference === 'string' && typeof cell.type === 'string' && typeof cell.text === 'string' && typeof cell.formula === 'boolean' && (cell.style === null || count(cell.style)))))) return null;
  return value as unknown as WorkbookModel;
}
/**
 * The model without the template's empty cells. The runner's template formats thousands of them, and the frozen model travels
 * with every check of a run; a real one dropped from 4 MB to 120 KB. The reader needs only cells that hold something, and the
 * byte comparison of the workbook covers the rest. A hidden row stays, because a hidden row is something to refuse.
 */
export function compactModel(model: WorkbookModel): WorkbookModel {
  return { ...model, sheets: model.sheets.map((sheet) => ({ ...sheet, rows: sheet.rows.map((row) => ({ ...row, cells: row.cells.filter((cell) => cell.text !== '' || cell.formula) })).filter((row) => row.cells.length > 0 || row.hidden) })) };
}
