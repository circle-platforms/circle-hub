import type {TestContext} from 'node:test';
import {createSyntheticSources} from '../../packages/connectors/src/synthetic-readonly.ts';
export async function readonlySources(t:TestContext){const source=await createSyntheticSources();t.after(()=>source.close());return source;}
