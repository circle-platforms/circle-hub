// A build-site-like stub (architecture brief section 8, structure only, invented content): anonymous, plain HTTP, pages in
// ISO-8859-1; an index page linking hub pages and listing pages, a hub page with a dead link, listing pages whose entries
// read `<build> (build on  <date> <time> ): [based on <base>] [Released on <date>]` (released ones in a red font element)
// followed by links with UNQUOTED attributes (image with size and SHA-256 in the text, the command tree, the fixed list),
// and command tree XML files.
import { notFound, startStub, text, type StubServer } from './stub.ts';

export interface StaticFile {
  body: Uint8Array;
  type: string;
}

const latin1 = (value: string): Uint8Array => Buffer.from(value, 'latin1');
const HTML = 'text/html; charset=ISO-8859-1';
const HEX = 'a'.repeat(16) + '0123456789abcdef'.repeat(3);

export const BUILDS = ['Rel_DEMO_2_1_0_5', 'Rel_DEMO_2_1_0_6'] as const;

export function commandTree(build: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<commands build="${build}">`,
    '  <scope name="global">',
    '    <menu name="widget">',
    '      <item name="list" help="list the widgets"><arguments><arg name="name" type="STRING" length="32" optional="true"/></arguments></item>',
    '      <item name="set" help="set a widget value"><arguments><arg name="value" type="U16" limit="[1 - 100]"/></arguments></item>',
    '    </menu>',
    '  </scope>',
    '</commands>',
    '',
  ].join('\n');
}

export function buildSiteFiles(): Record<string, StaticFile> {
  const files: Record<string, StaticFile> = {};
  const page = (path: string, html: string) => (files[path] = { body: latin1(html), type: HTML });
  page('/index.html', '<html><head><title>Builds</title></head><body><h1>Builds © synthetic</h1><a href=demo_2_1.html>DEMO 2.1 builds</a><br><a href=rel_demo_2_0.html>DEMO 2.0 builds</a><br></body></html>');
  page('/demo_2_1.html', '<html><body><a href=rel_demo_2_1.html>rel_demo_2_1</a><br><a href=rel_alt_2_1.html>rel_alt_2_1</a><br><a href=rel_demo_2_1_special.html>special</a></body></html>');
  const entry = (build: string, released: string | null, basedOn: string | null) =>
    `${build} (build on  2026-01-12 10:00:00 ): ${basedOn ? `based on ${basedOn} ` : ''}${released ? `<font color=red>Released on ${released}</font>` : ''}<br>` +
    `<a href=builds/${build}/image.click>image</a> (12.3M, SHA256: ${HEX})<br>` +
    `<a href=builds/${build}/command_tree-${build}.xml>command_tree-${build}.xml</a><br>` +
    `<a href=builds/${build}/Bugs_Fixed_with_${build}.html>Bugs_Fixed_with_${build}.html</a><br>`;
  page('/rel_demo_2_1.html', `<html><body><p>Café build list</p>${entry(BUILDS[1], null, null)}${entry(BUILDS[0], '2026-01-15', null)}</body></html>`);
  page('/rel_alt_2_1.html', `<html><body>${'Rel_ALT_2_1_0_5 (build on  2026-01-13 11:00:00 ): based on Rel_DEMO_2_1_0_5 <font color=red>Released on 2026-01-16</font><br>'}</body></html>`);
  page('/rel_demo_2_0.html', '<html><body>Rel_DEMO_2_0_0_9 (build on  2025-06-01 09:00:00 ): <font color=red>Released on 2025-06-03</font><br></body></html>');
  for (const build of BUILDS) {
    files[`/builds/${build}/command_tree-${build}.xml`] = { body: Buffer.from(commandTree(build), 'utf8'), type: 'application/xml' };
    files[`/builds/${build}/Bugs_Fixed_with_${build}.html`] = { body: latin1('<html><body><a href=http://192.0.2.9/bug?id=4242>4242</a></body></html>'), type: HTML };
  }
  return files;
}

export async function startBuildSiteStub(files: Record<string, StaticFile> = buildSiteFiles()): Promise<StubServer> {
  return startStub((request) => {
    if (request.method !== 'GET') return notFound();
    const file = files[decodeURIComponent(request.path)];
    return file === undefined ? notFound() : text(file.body, file.type);
  });
}
