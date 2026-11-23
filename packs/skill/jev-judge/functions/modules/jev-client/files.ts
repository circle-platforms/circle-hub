// Files the Jev client and its tool write: private (owner only), never through a symbolic link, never over an earlier file.
import { constants } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Creates the file and its folders; refuses when the path already exists (including a link). */
export async function writeNewPrivateFile(filePath: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, content, { flag: 'wx', mode: 0o600 });
}

/** Appends one line (a newline is added when missing); the file is created when missing, a link is refused. */
export async function appendPrivateLine(filePath: string, line: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(line.endsWith('\n') ? line : `${line}\n`, 'utf8');
  } finally {
    await handle.close();
  }
}

/** Opens the file for appending and closes it again, writing nothing: the proof that a later append can work. */
export async function checkAppendable(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  await handle.close();
}
