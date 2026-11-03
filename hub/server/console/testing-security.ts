// Test-only comparison of the fixed templates after response-boundary nonce injection.
export const withoutNonces=(body:string):string=>body.replace(/ nonce="[A-Za-z0-9+/=]+"/g,'');
