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
.ch-app [data-editor-foreground]{width:100%;max-width:850px;min-width:0}
[data-editor-foreground] form>[data-fields]{grid-template-columns:minmax(0,1fr)}
[data-editor-foreground] details>div{padding-block:var(--space-3)}
.ch-editor-actions{position:sticky;bottom:0;z-index:2;background:var(--surface-0);border-top:1px solid var(--line-hairline);padding-block:var(--space-4);flex-wrap:wrap}
[data-editor-foreground] textarea[name="statement"]{min-height:100px}
[data-editor-foreground] textarea[name="markdown"]{min-height:160px}
/* Blocks of the reorganized pages (decision 151): a bordered card, a row of figures, a main column beside a narrower one. */
.ch-card{display:flex;flex-direction:column;min-width:0;box-sizing:border-box;border:1px solid var(--line-hairline);border-radius:var(--radius-lg);background:var(--surface-1);color:inherit}
.ch-card-head{display:flex;align-items:center;flex-wrap:wrap;gap:var(--space-1) var(--space-3);padding:var(--space-4) var(--space-5) 0}
.ch-card-title{margin:0;font:600 15px/22px var(--font-sans);color:var(--text-primary)}
.ch-card-tail{margin-left:auto;font-size:13px}
.ch-card-body{min-width:0;padding:var(--space-3) var(--space-5) var(--space-4)}
.ch-card-body[data-flush]{padding:var(--space-2) 0 var(--space-1)}
/* An empty list inside a card has the card's edge, not a second one of its own. */
.ch-card-body .ch-empty{box-shadow:none;padding:var(--space-5)}
.ch-card-body[data-flush] .ch-list{gap:0}
.ch-card-body[data-flush] .ch-row{padding:var(--space-3) var(--space-5);border-radius:0;align-items:start}
.ch-card-body[data-flush] .ch-row+.ch-row{box-shadow:inset 0 1px 0 var(--line-hairline)}
.ch-card-foot{padding:var(--space-3) var(--space-5);box-shadow:inset 0 1px 0 var(--line-hairline);font-size:13px}
/* A row of a card is one link: its name reads as text, not as a link among links, and the row answers the pointer. */
.ch-card-body[data-flush] a.ch-row{color:inherit;text-decoration:none}
.ch-card-body[data-flush] a.ch-row b{color:var(--text-primary);font-weight:500}
.ch-card-body[data-flush] a.ch-row:hover{background:var(--surface-hover)}
/* The card's head already names the figure; the figure keeps its title for assistive technology. */
.ch-card-head+.ch-card-body .ch-figure-title{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.ch-tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:var(--space-4)}
.ch-tile{position:relative;padding:var(--space-4) var(--space-5)}
.ch-tile-link{position:absolute;inset:0;border-radius:inherit}
.ch-tile-link:hover{box-shadow:inset 0 0 0 1px var(--line-control)}
.ch-board{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:var(--space-4);align-items:start}
.ch-stack{display:flex;flex-direction:column;gap:var(--space-4);min-width:0}
/* A task's result beside what still waits for someone (decision 151). */
.ch-result{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr)}
.ch-result>div{display:flex;flex-direction:column;gap:var(--space-3);min-width:0;padding:var(--space-4) var(--space-5)}
.ch-result>div+div{box-shadow:inset 1px 0 0 var(--line-hairline)}
.ch-result p{margin:0}
.ch-todo{display:flex;flex-direction:column;gap:var(--space-2);margin:0;padding:0;list-style:none}
.ch-todo li{display:flex;align-items:baseline;gap:var(--space-3);min-width:0}
.ch-todo b{font-weight:500;overflow-wrap:anywhere}
.ch-todo-count{flex:none;min-width:48px;padding:0 var(--space-2);border-radius:var(--radius-sm);background:var(--status-warn-bg);color:var(--status-warn-text);font:600 13px/24px var(--font-sans);text-align:center}
@media(max-width:1180px){.ch-result{grid-template-columns:minmax(0,1fr)}.ch-result>div+div{box-shadow:inset 0 1px 0 var(--line-hairline)}}
/* Filters of a list: the result chips at the start, the other filters at the end. */
.ch-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:var(--space-3) var(--space-4)}
.ch-toolbar>[data-filters]{margin-left:auto}
/* A table inside a card reaches the card's edges; its cells keep the card's inset. */
.ch-card-body[data-flush] .ch-table-wrap{box-shadow:none;border-radius:0;background:transparent}
/* The first cell of a list of things names the thing: it reads as text and the whole row is the link. */
.ch-card-body[data-flush] .ch-table td:first-child>a{color:var(--text-primary);text-decoration:none}
.ch-card-body[data-flush] .ch-table td:first-child>a:hover{text-decoration:underline}
.ch-seg a .ch-count{margin-left:var(--space-2)}
.ch-toolbar [data-filters] label{display:inline-flex;flex-direction:row;align-items:center;gap:var(--space-2)}
.ch-card-body[data-flush] .ch-table th:first-child,.ch-card-body[data-flush] .ch-table td:first-child{padding-left:var(--space-5)}
.ch-card-body[data-flush] .ch-table th:last-child,.ch-card-body[data-flush] .ch-table td:last-child{padding-right:var(--space-5)}
.ch-table td>p.ch-meta{margin:2px 0 0}
.ch-row-end{display:flex;flex-direction:column;align-items:flex-end;gap:2px;margin-left:auto;flex:none;max-width:50%;text-align:right}
@media(max-width:1180px){.ch-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}.ch-board{grid-template-columns:minmax(0,1fr)}}
[data-overview-tasks] .ch-row-body{min-width:0}
[data-overview-tasks] .ch-row-body>b{white-space:normal;overflow-wrap:anywhere}
[data-overview-tasks] .ch-row{align-items:start}
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
.ch-dialog-panel { overflow:hidden; }
.ch-dialog-head,.ch-dialog-foot { flex-shrink:0; }
.ch-dialog-body { min-height:0; overflow-y:auto; overscroll-behavior-y:contain; flex:1 1 auto; }
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
.ch-page-toc{position:sticky;top:0;z-index:3;display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-2) var(--space-4);padding:var(--space-3) 0;background:var(--surface-1);border-bottom:1px solid var(--line-control)}
.ch-page-toc-label{font:600 12px/18px var(--font-sans);color:var(--text-secondary)}
.ch-page-toc>div{display:flex;flex-wrap:wrap;gap:var(--space-2) var(--space-4)}
.ch-page-toc a{display:inline-flex;align-items:center;min-height:32px;color:var(--text-secondary);font:400 13px/20px var(--font-sans);text-decoration:underline;text-underline-offset:5px;overflow-wrap:anywhere}
.ch-page-toc a[aria-current="location"]{color:var(--text-primary);font-weight:600;text-decoration-thickness:2px}
.ch-pane:has([data-page-toc]) [id]{scroll-margin-top:160px}
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
/* The line between two groups of places (decision 151). */
.ch-nav-sep { flex: none; width: auto; height: 0; margin: var(--space-2) var(--space-2); border: 0; border-top: 1px solid var(--line-hairline); }
.ch-nav-sub section { margin: 0; min-width: 0; }
.ch-inspector > .ch-section { margin: 0; }
/* The folder tree is nested lists of links (accessibility guide, lists); a folder inside a folder is indented. */
.ch-nav-tree ul { margin: 0; padding: 0; list-style: none; min-width: 0; }
.ch-nav-tree li { min-width: 0; }
.ch-nav-tree ul ul { padding-left: var(--space-3); }
.ch-nav-owner { display: block; min-width: 0; }
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

