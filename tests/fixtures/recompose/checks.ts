// Privacy audit is deliberately separate from semantic classification. Report filenames/counts, never matched values.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { isIP } from 'node:net';
const forbidden = [[65, 80, 86], [78, 83, 65, 69], [73, 110, 102, 111, 115, 101, 99, 79, 83]].map(a => String.fromCharCode(...a));
export function auditText(text: string) {
    const findings: string[] = [];
    for (const value of forbidden)
        if (new RegExp(value, 'i').test(text))
            findings.push('protected_name');
    for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?/g)) {
        const value = match[0].split('/')[0];
        if (isIP(value) === 4 && value.split('.').slice(0, 3).join('.') !== '192.0.2')
            findings.push('non_documentation_ipv4');
    }
    for (const token of text.match(/[0-9a-fA-F:]+/g) ?? []) {
        if (token.includes(':') && isIP(token) === 6) {
            const [a, b] = token.split(':');
            if (parseInt(a, 16) !== 0x2001 || parseInt(b, 16) !== 0xdb8)
                findings.push('non_documentation_ipv6');
        }
    }
    if (text.includes('/' + 'Users' + '/') || text.includes('/' + 'home' + '/'))
        findings.push('machine_path');
    return findings;
}
export function auditFixtures(root = fileURLToPath(new URL('./', import.meta.url))) { const results: Array<{
    file: string;
    findings: string[];
}> = []; const walk = (path: string, rel = '') => { for (const e of readdirSync(path, { withFileTypes: true })) {
    if (e.isDirectory())
        walk(join(path, e.name), rel + e.name + '/');
    else {
        const text = readFileSync(join(path, e.name), 'utf8');
        results.push({ file: rel + e.name, findings: auditText(text) });
    }
} }; walk(root); return results; }
if (import.meta.main) {
    const rows = auditFixtures();
    for (const row of rows)
        console.log(row.file + '\t' + row.findings.length);
    if (rows.some(r => r.findings.length))
        process.exitCode = 1;
}
