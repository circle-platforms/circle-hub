// A small synthetic build site of the product for end-to-end tests (not part of the pack): the index page links the mainline
// listing pages of line 10.6.1 of both name families; the FAMX page lists a released build with its command tree and its
// fixed-bug list and a newer build that is not released; the FAMY page lists an alias based on the released FAMX build. The
// command tree holds the invented commands of the synthetic review mind map (tests/fixtures/mindmaps/review-150), with typed
// parameters, so that a review's command checks have a catalog to consult. Structure of the real site (brief section 8),
// invented content; served under /builds by hub/connectors/testing startBuildSiteStub.

export const SITE_BASE = '/builds';
export const RELEASED = 'Rel_FAMX_10_6_1_57';
export const UNRELEASED = 'Rel_FAMX_10_6_1_58';
export const ALIAS = 'Rel_FAMY_10_6_1_57';
export const LINE = '10.6.1';

const latin1 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'latin1'));
const HTML = 'text/html; charset=ISO-8859-1';
const XML = 'application/xml';

const arg = (help: string, type: string, limit: string, optional = false, extra = ''): string =>
  `<arg name="" type="${type}" help_string="${help}" length="" limit="${limit}" optional="${optional ? 'YES' : 'NO'}" default_value=""${extra}></arg>`;

const item = (name: string, func: string, args: string[]): string =>
  `<item name="${name}" lock = "DEMO_LOCK_NONE" user_level="DEMO_LEVEL_CONFIG" func="${func}" help_string="${name} (synthetic)"><arguments>\n${args.join('\n')}\n</arguments><results></results></item>`;

/** The command tree of the released build (ISO-8859-1 XML in the shape of the real command_tree files). */
export function widgetTree(): string {
  return [
    '<?xml version="1.0" encoding="ISO-8859-1"?><commands><scope type="global">',
    '<menu name="widget" help_string="Widget gateway (synthetic)" user_level="DEMO_LEVEL_CONFIG">',
    '<menu name="health" help_string="Health checks" user_level="DEMO_LEVEL_CONFIG">',
    item('interval', 'demo_health_interval', [arg('Pool name', 'STRING', '[1 - 32]'), arg('Probe interval in seconds', 'U32', '[1 - 60]')]),
    item('retries', 'demo_health_retries', [arg('Pool name', 'STRING', '[1 - 32]'), arg('Retries before a member is down', 'U32', '[1 - 10]')]),
    item('probe', 'demo_health_probe', [arg('Pool name', 'STRING', '[1 - 32]'), arg('Probe type', 'STRING', '{http|tcp}')]),
    '</menu>',
    '</menu>',
    '<menu name="relay" help_string="Relay (synthetic)" user_level="DEMO_LEVEL_CONFIG">',
    '<menu name="endpoint" help_string="Endpoints" user_level="DEMO_LEVEL_CONFIG">',
    item('add', 'demo_endpoint_add', [arg('Endpoint address', 'IPADDR', ''), arg('Endpoint port', 'U16', '')]),
    '</menu>',
    '</menu>',
    '<menu name="show" help_string="Show (synthetic)" user_level="DEMO_LEVEL_VIEW">',
    item('health', 'demo_show_health', [arg('Pool name', 'STRING', '[1 - 32]', true)]),
    '</menu>',
    '</scope></commands>',
    '',
  ].join('\n');
}

const page = (title: string, body: string): string =>
  `<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML//EN">\n<HTML><HEAD><TITLE>${title}</TITLE></HEAD>\n<BODY BGCOLOR="#ffffffff">\n${body}\n</BODY>\n</HTML>\n`;

const files = (build: string): string =>
  `<BLOCKQUOTE> <A href=/builds/DemoOS-${build}.array>http://192.0.2.10/builds/DemoOS-${build}.array ( 901M\t, SHA256: ${'0f1e2d3c'.repeat(8)}    )</A><BR><A href=/builds/command_tree-${build}.xml>http://192.0.2.10/builds/command_tree-${build}.xml</A><BR><A href=/builds/Bugs_Fixed_with_${build}.html>http://192.0.2.10/builds/Bugs_Fixed_with_${build}.html</A><BR></BLOCKQUOTE>`;

/** Path -> file of the site. */
export function famxSite(): Record<string, { body: Uint8Array; type: string }> {
  const index = page(
    'Synthetic Build Machine',
    '<h1>Mainline</h1>\n<A HREF=rel_famx_10_6_1.html>rel_famx_10_6_1 builds</A><BR><BR>\n<A HREF="http://192.0.2.10/builds/rel_famy_10_6_1.html">rel_famy_10_6_1 builds</A><BR><BR>\n<A HREF=rel_famx_10_6_1_sy_demoos12.html>rel_famx_10_6_1_sy_demoos12 builds</A><BR><BR>',
  );
  const famx = page(
    'Synthetic FAMX listing',
    [
      `${UNRELEASED} (build on  2026-05-20 09:00:00 ):  </br> ${files(UNRELEASED)}`,
      `<font color=red>${RELEASED} (build on  2026-05-12 10:20:30 ): Released on 2026-05-14 </font> </br> ${files(RELEASED)}`,
    ].join('\n'),
  );
  const famy = page('Synthetic FAMY listing', `<font color=red>${ALIAS} (build on  2026-05-12 11:00:00 ): based on ${RELEASED} Released on 2026-05-15 </font> </br> <BLOCKQUOTE> <A href=/builds/DemoOS-${ALIAS}.array>http://192.0.2.10/builds/DemoOS-${ALIAS}.array</A><BR></BLOCKQUOTE>`);
  const fixed = page(`Bugs fixed with ${RELEASED}`, '<TABLE><TR><TD>31057</TD><TD>HTTP probe reported a member healthy on status 500 (synthetic)</TD></TR></TABLE>');
  return {
    [`${SITE_BASE}/index.html`]: { body: latin1(index), type: HTML },
    [`${SITE_BASE}/rel_famx_10_6_1.html`]: { body: latin1(famx), type: HTML },
    [`${SITE_BASE}/rel_famy_10_6_1.html`]: { body: latin1(famy), type: HTML },
    [`${SITE_BASE}/command_tree-${RELEASED}.xml`]: { body: latin1(widgetTree()), type: XML },
    [`${SITE_BASE}/Bugs_Fixed_with_${RELEASED}.html`]: { body: latin1(fixed), type: HTML },
  };
}
