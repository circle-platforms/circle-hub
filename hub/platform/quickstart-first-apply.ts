import { readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface QuickstartSample {
  schema: string;
  packs: Array<Record<string, unknown> & { directory?: string }>;
  workflowAssignments: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export function materializeQuickstartApply(sample: QuickstartSample, adminName: string, packDirectory: string): QuickstartSample {
  if (typeof adminName !== 'string' || adminName.trim().length === 0) throw new Error('admin name is required');
  if (typeof packDirectory !== 'string' || !isAbsolute(packDirectory)) throw new Error('pack directory must be an absolute path');
  return {
    ...sample,
    packs: sample.packs.map((pack) => ({ ...pack, directory: packDirectory })),
    workflowAssignments: sample.workflowAssignments.map((row) => ('user' in row ? { ...row, user: adminName } : { ...row })),
  };
}

export function writeQuickstartApplyFile(fromPath: string, adminName: string, packDirectory: string, outPath: string): void {
  const sample = JSON.parse(readFileSync(fromPath, 'utf8')) as QuickstartSample;
  if (sample.schema !== 'deployment@2' || !Array.isArray(sample.packs) || !Array.isArray(sample.workflowAssignments)) {
    throw new Error('quickstart sample is not a deployment@2 definition');
  }
  const body = `${JSON.stringify(materializeQuickstartApply(sample, adminName, packDirectory), null, 2)}\n`;
  writeFileSync(outPath, body, { mode: 0o600 });
}

if (import.meta.main) {
  const [fromPath, adminName, packDirectory, outPath] = process.argv.slice(2);
  if (!fromPath || !adminName || !packDirectory || !outPath) {
    console.error('usage: quickstart-first-apply.ts <sample.json> <admin> <absolute-pack-dir> <out.json>');
    process.exit(2);
  }
  try {
    writeQuickstartApplyFile(fromPath, adminName, packDirectory, outPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
