import type { ProtocolError } from '../../contracts/api.ts';
import { referencesIn } from '../../contracts/src/variables.ts';
import type { ExecutorDefinition } from './definition.ts';

/** This state is structural, never inferred from a failed permission projection. */
export function isBootstrapCaptureDefinition(definition: ExecutorDefinition): boolean {
  return definition.enabled && definition.resources.length === 0 && definition.target.trim().length > 0
    && referencesIn({ target: definition.target }).length === 0;
}

/** One typed refusal channel; the protocol payload contains no internal target or executor identity. */
export class EnvironmentRegistrationIncompleteError extends Error {
  readonly protocol: ProtocolError & {code:'SOURCE_NOT_PERMITTED';call_error_reason:'environment_registration_incomplete'};
  /** Only supplied after the source has verified the actual stored administrator. */
  readonly administratorExecutor: string | undefined;
  constructor(administratorExecutor?: string) {
    const protocol: EnvironmentRegistrationIncompleteError['protocol'] = {
      code: 'SOURCE_NOT_PERMITTED',
      call_error_reason: 'environment_registration_incomplete',
      object_kind: 'test_environment',
      message: '该测试环境还没有登记完成，尚未声明资源清单',
    };
    super(protocol.message);
    this.name = 'EnvironmentRegistrationIncompleteError';
    this.protocol = protocol;
    this.administratorExecutor = administratorExecutor;
  }
}

import { at } from './definition.ts';

export interface BootstrapCaptureObservation {
  operation:string; reference:string; record:string; complete:boolean; observed:boolean;
  value?:unknown; captures:Array<{pointer:string;value?:unknown;missing_fact?:string}>; missing_fact?:string;
}
/** Called only for a real returned Exchange after transport identity and tool success checks. */
export function bootstrapCaptureObservation(operation:string,reference:string,record:string,value:unknown,pointers:readonly string[]):BootstrapCaptureObservation {
  return {operation,reference,record,complete:true,observed:true,value,captures:pointers.map(pointer=>{
    const captured=at(value,pointer);
    return captured===undefined?{pointer,missing_fact:'声明的观察字段未出现，未取得该字段事实'}:{pointer,value:captured};
  })};
}

export function registrationIncompleteRefusal(error:EnvironmentRegistrationIncompleteError) {
  return {started:false as const,outcome:'not_dispatched' as const,error_code:error.protocol.code,
    call_error_reason:error.protocol.call_error_reason,reason:error.protocol.message,
    ...(error.administratorExecutor?{executor:error.administratorExecutor}:{})};
}
