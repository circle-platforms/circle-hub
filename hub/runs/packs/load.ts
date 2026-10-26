// Declarations of a published version, parsed from verified bytes with the contract shapes only: the version passed every
// rule when it was published, so a file that no longer parses is an integrity failure, not a pack author's problem.
import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { PackKind } from '../../../contracts/generated/vocabulary.ts';
import { ChecksFile, LedgerFile, KnowledgeFile, packPathProblem, RequirementsFile, SlotsFile, WorkflowFile, SkillDeclaration, type PackManifest } from '../../../contracts/src/pack.ts';
import { ProductDeclaration } from '../../../contracts/src/product.ts';
import { SystemProfile } from '../../../contracts/src/resources.ts';
import { IntegrityError, sha256Hex } from '../../records/api.ts';
import { MANIFEST_FILE } from './directory.ts';
import { readJsonFile, utf8 } from './problems.ts';
import type { PackDeclarations } from './types.ts';

/** A file a pack does not contain, or one that is not JSON, asked of LoadedWorkflow.readJson. */
export class PackFileError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(message);
    this.name = 'PackFileError';
    this.path = typeof path === 'string' ? path : String(path);
  }
}

function json(files: ReadonlyMap<string, Uint8Array>, path: string): unknown {
  const bytes = files.get(path);
  if (bytes === undefined) throw new IntegrityError(`已发布的包缺少 ${path}`, { detail: { path } });
  const read = readJsonFile(path, bytes);
  if (!read.ok) throw new IntegrityError(read.problem.message, { detail: { path } });
  return read.value;
}

function shaped<T>(schema: { safeParse(value: unknown): { success: boolean; data?: T } }, files: ReadonlyMap<string, Uint8Array>, path: string): T {
  const parsed = schema.safeParse(json(files, path));
  if (!parsed.success) throw new IntegrityError(`已发布的包里 ${path} 不再符合它的格式`, { detail: { path } });
  return parsed.data as T;
}

export function parseDeclarations(kind: PackKind, files: ReadonlyMap<string, Uint8Array>): PackDeclarations {
  if (kind === 'skill') {
    const method = files.has('workflow.json') ? parseDeclarations('workflow', files) : null;
    if (method !== null && method.kind !== 'workflow') throw new IntegrityError('技能包方法声明不是工作流');
    return { kind, skill: shaped(SkillDeclaration, files, 'skill.json'), method };
  }
  if (kind === 'product') return { kind, product: shaped(ProductDeclaration, files, 'product.json') };
  if (kind === 'system') return { kind, system: shaped(SystemProfile, files, 'system.json') };
  const skill = files.get('SKILL.md');
  const instructions = skill === undefined ? null : utf8(skill);
  if (skill === undefined || instructions === null) throw new IntegrityError('已发布的包里 SKILL.md 缺失或不是 UTF-8');
  return {
    kind,
    workflow: shaped(WorkflowFile, files, 'workflow.json'),
    requirements: shaped(RequirementsFile, files, 'requirements.json'),
    checks: shaped(ChecksFile, files, 'checks.json'),
    slots: shaped(SlotsFile, files, 'slots.schema.json'),
    ledger: files.has('ledger.json') ? shaped(LedgerFile, files, 'ledger.json') : null,
    knowledge: files.has('knowledge.json') ? shaped(KnowledgeFile, files, 'knowledge.json') : null,
    instructions,
    instructionsDigest: sha256Hex(skill),
  };
}

/**
 * readJson of a loaded pack: only a file the manifest lists (or pack.json), read from the extracted directory as a regular
 * file and checked against its SHA-256 before it is parsed. Anything else throws.
 */
export function packJsonReader(directory: string, manifest: PackManifest, digest: string): (path: string) => unknown {
  const listed = new Map(manifest.files.map((f) => [f.path, f.sha256]));
  return (path: string): unknown => {
    const sha256 = path === MANIFEST_FILE ? digest : typeof path === 'string' && packPathProblem(path) === null ? listed.get(path) : undefined;
    if (sha256 === undefined) throw new PackFileError(`包里没有文件 ${String(path)}`, path);
    const absolute = join(directory, ...path.split('/'));
    let bytes: Uint8Array;
    try {
      if (!lstatSync(absolute).isFile()) throw new Error('not a regular file');
      bytes = readFileSync(absolute);
    } catch {
      throw new IntegrityError(`解包目录里的 ${path} 读不出来`, { detail: { path, digest } });
    }
    if (sha256Hex(bytes) !== sha256) throw new IntegrityError(`解包目录里的 ${path} 与包清单不符`, { detail: { path, digest } });
    const read = readJsonFile(path, bytes);
    if (!read.ok) throw new PackFileError(read.problem.message, path);
    return read.value;
  };
}
