// A test bed for the pack registry: a fresh records kit (temporary PostgreSQL from hub/testing), an admin, two users with
// a publish right and one without, a registry extracting into a temporary directory, and a helper that writes a synthetic
// pack and publishes it.
import { join } from 'node:path';
import type { Principal, User } from '../../../records/api.ts';
import type { TemporaryPostgres } from '../../../testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../../../testing/records.ts';
import type { TamperEvent } from '../extract.ts';
import { createPackRegistry, type PackRegistry, type PackRegistryOptions } from '../registry.ts';
import type { PublishOutcome } from '../types.ts';
import { temporaryDirectory, writePack, type PackDescription, type WrittenPack } from './builder.ts';

export interface PackTestbed {
  kit: TestRecordsKit;
  registry: PackRegistry;
  admin: Principal;
  /** Users with a publish right. */
  alice: Principal;
  bob: Principal;
  /** A user without a publish right. */
  carol: Principal;
  root: string;
  extractDir: string;
  tamper: TamperEvent[];
  /** Writes the pack into a new directory under root. */
  write(pack: PackDescription): Promise<WrittenPack>;
  /** Writes and publishes; throws when the publication is refused, unless `expectRefusal`. */
  publish(by: Principal, pack: PackDescription): Promise<PublishOutcome & { ok: true }>;
  attempt(by: Principal, pack: PackDescription): Promise<PublishOutcome>;
  /** Another registry over the same records and extraction directory (another Hub process). */
  second(options?: Partial<PackRegistryOptions>): PackRegistry;
  close(): Promise<void>;
}

const principal = (user: User): Principal => ({ id: user.id, name: user.name, role: user.role });

export async function openPackTestbed(options: { postgres: TemporaryPostgres; now?: () => Date; registry?: Partial<PackRegistryOptions> }): Promise<PackTestbed> {
  const kit = await openTestRecords({ postgres: options.postgres, now: options.now });
  const temp = await temporaryDirectory();
  try {
    const admin = principal((await kit.principals.bootstrapAdmin('管理员')).user);
    const alice = principal(await kit.principals.createUser(admin, '甲'));
    const bob = principal(await kit.principals.createUser(admin, '乙'));
    const carol = principal(await kit.principals.createUser(admin, '丙'));
    await kit.authorizations.grantPublishRight(admin, alice.id);
    await kit.authorizations.grantPublishRight(admin, bob.id);
    const extractDir = join(temp.path, 'extracted');
    const tamper: TamperEvent[] = [];
    const base: PackRegistryOptions = {
      records: kit,
      extractDir,
      now: options.now,
      // Synthetic packs only: the sandbox may run without sandbox-exec where it is missing (it is used where present).
      sandbox: { requireOsIsolation: false },
      onTamper: (event) => tamper.push(event),
      ...options.registry,
    };
    const registry = createPackRegistry(base);
    let n = 0;
    const write = (pack: PackDescription): Promise<WrittenPack> => writePack(join(temp.path, 'sources', `${String(++n).padStart(3, '0')}-${pack.id}`), pack);
    const attempt = async (by: Principal, pack: PackDescription): Promise<PublishOutcome> => registry.publish(by, (await write(pack)).dir);
    return {
      kit,
      registry,
      admin,
      alice,
      bob,
      carol,
      root: temp.path,
      extractDir,
      tamper,
      write,
      attempt,
      async publish(by, pack) {
        const outcome = await attempt(by, pack);
        if (!outcome.ok) throw new Error(`publish refused: ${JSON.stringify(outcome.problems, null, 1)}`);
        return outcome;
      },
      second: (more = {}) => createPackRegistry({ ...base, ...more }),
      async close() {
        await kit.close();
        await temp.remove();
      },
    };
  } catch (error) {
    await kit.close();
    await temp.remove();
    throw error;
  }
}
