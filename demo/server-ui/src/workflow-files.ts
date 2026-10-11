import { outlineRows, type OutlineRow } from "./workflows.ts";

export const outlineColumns = [
  "编号",
  "一级模块",
  "二级模块",
  "用例标题",
  "备注",
  "层级深度",
  "路径",
];
export const rowValues = (r: OutlineRow) => [
  r.id,
  r.level1,
  r.level2,
  r.title,
  r.note,
  r.depth,
  r.path,
];
async function digest(bytes: Uint8Array<ArrayBuffer>) {
  const value = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(value), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function buildOutlineWorkbook(
  text: string,
  inputRevision: number,
) {
  const parsed = outlineRows(text);
  const ExcelJS = (await import("exceljs")).default;
  const book = new ExcelJS.Workbook();
  book.creator = "Circle Server frontend demo";
  const sheet = book.addWorksheet("用例清单");
  sheet.addRow(outlineColumns);
  parsed.rows.forEach((r) => sheet.addRow(rowValues(r)));
  sheet.columns.forEach((c, i) => {
    c.width = [14, 20, 22, 24, 38, 14, 48][i];
  });
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  const sourceSha256 = await digest(new TextEncoder().encode(text));
  const notes = book.addWorksheet("说明");
  notes.addRows([
    ["项", "值"],
    ["源文件 SHA-256", sourceSha256],
    [
      "输入格式",
      text.trim().startsWith("[") ? "XMind content.json" : "主题树 JSON",
    ],
    ["契约版本", "Excel 输出契约 V1"],
    ["映射规则版本", "Excel 输出契约 V1"],
    ["源文件标题", parsed.rootTitle],
    ["输入修订", String(inputRevision)],
    ["结果状态", parsed.unmapped.length ? "partial" : "succeeded"],
    ["演示范围", "浏览器内结构转换；没有调用模型或连接产品设备"],
    ...parsed.unmapped.map((x) => ["未映射", x]),
  ]);
  notes.getColumn(1).width = 24;
  notes.getColumn(2).width = 85;
  const raw = await book.xlsx.writeBuffer();
  const bytes = Uint8Array.from(new Uint8Array(raw));
  const readback = new ExcelJS.Workbook();
  await readback.xlsx.load(bytes.buffer);
  if (readback.worksheets.map((s) => s.name).join("|") !== "用例清单|说明")
    throw new Error("工作表名称或顺序不符合合同。");
  const reread = readback.getWorksheet("用例清单")!;
  if (reread.rowCount !== parsed.rows.length + 1 || reread.columnCount !== 7)
    throw new Error("行数或列数与映射不一致。");
  outlineColumns.forEach((name, i) => {
    if (reread.getCell(1, i + 1).value !== name)
      throw new Error("表头不符合七列合同。");
  });
  parsed.rows.forEach((row, index) =>
    rowValues(row).forEach((value, column) => {
      const actual = reread.getCell(index + 2, column + 1).value ?? "";
      if (actual !== value)
        throw new Error(`第 ${index + 2} 行 ${column + 1} 列的读回值不一致。`);
    }),
  );
  const artifactSha256 = await digest(bytes);
  return {
    bytes,
    parsed,
    receipt: {
      sourceSha256,
      artifactSha256,
      inputRevision,
      rows: parsed.rows.length,
      checked: true,
    },
  };
}
export function downloadBytes(
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  type: string,
) {
  const url = URL.createObjectURL(new Blob([bytes.buffer], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const downloadJson = (name: string, value: unknown) =>
  downloadBytes(
    name,
    new TextEncoder().encode(JSON.stringify(value, null, 2)),
    "application/json;charset=utf-8",
  );
export const bytesToBase64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
export const base64ToBytes = (base64: string) =>
  Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
