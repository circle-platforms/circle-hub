// Runtime binding helpers; executor and source shapes are owned by contracts.
import type {ExecutorDefinition} from '../../contracts/src/resources.ts';
export {ExecutorDefinition,WriteDeclaration} from '../../contracts/src/resources.ts';
export type CallRole = keyof ExecutorDefinition['calls'];
export function at(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  let current = value;
  for (const segment of pointer.slice(1).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
/** Interpret only the declared time representation; never guess a date from a numeric-looking string. */
export function readDeclaredTime(value:unknown,scale?:number):number {
  if(scale!==undefined) {
    const ms=typeof value==='number'?value*scale:NaN;
    return Number.isFinite(ms) && Number.isFinite(new Date(ms).getTime()) ? ms : NaN;
  }
  if(typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|\+00:00)$/.test(value))return NaN;
  const ms=Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0,19)===value.slice(0,19) ? ms : NaN;
}
export function bind(value: unknown, context: Readonly<Record<string, unknown>>): unknown {
  if (Array.isArray(value)) return value.map(v => bind(v, context));
  if (value !== null && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (Object.keys(o).length === 1 && typeof o.$value === 'string') {
      if (!Object.hasOwn(context, o.$value) || context[o.$value] === undefined) throw new Error('缺少调用参数的绑定事实');
      return context[o.$value];
    }
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, bind(v, context)]));
  }
  return value;
}

/** Only explicitly configured scalar words can map to Hub vocabulary; prototype properties are never words. */
export function mapped<T>(map: Readonly<Record<string, T>>, value: unknown): T | undefined {
  if (value === null || value === undefined || (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') || (typeof value === 'string' && !value.trim())) return undefined;
  const key = String(value); return Object.hasOwn(map, key) ? map[key] : undefined;
}

export function registrationMissing(d: ExecutorDefinition): string[] {
  const missing: string[] = [];
  if(!d.environment)missing.push('environment');
  if (!d.credential)missing.push('credential');
  if (!d.proof.warrant_id) missing.push('proof.warrant_id');
  if (!d.manifest_sha256) missing.push('manifest_sha256');
  if (!d.resources.length) missing.push('resources');
  if(d.resources.length && !d.probes)missing.push('probes');
  if(d.probes && d.probes.devices===undefined)missing.push('probes.devices');
  if(!d.refused_tools.length)missing.push('refused_tools');
  if (!d.conditions.length) missing.push('conditions');
  for (const [index, step] of d.precheck_reads.entries()) if (!step.conditions.length) missing.push(`precheck_reads/${index}/conditions`);
  return missing;
}
