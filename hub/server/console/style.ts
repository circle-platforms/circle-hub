// Shared generated tokens and components, with composition rules for the server-rendered console.
import { DESIGN_CSS } from './style.generated.ts';

const BASE_CSS = `
:where(.hub) *,:where(.hub) *::before,:where(.hub) *::after{box-sizing:border-box}
:where(.hub) b,:where(.hub) strong{font-weight:600}
:where(.hub) code,:where(.hub) pre,.num,.nowrap,:where(.hub) time{font-family:var(--font-mono);font-variant-numeric:tabular-nums}
:where(.hub) code{font-size:12px;overflow-wrap:anywhere}
.ch-original-preview{max-height:55vh;overflow:auto}
.ch-source-hit{color:var(--text-primary);background:var(--surface-pressed);outline:1px solid var(--focus-ring);scroll-margin-block:var(--space-4)}
:where(.hub) pre{white-space:pre-wrap;overflow:auto;max-width:100%}
:where(.hub) p{margin:0}
:where(.hub) :focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.ico{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.nowrap{white-space:nowrap}.grow{flex:1;min-width:0}.break{overflow-wrap:anywhere}
.error{color:var(--status-fail-text)}.notice{padding:var(--space-3);border:1px solid var(--line-control);border-radius:var(--radius-lg)}
.live-module{display:contents}.live-state{color:var(--status-warn-text);font-size:12px}
.t-pass{color:var(--status-pass-text)}.t-failure{color:var(--status-fail-text)}.t-judgment{color:var(--status-info-text)}.t-incomplete{color:var(--status-warn-text)}.t-unknown{color:var(--text-secondary);font-weight:600}
.fill-pass{fill:var(--status-pass)}.fill-fail{fill:var(--status-fail)}.fill-judgment{fill:var(--status-info)}
.fill-incomplete{fill:var(--status-warn)}.fill-unknown,.fill-unchecked{fill:var(--status-muted)}
`;

