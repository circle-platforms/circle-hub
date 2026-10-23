// Pure subject construction shared only inside one evaluation of one locked workflow version.
import { createHash } from 'node:crypto';
import { isExhaustedFunctionFailure, type PackFunctionTarget } from '../../rules/api.ts';

export class SubjectCopyError extends Error {
  constructor(cause: unknown) { super('Hub 无法复制被判对象数据', { cause }); this.name = 'SubjectCopyError'; }
}

type Build = (target: PackFunctionTarget, input: unknown) => Promise<unknown>;

export function subjectKey(target: PackFunctionTarget, wire: string): string {
  return createHash('sha256').update(JSON.stringify([target.packDir, target.module, target.export ?? 'default'])).update('\n').update(wire).digest('hex');
}

/** Create for one evaluation's run subject or one item, never across submissions. Checks still run independently. */
export function createSubjectBuilder(build: Build): Build {
  const pending = new Map<string, { build: Promise<unknown>; json?: string }>();
  return async (target, input) => {
    // Hash exactly the JSON the isolated function receives, including item identity and the run context.
    // Non-JSON inputs keep the sandbox's existing refusal instead of inventing a cache error.
    let wire: string | undefined;
    try { wire = JSON.stringify(input); } catch { return build(target, input); }
    if (wire === undefined) return build(target, input);
    const key = subjectKey(target, wire);
    let task = pending.get(key);
    if (task === undefined) {
      let snapshot: unknown;
      try { snapshot = JSON.parse(wire); } catch (error) { throw new SubjectCopyError(error); }
      task = { build: build(target, snapshot) };
      pending.set(key, task);
    }
    let output: unknown;
    try { output = await task.build; }
    catch (error) {
      // An exhausted transient build is shared; other failed builds are evicted. Copy failures keep its successful value/text.
      if (!isExhaustedFunctionFailure(error) && pending.get(key) === task) pending.delete(key);
      throw error;
    }
    try {
      if (task.json === undefined) {
        const text = JSON.stringify(output);
        if (text === undefined) throw new TypeError('successful subject was not JSON');
        task.json = text;
      }
      return JSON.parse(task.json);
    } catch (error) { throw new SubjectCopyError(error); }
  };
}
