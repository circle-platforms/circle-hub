// Pure subject construction shared only inside one evaluation of one locked workflow version.
import { createHash } from 'node:crypto';
import type { PackFunctionTarget } from '../../rules/api.ts';

type Build = (target: PackFunctionTarget, input: unknown) => Promise<unknown>;

/** Create for one evaluation's run subject or one item, never across submissions. Checks still run independently. */
export function createSubjectBuilder(build: Build): Build {
  const pending = new Map<string, Promise<unknown>>();
  return async (target, input) => {
    // Hash exactly the JSON the isolated function receives, including item identity and the run context.
    // Non-JSON inputs keep the sandbox's existing refusal instead of inventing a cache error.
    let wire: string | undefined;
    try { wire = JSON.stringify(input); } catch { return build(target, input); }
    if (wire === undefined) return build(target, input);
    const key = createHash('sha256').update(JSON.stringify([target.packDir, target.module, target.export ?? 'default'])).update('\n').update(wire).digest('hex');
    let task = pending.get(key);
    if (task === undefined) {
      task = build(target, JSON.parse(wire));
      pending.set(key, task);
    }
    try {
      // Interpreters get separate objects; mutation by one check cannot change the next check's subject.
      return structuredClone(await task);
    } catch (error) {
      // A transient sandbox failure must not become the result of another check's attempt.
      if (pending.get(key) === task) pending.delete(key);
      throw error;
    }
  };
}
