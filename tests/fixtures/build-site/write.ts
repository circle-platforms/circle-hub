// Writes the synthetic build-site fixture files (ISO-8859-1 bytes) from the texts below. Everything is invented: the
// product ORBIT with its second name family COMET, the builds, the commands and the bug numbers; addresses are in
// 192.0.2.0/24. The structure mirrors the real site (architecture brief section 8): an index page linking listing pages and
// a hub page, a hub page with a dead link, listing pages whose entries read `<build> (build on  <date> <time> ): [based on
// <base>] [Released on <date>]` with released entries in a red font element and links with unquoted attributes, a command
// tree in ISO-8859-1 with stray quotes in help strings and overloads (two items of one name), a fixed-bug list.
// Run `node tests/fixtures/build-site/write.ts` after a change; packs/system/build-site/reads.test.ts fails while the files differ.
import { writeFileSync } from 'node:fs';

const HEX = (seed: string): string => seed.repeat(64).slice(0, 64);

type Entry = { build: string; built: string; released?: string; basedOn?: string; tree?: boolean; bugs?: boolean; image?: string };

function listing(title: string, entries: Entry[]): string {
  const rows = entries.map((e) => {
    const head = `${e.build} (build on  ${e.built} ): ${e.basedOn ? `based on ${e.basedOn} ` : ''}${e.released ? `Released on ${e.released} ` : ''}`;
    const line = e.released ? `<font color=red>${head}</font>` : head;
    const files = [
      `<A href=/builds/OrbitOS-${e.build}.array>http://192.0.2.10/builds/OrbitOS-${e.build}.array ( 901M\t, SHA256: ${HEX(e.image ?? '0f')}    )</A><BR>`,
      `<A href=/builds/ORBIT-MIB-${e.build}.txt>http://192.0.2.10/builds/ORBIT-MIB-${e.build}.txt</A><BR>`,
      ...(e.tree ? [`<A href=/builds/command_tree-${e.build}.xml>http://192.0.2.10/builds/command_tree-${e.build}.xml</A><BR>`] : []),
      ...(e.bugs ? [`<A href=http://192.0.2.10/builds/Bugs_Fixed_with_${e.build}.html>http://192.0.2.10/builds/Bugs_Fixed_with_${e.build}.html</A><BR>`] : []),
    ];
    return `${line} </br> <BLOCKQUOTE> ${files.join('')}</BLOCKQUOTE>`;
  });
  return [
    '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">',
    '<html xmlns="http://www.w3.org/1999/xhtml" lang="en-US" xml:lang="en-US">',
    `<head><title>${title}</title><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1" /></head>`,
    '<body>',
    `<h2> ${title}</h2>`,
    '<font color=red>Note: synthetic page, every name and number is invented (créé pour les tests).</font>',
    '<hr />',
    '<strong>Packages</strong><br /><br />',
    ...rows,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

export const PAGES: Record<string, string> = {
  'index.html': [
    '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML//EN">',
    '<HTML><HEAD><TITLE>Synthetic Build Machine</TITLE></HEAD>',
    '<BODY BGCOLOR="#ffffffff">',
    '<FONT COLOR="green"><H1>Synthetic Build Machine © tests</H1></FONT><BR>',
    '<h1>Mainline</h1>',
    '<A HREF=http://192.0.2.10/builds/orbit_7_2.html>7.2 Builds</A><BR><BR>',
    '<FONT COLOR="green"><A HREF="http://192.0.2.10/builds/rel_orbit_7_1.html">ORBIT 7.1 builds</A></FONT><BR><BR>',
    '<A HREF=rel_comet_7_1.html>rel_comet_7_1 builds</A><BR><BR>',
    '<A HREF=http://192.0.2.10/builds/rel_orbit_6_9.html>rel_orbit_6_9 builds (removed)</A><BR><BR>',
    '<h1>Branches</h1>',
    '<A HREF="http://192.0.2.10/builds/rel_orbit_7_1_sy_k.html">rel_orbit_7_1_sy_k builds</A><BR><BR>',
    '<A HREF="mailto:builds@example.invalid">mail the build team</A><BR><BR>',
    '</BODY>',
    '</HTML>',
    '',
  ].join('\n'),
  'orbit_7_2.html': [
    '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML//EN">',
    '<HTML><HEAD><TITLE>Synthetic 7.2 builds</TITLE></HEAD>',
    '<BODY><FONT COLOR="green"><H1>7.2 Builds</H1></FONT><BR>',
    '<A HREF=/builds/rel_comet_7_2.html>rel_comet_7_2 builds</A><BR><BR>',
    '<A HREF="/builds/rel_orbit_7_2.html">rel_orbit_7_2 builds</A><BR><BR>',
    '<A HREF=/builds/rel_orbit_7_2_special.html>rel_orbit_7_2_special builds</A><BR><BR>',
    '</BODY></HTML>',
    '',
  ].join('\n'),
  'rel_orbit_7_1.html': listing('Synthetic ORBIT 7.1 builds', [
    { build: 'Rel_ORBIT_7_1_0_31', built: '2026-05-10 09:00:00', tree: true, image: '1a' },
    { build: 'Rel_ORBIT_7_1_0_30', built: '2026-05-02 08:00:00', released: '2026-05-04', tree: true, bugs: true, image: '2b' },
    { build: 'Rel_ORBIT_7_1_0_22', built: '2026-03-20 10:00:00', released: '2026-03-23', tree: true, image: '3c' },
  ]),
  'rel_comet_7_1.html': listing('Synthetic COMET 7.1 builds', [
    { build: 'Rel_COMET_7_1_0_12', built: '2026-05-06 11:00:00', basedOn: 'Rel_ORBIT_7_1_0_30', released: '2026-05-08', image: '4d' },
    { build: 'Rel_COMET_7_1_0_11', built: '2026-05-05 11:00:00', basedOn: 'Rel_ORBIT_7_1_0_30', image: '5e' },
  ]),
  'rel_orbit_7_2.html': listing('Synthetic ORBIT 7.2 builds', [{ build: 'Rel_ORBIT_7_2_0_8', built: '2026-06-01 10:00:00', tree: true, image: '6f' }]),
  'rel_comet_7_2.html': listing('Synthetic COMET 7.2 builds', [{ build: 'Rel_COMET_7_2_0_8', built: '2026-06-01 10:05:00', tree: true, image: '7a' }]),
  'rel_orbit_7_1_sy_k.html': listing('Synthetic ORBIT 7.1 builds on the SY-K platform', [
    { build: 'Rel_ORBIT-SY-K_7_1_0_3_1_2', built: '2026-05-20 10:00:00', released: '2026-05-22', tree: true, image: '8b' },
  ]),
};

/** A command the unreleased build adds, so its tree differs from the released one. */
export const NEW_COMMAND = '<item name="ping" lock = "ORBIT_LOCK_NONE" func="orbit_ping" help_string="Send echo requests"><arguments><arg name="" type="DOTTEDIP" help_string="Address to probe" length="" limit="" optional="NO" default_value=""></arg></arguments><results></results></item>';

/** A command tree: menus, items with argument lists, overloads (two items of one name), stray quotes in help strings. */
export function commandTree(extra = ''): string {
  return [
    '<?xml version="1.0" encoding="ISO-8859-1"?><commands><scope type="global">',
    '<menu name="orbit" help_string="Orbit commands (synthetic)" user_level="ORBIT_LEVEL_CONFIG">',
    '<menu name="beacon" help_string="Configure beacons" user_level="ORBIT_LEVEL_CONFIG">',
    '<item name="add" lock = "ORBIT_LOCK_NONE" func="orbit_beacon_add" help_string="Add a beacon to a ring"><arguments>',
    '<arg name="" type="STRING" help_string="Ring name" length="" limit="[1 - 32]" optional="NO" default_value=""></arg>',
    '<arg name="" type="IPADDR" help_string="Beacon address (either address family)" length="" limit="" optional="NO" default_value=""></arg>',
    '<arg name="" type="U16" help_string="Beacon port" length="" limit="" optional="NO" default_value=""></arg>',
    '<arg name="" type="U32" help_string="Weight (1 to 100, default 10)" length="" limit="[1 - 100]" optional="YES" default_value="10"></arg>',
    '</arguments><results></results></item>',
    '<item name="add" lock = "ORBIT_LOCK_NONE" func="orbit_beacon_add_host" help_string="Add a beacon by host name"><arguments>',
    '<arg name="" type="STRING" help_string="Ring name" length="" limit="[1 - 32]" optional="NO" default_value=""></arg>',
    '<arg name="" type="XSTRING" help_string="Beacon address or host name" length="" limit="" optional="NO" default_value=""></arg>',
    '</arguments><results></results></item>',
    '<item name="label" lock = "ORBIT_LOCK_NONE" func="orbit_beacon_label" help_string="Type "text" to label the beacon (étiquette)" hidden="yes"><arguments>',
    '<arg name="" type="STRING" help_string="Ring name" length="" limit="" optional="NO" default_value=""></arg>',
    '<arg name="" type="STRING" help_string="Label, ie cn=ring,dc=example,dc=invalid" length="64" limit="" optional="YES" default_value="&amp;quot;&amp;quot;"></arg>',
    '</arguments><results></results></item>',
    '</menu>',
    '<item name="mode" lock = "ORBIT_LOCK_NONE" func="orbit_mode" help_string="Set the ring mode"><arguments>',
    '<arg name="mode" type="STRING" help_string="Mode" length="" limit="{rr|lc|hash}" optional="NO" default_value="&amp;quot;rr&amp;quot;"></arg>',
    '</arguments><results></results></item>',
    '</menu>',
    '<menu name="show" help_string="Show information" user_level="ORBIT_LEVEL_USER">',
    '<menu name="orbit" help_string="Show orbit information" user_level="ORBIT_LEVEL_USER">',
    '<item name="status" lock = "ORBIT_LOCK_NONE" func="orbit_show_status" help_string="Show the status"><arguments></arguments><results></results></item>',
    '<item name="status" lock = "ORBIT_LOCK_NONE" func="orbit_show_ring_status" help_string="Show the status of one ring"><arguments>',
    '<arg name="" type="STRING" help_string="Ring name (every ring when left out)" length="" limit="" optional="YES" default_value="&amp;quot;all&amp;quot;"></arg>',
    '</arguments><results></results></item>',
    '</menu>',
    '</menu>',
    extra,
    "</scope></commands>",
    '',
  ].join('\n');
}

export function fixedBugs(build: string): string {
  return [
    '<html><head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><title>Bugs fixed</title></head><body>',
    `<h1>Bugs Fixed with ${build}</h1>`,
    '<table border=1>',
    '<tr><th>Bug ID</th><th>Summary</th></tr>',
    '<tr><td><a href=http://192.0.2.9/bug?id=70412>70412</a></td><td>Beacon weight 0 was accepted (cas limite résolu)</td></tr>',
    '<tr><td><a href=http://192.0.2.9/bug?id=70413>70413</a></td><td>show orbit status listed a removed ring</td></tr>',
    '</table>',
    '</body></html>',
    '',
  ].join('\n');
}

/** Every file of the synthetic site by its path below the origin, as ISO-8859-1 bytes. */
export function siteFiles(): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(PAGES)) files[`/builds/${name}`] = new Uint8Array(Buffer.from(text, 'latin1'));
  for (const build of ['Rel_ORBIT_7_1_0_31', 'Rel_ORBIT_7_1_0_30', 'Rel_ORBIT_7_1_0_22', 'Rel_ORBIT_7_2_0_8', 'Rel_COMET_7_2_0_8', 'Rel_ORBIT-SY-K_7_1_0_3_1_2']) {
    files[`/builds/command_tree-${build}.xml`] = new Uint8Array(Buffer.from(commandTree(build === 'Rel_ORBIT_7_1_0_31' ? NEW_COMMAND : ''), 'latin1'));
  }
  files['/builds/Bugs_Fixed_with_Rel_ORBIT_7_1_0_30.html'] = new Uint8Array(Buffer.from(fixedBugs('Rel_ORBIT_7_1_0_30'), 'latin1'));
  return files;
}

if (import.meta.main) {
  const dir = new URL('./files/', import.meta.url);
  for (const [path, bytes] of Object.entries(siteFiles())) writeFileSync(new URL(path.slice('/builds/'.length), dir), bytes);
  console.log(`wrote ${Object.keys(siteFiles()).length} files`);
}
