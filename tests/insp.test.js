// Phone-size checks of the morning inspiration note, with google.script.run mocked (no Gemini calls).
// Run: node tests/insp.test.js   (needs playwright). SHOT=dir also saves screenshots there.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const src = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const assert = (ok, msg) => { if (!ok) { console.error('FAIL', msg); process.exitCode = 1; } else console.log('ok  ', msg); };
const boardHtml = mock => src('BoardPage.html')
  .replace(/<\?!= include_\('(\w+)'\) \?>/g, (_, f) => src(f + '.html'))
  .replace("<?= boardKey ?>", 'k').replace(/<link[^>]+fonts[^>]+>/g, '')
  .replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1"><script>(' + mock + ')();</script>');

const mock = (() => {
  const calls = []; window.__calls = calls;
  const z = n => String(n).padStart(2, '0'), x = new Date(), d = x.getFullYear() + '-' + z(x.getMonth() + 1) + '-' + z(x.getDate());
  const day = { date: d, stage: 1, src: 'אשטוואקרה גיטה 1:11', verse: '"מי שחושב על עצמו כחופשי – חופשי."', story: 'המלך ג\'נקה שואל איך משיגים שחרור.',
    question: 'איך אתה מבין את הסוגיה הזו?', chat: [], ratings: {}, model: 'gemini-2.5-pro' };
  const board = { lists: [{ id: 'a', name: 'היום', note: '', kind: 'list', items: [] }], cal: [], quote: { s: 'ציטוט ישן', c: '', src: '' }, view: {}, today: d };
  const replies = [{ t: 'לפני שאגיב: למה התכוונת ב**תפיסה**?', stage: 2 }, { t: '### פרק 2\nתרגול נשימה.\n- נשיפה ארוכה\n\n### פרק 3\nחדשות טובות.', stage: 4, src: [{ u: 'https://www.nih.gov/x', t: 'nih.gov' }] }];
  const later = f => ({ ok: null, fail: null });
  function R() { let ok; const o = { withSuccessHandler(x) { ok = x; return o; }, withFailureHandler() { return o; },
    boardGet() { setTimeout(() => ok(JSON.parse(JSON.stringify(board))), 10); },
    boardOp(op) { calls.push(['op', op]); setTimeout(() => ok('ok'), 10); },
    inspGet() { calls.push(['get']); setTimeout(() => ok({ day: JSON.parse(JSON.stringify(day)), past: [{ date: '2026-11-27', src: 'גיטה 2:47', verse: 'עשה בלי להיאחז בפרי.' }] }), 10); },
    inspSend(t) { calls.push(['send', t]); if (t) day.chat.push({ r: 'me', t }); const a = replies.shift();
      day.chat.push(Object.assign({ r: 'om', t: a.t, m: 'gemini-2.5-pro' }, a.src ? { src: a.src } : {}, a.stage === 4 ? { fb: true } : {})); day.stage = a.stage;
      setTimeout(() => ok({ day: JSON.parse(JSON.stringify(day)) }), window.__slow ? 3600 : 30); },
    inspStatus() { setTimeout(() => ok({ m: 'gemini-3.6-flash', i: 2, prev: { m: 'gemini-3.8-flash', c: 503 }, at: Date.now() }), 10); },
    inspRate(ch, v) { calls.push(['rate', ch, v]); },
    inspDay(dt) { setTimeout(() => ok({ date: dt, src: 'גיטה 2:47', story: 'סיפור', chat: [{ r: 'me', t: 'תשובה ישנה' }], ratings: {} }), 10); } }; return o; }
  // a speech recognizer that starts but never hears anything (what happens inside Google's page frame)
  window.SpeechRecognition = window.webkitSpeechRecognition = function () { this.start = () => { window.__micStarts = (window.__micStarts || 0) + 1; }; this.abort = () => {}; this.stop = () => {}; };
  window.google = { script: { get run() { return R(); } } };
}).toString();

