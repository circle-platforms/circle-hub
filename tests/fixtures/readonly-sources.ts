import type {TestContext} from 'node:test';
import {createSyntheticSources} from '../../packs/synthetic/readonly-sources.ts';
export async function readonlySources(t:TestContext){const source=await createSyntheticSources();t.after(()=>source.close());return source;}
