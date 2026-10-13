import {z} from 'zod';
const record=z.object({label:z.string(),revision:z.string()}).strict();
export function project(value:unknown){return record.parse(value);}