// 运行状况: the resource cards size by their own width, so a narrow window never squeezes a curve; a stretch of a curve with no
// reading is a band named 未知; a crash opens in place.
const HEALTH_CSS = `
[data-cards] { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr)); gap: var(--space-6); align-items: start; }
.ch-resource { min-width: 0; }
.ch-chart.ch-curve .gapband { fill: var(--surface-hover); }
.ch-chart.ch-curve .mark { stroke: var(--status-fail); stroke-width: 1; shape-rendering: crispEdges; }
.ch-chart.ch-curve .dot.pin { fill: var(--status-fail); }
.ch-section > .ch-stats + .ch-stats { margin-top: var(--space-2); }
[data-area-content] > [data-cards] { margin-top: var(--space-4); }
[data-area-content] > [data-cards] + .ch-section, [data-area-content] > .ch-section + [data-cards] { margin-top: var(--space-5); }
.ch-tool { white-space: nowrap; }
/* The knowledge folder list: the table fits its box (the statement wraps, the other columns keep their text on one line) instead of
   scrolling inside it; on a narrow screen each entry is a block with its column names beside the values. */
/* A pack's requirement table fills the page: its two long columns wrap, the short ones stay on one line. */
.ch-table[data-view="pack-requirements"] { width: 100%; }
.ch-table[data-view="pack-requirements"] td:first-child, .ch-table[data-view="pack-requirements"] td:nth-child(n+3):nth-child(-n+6) { white-space: nowrap; }
.ch-table[data-view="pack-requirements"] td:nth-child(2) { min-width: 18rem; }
.ch-table[data-view="pack-requirements"] td:nth-child(7) { min-width: 12rem; }
.ch-table[data-view="knowledge-entries"] { width: 100%; }
.ch-table[data-view="knowledge-entries"] td { max-width: none; white-space: nowrap; }
.ch-table[data-view="knowledge-entries"] td:has([data-statement]) { white-space: normal; min-width: 14rem; }
/* The statement is the row's main content: neutral text, so it does not compete with the status and the other links in link
   colour. It carries no line at rest (owner, 2026-11-12, issue 215: a line under every row of a long statement reads heavy);
   hover and keyboard focus bring the link colour and the underline, and the focus ring stays. */
.ch-table[data-view="knowledge-entries"] [data-statement] a { color: var(--text-primary); text-decoration: none; text-underline-offset: 3px; }
.ch-table[data-view="knowledge-entries"] [data-statement] a:is(:hover, :focus-visible) { color: var(--text-link); text-decoration: underline; }
@media (max-width: 760px) {
 .ch-table[data-view="knowledge-entries"] thead { display: none; }
 .ch-table[data-view="knowledge-entries"], .ch-table[data-view="knowledge-entries"] tbody, .ch-table[data-view="knowledge-entries"] tr, .ch-table[data-view="knowledge-entries"] td { display: block; }
 .ch-table[data-view="knowledge-entries"] tr { position: relative; padding: 10px 14px 10px 44px; box-shadow: inset 0 1px 0 var(--line-hairline); }
 .ch-table[data-view="knowledge-entries"] tr:first-child { box-shadow: none; }
 .ch-table[data-view="knowledge-entries"] td { padding: 2px 0; box-shadow: none; white-space: normal; min-width: 0; }
 .ch-table[data-view="knowledge-entries"] [data-label]::before { content: attr(data-label) "："; color: var(--text-tertiary); }
 .ch-table[data-view="knowledge-entries"] td:has(input[type="checkbox"]) { position: absolute; left: 14px; top: 10px; padding: 0; }
}
/* Number columns that hold text with a unit: table() only right-aligns real numbers. */
:is(.ch-table[data-view="background"] :is(th, td):nth-child(n+2):not(:nth-child(4)):not(:nth-child(6)),
    .ch-table[data-view="clients"] :is(th, td):nth-child(n+5),
    .ch-table[data-view="releases"] :is(th, td):nth-child(3), .ch-table[data-view="releases"] :is(th, td):nth-child(4),
    .ch-table[data-view="inflight"] :is(th, td):nth-child(2)) { text-align: right; font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ch-finding { font-size: 14px; line-height: 22px; color: var(--text-primary); max-width: 62ch; }
.ch-event > summary { list-style: none; cursor: pointer; }
.ch-event > summary::-webkit-details-marker { display: none; }
.ch-event > summary .ch-row-title::after, .ch-event-link .ch-row-title::after { content: " ▸"; color: var(--text-tertiary); }
.ch-event[open] > summary .ch-row-title::after { content: " ▾"; }
.ch-event-link { color: inherit; text-decoration: none; }
.ch-event-link:hover { text-decoration: none; }
.ch-list > .ch-row > .ch-dot, .ch-event > summary > .ch-dot { margin-top: 8px; }
.ch-event-body { display: flex; flex-direction: column; gap: var(--space-4); padding: var(--space-2) var(--space-3) var(--space-5) 30px; }
.ch-event-top { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: var(--space-6); align-items: start; }
.ch-events .ch-row-body { flex-direction: row; flex-wrap: wrap; align-items: baseline; gap: 2px var(--space-3); }
.ch-events .ch-row-body > .ch-time { margin-left: auto; font-size: 12px; color: var(--text-tertiary); }
@media (max-width: 1180px) { .ch-event-top { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 760px) {
 .ch-table:is([data-view="background"], [data-view="clients"], [data-view="releases"], [data-view="inflight"]) :is(td, th) { padding-left: 8px; padding-right: 8px; }
 .ch-table:is([data-view="background"], [data-view="clients"], [data-view="releases"], [data-view="inflight"]) th { white-space: normal; vertical-align: bottom; }
 .ch-table[data-view="background"] .ch-tool code { display: none; }
 .ch-event-body { padding-left: var(--space-3); padding-right: 0; }
}
`;

