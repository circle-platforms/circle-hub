// Whether a result is the delivery of an administrative abandon. A leaf module: the statistics and the result summary read
// it without loading the management flow that writes such results.
import type {ValidationResult} from '../../../contracts/src/validation.ts';
import {ENGINE_COMPONENT} from './deps.ts';
export function isAbandonedResult(result:ValidationResult):boolean{return result.cross_item.some(c=>c.warrant.producer==='function'&&c.warrant.id===ENGINE_COMPONENT&&c.statement.data?.run_disposition==='abandon');}
