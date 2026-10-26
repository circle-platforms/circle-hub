// Retry classes are exhaustive, but every positive rule still needs versioned target evidence.
import type {RetrySafety,EffectMark} from '../../contracts/generated/vocabulary.ts';
export const RETRY_RULES={
 same_key_safe:{resend:true,window:false,mark:null},
 dedup_window:{resend:true,window:true,mark:null},
 duplicate_tolerant:{resend:true,window:false,mark:'possible_duplicate'},
 unsafe:{resend:false,window:false,mark:null},
} satisfies Record<RetrySafety,{resend:boolean;window:boolean;mark:EffectMark|null}>;
