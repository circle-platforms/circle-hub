// Shared generated tokens and component styles, plus temporary layout rules for pages not yet migrated.
// Chunks 2–5 remove these legacy rules as their markup moves to the shared component classes.
import { DESIGN_CSS } from './style.generated.ts';

const LEGACY_CSS = `

/* Temporary aliases, never a second palette. Both themes come only from the shared tokens. */
:where(.hub){
  --bg:var(--surface-1);--fg:var(--text-primary);--sidebar:var(--surface-0);--surface:var(--surface-2);--hover:var(--surface-hover);--active:var(--surface-pressed);--border:var(--line-hairline);
  --secondary:var(--text-secondary);--muted:var(--text-tertiary);--subtle:var(--surface-2);
  --read-bg:var(--status-info-bg);--write-bg:var(--status-pass-bg);--think-bg:var(--surface-2);--agent-bg:var(--surface-2);--removed-bg:var(--status-fail-bg);
  --accent:var(--area);--violet:var(--area-workflow);--negative:var(--status-fail);--attention:var(--status-warn);--positive:var(--status-pass);--call:var(--area-workflow);
  --accent-strong:var(--inverse-surface);--on-accent:var(--text-inverse);
  --s-pass:var(--status-pass);--s-fail:var(--status-fail);--s-judgment:var(--status-info);--s-unchecked:var(--status-muted);--s-incomplete:var(--status-warn);--s-unknown:var(--status-muted);
  --t-pass:var(--status-pass-text);--t-fail:var(--status-fail-text);--t-judgment:var(--status-info-text);--t-incomplete:var(--status-warn-text);--t-unknown:var(--text-secondary);--t-unchecked:var(--text-secondary);
  --b-pass:var(--status-pass-bg);--b-fail:var(--status-fail-bg);--b-judgment:var(--status-info-bg);--b-incomplete:var(--status-warn-bg);--b-unknown:var(--surface-hover);--b-unchecked:var(--surface-hover);
  --shadow:none;--shadow-pop:var(--shadow-popover);
  --ui:var(--type-body-size);--ui-small:var(--type-caption-size);--ui-tiny:var(--type-mono-small-size);--ui-large:var(--type-panel-title-size);--radius:var(--radius-md);
  --mono:var(--font-mono);
  font-family:var(--font-sans);
  font-size:var(--ui);line-height:var(--type-body-line-height);color:var(--fg);background:var(--bg);font-synthesis:none;-webkit-font-smoothing:antialiased;
  min-height:100vh;
}


:where(.hub) *,:where(.hub) *::before,:where(.hub) *::after{box-sizing:border-box}
body:where(.hub){margin:0}
:where(.hub) b,:where(.hub) strong{font-weight:600}
:where(.hub) code,:where(.hub) pre,.num,.nowrap,:where(.hub) time{font-family:var(--font-mono);font-variant-numeric:tabular-nums}
:where(.hub) code{font-size:12px;overflow-wrap:anywhere}
:where(.hub) pre{white-space:pre-wrap;overflow:auto;max-width:100%}
:where(.hub) p{margin:0}
:where(.hub) :focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}
.ico{width:16px;height:16px;flex:none;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
.nowrap{white-space:nowrap}.grow{flex:1;min-width:0}.break{overflow-wrap:anywhere}
.error{color:var(--status-fail-text)}.notice{padding:var(--space-3);border:1px solid var(--line-control);border-radius:var(--radius-lg)}
.live-module{display:contents}.live-state{color:var(--status-warn-text);font-size:12px}
.f-pass{background:var(--s-pass)}.f-fail{background:var(--s-fail)}.f-judgment{background:var(--s-judgment)}
.f-unchecked{background:var(--s-unchecked)}.f-incomplete{background:var(--s-incomplete)}.f-unknown{background:var(--s-unknown)}
.f-added{background:var(--s-pass)}.f-removed{background:var(--s-fail)}.f-modified{background:var(--s-judgment)}
.t1{background:var(--accent)}.t2{background:var(--violet)}.t3{background:var(--attention)}.t4{background:var(--positive)}.t5{background:color-mix(in srgb,var(--accent) 45%,var(--bg))}.t6{background:var(--negative)}
.axis{display:flex;justify-content:space-between;color:var(--secondary);font-size:var(--ui-tiny);margin-top:7px}
.funnel{display:flex;flex-direction:column;gap:10px}
.frow{display:grid;grid-template-columns:86px minmax(0,1fr) 52px;align-items:center;gap:10px;font-size:var(--ui-small);min-height:22px}
.fname{color:var(--secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fval{text-align:right;font-weight:600}
.t-pass{color:var(--t-pass)}.t-failure{color:var(--t-fail)}.t-judgment{color:var(--t-judgment)}.t-incomplete{color:var(--t-incomplete)}
.t-unknown{color:var(--t-unknown);font-weight:600}
/* ---------------------------------------------------------------- connections */
.topo{display:grid;grid-template-columns:minmax(0,1fr) 120px 150px 120px minmax(0,1fr);align-items:center}
@media (max-width:1080px){.topo{grid-template-columns:minmax(0,1fr);gap:12px}.topo .wires{display:none}}
.topo-col{display:flex;flex-direction:column;gap:12px}
.tnode{display:flex;align-items:center;gap:10px;height:44px;padding:0 12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);font-size:var(--ui-small)}
.tnode b{font-weight:600}
.tnode .sub{margin-left:auto}
.tnode.ghost{border-style:dashed;background:var(--subtle);color:var(--secondary)}
.tnode.hubn{flex-direction:column;justify-content:center;gap:6px;height:auto;padding:16px 12px;border-color:color-mix(in srgb,var(--accent) 40%,var(--border));background:color-mix(in srgb,var(--read-bg) 40%,var(--bg))}
.wires{display:block;width:100%;height:212px;overflow:visible}
.wire{fill:none;stroke:color-mix(in srgb,var(--accent) 55%,var(--border));stroke-width:1.6;stroke-dasharray:4 6;animation:dash 1.1s linear infinite}
.wire.ghost{stroke:var(--border);animation:none}
.chan{display:flex;flex-direction:column;gap:10px}
.chan-i{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--surface);color:var(--secondary)}


/* ---------------------------------------------------------------- trace waterfall: one picture of a task, step by step */
.wf{--name:300px;--dur:78px}
.wf-sum{display:flex;flex-wrap:wrap;gap:8px 26px;padding:0 0 14px;border-bottom:1px solid var(--border)}
.wf-sum > div{display:flex;flex-direction:column;gap:2px}
.wf-sum b{font-size:18px;font-weight:600;letter-spacing:-.3px;line-height:1.2}
.wf-sum span{font-size:var(--ui-tiny);color:var(--secondary)}
.wf-sum .bad b{color:var(--t-fail)}.wf-sum .unk b{color:var(--t-unknown)}
.wf-tools{display:flex;flex-wrap:wrap;align-items:center;gap:10px 16px;padding:12px 0 8px}
.wf-tools .search{margin:0;width:200px;height:30px}
.wf-tools .seg{margin-left:auto}
.wf-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:var(--ui-tiny);color:var(--secondary)}
.wf-legend span{display:inline-flex;align-items:center;gap:6px}
.wf-legend i{display:inline-block;width:16px;height:8px;border-radius:2px}
.wf-axis,.wf-row{display:grid;grid-template-columns:var(--name) minmax(0,1fr) var(--dur);align-items:center;gap:12px}
.wf-axis{height:26px;font-size:var(--ui-tiny);color:var(--secondary);border-bottom:1px solid var(--border);padding:0 8px 0 6px}
.wf-ticks{position:relative;align-self:stretch}
.wf-ticks span{position:absolute;top:6px;white-space:nowrap}
.wf-rows{position:relative}
.wf-row{width:100%;min-height:36px;padding:0 8px 0 6px;border:0;border-bottom:1px solid color-mix(in srgb,var(--border) 55%,transparent);background:none;text-align:left;cursor:pointer;font:inherit;color:inherit;transition:background .1s;animation:rise .35s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(var(--i,0) * 28ms + 80ms)}
.wf-row:hover{background:var(--subtle)}
.wf-row.on{background:color-mix(in srgb,var(--read-bg) 60%,var(--bg))}
.wf-name{display:flex;align-items:center;gap:7px;min-width:0;padding-left:calc(var(--d,0) * 20px);font-size:var(--ui-small)}
.wf-name .twist{width:14px;height:14px;flex:none;color:var(--secondary)}
.wf-name b{font-weight:600;white-space:nowrap;flex:none}
.wf-name .sub{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.wf-track{position:relative;align-self:stretch;min-height:36px;background-image:linear-gradient(90deg,color-mix(in srgb,var(--border) 75%,transparent) 1px,transparent 1px);background-size:25% 100%}
.wf-bar{position:absolute;top:50%;height:14px;margin-top:-7px;border-radius:4px;min-width:3px;transform-origin:left;animation:growx .7s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(var(--i,0) * 28ms + 220ms)}
.wf-bar.none{display:none}
.k-circle{background:var(--violet)}
.k-hub{background:var(--accent)}
.k-sys{background:color-mix(in srgb,var(--accent) 45%,var(--positive))}
.k-group{background:color-mix(in srgb,var(--fg) 28%,transparent)}
.wf-bar.k-group{height:6px;margin-top:-3px;border-radius:3px}
.k-wait{background:repeating-linear-gradient(135deg,var(--attention) 0 5px,color-mix(in srgb,var(--attention) 40%,var(--bg)) 5px 10px)}
.k-hand{background:color-mix(in srgb,var(--muted) 12%,transparent);border:1.5px dashed var(--muted)}
.k-fail{background:var(--negative)}
.wf-bar.k-result{width:12px;min-width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;border:2px solid var(--bg);box-shadow:0 0 0 1px var(--border);animation:pop .4s cubic-bezier(.2,.7,.2,1) both .9s}
.k-result.ok{background:var(--s-pass)}.k-result.back{background:var(--s-fail)}.k-result.wait{background:var(--s-incomplete)}.k-result.undone{background:var(--s-unchecked)}
.wf-bar.open{border-top-right-radius:0;border-bottom-right-radius:0;animation:growx .7s cubic-bezier(.2,.7,.2,1) both,breathe 2.2s ease-in-out infinite 1s}
.wf-bar.live{animation:growx .7s cubic-bezier(.2,.7,.2,1) both,breathe 1.4s ease-in-out infinite 1s}
.wf-dur{font-size:var(--ui-tiny);color:var(--secondary);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.wf-now{position:absolute;top:0;bottom:0;width:0;border-left:1.5px dashed var(--negative);pointer-events:none;z-index:1}
.wf-now span{position:absolute;top:-21px;left:-20px;font-size:var(--ui-tiny);color:var(--t-fail);font-weight:600;white-space:nowrap}
.tasks{--name:270px;--dur:96px;margin-top:22px}
.tasks .wf-row{min-height:42px}
.tasks .wf-name{flex-direction:column;align-items:flex-start;gap:0;line-height:1.35}
.slow{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:9px}
.slow li{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) 72px;align-items:center;gap:10px;font-size:var(--ui-small)}
.insp-h{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}
.insp-h h3{font-size:16px;font-weight:600}
.gloss{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1.3fr);gap:0 14px;font-size:var(--ui-small)}
.gloss > span{padding:9px 0;border-bottom:1px solid var(--border);min-width:0}
.gloss .gh{color:var(--secondary);font-weight:500;padding-top:0}
.gloss .old{color:var(--secondary);text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--muted) 60%,transparent)}
.gloss .new{font-weight:600;color:var(--fg)}
@keyframes breathe{50%{opacity:.62}}


/* ---------------------------------------------------------------- health strip, then narrow screens */


/* ---------------------------------------------------------------- console: charts drawn with SVG attributes */
.svg-track{display:block;width:100%;height:36px;overflow:visible}
.svg-track .tick{stroke:color-mix(in srgb,var(--border) 75%,transparent);stroke-width:1}
.svg-track .now{stroke:var(--negative);stroke-width:1.5;stroke-dasharray:3 3}
.tasks .svg-track{height:42px}
.fill-circle{fill:var(--violet)}.fill-hub{fill:var(--accent)}.fill-sys{fill:color-mix(in srgb,var(--accent) 45%,var(--positive))}
.fill-wait{fill:var(--attention)}.fill-hand{fill:color-mix(in srgb,var(--muted) 30%,transparent);stroke:var(--muted);stroke-width:1.5;stroke-dasharray:4 3}
.fill-fail{fill:var(--negative)}.fill-group{fill:color-mix(in srgb,var(--fg) 28%,transparent)}
.fill-pass{fill:var(--s-pass)}.fill-unchecked{fill:var(--s-unchecked)}.fill-incomplete{fill:var(--s-incomplete)}.fill-unknown{fill:var(--s-unknown)}.fill-judgment{fill:var(--s-judgment)}
.fill-track{fill:var(--surface)}
.dot-result{stroke:var(--bg);stroke-width:2}
.svg-bars{display:block;width:100%;height:230px;border-bottom:1px solid var(--border)}
.svg-bars .gl{stroke:var(--border);stroke-width:.4}
.svg-hbar{display:block;width:100%;height:10px}
.svg-stack{display:block;width:100%;height:10px;margin-top:12px}
.stroke-pass{stroke:var(--s-pass)}.stroke-fail{stroke:var(--s-fail)}.stroke-judgment{stroke:var(--s-judgment)}.stroke-unchecked{stroke:var(--s-unchecked)}.stroke-incomplete{stroke:var(--s-incomplete)}.stroke-unknown{stroke:var(--s-unknown)}
.wf-row.static{cursor:default}
a.wf-row{color:inherit}
.result-legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:var(--ui-small);color:var(--secondary);margin-bottom:6px}
.result-legend b{color:var(--fg);font-weight:600;margin-left:2px}
.result-legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.wf-name.d1{padding-left:22px}
.wf-ticks.flex{display:flex;justify-content:space-between;align-items:center}
.wf-ticks.flex span{position:static}
.task-list .wf-name{flex-direction:column;align-items:flex-start;gap:0;line-height:1.35}
.fill-t1{fill:var(--accent)}.fill-t2{fill:var(--violet)}.fill-t3{fill:var(--attention)}.fill-t4{fill:var(--positive)}.fill-t5{fill:color-mix(in srgb,var(--accent) 45%,var(--bg))}.fill-t6{fill:var(--negative)}
.f-hub{background:var(--accent)}.f-circle{background:var(--violet)}.f-wait{background:var(--attention)}
`;

