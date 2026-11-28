// Phone-size checks of the board page and the family page, with google.script.run and the Worker API mocked.
// Run: node tests/board.test.js   (needs playwright; nothing here is pushed to Apps Script)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const src = f => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
const assert = (ok, msg) => { if (!ok) { console.error('FAIL', msg); process.exitCode = 1; } else console.log('ok  ', msg); };

// BoardPage.html with its includes inlined, the way Apps Script serves it
const boardHtml = mock => src('BoardPage.html')
  .replace(/<\?!= include_\('(\w+)'\) \?>/g, (_, f) => src(f + '.html'))
  .replace("<?= boardKey ?>", 'k').replace(/<link[^>]+fonts[^>]+>/g, '')
  .replace('<head>', '<head><meta name="viewport" content="width=device-width, initial-scale=1"><script>(' + mock + ')();</script>');

const mock = (() => {
  const ops = []; window.__ops = ops;
  const d = new Date().toISOString().slice(0, 10), t = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const I = (id, tt, pos, k = '') => ({ id, t: tt, done: false, star: false, c: '', lastC: '', wait: null, k, pos });
  const data = { lists: [
    { id: 'a', name: 'טווח קצר', note: '', kind: 'list', items: [I('1', 'להתקשר לרו"ח', 1), I('s1', 'עבודה', 2, 'sep'), I('2', 'לשלוח חשבונית', 3), I('3', 'טסט לרכב', 4)] },
    { id: 's', name: 'לקנות', note: '', kind: 'shop', items: [I('i1', 'לחם', 1), I('p1', 'ירקות', 2, 'sep'), I('i2', 'עגבניות', 3), I('i3', 'כוסברה', 4), I('p2', 'טמבור', 5, 'sep'), I('i4', 'מסמרים', 6)] },
    { id: 'b', name: 'רעיונות', note: '', kind: 'list', items: [I('r1', 'טיול לגליל', 1)] }],
    cal: [{ id: 'e1', at: Date.now() + 36e5, date: d, time: '23:00', t: 'יוגה', st: '', to: '', series: true }, { id: 'e2', at: Date.now() + 864e5, date: t, time: '09:00', t: 'רופא שיניים', st: '', to: '', series: false }],
    quote: { s: 'יוגה היא שוויון נפש.', c: 'פרשנות', src: 'גיטה' }, view: { calPos: 2 }, today: d };
  function R() { let ok; const o = { withSuccessHandler(x) { ok = x; return o; }, withFailureHandler() { return o; },
    boardGet() { setTimeout(() => ok(JSON.parse(JSON.stringify(data))), 10); },
    boardOp(op) { ops.push(op); setTimeout(() => ok(op.t === 'rem.add' ? { ok: op.text } : 'ok'), 10); } }; return o; }
  window.google = { script: { get run() { return R(); } } };
}).toString();

