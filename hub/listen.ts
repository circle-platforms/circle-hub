// The listening endpoint and the authorities explicitly admitted at the HTTP boundary.
import { BlockList, isIP } from 'node:net';

const PRIVATE = new BlockList();
for (const [network, prefix] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24]] as const) PRIVATE.addSubnet(network, prefix, 'ipv4');
PRIVATE.addSubnet('fc00::', 7, 'ipv6');
PRIVATE.addSubnet('fe80::', 10, 'ipv6');
PRIVATE.addSubnet('2001:db8::', 32, 'ipv6');

export function validListenAddress(host: string): boolean {
  const family = isIP(host);
  if (!family || host === '0.0.0.0' || host === '::') return false;
  if (family === 6) {
    try { if (new URL(`http://[${host}]`).hostname !== `[${host}]`) return false; } catch { return false; }
  }
  if (host === '::1') return true;
  if (family === 4 && /^127\./.test(host)) return true;
  return PRIVATE.check(host, family === 4 ? 'ipv4' : 'ipv6');
}

/** Authorities are exact hostnames or IP literals, without a scheme, port, wildcard, credentials or path. */
export function validAllowedHost(host: string): boolean {
  if (!host || host.length > 253 || host !== host.toLowerCase()) return false;
  if (host.startsWith('[') && host.endsWith(']')) {
    try { return isIP(host.slice(1, -1)) === 6 && new URL(`http://${host}`).hostname === host; } catch { return false; }
  }
  if (isIP(host) === 4) return true;
  return host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export function validAllowedHosts(hosts: readonly string[]): boolean {
  return hosts.length > 0 && hosts.length <= 100 && new Set(hosts).size === hosts.length && hosts.every(validAllowedHost);
}

/** Explicit HTTPS proxy origin, with an authority distinct from every direct HTTP authority. */
export function validProxyOrigin(value: string, hosts: readonly string[] | undefined, port: number): boolean {
  if (!hosts) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password && hosts.includes(url.hostname) && !hosts.some(host => `${host}:${port}` === url.host);
  } catch { return false; }
}
