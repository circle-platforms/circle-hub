import type {TreeRootBody} from '../../contracts/src/knowledge.ts';
/** Labels are frozen producer data; the Hub adds no product vocabulary. */
export function emptyScopeNote(value:TreeRootBody['empty_scope']):string|null {
  return value ? `不分版本的根为空（清单完整，${value.sources.map(source=>`${source.label} ${source.selected} 份`).join('、')}）` : null;
}
