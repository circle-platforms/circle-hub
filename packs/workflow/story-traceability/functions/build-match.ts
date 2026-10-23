// Until unbound workflows have a read-only alias lookup, only exact names after NFKC/edge trimming prove this binding.
import { isRecord } from './text.ts';
import type { IndexViewData } from './types.ts';
export const buildNameKey = (value: string): string => value.normalize('NFKC').trim();
export function sameBuild(name: string, view: Pick<IndexViewData, 'product' | 'build' | 'root'>, input: unknown): boolean {
  const context = isRecord(input) ? input : {};
  if (typeof context.product === 'string' && context.product !== view.product) return false;
  if (typeof context.root === 'string' && context.root !== view.root) return false;
  return buildNameKey(name) === buildNameKey(view.build);
}
