import {
  StructuredErrorSchema,
  type ResponseStatus,
  type StructuredError,
} from "@infosec/contracts";
import { compileRows, type WorkbookRow } from "./compile.js";
import { irHash, sha256Hex, type TopicNode, type UnmappedEntry } from "./ir.js";
import { parseTopicTree, parseXmindContent } from "./parse.js";
import { buildWorkbook } from "./workbook.js";

export type MindmapFormat = "topic-tree" | "xmind-content";

export const FORMAT_DESCRIPTIONS: Record<MindmapFormat, string> = {
  "topic-tree": "主题树 JSON（IR 直接形态）",
  "xmind-content": "XMind content.json（sheet → rootTopic → children.attached）",
};

export interface CompileResult {
  status: Extract<ResponseStatus, "succeeded" | "partial" | "failed">;
  ir?: TopicNode;
  irHash?: string;
  rows?: WorkbookRow[];
  unmapped: UnmappedEntry[];
  workbook?: Buffer;
  workbookSha256?: string;
  error?: StructuredError;
}

function invalidPayload(message: string): StructuredError {
  return StructuredErrorSchema.parse({
    code: "INVALID_PAYLOAD",
    category: "validation",
    message,
    retryable: false,
    evidenceRefs: [],
    userAction:
      "Provide a parseable mind-map input (topic-tree JSON or XMind content.json).",
  });
}

/**
 * The V05 compile operation. Unparseable input fails as a whole with no
 * workbook; unmappable elements produce `partial` with the list carried
 * in the result and in the workbook's 说明 sheet (contract §3.5).
 */
export async function compileMindmap(input: {
  data: unknown;
  format: MindmapFormat;
  sourceSha256: string;
  generatedAtIso?: string;
}): Promise<CompileResult> {
  const parsed =
    input.format === "topic-tree"
      ? parseTopicTree(input.data)
      : parseXmindContent(input.data);
  if (!parsed.root) {
    return {
      status: "failed",
      unmapped: parsed.unmapped,
      error: invalidPayload(parsed.failure ?? "input cannot be parsed into the IR"),
    };
  }
  const rows = compileRows(parsed.root);
  const workbook = await buildWorkbook(rows, {
    sourceSha256: input.sourceSha256,
    inputFormat: FORMAT_DESCRIPTIONS[input.format],
    rootTitle: parsed.root.title,
    generatedAtIso: input.generatedAtIso ?? new Date().toISOString(),
    unmapped: parsed.unmapped,
  });
  return {
    status: parsed.unmapped.length > 0 ? "partial" : "succeeded",
    ir: parsed.root,
    irHash: irHash(parsed.root),
    rows,
    unmapped: parsed.unmapped,
    workbook,
    workbookSha256: sha256Hex(workbook),
  };
}