(async () => {
  const br = await chromium.launch(), errs = [], shot = process.env.SHOT;
  const p = await br.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  p.on('pageerror', e => errs.push(e.message));
  await p.setContent(boardHtml(mock), { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(300);
  const calls = () => p.evaluate(() => window.__calls);
  assert(await p.isVisible('#insp .verse') && await p.isHidden('#quote'), 'inspiration note shows chapter 1; old quote hidden');
  assert(await p.$eval('#lists', n => n.compareDocumentPosition(document.getElementById('insp')) & Node.DOCUMENT_POSITION_PRECEDING), 'note is above the lists');
  const long = 'התכוונתי לשני. '.repeat(30);
  await p.fill('#insp textarea', long);
  const h = await p.$eval('#insp textarea', t => [t.clientHeight, t.scrollHeight]);
  assert(h[0] >= h[1] - 4 && h[0] > 150, 'answer box grows to hold a long answer');
  await p.click('#insp .bar .up'); await p.waitForTimeout(100);
  assert((await calls()).some(c => c[0] === 'send' && c[1] === long.trim()), 'send passes the answer');
  assert(await p.$eval('#insp textarea', t => t.value) === '', 'box empties after send');
  assert((await p.textContent('#insp .chat .b.om')).includes('תפיסה') && await p.$eval('#insp .chat .b.om b', b => b.textContent) === 'תפיסה', 'reply shown, **bold** rendered');
  assert(await p.$$eval('#insp .steps i.on', x => x.length) === 2, 'stage dots follow the stage');
  assert(await p.textContent('#insp .mline') === 'ענה: gemini-2.5-pro' && await p.isVisible('#insp .mline'), 'the model that answered shows under the box');
  if (shot) await p.screenshot({ path: shot + '/insp-board.png' });
  await p.evaluate(() => { window.__slow = true; });
  await p.fill('#insp textarea', 'כן, נמשיך'); await p.click('#insp .bar .up'); await p.waitForTimeout(3300);
  assert((await p.textContent('#insp .b.wait')) === 'Google עמוסה (3.8-flash), מנסה 3.6-flash…', 'while waiting: says Google is busy and which model is trying');
  await p.waitForTimeout(500); await p.evaluate(() => { window.__slow = false; });
  assert(await p.$$eval('#insp .rate button', x => x.length) === 9, 'chapters 2-3: 3 rating buttons per chapter');
  assert(await p.$eval('#insp .srcs a', a => a.href) === 'https://www.nih.gov/x', 'links come from the search sources');
  await p.click('#insp .rate button[aria-label="פרק 2 · פרקטיקה: מדויק ומעמיק"]');
  assert((await calls()).some(c => c[0] === 'rate' && c[1] === 2 && c[2] === 'a'), 'rating saved');
  await p.click('#insp .dots'); await p.click('#pop button[aria-label="הגדל את הטקסט"]');
  assert(await p.$eval('#insp', s => s.style.getPropertyValue('--is')) === '1.1' && await p.textContent('#pop .isz span') === '110%', '⋯ menu: א+ makes the chat text bigger');
  assert(await p.$$eval('#pop button', x => x.length) === 2, '⋯ menu holds only א− א+');
  await p.click('#today');
  await p.evaluate(() => scrollTo(0, 0));
  assert(await p.$eval('#insp', s => s.getBoundingClientRect().height) <= 844, 'note mode: a long chat never makes the note taller than the screen');
  assert(await p.$eval('#insp .body', b => b.scrollHeight > b.clientHeight && b.scrollTop > 0), 'note mode: the text scrolls inside the note, at the newest message');
  if (shot) await p.screenshot({ path: shot + '/insp-note.png' });
  await p.click('#insp .ih button[aria-label="מסך מלא"]');
  assert(await p.isHidden('#insp .ih .ttl') && await p.isHidden('#insp .ih .steps') && await p.isHidden('#insp .vhead .src'), 'full screen: no title, no stage dots, no source');
  const hb = await p.$eval('#insp .ih', h => h.getBoundingClientRect()), vr = await p.$eval('#insp .vhead .verse', v => v.getBoundingClientRect());
  assert(hb.right <= vr.left + 2 || hb.bottom <= vr.top, 'full screen: the buttons do not cover the verse');
  assert(await p.$eval('#insp .vhead .verse', v => v.clientHeight >= v.scrollHeight - 2), 'full screen: the whole verse shows (up to 3 lines)');
  const box = await p.$eval('#insp .box2', b => b.getBoundingClientRect().bottom);
  assert(await p.$eval('#insp', s => s.classList.contains('full')) && box > 800, 'full screen: answer box at the bottom');
  await p.$eval('#insp .body', b => { b.scrollTop = b.scrollHeight; });
  const vt = await p.$eval('#insp .vhead', v => v.getBoundingClientRect().top), bt = await p.$eval('#insp .body', b => b.getBoundingClientRect().top);
  assert(Math.abs(vt - bt) < 2, 'full screen: the verse stays pinned at the top while the text scrolls');
  assert(await p.$eval('#insp .box2', b => b.getBoundingClientRect().height) < 64, 'full screen: an empty answer box is one line');
  if (shot) await p.screenshot({ path: shot + '/insp-full.png' });
  await p.click('#insp .ih button[aria-label="קפל את ההשראה"]');
  assert(await p.$eval('#insp', s => s.classList.contains('folded') && !s.classList.contains('full')), '− in full screen folds and leaves full screen');
  assert(await p.textContent('#insp .fv p') === '☀ "מי שחושב על עצמו כחופשי – חופשי."' && await p.isHidden('#insp .ih'), 'folded: only ☀ and the verse');
  if (shot) await p.screenshot({ path: shot + '/insp-folded.png' });
  await p.waitForTimeout(900);
  assert((await calls()).some(c => c[0] === 'op' && c[1].t === 'view.set' && c[1].view.fold.insp === 1 && c[1].view.insp_phone === 1.1), 'fold and size saved in the view');
  await p.click('#insp .fv button');
  await p.click('#insp .arch button'); await p.click('#insp .past > button'); await p.waitForTimeout(50);
  assert((await p.textContent('#insp .past .old')).includes('תשובה ישנה'), 'past days open from the archive');
  const on = () => p.$eval('#insp .mic', m => m.classList.contains('on'));
  await p.click('#insp .mic'); const a1 = await on(); await p.click('#insp .mic');
  assert(a1 && !(await on()), 'mic: a second tap always turns it off');
  await p.click('#insp .mic'); await p.waitForTimeout(4300);
  assert(!(await on()) && (await p.textContent('#toast')).includes('המקלדת'), 'mic: no sound in 4 s -> stops and points to the keyboard mic');
  await p.click('#insp .mic');
  assert(!(await on()) && await p.evaluate(() => window.__micStarts) === 2 && await p.evaluate(() => document.activeElement.tagName) === 'TEXTAREA', 'mic: after that, a tap opens the keyboard instead');
  assert(!errs.length, 'no page errors ' + errs.join('; '));
  await br.close();
})();