(async () => {
  const br = await chromium.launch(), errs = [];
  const p = await br.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  p.on('pageerror', e => errs.push(e.message));
  await p.setContent(boardHtml(mock), { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(300);
  const note = n => `#lists > section[aria-label="${n}"]`, shop = note('לקנות'), tk = note('טווח קצר');
  const rows = async s => p.$$eval(s + ' ul:first-of-type > li', l => l.map(x => x.textContent.replace(/[☆★]/g, '').trim()).join('|'));
  const off = () => p.click('#today');

  await p.click(shop + ' li.sep[data-sep="p1"] .name'); await p.click('#pop button[aria-label="למטה"]');
  assert(await rows(shop) === 'לחם|עגבניות|ירקות|כוסברה|טמבור|מסמרים', 'a line moves one step past an item');
  await off(); await p.click(shop + ' li.item:has-text("מסמרים") .txt');
  await p.click('#pop button[aria-label="למעלה"]'); await p.click('#pop button[aria-label="למעלה"]');
  assert(await rows(shop) === 'לחם|עגבניות|ירקות|מסמרים|כוסברה|טמבור', 'tap an item: ↑ ↑ (past a line), menu stays open');
  assert(await p.$$eval('#pop h3', x => x.length) === 0, 'shopping item menu has no "other note"');
  await off(); await p.fill(shop + ' .add input', 'ירקות: מלפפון'); await p.press(shop + ' .add input', 'Enter');
  assert(await rows(shop) === 'לחם|עגבניות|ירקות|מסמרים|כוסברה|מלפפון|טמבור', '"store: item" goes to the end of that part');
  await p.click(tk + ' li.item:has-text("טסט") .star');
  assert(await rows(tk) === 'להתקשר לרו"ח|עבודה|טסט לרכב|לשלוח חשבונית', '★ goes to the top of its part');
  await p.click(tk + ' li.item:has-text("לשלוח") .txt'); await p.click('#pop button[aria-label="למעלה"]');
  assert(await rows(tk) === 'להתקשר לרו"ח|עבודה|לשלוח חשבונית|טסט לרכב', 'normal note: item ↑');
  await p.click('#pop button[aria-label="ערוך את הטקסט"]');
  assert(await p.evaluate(() => document.activeElement.contentEditable) === 'true', '✎ edits the text');
  await off();
  const cz = tk + ' li.item:has-text("לרו") .cz', col = () => p.$eval(tk + ' li.item:has-text("לרו")', x => x.style.getPropertyValue('--c'));
  await p.click(cz); const c1 = await col(); await p.click(cz); const c2 = await col(); await p.waitForTimeout(4200); await p.click(cz);
  assert(c1 === 'var(--c-yellow)' && c2 === 'var(--c-green)' && await col() === '', 'colour: taps cycle, a later tap clears');
  await p.click(tk + ' h2 .fold'); await p.click('#calh .fold');
  assert(await p.$eval(tk, x => x.classList.contains('folded')) && await p.$eval('#calSheet', x => x.classList.contains('folded')), '+/− folds a note and the reminders');
  await p.click(tk + ' h2 .fold'); await p.click('#calh .fold');
  await p.click('#remAdd'); await p.click('#pop button[aria-label="שמור"]');
  assert(await p.textContent('#toast') === 'מה להזכיר?', 'new reminder: text is required');
  await p.fill('#n-text', 'להתקשר לרופא'); await p.click('#pop button[aria-label="מחר"]'); await p.fill('#n-time', '09:00'); await p.selectOption('#n-rep', 'weekly');
  await p.click('#pop button[aria-label="שמור"]'); await p.waitForTimeout(100);
  const ro = await p.evaluate(() => window.__ops.filter(o => o.t === 'rem.add').pop());
  assert(ro.text === 'להתקשר לרופא' && ro.time === '09:00' && ro.repeat === 'weekly' && ro.date > new Date().toISOString().slice(0, 10), 'new reminder form sends text, day, time, repeat');
  assert((await p.textContent('#toast')).startsWith('✓ נקבעה') && await p.isHidden('#pop'), 'new reminder saved, form closed');
  assert(await p.$$eval('#cal li.day .ln', x => x.length) === 2, 'reminder days are lines');

  // family page
  const f = await br.newPage({ viewport: { width: 390, height: 700 }, hasTouch: true, isMobile: true }), fops = [];
  f.on('pageerror', e => errs.push(e.message));
  const R0 = [{ id: 'i1', t: 'לחם', k: '', done: false }, { id: 'p1', t: 'ירקות', k: 'sep', done: false }, { id: 'i2', t: 'עגבניות', k: '', done: false },
    { id: 'p2', t: 'טמבור', k: 'sep', done: false }, { id: 'i4', t: 'מסמרים', k: '', done: false }, { id: 'd', t: 'חלב', k: '', done: true }];
  await f.route('https://x.test/**', r => r.fulfill({ contentType: 'text/html', body: src('FamilyPage.html') }));
  await f.route('**/shop/api**', r => { fops.push(JSON.parse(r.request().postData())); r.fulfill({ contentType: 'application/json', body: JSON.stringify({ rows: R0, seps: R0.filter(x => x.k === 'sep') }) }); });
  await f.goto('https://x.test/shop?f=k'); await f.waitForTimeout(300);
  await f.click('li.it:has-text("מסמרים") span'); await f.click('.pop button:text("↑")'); await f.waitForTimeout(50);
  assert(JSON.stringify(fops[1]) === JSON.stringify({ t: 'order', ids: ['i1', 'p1', 'i2', 'i4', 'p2'] }), 'family: ↑ sends the new order');
  await f.click('h1'); await f.fill('#t', 'ירקות: מלפפון'); await f.press('#t', 'Enter'); await f.waitForTimeout(50);
  assert(JSON.stringify(fops[2]) === JSON.stringify({ t: 'add', text: 'מלפפון', store: 'ירקות' }), 'family: "store: item"');

  assert(!errs.length, 'no page errors ' + errs.join('; '));
  await br.close();
})();
