export interface Heartbeat {stop:()=>Promise<void>;held:()=>boolean;lastConfirmedAt:()=>number|null;}
export interface LeaseClock {at:number;mono:number;ttl:number;}
export interface RemoteLease { id: unknown; token: unknown; ttl: number; }
