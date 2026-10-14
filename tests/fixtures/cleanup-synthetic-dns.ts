// A synthetic non-allowlisted HTTP host still connects only to the loopback
// fixture. The production plaintext policy and transport remain unchanged.
import dns from 'node:dns';
const lookup=dns.lookup;
dns.lookup=((hostname:any,...args:any[])=>Reflect.apply(lookup,dns,[hostname==='gateway.synthetic.test'?'127.0.0.1':hostname,...args])) as typeof dns.lookup;
