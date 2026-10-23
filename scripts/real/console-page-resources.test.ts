import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizePage } from './console-page.ts';

test('displayed URLs and quoted or raw text are not external page resources',()=>{
  const body=`<p>合成 http://192.0.2.1/x 标题 &lt;img src="//192.0.2.2/a"&gt;</p>
    <p title="https://192.0.2.3/title">普通文字</p>
    <!-- <img src="//192.0.2.4/comment"> -->
    <textarea><img src="//192.0.2.5/text"></textarea>
    <a href="/console/results?source=https://192.0.2.6">本地链接</a>`;
  assert.equal(summarizePage(body).externalAddresses,0);
});

test('resource and navigation attributes count external URLs, including srcset candidates',()=>{
  const body=`<a href='https://192.0.2.1/a'>链接</a><img src=//192.0.2.2/a>
    <img srcset='/local 1x, //192.0.2.3/a 2x, https://192.0.2.4/a 3x'>
    <form action='//192.0.2.5/a'></form><button formaction='https://192.0.2.6/a'>按钮</button>
    <video poster='//192.0.2.7/a'></video><object data='https://192.0.2.8/a'></object>`;
  assert.equal(summarizePage(body).externalAddresses,8);
});

test('attribute parsing preserves quoted values and decodes address syntax',()=>{
  assert.equal(summarizePage(`<p title='prefix > src="https://192.0.2.1/a"'>文字</p>`).externalAddresses,0);
  assert.equal(summarizePage('<img src="&#47;&#47;192.0.2.2/a"><a href="https&colon;//192.0.2.3/a">链接</a>').externalAddresses,2);
  assert.equal(summarizePage('<script>const url="https://192.0.2.4/a";</script>').externalAddresses,0);
});

for(const markup of [
  '<style>@import url(https://192.0.2.1/a.css);</style>',
  '<style>@import "//192.0.2.1/a.css";</style>',
  '<div style="background:url(https://192.0.2.1/a.png)"></div>',
  '<meta http-equiv="refresh" content="0;url=https://192.0.2.1/">',
  '<svg><image xlink:href="https://192.0.2.1/a.png"/></svg>',
  '<iframe srcdoc="&lt;img src=https://192.0.2.1/a&gt;"></iframe>',
  '<a ping="https://192.0.2.1/p">link</a>',
  '<body background="//192.0.2.1/a.png"></body>',
  '<blockquote cite="https://192.0.2.1/a">text</blockquote>',
  '<html manifest="https://192.0.2.1/a"></html>',
  '<menuitem icon="https://192.0.2.1/a">',
])test('CSS, refresh, namespaced, embedded and additional resource locations are inspected '+markup.split(/[ >]/)[0],()=>{
  assert.equal(summarizePage(markup).externalAddresses,1);
});

test('CSS syntax distinguishes resource targets from displayed strings and comments',()=>{
  assert.equal(summarizePage('<style>/* url(https://192.0.2.1/a) */ p{content:"url(https://192.0.2.2/a)";background:url(/local)}</style>').externalAddresses,0);
  assert.equal(summarizePage('<style>p{background:u\\72l("\\68ttps://192.0.2.1/a")}</style>').externalAddresses,1);
  assert.equal(summarizePage('<a ping="/local https://192.0.2.1/a //192.0.2.2/a">link</a>').externalAddresses,2);
  assert.equal(summarizePage('<meta http-equiv="refresh" content="0;url=&quot;//192.0.2.1/a&quot;">').externalAddresses,1);
});

test('srcdoc documents are inspected through multiple entity-encoded nesting levels',()=>{
  const attribute=(value:string)=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const inner='<iframe srcdoc="'+attribute('<img src="//192.0.2.1/a">')+'"></iframe>';
  assert.equal(summarizePage('<iframe srcdoc="'+attribute(inner)+'"></iframe>').externalAddresses,1);
  assert.equal(summarizePage('<iframe srcdoc="'+attribute('<p>https://192.0.2.1/displayed</p>')+'"></iframe>').externalAddresses,0);
});