// Composition rules adapt the shared components without introducing a second palette.
const SHELL_CSS = `
[hidden]{display:none!important}
.ch-toast[hidden]{display:none}
.ch-plot{max-width:480px}
.ch-plot:has([data-timeline]){max-width:680px;overflow-x:auto}
.ch-chart[data-timeline]{min-width:600px}
.ch-tip-bubble{display:none}
.ch-tip:hover .ch-tip-bubble,.ch-tip:focus-within .ch-tip-bubble,.ch-tip.is-open .ch-tip-bubble{display:block;animation:ch-tip-in var(--dur-fast) var(--ease-enter)}
@keyframes ch-tip-in{from{opacity:0}to{opacity:1}}
.ch-tip.is-below .ch-tip-bubble{top:calc(100% + 8px);bottom:auto}
.ch-tip.is-edge-right .ch-tip-bubble{left:auto;right:0;transform:none}
.ch-chart.is-dim .bar:not(.is-hot){opacity:.9}
.ch-plot.is-loading{opacity:.9}
.ch-plot.is-loading .ch-chart.is-dim .bar:not(.is-hot){opacity:1}
.ch-chart-tip{top:var(--space-2);right:var(--space-2);max-width:calc(100% - 16px)}
.ch-chart-tip p,.ch-chart-tip .when{overflow-wrap:anywhere}
.ch-chart [data-chart-index].is-hot .crosshair{visibility:visible}
.ch-chart [data-chart-index]:focus-visible{outline:none}
.ch-chart [data-chart-index]:focus-visible .hit{stroke:var(--focus-ring);stroke-width:2}
.ch-chart [data-row-href] .hit{cursor:pointer}
.ch-field-error{display:block}
.ch-app[aria-busy="true"] .ch-table tbody{opacity:.9}
.ch-connection-map{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:var(--space-5)}
@media(max-width:760px){.ch-connection-map{grid-template-columns:minmax(0,1fr)}}


.ch-actions a.ch-chip { display:inline-flex;align-items:center;gap:var(--space-2); }
.ch-chip[aria-current] { background:var(--surface-pressed);box-shadow:inset 0 0 0 1px var(--focus-ring);color:var(--text-primary); }
[data-columns] { display:grid; gap:var(--space-6); align-items:start; }
[data-columns="2"] { grid-template-columns:repeat(2,minmax(0,1fr)); }
[data-columns="3"] { grid-template-columns:repeat(3,minmax(0,1fr)); }
[data-columns="4"] { grid-template-columns:repeat(4,minmax(0,1fr)); }
[data-inspector-content] { display:flex;flex-direction:column;gap:var(--space-5);min-width:0;min-height:calc(100dvh - 90px); }
[data-inspector-content] .ch-inspector-actions { margin-top:auto;flex-wrap:wrap; }
.ch-inspector-actions .ch-btn { padding-inline:var(--space-2); }
.ch-stat-unit { font:400 12px/18px var(--font-sans); color:var(--text-secondary); }
.ch-stat-label { display:flex;align-items:center;gap:var(--space-2); }
.ch-legend .fill-pass{--s:var(--status-pass)}.ch-legend .fill-fail{--s:var(--status-fail)}.ch-legend .fill-judgment{--s:var(--status-info)}.ch-legend .fill-incomplete{--s:var(--status-warn)}.ch-legend .fill-unknown,.ch-legend .fill-unchecked{--s:var(--status-muted)}
.ch-parts { width:100%;height:8px;display:block;border-radius:4px;overflow:hidden; }
[data-filters] { display:flex;flex-wrap:wrap;gap:var(--space-3);align-items:end; }
[data-filters] label { display:flex;flex-direction:column;gap:var(--space-2);font-size:12px;color:var(--text-secondary);min-width:0; }
[data-filters] input,[data-filters] select { max-width:100%;min-width:0; }
/* Bare fields retained by read-only comparison forms use the same Input tokens. */
:where([data-area-content] form input:not([type=hidden]):not([type=checkbox]):not([type=radio]),[data-area-content] form select,[data-area-content] form textarea):not(.ch-input *) { border:1px solid var(--line-control);border-radius:var(--radius-md);background:var(--surface-sunken);color:var(--text-primary);padding:6px 10px;min-height:var(--control-height);font:inherit;max-width:100%; }
.ch-dialog .ch-quote { user-select:all; }
.ch-feed li { min-width:0;overflow-wrap:anywhere; }
.ch-feed time { white-space:nowrap; }
@media(max-width:1180px){[data-columns="3"],[data-columns="4"]{grid-template-columns:repeat(2,minmax(0,1fr));}}
@media(max-width:760px){[data-columns]{grid-template-columns:minmax(0,1fr);} [data-inspector-content]{min-height:calc(100dvh - 120px);}}
.ch-app[data-without-inspector] { grid-template-columns: var(--nav-width) minmax(0, 1fr); }
.ch-table-wrap { min-width: 0; width: 100%; max-width: 100%; overflow-x: auto; overscroll-behavior-x: contain; }
.ch-table-wrap:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
.ch-table { width: max-content; min-width: 100%; }
.ch-table td { max-width: 32rem; overflow-wrap: anywhere; }
.ch-table th { background: var(--surface-1); }
[data-area-content], [data-area-content] .ch-section { min-width: 0; }
[data-area-content] .ch-section { margin: 0; }
[data-area-content] > .ch-section + .ch-section { margin-top: var(--space-6); }
[data-area-content] pre { max-width: 100%; box-sizing: border-box; overflow: auto; }
[data-area-content] [data-fields] { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
[data-area-content] [data-wide-field] { grid-column: 1 / -1; }
[data-area-content] .ch-input input, [data-area-content] .ch-input select, [data-area-content] .ch-input textarea { width: 100%; }
[data-area-content] .ch-dialog-body { min-width: 0; }
[data-knowledge-selection] { min-width: 0; }
[data-knowledge-selection]:not(:has(input[name="selected_entry"]:checked)) > .ch-bulkbar { display: none; }
[data-grant-controls] { display: flex; flex-wrap: wrap; align-items: end; gap: var(--space-3); }
[data-grant-controls]:has(option[value="administrators"]:checked) [data-member-input] { display: none; }
.ch-table-wrap .ch-table [data-technical] { min-width: 4em; }
.ch-table-wrap .ch-table [data-technical][open] { max-width: 24rem; }
.ch-seg a { display: inline-flex; align-items: center; min-height: 28px; padding: 0 var(--space-3); border-radius: var(--radius-sm); font: 500 12px/1 var(--font-sans); color: var(--text-secondary); white-space: nowrap; }
.ch-seg a[aria-current] { background: var(--surface-2); color: var(--text-primary); box-shadow: inset 0 0 0 1px var(--focus-ring); }
.ch-row[data-row-href], .ch-table tr[data-row-href] { cursor: pointer; }
.ch-row-title { overflow-wrap: anywhere; }
.ch-inspector [data-area-content] .ch-section + .ch-section { margin-top: var(--space-5); }
.ch-inspector [data-fields] { grid-template-columns: minmax(0, 1fr); }
[data-technical] > summary { color: var(--text-link); font: 400 12px/18px var(--font-sans); cursor: pointer; }
.ch-dialog [data-fields] { display: grid; gap: var(--space-3); }
.ch-app { min-width: 0; }
.ch-app > .ch-nav, .ch-app > .ch-inspector { position: sticky; top: 0; height: 100dvh; min-height: 0; box-sizing: border-box; overflow: auto; align-self: start; }
.ch-pane > *, .ch-inspector > *, [data-page-content] > * { min-width: 0; max-width: 100%; }
.ch-pane .tablewrap { min-width: 0; max-width: 100%; overflow-x: auto; }
.ch-pane pre, .ch-inspector pre { overflow-wrap: anywhere; }
.ch-pane .ch-title { text-wrap: balance; overflow-wrap: anywhere; }
.ch-page-head > div:first-child { flex: 1 1 180px; min-width: 0; }
.ch-page-head > .ch-actions { margin-left: auto; }
.ch-nav .ch-brand > span { flex: 1; }
.ch-nav .ch-brand > label, [data-navigation-toggle] { display: none; }
.ch-nav form { margin: 0; }
.ch-nav .ch-input { width: 100%; }
.ch-nav-item > span:last-child, .ch-nav-foot .ch-section > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-nav-sub section { margin: 0; min-width: 0; }
.ch-inspector > .ch-section { margin: 0; }
.ch-nav-sub details { margin: 0; min-width: 0; }
.ch-nav-sub summary { display: block; min-width: 0; }
.ch-nav-tree details details { padding-left: var(--space-3); }
.ch-nav-tree a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-nav-foot { flex-wrap: wrap; gap: var(--space-2); }
.ch-nav-foot > .ch-actions { width: 100%; flex-wrap: nowrap; }
.ch-nav-foot .ch-section { flex: 1; gap: 0; min-width: 0; }
.ch-nav-foot .ch-seg { max-width: 100%; }
.ch-nav-foot form { flex: none; }
.ch-seg button[aria-checked="true"] { background: var(--surface-2); color: var(--text-primary); box-shadow: inset 0 0 0 1px var(--focus-ring); }
[data-sign-in] { box-sizing: border-box; width: min(440px, calc(100% - 32px)); margin: auto; background: var(--surface-2); padding: var(--space-6); border-radius: var(--radius-xl); box-shadow: none; }
[data-sign-in][data-wide] { width: min(720px, calc(100% - 32px)); }
body:has(> [data-sign-in]) { display: flex; min-height: 100vh; padding: var(--space-6) 0; box-sizing: border-box; background: var(--surface-0); }
[data-sign-in] .ch-brand { padding: 0; }
[data-sign-in] .ch-section { gap: var(--space-4); }
[data-sign-in] .ch-field { margin: 0; }
[data-sign-in] .ch-input { width: 100%; }
[data-sign-in] form { display: flex; flex-direction: column; gap: var(--space-4); margin: 0; }
[data-sign-in] .ch-input input { width: 100%; }
[data-sign-in] footer { justify-content: flex-end; margin-top: var(--space-2); }
[data-sign-in] .ch-field-error, [data-sign-in] .error { overflow-wrap: anywhere; }
@media (max-width: 760px) {
 .ch-app[data-without-inspector] { grid-template-columns: minmax(0, 1fr); }
 [data-area-content] [data-fields] { grid-template-columns: minmax(0, 1fr); }
 .ch-app { grid-template-rows: auto minmax(0, 1fr); }
 .ch-app > .ch-nav { position: static; height: auto; min-height: 0; overflow: visible; display: block; }
 .ch-app > .ch-inspector { position: static; height: auto; }
 .ch-nav .ch-brand { min-height: var(--control-height); }
 .ch-nav .ch-brand > label { display: inline-grid; }
 [data-navigation-toggle] { display: block; }
 [data-navigation-toggle]:focus-visible + .ch-brand label { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
 [data-navigation-toggle]:not(:checked) ~ form, [data-navigation-toggle]:not(:checked) ~ .ch-nav-list, [data-navigation-toggle]:not(:checked) ~ .ch-nav-foot { display: none; }
 .ch-nav > form, .ch-nav-list, .ch-nav-foot { margin-top: var(--space-3); }
 .ch-nav-foot { margin-top: var(--space-4); }
 .ch-page-head > .ch-actions { margin-left: 0; width: 100%; }
 [data-sign-in] { padding: var(--space-5); }
}
`;

export const CSS = `${DESIGN_CSS}\n${BASE_CSS}\n${SHELL_CSS}\n[data-theme-switch][hidden]{display:none}\n`;
