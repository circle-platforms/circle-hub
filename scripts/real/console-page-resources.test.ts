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