for(const markup of [
  '<meta http-equiv="refresh" content="0; https://192.0.2.1/">',
  '<meta http-equiv="refresh" content="0,url=https://192.0.2.1/">',
  '<meta http-equiv="refresh" content="0 https://192.0.2.1/">',
  '<meta http-equiv="refresh" content=".5, URL = &quot;//192.0.2.1/a&quot; ignored">',
  '<link rel="preload" as="image" imagesrcset="/local 1x, https://192.0.2.1/a.png 2x">',
  `<div style="background-image:image-set('https://192.0.2.1/a.png' 1x)"></div>`,
  `<style>p{background:-webkit-image-set("https://192.0.2.1/a.png" 2x)}</style>`,
  '<svg><rect fill="url(https://192.0.2.1/p.svg#g)"/></svg>',
  '<svg><rect filter="url(https://192.0.2.1/p.svg#g)"/></svg>',
  '<svg><rect mask="url(https://192.0.2.1/p.svg#g)"/></svg>',
  '<noscript><img src="https://192.0.2.1/a.png"></noscript>',
  '<noscript><style>@import "https://192.0.2.1/a.css";</style></noscript>',
])test('the third review resource form is counted '+markup,()=>{
  assert.equal(summarizePage(markup).externalAddresses,1);
});

test('refresh syntax and nested CSS strings distinguish targets from non-resource text',()=>{
  assert.equal(summarizePage('<meta http-equiv="refresh" content="bad;url=https://192.0.2.1/">').externalAddresses,0);
  assert.equal(summarizePage(`<style>p{content:"image-set('https://192.0.2.1/a')";background:image-set('/local' 1x type('https://192.0.2.2/not-a-resource'))}</style>`).externalAddresses,0);
  assert.equal(summarizePage(`<style>p{background:image-set('https://192.0.2.1/a' 1x,url(https://192.0.2.2/b) 2x)}</style>`).externalAddresses,2);
  assert.equal(summarizePage('<svg><rect fill="url(#local)" filter="u\\72l(https://192.0.2.1/a)"/></svg>').externalAddresses,1);
});

for(const embedded of [false,true])test('noscript closing text is scanned in both scripting modes '+String(embedded),()=>{
  const markup='<noscript><p title="</noscript><img src=https://192.0.2.1/a.png>\"></noscript>';
  const attribute=(value:string)=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  assert.equal(summarizePage(embedded?'<iframe srcdoc="'+attribute(markup)+'"></iframe>':markup).externalAddresses,1);
});

for(const markup of [
  String.raw`<img src="\\192.0.2.1/a.png">`,
  String.raw`<img src="/\192.0.2.1/a.png">`,
  String.raw`<a href="\/192.0.2.1/x">link</a>`,
  '<svg><image><set attributeName="href" to="https://192.0.2.1/a.png"/></image></svg>',
  '<svg><a><animate attributeName="href" values="https://192.0.2.1/"/><text>x</text></a></svg>',
])test('URL reference spelling and SVG animation are counted '+markup,()=>{
  assert.equal(summarizePage(markup).externalAddresses,1);
});

test('SVG URL animations inspect each value while non URL attributes remain plain values',()=>{
  assert.equal(summarizePage('<svg><image><animate attributeName="xlink:href" from="//192.0.2.1/a" to="/local" by="https://192.0.2.2/b" values="/local;https://192.0.2.3/c;//192.0.2.4/d"/></image></svg>').externalAddresses,4);
  for(const attributeName of ['width','x'])for(const tag of ['set','animate'])assert.equal(summarizePage(`<svg><rect><${tag} attributeName="${attributeName}" from="https://192.0.2.1/a" to="//192.0.2.2/b" values="https://192.0.2.3/c"/></rect></svg>`).externalAddresses,0);
});
