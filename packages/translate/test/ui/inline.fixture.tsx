import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { installParagraphTranslation } from '../../src/client/paragraph.js';
import { installTranslationDom } from '../../src/client/dom.js';
import { installStyles } from '../../src/client/styles.js';

localStorage.removeItem('dsh-translate.settings.v1');
const fixture = {
  text: '', context: '', fail: false, defer: false, resolve: () => {},
  update: (_text: string) => {}, unmount: () => {},
  translation: '如果之后仍未出现 0.2.25，请发送一张发现页面的截图给我，以便我查看问题卡在哪里。',
};
Object.assign(window, { fixture });
window.fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body));
  fixture.text = body.text; fixture.context = body.context;
  if (fixture.defer) await new Promise<void>(resolve => { fixture.resolve = resolve; });
  return fixture.fail ? Response.json({ error: 'Enter a translation model first' }, { status: 400 })
    : Response.json({ translation: fixture.translation, target: 'zh-CN' });
};
document.head.insertAdjacentHTML('beforeend', `<style>
body{margin:0;background:#18181b;color:#eee;font:14px/1.7 system-ui;--dsw-alias-label-secondary:#aaa}
main{max-width:680px;margin:40px auto;padding:0 32px}#scroll{height:440px;overflow:auto;padding:0 28px}p{margin:12px 0}h2{font-size:18px}li{margin:8px 0}blockquote{margin:12px 0;padding-left:16px;border-left:2px solid #555}textarea{box-sizing:border-box;width:100%;height:72px;background:#27272a;color:inherit;border:0;padding:12px}
</style>`);
const mount = document.createElement('main'); document.body.append(mount);
const root = createRoot(mount);
fixture.unmount = () => root.unmount();
function Conversation() {
  const [text, setText] = useState("If 0.2.25 still doesn't appear after that, send me a screenshot of the Discover page so I can see where it's stuck.");
  fixture.update = setText;
  return <><div id="scroll"><article data-testid="assistant-message">
    <p id="first">{text}</p><p id="second">This paragraph should move down when a translation is inserted above it.</p>
    <ul><li id="item">A list item with context.<ul><li id="nested">Nested item.</li></ul></li></ul>
    <h2 id="heading">A heading</h2><blockquote id="quote">A plain quote.</blockquote>
    <p id="word">The bank of the river.</p><p style={{ height: 400 }}>More conversation content.</p>
  </article></div><textarea placeholder="发送消息或创建任务" /></>;
}
root.render(<Conversation />);
const cleanups = [installStyles(), installTranslationDom(), installParagraphTranslation()];
Object.assign(fixture, { dispose: () => cleanups.reverse().forEach(cleanup => cleanup()) });
