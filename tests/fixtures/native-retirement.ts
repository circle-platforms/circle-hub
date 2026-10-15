import assert from 'node:assert/strict';
import {access} from 'node:fs/promises';
export async function assertNativeRetired(){await assert.rejects(access(new URL('../../packs/apv/execution/',import.meta.url)),{code:'ENOENT'});}
