import { isRecord } from './common.ts';
export function classificationSubject(input:unknown):Record<string,unknown>{
 const raw=isRecord(input)?input:{},item=isRecord(raw.item)?raw.item:{},fields=isRecord(item.fields)?item.fields:{};
 const context=isRecord(raw.context)?raw.context:{},groups=Array.isArray(context.groups)?context.groups.filter(isRecord):[];
 const document=groups.find(g=>g.kind==='document'&&g.id===item.id);
 const slots=isRecord(raw.slots)?raw.slots:{};
 return {item:item.id,location:item.location,document:document?.id??fields.document,source:document?.classification_source,case_rule:document?.case_rule,claims:slots.coverage,skipped:fields.skipped??[],scope_complete:fields.scope_complete===true};
}
export default classificationSubject;
