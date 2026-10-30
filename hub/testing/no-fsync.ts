// Loaded by tools/run-unit-tests.ts into the test processes of the shared and isolated unit lanes (not the timing
// sentinels): fsync and fdatasync return at once, the way the test PostgreSQL clusters already run with fsync=off. Unit
// tests check what is written and read back, never durability across a power loss. On macOS fsync is serialized for the
// whole machine (about 250 file-and-directory pairs a second for one writer, 375 for twelve), and the object store and the
// vault fsync every write, so database-heavy files mostly waited for each other's fsyncs. HUB_UNIT_FSYNC=on keeps them.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

type Callback = (error: NodeJS.ErrnoException | null) => void;
const done = (_fd: number, callback: Callback): void => process.nextTick(callback, null);
Object.assign(fs, { fsync: done, fdatasync: done, fsyncSync: () => {}, fdatasyncSync: () => {} });
syncBuiltinESMExports();

const handle = await fs.promises.open(fileURLToPath(import.meta.url), 'r');
const prototype = Object.getPrototypeOf(handle) as { sync(): Promise<void>; datasync(): Promise<void> };
await handle.close();
prototype.sync = async () => {};
prototype.datasync = async () => {};
