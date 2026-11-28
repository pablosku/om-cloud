// The board served by the Worker (v31): the google.script.run stand-in (BOARD_SHIM in Board.js) must send every call
// to /board/api and hand the answer back. Run: node tests/worker.test.js (needs playwright)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const src = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const assert = (ok, msg) => { if (!ok) { console.error('FAIL', msg); process.exitCode = 1; } else console.log('ok  ', msg); };
const shim = src('Board.js').match(/const BOARD_SHIM = `([\s\S]*?)`;/)[1];
const K = 'a'.repeat(32);
const page = '<!doctype html>' + src('BoardPage.html').replace(/^<!DOCTYPE html>/i, '')
  .replace(/<\?!= include_\('(\w+)'\) \?>/g, (_, f) => src(f + '.html')).replace('<?= boardKey ?>', K).replace(/<link[^>]+fonts[^>]+>/g, '')
  .replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1"><script>' + shim + '</script>');
const d = new Date().toISOString().slice(0, 10);
const answers = {
  boardGet: { lists: [{ id: 'a', name: 'היום', note: '', kind: 'list', items: [] }], cal: [], quote: null, view: {}, today: d },
  inspGet: { day: { date: d, stage: 1, src: 'גיטה', verse: 'פסוק', story: '', question: 'שאלה', chat: [], ratings: {}, model: 'gemini-x' }, past: [] },
  inspSend: { day: { date: d, stage: 2, src: 'גיטה', verse: 'פסוק', story: '', question: 'שאלה', chat: [{ r: 'me', t: 'שלום' }, { r: 'om', t: 'תשובה', m: 'gemini-x' }], ratings: {}, model: 'gemini-x' } },
};
(async () => {
  const br = await chromium.launch(), errs = [], calls = [];
  const p = await br.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  p.on('pageerror', e => errs.push(e.message));
  await p.route('https://w.test/board?k=' + K, r => r.fulfill({ contentType: 'text/html', body: page }));
  await p.route('https://w.test/board/api**', r => { const b = JSON.parse(r.request().postData()); calls.push([new URL(r.request().url()).search, b]);
    r.fulfill({ contentType: 'application/json', body: JSON.stringify(b.fn in answers ? { ok: answers[b.fn] } : b.fn === 'boardOp' ? { ok: 'ok' } : { err: 'unknown call' }) }); });
  await p.goto('https://w.test/board?k=' + K); await p.waitForTimeout(400);
  assert(calls.some(c => c[1].fn === 'boardGet' && c[1].args[0] === K && c[0] === '?k=' + K), 'boardGet goes to /board/api with the key');
  assert(await p.textContent('#lists h2 .name') === 'היום' && await p.textContent('#insp .verse') === 'פסוק', 'board and inspiration load through the Worker');
  await p.fill('#insp textarea', 'שלום'); await p.click('#insp .bar .up'); await p.waitForTimeout(200);
  assert(calls.some(c => c[1].fn === 'inspSend' && c[1].args[0] === 'שלום') && (await p.textContent('#insp .chat')).includes('תשובה'), 'a chat message goes and the answer shows');
  assert(!errs.length, 'no page errors ' + errs.join('; '));
  await br.close();
})();