// Decision 151, step 9: text that is read (notes, table heads, the labels of figures and fields, trails, hints) uses the
// shared scale's small size, 13px, in the console; its caption size, 12px, stays for labels inside controls (badges, chips,
// tabs, counts, times). The shared design system is unchanged: both sizes are its own. These rules come last, after the
// rules of the same weight above that they replace.
const TYPE_CSS = `
.ch-meta,.ch-row-meta,.ch-crumbs,.ch-stat-label,.ch-stat-note,.ch-stat-unit,.ch-figure-note,.ch-field-label,.ch-field-hint,.ch-field-error,.ch-tip-bubble,.ch-legend,.ch-tableview summary,[data-filters] label,[data-technical] > summary{font-size:13px;line-height:20px}
.ch-table th,.ch-section-label{font-size:13px;line-height:18px}
`;

// Findings of the audit against the modern-web-guidance guides (2026-11-12) that need no design decision.
const AUDIT_CSS = `
/* accessibility, skip links: out of sight until the keyboard reaches it, then over the page's corner. */
.ch-skip { position: absolute; left: var(--space-3); top: var(--space-3); z-index: 1000; padding: 8px 12px; border-radius: var(--radius-sm); background: var(--surface-1); color: var(--text-link); font: 500 13px/20px var(--font-sans); outline: 2px solid var(--focus-ring); outline-offset: 2px; transform: translateY(-300%); }
.ch-skip:focus { transform: none; }
#console-main:focus { outline: none; }
/* tabs, "tabs that do not fit": a row of page tabs stays one row and scrolls in its own box instead of widening the page
   (a task's six tabs are 405px wide on a 390px screen). */
main nav.ch-seg { max-width: 100%; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: thin; }
main nav.ch-seg a { flex: none; }
/* color, forced colors: a ring drawn with box-shadow or a border colour is removed there, so the field gets an outline. */
@media (forced-colors: active) {
  .ch-input:focus-within, .ch-composer:focus-within { outline: 2px solid Highlight; outline-offset: 1px; }
  .ch-seg a[aria-current], .ch-seg button[aria-checked="true"], .ch-nav-item[aria-current] { outline: 1px solid Highlight; outline-offset: -1px; }
}
/* A value with no place to break (a digest, a run id, a reference) wraps inside its cell instead of widening the page:
   a 64-character digest in a task's 技术信息 made the page 198px wider than a 390px screen. */
.ch-kv dd { min-width: 0; overflow-wrap: anywhere; }
/* html, focus boundaries: a preview that scrolls can be reached and scrolled with the keyboard. */
.ch-original-preview:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
/* breadcrumbs: the places above a page and the page itself are an ordered list drawn on one line. The separator is the
   style sheet's, with empty alternative text where the browser takes one, so a screen reader reads the names only. */
.ch-crumbs ol { display: flex; flex-wrap: wrap; align-items: center; gap: 0 6px; margin: 0; padding: 0; list-style: none; }
.ch-crumbs li { min-width: 0; overflow-wrap: anywhere; }
.ch-crumbs li + li::before { content: "›"; content: "›" / ""; margin-right: 6px; }
/* The page itself is told apart by more than colour, and keeps a mark where colours are forced. */
.ch-crumbs a[aria-current="page"] { color: var(--text-secondary); font-weight: 500; text-decoration: none; }
@media (forced-colors: active) { .ch-crumbs a[aria-current="page"] { text-decoration: underline; } }
/* A scroll region holds what is placed out of the flow inside it (the text kept for screen readers in a link of a wide
   table): without this that text stood where the table's far column is and made the page itself wider than the screen. */
.ch-table-wrap { position: relative; }
/* accessibility, headings: where the list is hidden and the detail stands alone (up to 1180px) the page's title is still
   its level-one heading, for a screen reader; on a wider screen the list's own heading is shown and this one is absent. */
.ch-detail-heading { display: none; }
@media (max-width: 1180px) { .ch-app.is-detail .ch-detail-heading { display: block; } }
/* html, code blocks: code inside a block keeps the block's size and wrapping, not the inline code's. */
:where(.hub) pre code { font-size: inherit; overflow-wrap: inherit; }
/* accessibility, target size (WCAG 2.2, 2.5.8): on a touch screen whatever a finger presses is at least 24px high. With a
   mouse nothing here applies and the rows stay as dense as they were. */
@media (pointer: coarse) {
  .hub :is(.ch-table, .ch-kv, .ch-crumbs, .ch-meta, .ch-feed, .ch-list, .ch-actions, .ch-card-foot, .ch-card-tail, p, li, dd) > a:not(.ch-btn, .ch-row, .ch-nav-item), .hub .ch-table td a:not(.ch-btn) { padding-block: 4px; }
  /* A short name (one or two characters) is as wide as it is high. */
  .hub .ch-table td a:not(.ch-btn), .hub .ch-crumbs a { display: inline-block; min-width: 24px; }
  .hub .ch-source-head > a { min-height: 24px; align-content: center; }
  .hub summary { min-height: 24px; align-content: center; }
  .hub :is(input[type="checkbox"], input[type="radio"]) { min-width: 24px; min-height: 24px; }
  .hub :is(input:not([type="checkbox"], [type="radio"], [type="hidden"]), select, textarea) { min-height: 32px; }
  .hub .ch-tip { min-height: 24px; }
}
/* forms, zoom on focus: a phone's browser zooms the page in when a field whose text is under 16px is tapped. */
@media (pointer: coarse), (max-width: 760px) {
  .hub :is(input:not([type="checkbox"], [type="radio"], [type="hidden"]), select, textarea) { font-size: 16px; }
}
`;

export const CSS = `${DESIGN_CSS}\n${BASE_CSS}\n${SHELL_CSS}\n${HEALTH_CSS}\n${TYPE_CSS}\n${AUDIT_CSS}\n[data-theme-switch][hidden]{display:none}\n`;
