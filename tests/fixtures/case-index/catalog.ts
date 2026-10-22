// The invented command catalog of the case-index fixtures, written as a build site's command tree (`commands > scope >
// menu[name] > item[name] > arguments > arg[...]`, the full command is the menu path plus the item name; brief section 8).
// Every word is invented. Version `a` is the catalog of the earlier build, version `b` of the later one: `b` widens the
// range of `widget health interval`, removes `relay encrypt mode` and adds `widget pool rename`, so that the version
// difference of the two builds is known here, independently of the Hub.

export type Arg = { type: string; help: string; limit?: string; optional?: boolean; default?: string };
export type Command = { words: string; help: string; args: Arg[] };

const pool: Arg = { type: 'STRING', help: 'Pool name', limit: '[1 - 32]' };
const name: Arg = { type: 'STRING', help: 'Name', limit: '[1 - 32]' };
const address: Arg = { type: 'IPADDR', help: 'Endpoint address (either family)' };

/** The commands of version `a`, in tree order. */
export const CATALOG_A: readonly Command[] = [
  { words: 'widget health interval', help: 'Probe interval', args: [pool, { type: 'U32', help: 'Seconds', limit: '[1 - 60]' }] },
  { words: 'widget health retries', help: 'Retries before down', args: [pool, { type: 'U32', help: 'Count', limit: '[1 - 10]' }] },
  { words: 'widget health probe', help: 'Probe type', args: [pool, { type: 'STRING', help: 'Type', limit: '{http|tcp}' }] },
  { words: 'widget pool add', help: 'Add a pool', args: [name, { type: 'U32', help: 'Weight', limit: '[1 - 100]', optional: true, default: '10' }] },
  { words: 'widget pool delete', help: 'Delete a pool', args: [name] },
  { words: 'widget pool mode', help: 'Scheduling mode', args: [name, { type: 'STRING', help: 'Mode', limit: '{rr|lc}' }] },
  { words: 'widget session clear', help: 'Clear the sessions of a pool', args: [pool] },
  { words: 'widget profile set', help: 'Set a profile value', args: [name, { type: 'STRING', help: 'Value' }] },
  { words: 'relay endpoint add', help: 'Add an endpoint', args: [address, { type: 'U16', help: 'Port' }] },
  { words: 'relay endpoint delete', help: 'Delete an endpoint', args: [address] },
  { words: 'relay endpoint weight', help: 'Endpoint weight', args: [address, { type: 'U32', help: 'Weight', limit: '[1 - 100]' }] },
  { words: 'relay encrypt mode', help: 'Encryption', args: [{ type: 'STRING', help: 'State', limit: '{on|off}' }] },
  { words: 'relay log level', help: 'Log level', args: [{ type: 'STRING', help: 'Level', limit: '{debug|info|warn}' }] },
  { words: 'beacon group add', help: 'Add a beacon group', args: [name, { type: 'U32', help: 'TTL', limit: '[1 - 255]' }] },
  { words: 'beacon group delete', help: 'Delete a beacon group', args: [name] },
  { words: 'beacon ttl inherit', help: 'TTL inheritance', args: [name, { type: 'STRING', help: 'State', limit: '{on|off}' }] },
  { words: 'show health', help: 'Show health', args: [{ ...pool, optional: true }] },
  { words: 'show health detail', help: 'Show health details', args: [pool] },
  { words: 'show endpoints', help: 'Show endpoints', args: [] },
  { words: 'show pools', help: 'Show pools', args: [] },
  { words: 'show profile', help: 'Show profiles', args: [{ ...name, optional: true }] },
  { words: 'show beacon group', help: 'Show beacon groups', args: [{ ...name, optional: true }] },
  { words: 'show statistics relay', help: 'Show relay statistics', args: [] },
  { words: 'no widget health probe', help: 'Reset the probe type', args: [pool] },
  { words: 'no relay log level', help: 'Reset the log level', args: [] },
  { words: 'system reboot', help: 'Reboot', args: [{ type: 'U32', help: 'Delay', limit: '[0 - 600]', optional: true }] },
  { words: 'system backup save', help: 'Save a backup', args: [{ type: 'STRING', help: 'File' }] },
  { words: 'system backup restore', help: 'Restore a backup', args: [{ type: 'STRING', help: 'File' }] },
  { words: 'clear statistics relay', help: 'Clear relay statistics', args: [] },
  { words: 'ping', help: 'Ping a host', args: [{ type: 'STRING', help: 'Host' }] },
];

/** The commands of version `b`: interval widened to 120 seconds, relay encrypt mode removed, widget pool rename added. */
export const CATALOG_B: readonly Command[] = [
  ...CATALOG_A.filter((c) => c.words !== 'relay encrypt mode').map((c) =>
    c.words === 'widget health interval' ? { ...c, args: [pool, { type: 'U32', help: 'Seconds', limit: '[1 - 120]' }] } : c,
  ),
  { words: 'widget pool rename', help: 'Rename a pool', args: [name, name] },
];

/** Command words whose definition differs between `a` and `b` (modified, removed, added), sorted. */
export const CHANGED_COMMANDS: readonly string[] = ['relay encrypt mode', 'widget health interval', 'widget pool rename'];

const escape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function argXml(arg: Arg): string {
  const def = arg.default === undefined ? '' : escape(escape(`"${arg.default}"`));
  return `<arg name="" type="${arg.type}" help_string="${escape(arg.help)}" length="" limit="${escape(arg.limit ?? '')}" optional="${arg.optional ? 'YES' : 'NO'}" default_value="${def}"></arg>`;
}

type Menu = { menus: Map<string, Menu>; items: Command[] };

/** The command tree XML of a catalog (ASCII, so its ISO-8859-1 and UTF-8 bytes are the same). */
export function commandTreeXml(catalog: readonly Command[]): string {
  const root: Menu = { menus: new Map(), items: [] };
  for (const command of catalog) {
    const words = command.words.split(' ');
    let menu = root;
    for (const word of words.slice(0, -1)) {
      let next = menu.menus.get(word);
      if (next === undefined) {
        next = { menus: new Map(), items: [] };
        menu.menus.set(word, next);
      }
      menu = next;
    }
    menu.items.push(command);
  }
  const lines: string[] = [];
  const write = (menu: Menu, depth: number): void => {
    for (const command of menu.items) {
      const item = command.words.split(' ').at(-1) as string;
      lines.push(`${'  '.repeat(depth)}<item name="${item}" lock = "DEMO_LOCK_NONE" func="demo_${command.words.replaceAll(' ', '_')}" help_string="${escape(command.help)}"><arguments>`);
      for (const arg of command.args) lines.push(`${'  '.repeat(depth + 1)}${argXml(arg)}`);
      lines.push(`${'  '.repeat(depth)}</arguments><results></results></item>`);
    }
    for (const [word, child] of menu.menus) {
      lines.push(`${'  '.repeat(depth)}<menu name="${word}" help_string="${word} (synthetic)" user_level="DEMO_LEVEL_CONFIG">`);
      write(child, depth + 1);
      lines.push(`${'  '.repeat(depth)}</menu>`);
    }
  };
  write(root, 1);
  return ['<?xml version="1.0" encoding="ISO-8859-1"?><commands><scope type="global">', ...lines, '</scope></commands>', ''].join('\n');
}

/** The tree path of a command as the product pack files it: /commands/<word>/<word>... */
export function commandPath(words: string): string {
  return `/commands/${words.split(' ').join('/')}`;
}