// Composition rules adapt the shared components without introducing a second palette.
const SHELL_CSS = `

.ch-actions a.ch-chip { display:inline-flex;align-items:center;gap:var(--space-2); }
.ch-chip[aria-current] { background:var(--surface-pressed);box-shadow:none;color:var(--text-primary); }
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
.ch-parts { width:100%;height:8px;display:block; }
[data-filters] { display:flex;flex-wrap:wrap;gap:var(--space-3);align-items:end; }
[data-filters] label { display:flex;flex-direction:column;gap:var(--space-2);font-size:12px;color:var(--text-secondary);min-width:0; }
[data-filters] input,[data-filters] select { max-width:100%;min-width:0; }
/* Bare fields retained by read-only comparison forms use the same Input tokens. */
:where([data-area-content] form input:not([type=hidden]):not([type=checkbox]):not([type=radio]),[data-area-content] form select,[data-area-content] form textarea):not(.ch-input *) { border:1px solid var(--line-control);border-radius:var(--radius-md);background:var(--surface-sunken);color:var(--text-primary);padding:6px 10px;min-height:var(--control-height);font:inherit;max-width:100%; }
.ch-dialog .ch-quote { user-select:all; }
.ch-feed li { min-width:0;overflow-wrap:anywhere; }
.wf-ticks.flex { display:flex;align-items:center;justify-content:space-between;min-width:0; }
.wf-ticks.flex span { position:static; }
@media(max-width:760px){.wf-ticks.flex span:not(:first-child):not(:last-child){display:none;}}
.ch-feed time { white-space:nowrap; }
@media(max-width:1180px){[data-columns="3"],[data-columns="4"]{grid-template-columns:repeat(2,minmax(0,1fr));}}
@media(max-width:760px){[data-columns]{grid-template-columns:minmax(0,1fr);} [data-inspector-content]{min-height:calc(100dvh - 120px);}.wf{--name:160px;--dur:62px}.wf-name{flex-wrap:wrap}.wf-name b{white-space:normal;overflow-wrap:anywhere}.wf-name .ch-meta{white-space:normal}.wf-axis,.wf-row{gap:var(--space-2);}.health{grid-template-columns:1fr;}}
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
.ch-seg a[aria-current] { background: var(--surface-2); color: var(--text-primary); box-shadow: 0 0 0 1px var(--line-hairline); }
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
.ch-seg button[aria-checked="true"] { background: var(--surface-2); color: var(--text-primary); box-shadow: 0 0 0 1px var(--line-hairline); }
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

export const CSS = `${LEGACY_CSS}\n${DESIGN_CSS}\n${SHELL_CSS}\n[data-theme-switch][hidden]{display:none}\n`;
