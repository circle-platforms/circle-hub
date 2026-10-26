// System profiles: system.json of the published system pack a resource names, validated against system@1 and checked for the
// functions it names. Loaded through PacksPort only (provided by runs): a pack that is unknown, withdrawn, retired or not a
// system pack is unavailable. Profiles are cached by pack digest; the handle of a reference for a few seconds.
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { SystemProfile } from '../../contracts/src/resources.ts';
import type { PackHandle, PacksPort } from '../ports.ts';
import { ConnectorError } from './errors.ts';

export interface LoadedProfile {
  pack: PackHandle;
  profile: SystemProfile;
}

const MAX_PROFILE_BYTES = 1024 * 1024;
const HANDLE_TTL_MS = 5_000;
const MAX_CACHED = 200;

function issueText(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((issue) => `/${issue.path.map(String).join('/')}: ${issue.message}`)
    .join('; ');
}

export class ProfileCache {
  readonly #packs: PacksPort;
  readonly #now: () => number;
  readonly #byDigest = new Map<string, SystemProfile>();
  readonly #handles = new Map<string, { at: number; pack: PackHandle | null }>();

  constructor(packs: PacksPort, now: () => number = Date.now) {
    this.#packs = packs;
    this.#now = now;
  }

  /** Forgets every cached handle (after a publication or a withdrawal the caller knows of). */
  clear(): void {
    this.#handles.clear();
  }

  /** The validated profile of `ref` (`id` or `id@version`). Throws PACK_UNAVAILABLE or PROFILE_INVALID. */
  async load(ref: string): Promise<LoadedProfile> {
    const pack = await this.#handle(ref);
    if (pack === null) throw new ConnectorError('PACK_UNAVAILABLE', `系统包 ${ref} 不可用（未发布、已撤回或已退役）`, { detail: { pack: ref } });
    if (pack.kind !== 'system') throw new ConnectorError('PACK_UNAVAILABLE', `${ref} 不是系统包（种类 ${pack.kind}）`, { detail: { pack: ref, kind: pack.kind } });
    const cached = this.#byDigest.get(pack.digest);
    if (cached !== undefined) return { pack, profile: cached };
    const profile = await readProfile(pack);
    if (this.#byDigest.size >= MAX_CACHED) this.#byDigest.clear();
    this.#byDigest.set(pack.digest, profile);
    return { pack, profile };
  }

  async #handle(ref: string): Promise<PackHandle | null> {
    const now = this.#now();
    const hit = this.#handles.get(ref);
    if (hit !== undefined && now - hit.at < HANDLE_TTL_MS) return hit.pack;
    const pack = await this.#packs.pack(ref);
    if (this.#handles.size >= MAX_CACHED) this.#handles.clear();
    this.#handles.set(ref, { at: now, pack });
    return pack;
  }
}

/** Reads and validates system.json of an extracted system pack and checks that every function it names is a file of the pack. */
export async function readProfile(pack: PackHandle): Promise<SystemProfile> {
  const path = join(pack.directory, 'system.json');
  let text: string;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_PROFILE_BYTES) throw new Error('not a file of the allowed size');
    text = await readFile(path, 'utf8');
  } catch {
    throw new ConnectorError('PROFILE_INVALID', `系统包 ${pack.id}@${pack.version} 没有可读的 system.json`, { detail: { pack: pack.id } });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ConnectorError('PROFILE_INVALID', `系统包 ${pack.id}@${pack.version} 的 system.json 不是 JSON`, { detail: { pack: pack.id } });
  }
  const parsed = SystemProfile.safeParse(json);
  if (!parsed.success) throw new ConnectorError('PROFILE_INVALID', `系统包 ${pack.id}@${pack.version} 的 system.json 不符合 system@1：${issueText(parsed.error.issues)}`, { detail: { pack: pack.id } });
  for (const read of parsed.data.reads) {
    for (const ref of [read.plan, read.project]) {
      if (ref === undefined) continue;
      const file = normalize(join(pack.directory, ref.module));
      const inside = relative(pack.directory, file);
      let ok = inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
      if (ok) {
        try {
          ok = (await stat(file)).isFile();
        } catch {
          ok = false;
        }
      }
      if (!ok) throw new ConnectorError('PROFILE_INVALID', `系统包 ${pack.id}@${pack.version} 的读取 ${read.name} 引用的函数 ${ref.module} 不在包里`, { detail: { pack: pack.id, read: read.name } });
    }
  }
  return parsed.data;
}
