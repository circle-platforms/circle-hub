// The console's stylesheet: the hub.css of the design canvas (version 25, in the palette of Circle's workbench) with the
// dark theme and reduced motion following the reader's system settings, then the console's own blocks. The Content-Security-
// Policy allows it by its hash; the markup uses classes only (a style attribute would be refused) and draws its charts with
// SVG attributes.
export const CSS = `@property --sweep{syntax:'<percentage>';inherits:false;initial-value:100%}

/* ---------------------------------------------------------------- tokens: Circle's light theme */
.hub{
  --bg:#ffffff;--fg:#3c4148;--sidebar:#ffffff;--surface:#f6f6f7;--hover:#eeefef;--active:#e8e8e9;--border:#e2e3e4;
  --secondary:#676b70;--muted:#888b8f;--subtle:#fafafa;
  --read-bg:#e7ebff;--write-bg:#e2f1e6;--think-bg:#f3e7f3;--agent-bg:#d9f8f8;--removed-bg:#ffdee4;
  --accent:#0894ff;--violet:#c959dd;--negative:#ff2e54;--attention:#d97a03;--positive:#2d7844;--call:#c026d3;
  --accent-strong:#0a6fd1;--on-accent:#ffffff;
  --logo-1:#0894ff;--logo-2:#c959dd;--logo-3:#ff2e54;--logo-4:#d97a03;
  /* the model's states: fills for marks, text on their tints */
  --s-pass:var(--positive);--s-fail:var(--negative);--s-judgment:var(--accent);--s-unchecked:#b8bbbf;--s-incomplete:var(--attention);--s-unknown:var(--violet);
  --t-pass:#2d7844;--t-fail:#c8102e;--t-judgment:#0a66b8;--t-incomplete:#955300;--t-unknown:#9b2fb0;--t-unchecked:#5b5f64;
  --b-pass:var(--write-bg);--b-fail:var(--removed-bg);--b-judgment:var(--read-bg);--b-incomplete:#fdf0dc;--b-unknown:var(--think-bg);--b-unchecked:var(--hover);
  --shadow:0 1px 3px color-mix(in srgb,var(--fg) 6%,transparent);
  --shadow-pop:0 12px 32px color-mix(in srgb,var(--fg) 14%,transparent);
  --ui:14px;--ui-small:12px;--ui-tiny:11px;--ui-large:19px;--radius:7px;
  --mono:ui-monospace,SFMono-Regular,Consolas,monospace;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI Variable','Segoe UI Variable Text','Segoe UI','Circle CJK','PingFang SC','Microsoft YaHei',system-ui,sans-serif;
  font-size:var(--ui);line-height:1.5;color:var(--fg);background:var(--bg);font-synthesis:none;-webkit-font-smoothing:antialiased;
  min-height:100vh;
}
/* Circle's dark theme, following the system setting: the sidebar a shade off the ground */
@media (prefers-color-scheme:dark){.hub{
  --bg:#10151a;--fg:#d6dee6;--sidebar:#171c21;--surface:#191e23;--hover:#21262b;--active:#282d32;--border:#2e3339;
  --secondary:#aab2b9;--muted:#899096;--subtle:#151a1f;
  --read-bg:#1b243c;--write-bg:#172a24;--think-bg:#282030;--agent-bg:#0e3135;--removed-bg:#361923;
  --attention:#ff9004;--positive:#46a562;--accent-strong:#0894ff;--on-accent:#10151a;
  --logo-4:#ff9004;
  --s-unchecked:#4f565d;
  --t-pass:#5cc27a;--t-fail:#ff6b85;--t-judgment:#5cb6ff;--t-incomplete:#ffa53d;--t-unknown:#dc8cec;--t-unchecked:#aab2b9;
  --b-incomplete:#33240f;
  --shadow:0 1px 3px rgb(0 0 0 / 35%);--shadow-pop:0 14px 36px rgb(0 0 0 / 50%);
}}

/* ---------------------------------------------------------------- base */
.hub *,.hub *::before,.hub *::after{box-sizing:border-box}
.hub a{color:inherit;text-decoration:none}
.hub button,.hub input,.hub select,.hub textarea{font:inherit;color:inherit}
.hub h1,.hub h2,.hub h3,.hub h4,.hub p{margin:0}
.hub :focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.num{font-variant-numeric:tabular-nums}
.mono,.hub code{font-family:var(--mono);font-size:calc(var(--ui) - 1.5px)}
.sub{color:var(--secondary);font-size:var(--ui-small)}
.link{color:var(--t-judgment);font-size:var(--ui-small);font-weight:550;white-space:nowrap}
.link:hover{text-decoration:underline}
.note{color:var(--secondary);font-size:var(--ui-small);margin-top:10px}
.ico{width:16px;height:16px;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}

/* ---------------------------------------------------------------- shell: sidebar + content, stacked on a phone */
.shell{display:flex;flex-wrap:wrap;align-items:stretch;min-height:100vh}
.side-wrap{flex:1 1 232px;max-width:100%;background:var(--sidebar);border-right:1px solid var(--border)}
.content{flex:999 1 560px;min-width:0;padding:0 28px 56px}
@media (max-width:820px){.side-wrap{border-right:0;border-bottom:1px solid var(--border)}.content{padding:0 16px 40px}}

/* ---------------------------------------------------------------- sidebar */
.side{display:flex;flex-direction:column;gap:1px;padding:0 10px 14px}
.brand{display:flex;align-items:center;gap:9px;height:60px;padding:0 8px}
.brand strong{font-size:calc(var(--ui) + 5px);letter-spacing:-.6px;font-weight:650}
.env{margin-left:auto;font-size:var(--ui-tiny);letter-spacing:1px;color:var(--secondary);border:1px solid var(--border);border-radius:999px;padding:0 8px;line-height:18px}
.logo{display:inline-block;width:22px;height:22px;flex-shrink:0}
.logo.lg{width:64px;height:64px}
.logo .s1{fill:var(--logo-1)}.logo .s2{fill:var(--logo-2)}.logo .s3{fill:var(--logo-3)}.logo .s4{fill:var(--logo-4)}
.logo.spin{animation:spin 10s linear infinite}
.search{display:flex;align-items:center;gap:8px;height:34px;margin:2px 0 6px;padding:0 10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);color:var(--secondary)}
.search input{flex:1;min-width:0;border:0;background:none;outline:none;font-size:var(--ui-small);color:var(--fg)}
.search input::placeholder{color:var(--secondary)}
.search:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 20%,transparent)}
.top h1[title],.card-h h3[title],.section-h h2[title],.hub section h2[title]{cursor:help}
.search kbd{font-family:var(--mono);font-size:var(--ui-tiny);padding:0 5px;border:1px solid var(--border);border-radius:4px;line-height:16px}
.nav-label{padding:14px 10px 4px;font-size:var(--ui-tiny);color:var(--secondary);letter-spacing:.5px}
.nav-item{display:flex;align-items:center;gap:10px;min-height:36px;padding:0 10px;border-radius:var(--radius);color:var(--secondary);transition:background .1s,color .1s}
.nav-item:hover{background:var(--hover);color:var(--fg)}
.nav-item.on{background:var(--active);color:var(--fg);font-weight:550}
.nav-item svg{width:17px;height:17px;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.nav-item .planned,.nav-item .count{margin-left:auto}
.nav-item.is-planned > span:nth-of-type(1){opacity:.85}
.count{font-size:var(--ui-tiny);font-weight:650;padding:0 7px;line-height:18px;border-radius:999px;background:var(--b-unknown);color:var(--t-unknown)}
.me{display:flex;align-items:center;gap:10px;margin-top:16px;padding:12px 8px 0;border-top:1px solid var(--border)}
.me-t{flex:1;min-width:0;line-height:1.3}
.me-t div:first-child{font-weight:550}
.me-r{font-size:var(--ui-tiny);color:var(--secondary)}
.avatar{width:28px;height:28px;border-radius:50%;display:grid;place-items:center;background:var(--read-bg);color:var(--t-judgment);font-weight:650;font-size:var(--ui-small);flex:none}

/* ---------------------------------------------------------------- page top, buttons, controls */
.top{display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px;padding:22px 0 6px}
.top h1{font-size:22px;font-weight:650;letter-spacing:-.3px}
.top .sub{margin-top:2px}
.actions{margin-left:auto;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:34px;padding:0 12px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:var(--ui-small);font-weight:500;white-space:nowrap;cursor:pointer;transition:background .1s,border-color .1s}
.btn:hover{background:var(--hover)}
.btn.primary{background:var(--accent-strong);border-color:var(--accent-strong);color:var(--on-accent)}
.btn.primary:hover{filter:brightness(1.08)}
.btn.danger{color:var(--t-fail)}
.btn.ghost{background:none;border-color:transparent}
.btn[disabled],.btn.off{opacity:.55;cursor:not-allowed}
.icon-btn{display:inline-grid;place-items:center;width:32px;height:32px;border-radius:6px;border:0;background:none;color:var(--secondary);cursor:pointer;flex:none}
.icon-btn:hover{background:var(--hover);color:var(--fg)}
.seg{display:inline-flex;align-items:center;gap:2px;padding:3px;background:var(--hover);border-radius:7px}
.seg button,.seg a{display:inline-flex;align-items:center;gap:6px;border:0;background:none;padding:5px 11px;border-radius:5px;color:var(--secondary);font-size:var(--ui-small);cursor:pointer;white-space:nowrap}
.seg button.on,.seg a.on{background:var(--bg);color:var(--fg);box-shadow:var(--shadow);font-weight:550}
.tabs{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--border);margin-top:14px}
.tabs a,.tabs button{display:inline-flex;align-items:center;gap:7px;border:0;background:none;padding:10px 12px;margin-bottom:-1px;border-bottom:2px solid transparent;color:var(--secondary);cursor:pointer;font-size:var(--ui)}
.tabs .on{color:var(--fg);border-bottom-color:var(--accent);font-weight:550}
.pills{display:flex;flex-wrap:wrap;gap:6px}
.pill{display:inline-flex;align-items:center;gap:6px;min-height:30px;padding:0 11px;border:1px solid var(--border);border-radius:999px;background:var(--bg);font-size:var(--ui-small);color:var(--secondary);cursor:pointer}
.pill b{color:var(--fg);font-weight:600}
.pill.on{border-color:var(--accent);color:var(--fg);background:color-mix(in srgb,var(--read-bg) 70%,var(--bg))}
.select{height:34px;padding:0 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);font-size:var(--ui-small)}
.input{height:40px;width:100%;border:1px solid var(--border);border-radius:var(--radius);padding:0 12px;background:var(--bg);outline:none;transition:border-color .12s,box-shadow .12s}
.input:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 20%,transparent)}

/* ---------------------------------------------------------------- cards and grids */
.section{margin-top:18px}
.section-h{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;margin:30px 0 12px}
.section-h h2{font-size:16px;font-weight:650}
.section-h p{color:var(--secondary);font-size:var(--ui-small)}
.grid{display:grid;gap:14px}
.g4{grid-template-columns:repeat(4,minmax(0,1fr))}
.g3{grid-template-columns:repeat(3,minmax(0,1fr))}
.g2{grid-template-columns:repeat(2,minmax(0,1fr))}
.g-2-1{grid-template-columns:minmax(0,2fr) minmax(0,1fr)}
.g-1-2{grid-template-columns:minmax(0,1fr) minmax(0,2fr)}
.span2{grid-column:span 2}
@media (max-width:1180px){.g4{grid-template-columns:repeat(2,minmax(0,1fr))}.g3{grid-template-columns:repeat(2,minmax(0,1fr))}.g-2-1,.g-1-2{grid-template-columns:minmax(0,1fr)}}
@media (max-width:680px){.g4,.g3,.g2{grid-template-columns:minmax(0,1fr)}.span2{grid-column:auto}}
.card{border:1px solid var(--border);border-radius:12px;background:var(--bg);padding:14px 16px 16px;min-width:0}
.card-h{display:flex;align-items:center;gap:8px;min-height:26px;margin-bottom:12px}
.card-h h3{font-size:var(--ui);font-weight:600}
.card-h .meta{margin-left:auto;color:var(--secondary);font-size:var(--ui-small);white-space:nowrap}
.card-h > .chip,.card-h > .planned,.card-h > .seg{margin-left:auto}
.card-f{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin-top:14px}
.card-f .note{margin-top:0;flex:1;min-width:200px}

/* onboarding */
.onboard{display:flex;flex-wrap:wrap;align-items:center;gap:14px 22px;margin-top:16px;padding:14px 16px}
.onboard-t{flex:1 1 220px;min-width:0}
.onboard-t h3{font-size:15px;font-weight:600}
.ring{--p:0;width:54px;height:54px;border-radius:50%;background:conic-gradient(var(--accent) calc(var(--p) * 1%),var(--surface) 0);display:grid;place-items:center;flex:none;position:relative}
.ring::after{content:'';position:absolute;inset:6px;border-radius:50%;background:var(--bg)}
.ring span{position:relative;z-index:1;font-weight:650;font-size:var(--ui-small)}
.todo{display:flex;flex-wrap:wrap;gap:8px}
.todo a{display:inline-flex;align-items:center;gap:8px;min-height:34px;padding:0 13px 0 7px;border:1px solid var(--border);border-radius:999px;font-size:var(--ui-small);transition:background .1s}
.todo a:hover{background:var(--hover)}
.todo a.done{color:var(--secondary);background:var(--subtle)}
.todo .n{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:11px;background:var(--hover);font-weight:650}
.todo .n svg{width:12px;height:12px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
.todo a.done .n{background:var(--b-pass);color:var(--t-pass)}

/* ---------------------------------------------------------------- figures */
.kpi .label{display:flex;align-items:center;gap:7px;color:var(--secondary);font-size:var(--ui-small)}
.kpi .value{font-size:30px;font-weight:650;letter-spacing:-.6px;margin-top:6px;line-height:1.15}
.kpi .value small{font-size:15px;font-weight:500;color:var(--secondary);margin-left:3px;letter-spacing:0}
.kpi-f{display:flex;flex-wrap:wrap;gap:4px 8px;align-items:baseline;margin-top:4px}
.delta{font-size:var(--ui-small);font-weight:600}
.delta.up{color:var(--t-pass)}.delta.down{color:var(--t-fail)}.delta.warn{color:var(--t-incomplete)}
.spark{display:block;width:100%;height:auto;margin-top:10px;overflow:visible}
.spark .area{fill:color-mix(in srgb,var(--c) 15%,transparent);animation:fade .9s ease both;animation-delay:calc(var(--i,0) * 80ms + 300ms)}
.spark .line{fill:none;stroke:var(--c);stroke-width:2;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:0;animation:trace 1.3s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(var(--i,0) * 80ms + 200ms)}

.legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:var(--ui-small);color:var(--secondary);margin-bottom:6px}
.legend b{color:var(--fg);font-weight:600;margin-left:2px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.f-pass{background:var(--s-pass)}.f-fail{background:var(--s-fail)}.f-judgment{background:var(--s-judgment)}
.f-unchecked{background:var(--s-unchecked)}.f-incomplete{background:var(--s-incomplete)}.f-unknown{background:var(--s-unknown)}
.f-added{background:var(--s-pass)}.f-removed{background:var(--s-fail)}.f-modified{background:var(--s-judgment)}
.t1{background:var(--accent)}.t2{background:var(--violet)}.t3{background:var(--attention)}.t4{background:var(--positive)}.t5{background:color-mix(in srgb,var(--accent) 45%,var(--bg))}.t6{background:var(--negative)}

.bars{display:flex;align-items:flex-end;gap:var(--gap,6px);height:230px;padding-top:6px;border-bottom:1px solid var(--border);background:linear-gradient(var(--border) 1px,transparent 1px) 0 6px / 100% 25%}
.bar{flex:1 1 0;min-width:0;display:flex;flex-direction:column-reverse;border-radius:4px 4px 0 0;overflow:hidden;transform-origin:bottom;animation:grow .7s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(var(--i,0) * 22ms + 120ms);transition:filter .12s;cursor:default}
.bar span{display:block;flex:none}
.bar:hover{filter:brightness(1.12) saturate(1.1)}
.axis{display:flex;justify-content:space-between;color:var(--secondary);font-size:var(--ui-tiny);margin-top:7px}

.donut-box{display:flex;flex-wrap:wrap;align-items:center;gap:18px 22px}
.donut-wrap{position:relative;width:164px;height:164px;flex:none}
.donut{position:absolute;inset:0;border-radius:50%;-webkit-mask:conic-gradient(#000 var(--sweep),transparent 0);mask:conic-gradient(#000 var(--sweep),transparent 0);animation:sweep 1.2s cubic-bezier(.2,.7,.2,1) both .25s}
.donut::after{content:'';position:absolute;inset:22px;border-radius:50%;background:var(--bg)}
.donut-c{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1.2}
.donut-c b{font-size:24px;font-weight:650;letter-spacing:-.4px}
.donut-c span{font-size:var(--ui-small);color:var(--secondary)}
.dlist{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;flex:1 1 150px;min-width:0}
.dlist li{display:grid;grid-template-columns:10px minmax(0,1fr) auto 46px;align-items:center;gap:8px;font-size:var(--ui-small)}
.dlist i{width:9px;height:9px;border-radius:3px}
.dlist b{font-weight:600}
.dlist em{font-style:normal;color:var(--secondary);text-align:right}

.funnel{display:flex;flex-direction:column;gap:10px}
.frow{display:grid;grid-template-columns:86px minmax(0,1fr) 52px;align-items:center;gap:10px;font-size:var(--ui-small);min-height:22px}
.fname{color:var(--secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.fval{text-align:right;font-weight:600}
.track{height:10px;border-radius:5px;background:var(--surface);overflow:hidden}
.fill{height:100%;border-radius:5px;background:var(--accent);transform-origin:left;animation:growx .9s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(var(--i,0) * 70ms + 200ms)}
.fill.unknown{background:var(--s-unknown)}.fill.pass{background:var(--s-pass)}.fill.warn{background:var(--s-incomplete)}
.meter{display:inline-block;width:44px;height:8px;border-radius:4px;background:var(--surface);overflow:hidden;vertical-align:middle}
.meter i{display:block;height:100%;border-radius:4px;background:var(--accent);transform-origin:left;animation:growx .9s cubic-bezier(.2,.7,.2,1) both .3s}
.meter.high i{background:var(--attention)}.meter.full i{background:var(--negative)}.meter.ok i{background:var(--positive)}
.stackbar{display:flex;height:10px;border-radius:5px;overflow:hidden;gap:2px;background:var(--surface)}
.stackbar i{display:block;height:100%;transform-origin:left;animation:growx .9s cubic-bezier(.2,.7,.2,1) both .25s}

.chart{display:block;width:100%;height:auto;overflow:visible}
.chart .gl{stroke:var(--border);stroke-width:1}
.chart text{font-size:11px;fill:var(--secondary)}
.chart .lbl{font-size:12px;fill:var(--fg);font-weight:550}
.chart .ln{fill:none;stroke:var(--k);stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:0;animation:trace 1.6s cubic-bezier(.2,.7,.2,1) both .2s}
.chart .ar{fill:var(--k);opacity:.1}
.chart .pt{fill:var(--k);stroke:var(--bg);stroke-width:2;animation:pop .4s cubic-bezier(.2,.7,.2,1) both 1.5s;transform-box:fill-box;transform-origin:center}
.k1{--k:var(--accent)}.k2{--k:var(--violet)}.k3{--k:var(--attention)}.k4{--k:var(--positive)}
.kstats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:12px}
.kstats b{display:block;font-size:20px;font-weight:650;letter-spacing:-.3px;line-height:1.3}
@media (max-width:680px){.kstats{grid-template-columns:repeat(2,minmax(0,1fr))}}

/* ---------------------------------------------------------------- status: dots, chips, planned */
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:currentColor;flex:none;color:var(--s-unchecked)}
.dot.ok{color:var(--s-pass)}.dot.warn{color:var(--s-incomplete)}.dot.down{color:var(--s-fail)}.dot.idle{color:var(--s-unchecked)}.dot.info{color:var(--accent)}.dot.unknown{color:var(--s-unknown)}
.dot.live{animation:pulse 2.4s cubic-bezier(.2,.7,.2,1) infinite}
.chip{display:inline-flex;align-items:center;gap:5px;font-size:var(--ui-tiny);font-weight:600;padding:1px 7px;line-height:18px;border-radius:4px;background:var(--hover);color:var(--secondary);white-space:nowrap;vertical-align:1px}
.chip::before{content:'';width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.chip.plain::before{display:none}
.chip.code{font-family:var(--mono);font-weight:500}
.c-pass{background:var(--b-pass);color:var(--t-pass)}.c-fail{background:var(--b-fail);color:var(--t-fail)}
.c-judgment{background:var(--b-judgment);color:var(--t-judgment)}.c-unchecked{background:var(--b-unchecked);color:var(--t-unchecked)}
.c-incomplete{background:var(--b-incomplete);color:var(--t-incomplete)}.c-unknown{background:var(--b-unknown);color:var(--t-unknown)}
.planned{display:inline-flex;align-items:center;gap:4px;font-size:var(--ui-tiny);font-weight:550;line-height:18px;padding:0 8px;border:1px dashed var(--muted);border-radius:999px;color:var(--secondary);white-space:nowrap;background:var(--bg)}
.card.plan{border-style:dashed;border-color:color-mix(in srgb,var(--muted) 70%,var(--border));background:var(--subtle)}
.card.plan .card-h .ico{color:var(--secondary)}
.plan-t{color:var(--secondary);font-size:var(--ui-small);line-height:1.6}
.ghost{margin-top:14px;opacity:.75}
.skel{display:block;height:9px;border-radius:5px;background:linear-gradient(90deg,var(--surface) 30%,var(--hover) 50%,var(--surface) 70%);background-size:300% 100%;animation:shimmer 2.8s ease-in-out infinite}
.g-rows{display:flex;flex-direction:column;gap:9px}
.g-rows > div{display:flex;align-items:center;gap:9px}
.g-rows .dot{opacity:.7}
.g-chat{display:flex;flex-direction:column;gap:7px}
.bubble{align-self:flex-start;padding:8px 11px;border-radius:11px 11px 11px 3px;background:var(--surface)}
.bubble.me{align-self:flex-end;border-radius:11px 11px 3px 11px;background:var(--read-bg)}
.bubble .skel{background-color:transparent}
.g-cal{display:grid;grid-template-columns:repeat(14,minmax(0,1fr));gap:3px}
.g-cal i{display:block;aspect-ratio:1;border-radius:3px;background:var(--surface)}
.g-cal .h1,.heat .h1{background:color-mix(in srgb,var(--accent) 22%,var(--surface))}
.g-cal .h2,.heat .h2{background:color-mix(in srgb,var(--accent) 45%,var(--surface))}
.g-cal .h3,.heat .h3{background:color-mix(in srgb,var(--accent) 72%,var(--surface))}
.heat .h4{background:var(--accent)}
.g-flow{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 30px}
.g-flow span{display:block;height:22px;border-radius:6px;background:linear-gradient(90deg,var(--surface) 30%,var(--hover) 50%,var(--surface) 70%);background-size:300% 100%;animation:shimmer 2.8s ease-in-out infinite}
.g-flow span:nth-child(2),.g-flow span:nth-child(5){height:40px;grid-row:span 2}
.callout{display:flex;gap:10px;align-items:flex-start;padding:11px 13px;border-radius:10px;font-size:var(--ui-small);line-height:1.6}
.callout .ico{margin-top:2px}
.callout.unknown{background:var(--b-unknown);color:var(--t-unknown)}
.callout.info{background:var(--b-judgment);color:var(--t-judgment)}
.callout.warn{background:var(--b-incomplete);color:var(--t-incomplete)}
.callout b{font-weight:650}

/* ---------------------------------------------------------------- lists, feeds, tables */
.syslist{display:flex;flex-direction:column;gap:2px}
.sysrow{display:grid;grid-template-columns:10px minmax(0,1fr) 84px;align-items:center;gap:10px;padding:7px 6px;border-radius:8px;transition:background .1s}
.sysrow:hover{background:var(--hover)}
.sys-t{min-width:0;line-height:1.35}
.sys-t b{display:block;font-weight:550}
.mini{display:flex;align-items:flex-end;gap:2px;height:24px}
.mini i{flex:1;min-width:0;background:color-mix(in srgb,var(--accent) 55%,transparent);border-radius:2px 2px 0 0;transform-origin:bottom;animation:grow .6s cubic-bezier(.2,.7,.2,1) both .35s}
.feed{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.feed li{display:grid;grid-template-columns:42px 14px minmax(0,1fr);gap:8px;padding:6px 0;font-size:var(--ui-small);line-height:1.55;animation:rise .45s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(var(--i,0) * 70ms + 250ms)}
.feed time{color:var(--secondary);font-family:var(--mono);font-size:var(--ui-tiny);padding-top:1px}
.rail{position:relative}
.rail::before{content:'';position:absolute;left:4px;top:15px;bottom:-12px;width:1px;background:var(--border)}
.feed li:last-child .rail::before{display:none}
.rail .dot{position:absolute;left:0;top:6px}
.feed-t b{font-weight:600}
.tbl{font-size:var(--ui-small);min-width:0}
.tr{display:grid;grid-template-columns:var(--cols);align-items:center;gap:12px;padding:10px 12px;border-bottom:1px solid var(--border);transition:background .1s}
.tr.th{color:var(--secondary);font-weight:550;padding-top:2px;padding-bottom:8px}
.tr:last-child{border-bottom:0}
.tr.row:hover{background:var(--subtle)}
.tr.sel{background:color-mix(in srgb,var(--read-bg) 55%,var(--bg))}
.tr .end{text-align:right;justify-self:end}
.tr b{font-weight:600}
.scroll-x{overflow-x:auto}
.scroll-x > .tbl{min-width:760px}
.namecell{display:flex;align-items:center;gap:10px;min-width:0}
.namecell b{display:block}
.sq{display:inline-block;width:12px;height:12px;border-radius:3px;background:var(--s-unchecked)}
.sq.pass{background:var(--s-pass)}.sq.fail{background:var(--s-fail)}.sq.judgment{background:var(--s-judgment)}.sq.incomplete{background:var(--s-incomplete)}.sq.unknown{background:var(--s-unknown)}
.kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;font-size:var(--ui-small)}
.kv dt{color:var(--secondary)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}

/* ---------------------------------------------------------------- review */
.split{display:grid;grid-template-columns:340px minmax(0,1fr);gap:14px;align-items:start;margin-top:16px}
@media (max-width:1080px){.split{grid-template-columns:minmax(0,1fr)}}
.rlist{display:flex;flex-direction:column;gap:6px;padding:8px}
.ritem{display:flex;flex-direction:column;gap:5px;width:100%;text-align:left;padding:10px 12px;border:1px solid transparent;border-radius:10px;background:none;cursor:pointer;transition:background .1s,border-color .1s}
.ritem:hover{background:var(--hover)}
.ritem.on{background:color-mix(in srgb,var(--read-bg) 60%,var(--bg));border-color:color-mix(in srgb,var(--accent) 35%,var(--border))}
.ritem .r-1{display:flex;align-items:center;gap:8px}
.ritem .r-1 b{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ritem .r-2{display:flex;align-items:center;gap:8px;color:var(--secondary);font-size:var(--ui-tiny)}
.ritem .r-2 .lay{margin-left:auto;display:inline-flex;gap:3px}
.dhead{display:flex;flex-wrap:wrap;align-items:flex-start;gap:10px 16px}
.dhead h2{font-size:18px;font-weight:650;letter-spacing:-.2px}
.dhead .actions{margin-left:auto}
.matrix{display:grid;grid-template-columns:minmax(0,1fr) 92px 92px;gap:6px 10px;align-items:center;font-size:var(--ui-small)}
.matrix .mh{color:var(--secondary);font-weight:550}
.matrix .req{min-width:0}
.matrix .req b{font-weight:550}
.matrix .chip{justify-self:start;animation:pop .35s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(var(--i,0) * 60ms + 150ms)}
.claims{display:flex;flex-direction:column;gap:10px}
.claim{border:1px solid var(--border);border-radius:10px;padding:12px 14px;animation:rise .45s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(var(--i,0) * 70ms + 200ms)}
.claim-h{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px}
.claim-h p{flex:1 1 260px;font-weight:550}
.ref{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;margin-top:9px;font-size:var(--ui-small);color:var(--secondary)}
.ref code{color:var(--fg);background:var(--surface);padding:1px 6px;border-radius:4px;overflow-wrap:anywhere}
.quote{margin-top:9px;font-size:var(--ui-small);line-height:1.75;padding:9px 12px;border-radius:8px;background:var(--surface);border-left:0}
.quote .q-h{display:block;color:var(--secondary);font-size:var(--ui-tiny);margin-bottom:2px}
.quote mark{background:var(--write-bg);color:inherit;border-radius:3px;padding:1px 2px}
.quote del{background:var(--removed-bg);color:var(--t-fail);text-decoration:line-through;border-radius:3px;padding:1px 2px}
.quote ins{background:var(--write-bg);color:var(--t-pass);text-decoration:none;border-radius:3px;padding:1px 2px}
.vsteps{list-style:none;margin:0;padding:0}
.vsteps li{display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:10px;padding:5px 0;font-size:var(--ui-small);position:relative;animation:rise .4s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(var(--i,0) * 60ms + 150ms)}
.vsteps li::before{content:'';position:absolute;left:4px;top:18px;bottom:-6px;width:1px;background:var(--border)}
.vsteps li:last-child::before{display:none}
.vsteps .dot{margin-top:5px}
.vsteps time{font-family:var(--mono);font-size:var(--ui-tiny);color:var(--secondary)}
.log{margin:10px 0 0;padding:10px 12px;border-radius:8px;background:var(--surface);font-family:var(--mono);font-size:var(--ui-tiny);line-height:1.7;white-space:pre-wrap;color:var(--secondary)}
.log b{color:var(--t-pass);font-weight:600}

/* ---------------------------------------------------------------- knowledge */
.tree{display:flex;flex-direction:column;gap:1px;font-size:var(--ui-small)}
.node{display:flex;align-items:center;gap:8px;min-height:32px;width:100%;padding:0 10px;border:0;border-radius:7px;background:none;text-align:left;cursor:pointer;transition:background .1s}
.node:hover{background:var(--hover)}
.node.on{background:var(--active)}
.node .twist{width:14px;height:14px;color:var(--secondary)}
.node .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.node .hash{font-family:var(--mono);font-size:var(--ui-tiny);color:var(--secondary)}
.lv1{padding-left:28px}.lv2{padding-left:48px}.lv3{padding-left:68px}
.progress{height:8px;border-radius:4px;background:var(--surface);overflow:hidden}
.progress i{display:block;height:100%;border-radius:4px;background:var(--accent);transform-origin:left;animation:growx 1s cubic-bezier(.2,.7,.2,1) both .2s}
.progress.run i{background-image:linear-gradient(45deg,rgb(255 255 255 / 25%) 25%,transparent 25% 50%,rgb(255 255 255 / 25%) 50% 75%,transparent 75%);background-size:14px 14px;animation:growx 1s cubic-bezier(.2,.7,.2,1) both .2s,stripes .8s linear infinite}
.progress.done i{background:var(--s-pass)}
.jobs{display:flex;flex-direction:column;gap:12px}
.job{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 12px;align-items:center;font-size:var(--ui-small)}
.job .progress{grid-column:1 / -1}
.job b{font-weight:600}

/* ---------------------------------------------------------------- workflows */
.packs{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}
@media (max-width:1180px){.packs{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:680px){.packs{grid-template-columns:minmax(0,1fr)}}
.pack{display:flex;flex-direction:column;gap:10px;width:100%;text-align:left;border:1px solid var(--border);border-radius:12px;background:var(--bg);padding:14px 16px;cursor:pointer;transition:border-color .12s,box-shadow .12s,transform .12s}
.pack:hover{border-color:color-mix(in srgb,var(--accent) 35%,var(--border));box-shadow:var(--shadow);transform:translateY(-1px)}
.pack.on{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 14%,transparent)}
.pack-h{display:flex;align-items:center;gap:10px}
.pack-h b{font-size:15px;font-weight:600}
.pack-i{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;background:var(--read-bg);color:var(--t-judgment);flex:none}
.pack-i.v{background:var(--think-bg);color:var(--t-unknown)}.pack-i.g{background:var(--write-bg);color:var(--t-pass)}.pack-i.o{background:var(--b-incomplete);color:var(--t-incomplete)}
.pack-m{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;font-size:var(--ui-small);color:var(--secondary)}
.pack .spark{margin-top:0}
.avatars{display:inline-flex}
.avatars .avatar{width:22px;height:22px;font-size:10px;border:2px solid var(--bg);margin-left:-6px}
.avatars .avatar:first-child{margin-left:0}
.avatars .avatar:nth-child(2){background:var(--think-bg);color:var(--t-unknown)}
.avatars .avatar:nth-child(3){background:var(--write-bg);color:var(--t-pass)}
.stages{display:flex;flex-wrap:wrap;gap:12px 26px}
.knowledge-space .card-h{flex-wrap:wrap}
.knowledge-space .card-h h3,.space-owner{min-width:0;overflow-wrap:anywhere}
.knowledge-space .card-h .meta{max-width:100%;white-space:normal;overflow-wrap:anywhere;word-break:break-all}
.knowledge-space h2{overflow-wrap:anywhere}
.knowledge-flow{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);gap:16px;align-items:center}
.knowledge-column{display:grid;gap:12px;min-width:0}
.knowledge-column h3{font-size:var(--ui);margin:0}
.knowledge-bridge{font-size:var(--ui-small);color:var(--secondary);text-align:center;max-width:180px}
.knowledge-flow .stage::after,.knowledge-flow .stage::before{display:none}
@media(max-width:900px){.knowledge-flow{grid-template-columns:1fr}.knowledge-bridge{max-width:none}}
.stage{flex:1 1 140px;position:relative;border:1px solid var(--border);border-radius:10px;padding:10px 12px;background:var(--bg);font-size:var(--ui-small);animation:rise .45s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(var(--i,0) * 90ms + 150ms)}
.stage::after{content:'';position:absolute;top:50%;right:-21px;width:16px;height:2px;background:var(--border)}
.stage::before{content:'';position:absolute;top:calc(50% - 4px);right:-23px;border:5px solid transparent;border-left-color:var(--muted);border-right:0}
.stage:last-child::after,.stage:last-child::before{display:none}
.stage b{display:block;font-size:var(--ui);font-weight:600;margin:2px 0}
.stage .host{display:inline-flex;align-items:center;gap:5px;color:var(--secondary);font-size:var(--ui-tiny)}
.stage.on-hub{border-color:color-mix(in srgb,var(--accent) 40%,var(--border));background:color-mix(in srgb,var(--read-bg) 45%,var(--bg))}
.stage.circle{border-color:color-mix(in srgb,var(--violet) 40%,var(--border));background:color-mix(in srgb,var(--think-bg) 45%,var(--bg))}
.stage.planned-stage{border-style:dashed;background:var(--subtle)}
.versions{list-style:none;margin:0;padding:0}
.versions li{display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:10px;padding:7px 0;font-size:var(--ui-small);position:relative}
.versions li::before{content:'';position:absolute;left:4px;top:20px;bottom:-8px;width:1px;background:var(--border)}
.versions li:last-child::before{display:none}
.versions .dot{margin-top:5px}
.heat{display:grid;grid-template-columns:28px repeat(24,minmax(0,1fr));gap:3px;font-size:var(--ui-tiny);color:var(--secondary);align-items:center}
.heat i{display:block;aspect-ratio:1;border-radius:3px;background:var(--surface)}

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

/* ---------------------------------------------------------------- dialog */
.scrim{position:absolute;inset:0;background:color-mix(in srgb,var(--fg) 28%,transparent);display:grid;place-items:center;padding:16px;animation:fade .15s ease both;z-index:5}
.dialog{width:100%;max-width:420px;border:1px solid var(--border);border-radius:14px;background:var(--bg);box-shadow:var(--shadow-pop);padding:20px 22px;animation:pop .2s cubic-bezier(.2,.7,.2,1) both}
.dialog h3{font-size:16px;font-weight:650}
.dialog p{color:var(--secondary);font-size:var(--ui-small);margin-top:8px;line-height:1.6}
.dialog .actions{margin-top:18px;justify-content:flex-end}
.snippet{position:relative;margin:10px 0 0;padding:12px 14px;border-radius:10px;background:var(--surface);font-family:var(--mono);font-size:var(--ui-tiny);line-height:1.7;white-space:pre;overflow-x:auto}

/* ---------------------------------------------------------------- login */
.login{min-height:100vh;display:grid;place-items:center;padding:48px 16px;background:radial-gradient(circle at 50% 0%,color-mix(in srgb,var(--read-bg) 55%,transparent),transparent 55%) var(--bg)}
.login-card{width:100%;max-width:440px;border:1px solid var(--border);border-radius:18px;background:var(--bg);box-shadow:var(--shadow-pop);padding:30px 30px 26px;animation:rise .5s cubic-bezier(.2,.7,.2,1) both}
.login-card h1{font-size:22px;font-weight:650;letter-spacing:-.3px;margin-top:16px}
.field{display:flex;flex-direction:column;gap:6px;margin-top:16px}
.field label{font-size:var(--ui-small);color:var(--secondary);font-weight:550}
.sso{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:12px}
.sso .btn{justify-content:flex-start;min-height:40px}
.sso .btn .planned{margin-left:auto}
.divider{display:flex;align-items:center;gap:10px;margin:20px 0 4px;color:var(--secondary);font-size:var(--ui-tiny)}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:var(--border)}

/* ---------------------------------------------------------------- trace waterfall: one picture of a task, step by step */
.wf{--name:300px;--dur:78px}
.wf-sum{display:flex;flex-wrap:wrap;gap:8px 26px;padding:0 0 14px;border-bottom:1px solid var(--border)}
.wf-sum > div{display:flex;flex-direction:column;gap:2px}
.wf-sum b{font-size:18px;font-weight:650;letter-spacing:-.3px;line-height:1.2}
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
.insp-h h3{font-size:16px;font-weight:650}
.gloss{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1.3fr);gap:0 14px;font-size:var(--ui-small)}
.gloss > span{padding:9px 0;border-bottom:1px solid var(--border);min-width:0}
.gloss .gh{color:var(--secondary);font-weight:550;padding-top:0}
.gloss .old{color:var(--secondary);text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--muted) 60%,transparent)}
.gloss .new{font-weight:600;color:var(--fg)}
@keyframes breathe{50%{opacity:.62}}

/* ---------------------------------------------------------------- motion */
.rise{animation:rise .5s cubic-bezier(.2,.7,.2,1) both;animation-delay:calc(var(--i,0) * 55ms)}
@keyframes rise{from{opacity:0;transform:translateY(8px)}}
@keyframes fade{from{opacity:0}}
@keyframes pop{from{opacity:0;transform:scale(.92)}}
@keyframes grow{from{transform:scaleY(0)}}
@keyframes growx{from{transform:scaleX(0)}}
@keyframes sweep{from{--sweep:0%}}
@keyframes trace{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
@keyframes spin{to{transform:rotate(1turn)}}
@keyframes dash{to{stroke-dashoffset:-20}}
@keyframes stripes{to{background-position:14px 0}}
@keyframes shimmer{from{background-position:100% 0}to{background-position:0 0}}
@keyframes pulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,currentColor 45%,transparent)}70%,100%{box-shadow:0 0 0 7px color-mix(in srgb,currentColor 0%,transparent)}}
/* Motion follows the reader's reduced-motion setting. */
@media (prefers-reduced-motion:reduce){.hub *,.hub *::before,.hub *::after{animation:none !important;transition:none !important}}

.k-wait{background-size:14.142px 14.142px}

/* ---------------------------------------------------------------- health strip, then narrow screens */
.health{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
.hcell{display:flex;align-items:center;gap:11px;padding:12px 14px;border:1px solid var(--border);border-radius:10px;font-size:var(--ui-small);transition:background .1s;min-width:0}
.hcell:hover{background:var(--subtle)}
.hcell b{display:block;font-weight:600;font-size:var(--ui)}
@media (max-width:1180px){.health{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:680px){.health{grid-template-columns:repeat(2,minmax(0,1fr))}.top h1{font-size:20px}.kpi .value{font-size:26px}}

/* ---------------------------------------------------------------- console: frame */
body.hub{margin:0}
.side form.logout{margin:0}
.side form.logout button{border:0}
.top .sub a,.note a,.plan-t a{color:var(--t-judgment)}
.back{display:inline-flex;align-items:center;gap:6px;color:var(--secondary);font-size:var(--ui-small);margin-top:18px}
.back:hover{color:var(--fg)}
.login-card .sub + .sub{margin-top:6px}
.login-card form{margin:0}
.login-card .btn.primary{width:100%;min-height:42px;margin-top:16px;font-size:var(--ui)}
.login-foot{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:22px;color:var(--secondary);font-size:var(--ui-small);text-align:center}
.setup-card{max-width:720px}

/* ---------------------------------------------------------------- console: blocks of the detailed pages */
.hub section{margin-top:22px}
.hub section > h2{font-size:15px;font-weight:650;margin:0 0 10px}
.hub section section > h2{font-size:14px}
.tablewrap{overflow-x:auto;border:1px solid var(--border);border-radius:10px;margin:8px 0;background:var(--bg)}
.hub table{border-collapse:collapse;width:100%;font-size:var(--ui-small)}
.hub th,.hub td{padding:8px 10px;text-align:left;vertical-align:top;border-bottom:1px solid var(--border)}
.hub th{color:var(--secondary);font-weight:550;background:var(--subtle);white-space:nowrap}
.hub tbody tr:last-child td{border-bottom:0}
.hub tbody tr:hover{background:var(--subtle)}
.hub td.end,.hub th.end{text-align:right}
.hub dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 16px;margin:0;font-size:var(--ui-small)}
.hub dt{color:var(--secondary);font-weight:550}
.hub dd{margin:0;min-width:0;overflow-wrap:anywhere}
.hub pre{font-family:var(--mono);font-size:var(--ui-tiny);line-height:1.7;white-space:pre-wrap;word-break:break-all;background:var(--surface);border-radius:8px;padding:10px 12px;max-height:40em;overflow:auto;margin:8px 0}
.hub details{margin:6px 0}
.hub details > summary{cursor:pointer;color:var(--t-judgment);font-size:var(--ui-small);font-weight:550}
.hub .claim{margin:6px 0;padding:10px 12px}
.hub .claim dl{gap:4px 14px}
.empty{color:var(--secondary);font-size:var(--ui-small)}
.error{color:var(--t-fail)}
pre.error{color:var(--t-fail);background:var(--b-fail)}
.notice{background:var(--b-incomplete);color:var(--t-incomplete);padding:9px 12px;border-radius:8px;font-size:var(--ui-small);line-height:1.6;margin:8px 0}
.ok{color:var(--t-pass)}
.t-pass{color:var(--t-pass)}.t-failure{color:var(--t-fail)}.t-judgment{color:var(--t-judgment)}.t-incomplete{color:var(--t-incomplete)}
.t-unknown{color:var(--t-unknown);font-weight:600}
.unverified{border-left:3px solid var(--attention);padding-left:10px}
.subnav{display:flex;flex-wrap:wrap;gap:6px 14px;margin:6px 0 12px;font-size:var(--ui-small)}
.subnav a{color:var(--t-judgment)}
.record{margin-top:28px;padding-top:4px;border-top:1px solid var(--border)}
.record > h2{font-size:16px;font-weight:650;margin-top:18px}

/* ---------------------------------------------------------------- console: forms */
.hub form{margin:8px 0}
.hub form.inline{display:inline-block;margin:0 6px 4px 0}
.hub form.filters{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:flex-end}
.hub label{font-size:var(--ui-small);color:var(--secondary)}
.hub input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden]):not([type=search]),.hub select,.hub textarea{min-height:34px;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg);font-size:var(--ui-small);outline:none}
.hub textarea{font-family:var(--mono);width:100%;min-height:72px}
.hub input:not([type=search]):focus,.hub select:focus,.hub textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 20%,transparent)}
.hub form button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:34px;padding:0 12px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:var(--ui-small);font-weight:500;cursor:pointer;color:var(--fg)}
.hub form button:hover{background:var(--hover)}
.hub form button.primary{background:var(--accent-strong);border-color:var(--accent-strong);color:var(--on-accent)}
.hub form button.icon-btn{min-height:32px;width:32px;padding:0;background:none;border:0;color:var(--secondary)}
.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px;margin-top:14px}
@media (max-width:680px){.fields{grid-template-columns:minmax(0,1fr)}}
.fields .full{grid-column:1 / -1}
.fields label{display:flex;flex-direction:column;gap:6px;font-weight:550}
.fields input,.fields select,.fields textarea{width:100%}
.fields .hint{font-weight:400;color:var(--muted);font-size:var(--ui-tiny)}
.check{display:inline-flex !important;flex-direction:row !important;align-items:center;gap:8px}
.form-f{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:16px}

/* ---------------------------------------------------------------- console: helpers in place of style attributes */
.row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}
.stack{display:flex;flex-direction:column;gap:14px;min-width:0}
.grow{flex:1 1 auto;min-width:0}
.mt4{margin-top:4px}.mt8{margin-top:8px}.mt12{margin-top:12px}.mt16{margin-top:16px}.mt22{margin-top:22px}
.ml-auto{margin-left:auto}
.nowrap{white-space:nowrap}
.muted{color:var(--secondary)}
.small{font-size:var(--ui-small)}
.break{overflow-wrap:anywhere}
.digest{font-family:var(--mono);font-size:var(--ui-tiny);color:var(--secondary)}
.steps-n{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.steps-n span{display:inline-flex;align-items:center;gap:7px;padding:4px 11px 4px 5px;border:1px solid var(--border);border-radius:999px;font-size:var(--ui-small);color:var(--secondary)}
.steps-n span b{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:11px;background:var(--hover)}
.steps-n span.on{border-color:var(--accent);color:var(--fg)}
.steps-n span.on b{background:var(--accent-strong);color:var(--on-accent)}
.steps-n span.done b{background:var(--b-pass);color:var(--t-pass)}

/* ---------------------------------------------------------------- console: the command dialog (no script: :target) */
.modal{display:none}
.modal:target{position:fixed;inset:0;z-index:20;display:grid;place-items:center;padding:16px;background:color-mix(in srgb,var(--fg) 28%,transparent);animation:fade .15s ease both}
.modal .dialog{max-width:600px;max-height:calc(100vh - 32px);overflow:auto}
.modal pre.snippet{user-select:all;white-space:pre-wrap;word-break:break-all}
.modal .actions{margin-top:16px;justify-content:flex-end}

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
.donut-svg{width:164px;height:164px;flex:none;transform:rotate(-90deg)}
.donut-svg circle{fill:none;stroke-width:6}
.donut-svg .ring{stroke:var(--surface)}
.stroke-pass{stroke:var(--s-pass)}.stroke-fail{stroke:var(--s-fail)}.stroke-judgment{stroke:var(--s-judgment)}.stroke-unchecked{stroke:var(--s-unchecked)}.stroke-incomplete{stroke:var(--s-incomplete)}.stroke-unknown{stroke:var(--s-unknown)}
.donut-hold{position:relative;width:164px;height:164px;flex:none}
.donut-hold .donut-c{position:absolute;inset:0}
.wf-row.static{cursor:default}
a.wf-row{color:inherit}
.result-legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:var(--ui-small);color:var(--secondary);margin-bottom:6px}
.result-legend b{color:var(--fg);font-weight:600;margin-left:2px}
.result-legend i{display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px;vertical-align:-1px}
.wf-name.d1{padding-left:22px}
.wf-ticks.flex{display:flex;justify-content:space-between;align-items:center}
.wf-ticks.flex span{position:static}
.brand-name{font-size:22px;font-weight:650;letter-spacing:-.6px}
.task-list .wf-name{flex-direction:column;align-items:flex-start;gap:0;line-height:1.35}
.kstats.two{grid-template-columns:repeat(2,minmax(0,1fr))}
.fill-t1{fill:var(--accent)}.fill-t2{fill:var(--violet)}.fill-t3{fill:var(--attention)}.fill-t4{fill:var(--positive)}.fill-t5{fill:color-mix(in srgb,var(--accent) 45%,var(--bg))}.fill-t6{fill:var(--negative)}
.f-hub{background:var(--accent)}.f-circle{background:var(--violet)}.f-wait{background:var(--attention)}
table.calls td{white-space:nowrap}
table.calls td:nth-child(n+9){white-space:normal}
.live-module{display:contents}
.live-state{margin-top:4px;color:var(--t-incomplete);font-size:var(--ui-small)}
`;
