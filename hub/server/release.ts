// The release this process serves: release.json in the code root (releases/<id>/release.json, written by hub/platform's
// deploy). GET /healthz names it, so a deploy can tell the new process from the old one. A checkout without one serves null.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root this module runs from: hub/server/../../. */
export const CODE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const RELEASE_SCHEMA = 'circle-hub-release@1';
const RELEASE_ID = /^[0-9a-f]{12}$/;

/** The release id of release.json in `codeRoot`, null when there is none; a file that is not a release record refuses to start. */
export function readReleaseId(codeRoot: string = CODE_ROOT): string | null {
  let text: string;
  try {
    text = readFileSync(join(codeRoot, 'release.json'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  const record = value as { schema?: unknown; id?: unknown } | undefined;
  if (record?.schema !== RELEASE_SCHEMA || typeof record.id !== 'string' || !RELEASE_ID.test(record.id)) {
    throw new Error(`${join(codeRoot, 'release.json')} 不是 ${RELEASE_SCHEMA} 的发布记录，拒绝启动：这个发布可能不完整`);
  }
  return record.id;
}

/** The version of the package (package.json in the code root), for the MCP serverInfo. */
export function packageVersion(codeRoot: string = CODE_ROOT): string {
  try {
    const value = JSON.parse(readFileSync(join(codeRoot, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof value.version === 'string' && value.version.length > 0 ? value.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
