// ===== Office Manager Cloud: monthly reports =====
// Clinic hours ("קליניקה בכפר"): text summary per therapist, read straight from the clinic calendar.
// Replaces Secretary/klinka.py (no Excel). Same rules: skip all-day and cancelled events, skip פבלו,
// event counted in the month it starts, aliases merge name variants.
// Triggers: message containing "קליניק" (e.g. "שעות קליניקה", "קליניקה 10.26", "קליניקה עדי אוקטובר", "קליניקה פירוט"),
//           /klinka [M.YY] [פירוט], and automatically on the 1st of the month at KLINKA_AUTO_AT for the month before.
// Optional Script Properties: KLINKA_CAL_ID (default below), KLINKA_AUTO (default 1, 0 = off), KLINKA_AUTO_AT (default 08:00)

const KLINKA_CAL_DEFAULT = '4hsp67pj5l9lo7sruric2cm9hk@group.calendar.google.com';
const KLINKA_EXCLUDE = ['פבלו'];
const KLINKA_ALIASES = { "מיכל חימוביץ'": 'מיכל', 'מיכל חימוביץ’': 'מיכל' };
const MONTHS_HE = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

// READ ONLY: the clinic calendar is touched in exactly one place, klinkaEvents_, which copies each event
// into a plain object {n, s, e, allDay}. No CalendarEvent object leaves it, so nothing here can edit or delete.
function klinkaEvents_(a, b) {
  const id = prop('KLINKA_CAL_ID') || KLINKA_CAL_DEFAULT;
  const cal = CalendarApp.getCalendarById(id);
  if (!cal) throw new Error('לא מוצא את יומן הקליניקה (' + id + ')');
  return cal.getEvents(a, b).map(ev => {
    const n = String(ev.getTitle() || '').trim();
    return { n: KLINKA_ALIASES[n] || n, s: ev.getStartTime(), e: ev.getEndTime(), allDay: ev.isAllDayEvent() };
  });
}

const hm_ = min => Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0');

// "10.26" / "10/2026" / month name -> {m, y}; nothing -> previous month (Israel time)
function reportMonth_(text, now) {
  now = now || new Date();
  const y0 = Number(Utilities.formatDate(now, HOME_TZ, 'yyyy')), m0 = Number(Utilities.formatDate(now, HOME_TZ, 'M'));
  const d = String(text || '').match(/(?:^|\D)(\d{1,2})[./](\d{2}|\d{4})(?!\d)/);
  if (d) {
    const m = Number(d[1]), y = d[2].length === 2 ? 2000 + Number(d[2]) : Number(d[2]);
    if (m >= 1 && m <= 12) return { m, y };
  }
  const i = MONTHS_HE.findIndex(n => String(text || '').includes(n));
  if (i >= 0) return { m: i + 1, y: i + 1 > m0 ? y0 - 1 : y0 }; // a month name later than now = last year
  if (/החודש|הנוכחי/.test(text || '')) return { m: m0, y: y0 };
  return m0 === 1 ? { m: 12, y: y0 - 1 } : { m: m0 - 1, y: y0 };
}

function klinkaRows_(m, y) {
  const pad = n => String(n).padStart(2, '0');
  const a = Utilities.parseDate(y + '-' + pad(m) + '-01 00:00', HOME_TZ, 'yyyy-MM-dd HH:mm');
  const b = Utilities.parseDate((m === 12 ? y + 1 : y) + '-' + pad(m % 12 + 1) + '-01 00:00', HOME_TZ, 'yyyy-MM-dd HH:mm');
  const rows = [];
  klinkaEvents_(a, b).forEach(({ n, s, e, allDay }) => {
    if (allDay) return;
    if (s < a || s >= b) return; // started in the previous month
    if (!n || KLINKA_EXCLUDE.includes(n)) return;
    rows.push({ n, s, e, min: Math.round((e - s) / 60000) });
  });
  rows.sort((p, q) => p.n.localeCompare(q.n, 'he') || p.s - q.s);
  return rows;
}

const dayHe_ = d => DAYS[Number(Utilities.formatDate(d, HOME_TZ, 'u')) % 7];
const times_ = n => n === 1 ? 'פעם אחת' : n + ' פעמים';
const rowLine_ = r => '  ' + dayHe_(r.s) + ' ' + Utilities.formatDate(r.s, HOME_TZ, 'dd/MM HH:mm') + '–' +
  Utilities.formatDate(r.e, HOME_TZ, 'HH:mm') + '  ' + hm_(r.min);

// who: a therapist's name -> only that person's dates and hours; detail: dates for everyone
function klinkaText(m, y, detail, who) {
  const rows = klinkaRows_(m, y);
  const title = MONTHS_HE[m - 1] + ' ' + y;
  if (who) {
    const mine = rows.filter(r => r.n === who);
    if (!mine.length) return '🏡 ' + who + ', ' + title + ': אין אירועים ביומן הקליניקה.';
    const tot = mine.reduce((s, r) => s + r.min, 0);
    return ['🏡 ' + who + ', ' + title + ': ' + hm_(tot) + ' (' + times_(mine.length) + ')', ''].concat(mine.map(rowLine_)).join('\n');
  }
  if (!rows.length) return '🏡 קליניקה בכפר, ' + title + ': אין אירועים ביומן.';
  const tot = {}, cnt = {};
  rows.forEach(r => { tot[r.n] = (tot[r.n] || 0) + r.min; cnt[r.n] = (cnt[r.n] || 0) + 1; });
  const names = Object.keys(tot).sort((p, q) => p.localeCompare(q, 'he'));
  const lines = ['🏡 קליניקה בכפר, שעות ' + title, ''];
  names.forEach(n => lines.push('• ' + n + ': ' + hm_(tot[n]) + ' (' + times_(cnt[n]) + ')'));
  if (detail) names.forEach(n => { lines.push('', n + ':'); rows.filter(r => r.n === n).forEach(r => lines.push(rowLine_(r))); });
  else lines.push('', 'לפירוט של אדם אחד: "קליניקה ' + names[0] + ' ' + m + '.' + String(y % 100).padStart(2, '0') + '"');
  return lines.join('\n');
}

// names that appear in the clinic calendar in the last 120 days (for recognizing a name in a message)
function klinkaNames_() {
  const c = CacheService.getScriptCache(), hit = c.get('klinka_names');
  if (hit) return JSON.parse(hit);
  const now = Date.now(), set = {};
  klinkaEvents_(new Date(now - 120 * 864e5), new Date(now + 60 * 864e5)).forEach(({ n }) => {
    if (n && !KLINKA_EXCLUDE.includes(n)) set[n] = 1;
  });
  const names = Object.keys(set).sort((a, b) => b.length - a.length); // longest first
  c.put('klinka_names', JSON.stringify(names), 3600);
  return names;
}
const whoIn_ = text => klinkaNames_().find(n => String(text).includes(n)) || '';

// message or /klinka command
function klinkaCmd(text) {
  try {
    const { m, y } = reportMonth_(text);
    send(klinkaText(m, y, /פירוט|מפורט/.test(text), whoIn_(text)));
  } catch (e) { log('klinka error', String(e && e.stack || e)); send('חישוב שעות הקליניקה נכשל: ' + e.message); }
}

// ===== Punch cards (כרטיסייה): hours bought vs. hours used in the clinic calendar =====
// Property CARDS = {name: {size: 10, buys: ['yyyy-MM-dd', ...], warned: 'level|bought'}}
// Used = calendar hours of that name from the first purchase date until now (ended events only).
// Remaining = size * purchases - used, so a new card simply adds hours (overdraft is carried).
// Opening balance: "כרטיסייה עדי יתרה 8 מ-1.11" (hours left on that date; replaces earlier purchases)
// Messages: "עדי קנתה כרטיסייה" (today) / "עדי קנתה כרטיסייה 20.11" / "כרטיסייה עדי" (status) / "כרטיסיות" (all)
//           "בטל כרטיסייה עדי" (removes the last purchase), "כרטיסייה של 5 עדי" (another size).
// Alerts (once each, checked hourly): 1 hour left, card finished.
const CARD_SIZE_DEFAULT = 10;
const cards_ = () => JSON.parse(prop('CARDS') || '{}');
const saveCards_ = c => P.setProperty('CARDS', JSON.stringify(c));

function cardDate_(text, now) {
  const d = String(text).match(/(?:^|\D)(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?(?![\d./])/);
  const ymd = Utilities.formatDate(now, HOME_TZ, 'yyyy-MM-dd');
  if (!d) return /אתמול/.test(text) ? Utilities.formatDate(new Date(now - 864e5), HOME_TZ, 'yyyy-MM-dd') : ymd;
  let y = d[3] ? (d[3].length === 2 ? 2000 + Number(d[3]) : Number(d[3])) : Number(ymd.slice(0, 4));
  const iso = y + '-' + d[2].padStart(2, '0') + '-' + d[1].padStart(2, '0');
  return !d[3] && iso > ymd ? (y - 1) + iso.slice(4) : iso; // "20.12" said in January = last year
}

// card.open = ['yyyy-MM-dd', minutes]: opening balance on that date (e.g. 8 hours on 1.11 after 2 unpaid hours)
function cardState_(name, card, now) {
  const starts = card.buys.concat(card.open ? [card.open[0]] : []).sort();
  if (!starts.length) return { bought: 0, used: 0, left: 0, rows: [] };
  const boughtMin = card.size * 60 * card.buys.length + (card.open ? card.open[1] : 0);
  const from = Utilities.parseDate(starts[0] + ' 00:00', HOME_TZ, 'yyyy-MM-dd HH:mm');
  const rows = klinkaEvents_(from, now).filter(r => r.n === name && !r.allDay && r.s >= from && r.e <= now)
    .map(r => ({ s: r.s, e: r.e, min: Math.round((r.e - r.s) / 60000) }));
  const used = rows.reduce((s, r) => s + r.min, 0);
  return { bought: boughtMin, used, left: boughtMin - used, rows };
}

function cardText_(name, card, st) {
  const fmtD = iso => iso.slice(8, 10) + '/' + iso.slice(5, 7);
  const left = st.left >= 0 ? 'נשארו ' + hm_(st.left) + ' שעות' : '⚠️ חריגה של ' + hm_(-st.left) + ' שעות';
  const lines = ['🎟️ ' + name + ': ' + left];
  if (card.open) lines.push('יתרת פתיחה: ' + hm_(card.open[1]) + ' שעות ב-' + fmtD(card.open[0]));
  if (card.buys.length) lines.push('נקנו: ' + card.buys.map(fmtD).join(', ') + ' (' + card.size + ' שעות כל אחת)');
  lines.push('נוצלו: ' + hm_(st.used) + ' שעות');
  if (st.rows.length) lines.push('', ...st.rows.slice(-12).map(r => rowLine_(r)));
  return lines.join('\n');
}

function cardCmd(text) {
  try {
    const now = new Date(), all = cards_();
    const who = whoIn_(text) || Object.keys(all).find(n => text.includes(n));
    if (!who) {
      const names = Object.keys(all);
      if (!names.length) return send('אין כרטיסיות. לדוגמה: "עדי קנתה כרטיסייה 20.11"');
      return send(names.map(n => cardText_(n, all[n], cardState_(n, all[n], now)).split('\n')[0]).join('\n'));
    }
    const card = all[who] || { size: CARD_SIZE_DEFAULT, buys: [] };
    const open = text.match(/יתרה\D{0,6}(\d{1,2})(?:[.:](\d{1,2}))?\s*(?:שעות|ש׳)?/);
    if (open) { // "כרטיסייה עדי יתרה 8 מ-1.11": opening balance, replaces earlier records
      const rest = text.replace(open[0], ' ');
      card.open = [cardDate_(rest, now), Number(open[1]) * 60 + (open[2] ? Number(open[2].padEnd(2, '0')) : 0)];
      card.buys = card.buys.filter(d => d > card.open[0]);
      card.warned = '';
      all[who] = card; saveCards_(all);
      return send('נרשם ✅\n' + cardText_(who, card, cardState_(who, card, now)));
    }
    if (/בטל|מחק|טעות/.test(text)) {
      if (!card.buys.length) return send('אין ל' + who + ' קנייה לבטל.' + (card.open ? ' (יתרת פתיחה משנים עם "כרטיסייה ' + who + ' יתרה 8 מ-1.11")' : ''));
      const gone = card.buys.pop();
      card.warned = '';
      if (card.buys.length || card.open) all[who] = card; else delete all[who];
      saveCards_(all);
      return send('בוטלה הכרטיסייה של ' + who + ' מ-' + gone.slice(8, 10) + '/' + gone.slice(5, 7) + '.' +
        (card.buys.length || card.open ? '\n' + cardText_(who, card, cardState_(who, card, now)) : ''));
    }
    if (/קנת|קנה|רכש|חדשה|הוסף|נוספה/.test(text)) {
      const size = text.match(/של (\d{1,2})(?!\d)/);
      if (size) card.size = Number(size[1]);
      const day = cardDate_(text.replace(/של \d{1,2}(?!\d)/, ''), now);
      card.buys.push(day); card.buys.sort();
      card.warned = '';
      all[who] = card; saveCards_(all);
      return send('נרשם ✅\n' + cardText_(who, card, cardState_(who, card, now)));
    }
    if (!all[who]) return send('אין ל' + who + ' כרטיסייה. לרישום: "' + who + ' קנתה כרטיסייה 20.11"');
    send(cardText_(who, card, cardState_(who, card, now)));
  } catch (e) { log('card error', String(e && e.stack || e)); send('הכרטיסייה נכשלה: ' + e.message); }
}

// hourly from tick(): warn once at 1 hour left and once when the card is used up
function cardsTick(now) {
  const all = cards_();
  let dirty = false;
  Object.keys(all).forEach(n => {
    const card = all[n], st = cardState_(n, card, now);
    const level = st.left <= 0 ? 'out' : st.left <= 60 ? 'low' : '';
    const mark = level + '|' + card.buys.length;
    if (!level || card.warned === mark || (level === 'low' && card.warned === 'out|' + card.buys.length)) return;
    card.warned = mark; dirty = true;
    send(level === 'out' ? '🎟️ הכרטיסייה של ' + n + ' נגמרה' + (st.left < 0 ? ' (חריגה של ' + hm_(-st.left) + ')' : '') + '.\nלרישום כרטיסייה חדשה: "' + n + ' קנתה כרטיסייה"'
      : '🎟️ ל' + n + ' נשארה ' + (st.left === 60 ? 'שעה אחת' : hm_(st.left) + ' שעות') + ' בכרטיסייה.');
  });
  if (dirty) saveCards_(all);
}

// called from tick(): cards hourly; on the 1st, last month's clinic summary + Retorno button
function reportsTick() {
  const now = new Date();
  const hour = Utilities.formatDate(now, HOME_TZ, 'yyyy-MM-dd HH');
  if (prop('CARDS') && prop('CARDS_CHECKED') !== hour) {
    P.setProperty('CARDS_CHECKED', hour);
    try { cardsTick(now); } catch (e) { log('cards error', String(e && e.stack || e)); }
  }
  if (prop('KLINKA_AUTO') === '0') return;
  if (Utilities.formatDate(now, HOME_TZ, 'd') !== '1') return;
  if (Utilities.formatDate(now, HOME_TZ, 'HH:mm') < (prop('KLINKA_AUTO_AT') || '08:00')) return;
  const ym = Utilities.formatDate(now, HOME_TZ, 'yyyy-MM');
  if (prop('KLINKA_SENT') === ym) return;
  P.setProperty('KLINKA_SENT', ym); // set first: never send twice, even if sending fails
  const { m, y } = reportMonth_('', now);
  klinkaCmd(m + '.' + y);
  if (prop('RETORNO_TEMPLATE_ID') && prop('RETORNO_FOLDER_ID'))
    try { retornoPreview(m, y); } catch (e) { log('retorno preview error', String(e && e.stack || e)); }
}

// ===== Retorno monthly hour reports (replaces Secretary/retorno.py) =====
// One .docx per project, built from a Word template in Drive by editing word/document.xml inside the zip,
// so the layout stays exactly as in the template. Saved to the reports folder in Drive and sent on Telegram.
// Never overwrites: a report that already exists in the folder is only re-sent.
// Triggers: "רטורנו" / "דוחות רטורנו 11.26" [מחדש], /retorno [M.YY]: a preview to fix dates first; on the 1st the preview comes by itself.
// Script Properties: RETORNO_TEMPLATE_ID (the template .docx), RETORNO_FOLDER_ID (where reports go)
const RETORNO_PROJECTS = [ // [project, [[weekday 0=Sun, start, end, hours, notes, price], ...]], same as retorno.py
  ['חוסן', [[1, '13:30', '14:30', '1', 'ותיקים', 450], [2, '11:00', '14:00', '3', 'חוסן *2', 900]]],
  ['קהילה', [[2, '17:00', '18:30', '1.5', 'בוגרים', 300]]],
  ['אשפוזית חוץ', [[2, '15:30', '16:30', '1', 'אשפוזית חוץ', 300]]],
  ['אשפוזית', [[4, '12:00', '13:00', '1', 'אשפוזית', 300]]],
];
const HE_DAY_LETTER = ['א’', 'ב’', 'ג’', 'ד’', 'ה’', 'ו’', 'ש’'];
const HOLIDAYS_CAL = 'en.jewish#holiday@group.v.calendar.google.com';
const retornoName_ = (p, m, y) => 'דיווח ' + p + ' ' + m + '.' + String(y % 100).padStart(2, '0') + '.docx';

function retornoRows_(sessions, m, y) {
  const days = new Date(y, m, 0).getDate(), rows = [];
  sessions.forEach(([wd, start, end, hours, notes, price]) => {
    for (let d = 1; d <= days; d++) {
      if (new Date(y, m - 1, d).getDay() !== wd) continue;
      rows.push({ price: String(price), topic: 'יוגה', notes, hours, end, start, day: HE_DAY_LETTER[wd],
        date: String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0') + '/' + y, d });
    }
  });
  return rows;
}

const xmlEsc_ = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// cell = <w:tc> with its <w:tcPr> kept and one centered RTL Arial 10.5pt paragraph (as the existing reports)
function cellXml_(tc, text) {
  const pr = (tc.match(/<w:tcPr>[\s\S]*?<\/w:tcPr>/) || [''])[0];
  const run = text === '' ? '' : '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:cs="Arial" w:eastAsia="Arial" w:hAnsi="Arial"/>' +
    '<w:sz w:val="21"/><w:szCs w:val="21"/><w:rtl w:val="1"/></w:rPr><w:t xml:space="preserve">' + xmlEsc_(text) + '</w:t></w:r>';
  return '<w:tc>' + pr + '<w:p><w:pPr><w:bidi w:val="1"/><w:jc w:val="center"/></w:pPr>' + run + '</w:p></w:tc>';
}
// put the whole text in the first <w:t> of the row and empty the others, so the first run's formatting is kept
function rowText_(tr, text) {
  let first = true;
  return tr.replace(/<w:t(?: [^>]*)?>[^<]*<\/w:t>/g, () => {
    const t = '<w:t xml:space="preserve">' + (first ? xmlEsc_(text) : '') + '</w:t>';
    first = false; return t;
  });
}

// pure function, tested offline against the real form
function fillDocXml_(xml, project, m, y, rows) {
  const tbl = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/);
  if (!tbl) throw new Error('אין טבלה בתבנית');
  const trs = tbl[0].match(/<w:tr[ >][\s\S]*?<\/w:tr>/g);
  const cellsOf = tr => tr.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || [];
  const data = []; // rows after the column titles (row 2) that have the 9 columns
  for (let i = 3; i < trs.length; i++) if (cellsOf(trs[i]).length === 9) data.push(i); else break;
  if (rows.length > data.length) throw new Error(project + ': ' + rows.length + ' מפגשים לא נכנסים ב-' + data.length + ' השורות של הטופס');
  const out = trs.slice();
  // keep each run's formatting where the template splits the text (title bold, project plain): change only the parts
  const T = /<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g;
  const ts0 = [...trs[0].matchAll(T)], last = ts0.filter(x => x[1].trim()).pop();
  out[0] = last && ts0.length > 1 && /- $/.test(ts0[ts0.indexOf(last) - 1][1])
    ? trs[0].slice(0, last.index) + '<w:t xml:space="preserve">' + xmlEsc_(project) + '</w:t>' + trs[0].slice(last.index + last[0].length)
    : rowText_(trs[0], 'טופס דיווח חודשי- ספקים ומטפלים - ' + project);
  let mOk = false, yOk = false;
  const r1 = trs[1].replace(T, (w, t) => {
    if (!mOk && /^: \d{1,2}(\s*)$/.test(t)) { mOk = true; return '<w:t xml:space="preserve">: ' + m + t.match(/\s*$/)[0] + '</w:t>'; }
    if (!yOk && /^: \d{4}\s*$/.test(t)) { yOk = true; return '<w:t xml:space="preserve">: ' + y + '</w:t>'; }
    return w;
  });
  out[1] = mOk && yOk ? r1 : rowText_(trs[1], 'שם הספק: פבלו           חודש: ' + m + '           שנה: ' + y);
  const keys = ['price', '', 'topic', 'notes', 'hours', 'end', 'start', 'day', 'date']; // document order (column 2 = signature, blank)
  data.forEach((ri, k) => {
    const r = rows[k];
    let ci = 0;
    out[ri] = trs[ri].replace(/<w:tc>[\s\S]*?<\/w:tc>/g, tc => cellXml_(tc, r && keys[ci] ? r[keys[ci++]] : (ci++, '')));
  });
  // totals at the bottom of the form: the number goes after the "-" of each label, in the label's last run
  const n = rows.length, hrs = rows.reduce((s, r) => s + Number(r.hours), 0), pay = rows.reduce((s, r) => s + Number(r.price), 0);
  const TOT = [[/ימים\/מפגשים-\s*$/, ' ' + n], [/שעות-\s*$/, ' ' + hrs], [/לתשלום-\s*₪\s*$/, ' ' + pay + ' ₪']];
  for (let i = data.length ? data[data.length - 1] + 1 : 3; i < trs.length; i++)
    out[i] = trs[i].replace(/<w:tc>[\s\S]*?<\/w:tc>/g, tc => {
      const ts = [...tc.matchAll(T)], txt = ts.map(x => x[1]).join('').replace(/&quot;/g, '"'), hit = TOT.find(([re]) => re.test(txt));
      if (!hit || !ts.length) return tc;
      const lastT = ts[ts.length - 1], base = lastT[1].replace(/\s*₪?\s*$/, '');
      return tc.slice(0, lastT.index) + '<w:t xml:space="preserve">' + base + hit[1] + '</w:t>' + tc.slice(lastT.index + lastT[0].length);
    });
  let pos = 0;
  const newTbl = tbl[0].replace(/<w:tr[ >][\s\S]*?<\/w:tr>/g, () => out[pos++]);
  return xml.replace(tbl[0], () => newTbl);
}

function retornoDocx_(template, project, rows, m, y) {
  const parts = Utilities.unzip(template.copyBlob().setContentType('application/zip'));
  const blobs = parts.map(b => b.getName() !== 'word/document.xml' ? b :
    Utilities.newBlob(fillDocXml_(b.getDataAsString('UTF-8'), project, m, y, rows), 'application/xml', 'word/document.xml'));
  const name = retornoName_(project, m, y);
  const docx = Utilities.zip(blobs, name).setContentType('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  // check before saving: valid zip, same parts, the last date is inside
  const back = Utilities.unzip(docx.copyBlob().setContentType('application/zip'));
  const doc = back.filter(b => b.getName() === 'word/document.xml')[0];
  if (back.length !== parts.length || !doc || (rows.length && doc.getDataAsString('UTF-8').indexOf(rows[rows.length - 1].date) < 0))
    throw new Error(name + ': הקובץ שנוצר לא תקין');
  return { docx, rows };
}

function holidays_(m, y) {
  const cal = CalendarApp.getCalendarById(HOLIDAYS_CAL), out = {};
  if (!cal) return out;
  cal.getEvents(new Date(y, m - 1, 1), new Date(y, m, 1)).forEach(e => {
    const k = Utilities.formatDate(e.getStartTime(), HOME_TZ, 'dd/MM/yyyy');
    out[k] = (out[k] ? out[k] + ', ' : '') + e.getTitle();
  });
  return out;
}

// multipart built by hand: UrlFetchApp drops the Hebrew part of the file name, so Telegram showed only "11.26.docx"
function sendDoc_(blob, caption) {
  const b = '----om' + Utilities.getUuid().replace(/-/g, ''), u = s => Utilities.newBlob('').setDataFromString(s, 'UTF-8').getBytes();
  const field = (k, v) => u('--' + b + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + v + '\r\n');
  const name = String(blob.getName() || 'file.docx').replace(/["\r\n]/g, '');
  const body = [].concat(field('chat_id', prop('ALLOWED_USER_ID')), field('caption', caption || ''),
    u('--' + b + '\r\nContent-Disposition: form-data; name="document"; filename="' + name + '"\r\nContent-Type: ' +
      (blob.getContentType() || 'application/octet-stream') + '\r\n\r\n'), blob.getBytes(), u('\r\n--' + b + '--\r\n'));
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + prop('TG_TOKEN') + '/sendDocument',
    { method: 'post', contentType: 'multipart/form-data; boundary=' + b, payload: body, muteHttpExceptions: true });
  const j = JSON.parse(r.getContentText());
  if (!j.ok) { log('tg error sendDocument', j.description); throw new Error(j.description); }
}

// ----- month edits: cancelled sessions and staff meetings -----
// Script Property RT_EDITS = {"2026-11": {"off": ["חוסן|10/11/2026", ...], "staff": ["18/11/2026", ...]}}
// All edits are made on the preview that "רטורנו 11.26" shows before creating: one button per date (✅ / ❌),
// "➕ ישיבת צוות" opens a day picker (tap a staff meeting in the preview to remove it), then "📄 צור ושלח".
const RETORNO_STAFF = { project: 'חוסן', start: '20:30', end: '22:00', hours: '1.5', price: 300, topic: 'יוגה', notes: 'ישיבת צוות' };
const RETORNO_SORT_BY_DATE = false; // false: staff meetings after the regular sessions; true: all rows by date
const ymKey_ = (m, y) => y + '-' + String(m).padStart(2, '0');
const ddmm_ = date => date.slice(0, 5).replace('/', '.');

function rtEdits_() { try { return JSON.parse(prop('RT_EDITS') || '{}'); } catch (e) { return {}; } }
function rtMonth_(all, m, y) { const k = ymKey_(m, y); all[k] = all[k] || { off: [], staff: [] }; return all[k]; }
function rtSave_(all) { // keep the last 6 months only
  Object.keys(all).sort().slice(0, -6).forEach(k => delete all[k]);
  P.setProperty('RT_EDITS', JSON.stringify(all));
}

// rows of one project for the month, after edits; each row has .key (project|date) and .on
function retornoMonthRows_(pi, m, y, ed) {
  const [project, sessions] = RETORNO_PROJECTS[pi];
  let rows = retornoRows_(sessions, m, y).map(r => Object.assign(r, { key: project + '|' + r.date }));
  if (project === RETORNO_STAFF.project) {
    const S = RETORNO_STAFF;
    rows = rows.concat(ed.staff.slice().sort((a, b) => Number(a.slice(0, 2)) - Number(b.slice(0, 2))).map(date => {
      const d = Number(date.slice(0, 2));
      return { price: String(S.price), topic: S.topic, notes: S.notes, hours: S.hours, end: S.end, start: S.start,
        day: HE_DAY_LETTER[new Date(y, m - 1, d).getDay()], date, d, key: 'staff|' + date, staff: true };
    }));
  }
  if (RETORNO_SORT_BY_DATE) rows.sort((a, b) => a.d - b.d);
  rows.forEach(r => r.on = ed.off.indexOf(r.key) < 0);
  return rows;
}

// files of the month that already exist in the reports folder
function rtExisting_(m, y) {
  const folder = DriveApp.getFolderById(prop('RETORNO_FOLDER_ID'));
  return RETORNO_PROJECTS.map(p => retornoName_(p[0], m, y)).filter(n => folder.getFilesByName(n).hasNext());
}

// ----- preview -----
function rtPreview_(m, y) {
  const ed = rtMonth_(rtEdits_(), m, y), hol = holidays_(m, y), mm = m + '.' + String(y % 100).padStart(2, '0');
  const lines = ['📄 רטורנו ' + mm + ': לבדוק לפני יצירה', 'לחיצה על תאריך: ✅ היה / ❌ בוטל. לחיצה על ישיבת צוות מוחקת אותה.', ''], kb = [];
  let th = 0, tp = 0;
  RETORNO_PROJECTS.forEach(([project], pi) => {
    const rows = retornoMonthRows_(pi, m, y, ed), on = rows.filter(r => r.on);
    const h = on.reduce((s, r) => s + Number(r.hours), 0), p = on.reduce((s, r) => s + Number(r.price), 0);
    th += h; tp += p;
    lines.push('• ' + project + ': ' + on.length + ' מפגשים, ' + h + ' שעות, ' + p + ' ₪');
    // one header per session type (by the notes column), dates in order under it: "חוסן", "חוסן ותיקים", "חוסן ישיבות צוות"
    const groups = [];
    rows.forEach(r => {
      const g = r.staff ? 'ישיבות צוות' : r.notes, last = groups[groups.length - 1];
      if (last && last.g === g) last.rows.push(r); else groups.push({ g, rows: [r] });
    });
    groups.forEach(G => G.rows.sort((a, b) => a.d - b.d));
    let row = [];
    const flush = () => { if (row.length) kb.push(row); row = []; };
    groups.forEach(G => {
      flush();
      const label = groups.length === 1 || G.g.indexOf(project) >= 0 ? project : project + ' ' + G.g;
      kb.push([{ text: '— ' + label + ' —', callback_data: 'rt:n:' }]);
      G.rows.forEach(r => {
      const mark = !r.on ? '❌' : hol[r.date] ? '⚠️' : '✅';
      row.push({ text: (r.staff ? '🗑 ' : mark + ' ') + ddmm_(r.date) + (r.staff ? ' צוות' : ''), callback_data: 'rt:t:' + m + '.' + y + '.' + (r.staff ? 's' : pi) + '.' + r.d });
      if (row.length === 4) flush();
      });
    });
    flush();
  });
  lines.push('סה״כ: ' + th + ' שעות, ' + tp + ' ₪');
  const w = Object.keys(hol).filter(d => RETORNO_PROJECTS.some((p, pi) => retornoMonthRows_(pi, m, y, ed).some(r => r.date === d)));
  if (w.length) lines.push('', '⚠️ חג: ' + w.map(d => ddmm_(d) + ' ' + hol[d]).join(', '));
  const ex = rtExisting_(m, y);
  if (ex.length) lines.push('', 'כבר קיימים בדרייב (לא ייווצרו מחדש): ' + ex.map(n => n.replace('.docx', '')).join(', '));
  kb.push([{ text: '➕ ישיבת צוות', callback_data: 'rt:add:' + m + '.' + y }]);
  kb.push([{ text: '📄 צור ושלח', callback_data: 'rt:go:' + m + '.' + y }, { text: '✖️ סגור', callback_data: 'rt:x:' }]);
  return { text: lines.join('\n'), kb };
}

function retornoPreview(m, y) { const v = rtPreview_(m, y); send(v.text, v.kb); }

// "רטורנו 11.26" -> preview; "רטורנו 11.26 מחדש" -> existing files of the month go to the trash, then preview
function retornoCmd(text) {
  if (!prop('RETORNO_TEMPLATE_ID') || !prop('RETORNO_FOLDER_ID')) return send('חסר RETORNO_TEMPLATE_ID או RETORNO_FOLDER_ID ב-Script Properties.');
  const { m, y } = reportMonth_(text);
  if (/מחדש/.test(text)) {
    const folder = DriveApp.getFolderById(prop('RETORNO_FOLDER_ID')), gone = [];
    RETORNO_PROJECTS.forEach(([p]) => { const it = folder.getFilesByName(retornoName_(p, m, y)); while (it.hasNext()) { const f = it.next(); f.setTrashed(true); gone.push(f.getName()); } });
    if (gone.length) send('🗑 הועברו לפח בדרייב: ' + gone.map(n => n.replace('.docx', '')).join(', '));
  }
  retornoPreview(m, y);
}

// buttons: "rt:t:<M>.<YYYY>.<pi|s>.<day>" toggle (s = staff: remove), "rt:add:<M>.<YYYY>" day picker, "rt:sd:<M>.<YYYY>.<day>" add staff,
// "rt:back:<M>.<YYYY>" back to preview, "rt:go:<M>.<YYYY>" create, "rt:x:" close, "rt:n:" header,
// and the old "rt:<M>.<YYYY>" (opens the preview)
function retornoButton(q, k) {
  const parts = String(q.data).split(':'), arg = parts[2] || '', chat = q.message.chat.id, mid = q.message.message_id;
  const answer = t => tg('answerCallbackQuery', { callback_query_id: q.id, text: t || '' });
  if (k === 'n') return answer();
  if (k === 'x') { answer(); return tg('editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: [] } }); }
  if (k === 't') {
    const [m, y, who, d] = arg.split('.'), date = String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0') + '/' + y;
    const key = (who === 's' ? 'staff' : RETORNO_PROJECTS[Number(who)][0]) + '|' + date;
    const all = rtEdits_(), ed = rtMonth_(all, Number(m), Number(y)), i = ed.off.indexOf(key);
    if (who === 's') { ed.staff = ed.staff.filter(x => x !== date); answer('🗑 ישיבת צוות ' + ddmm_(date)); }
    else { if (i >= 0) ed.off.splice(i, 1); else ed.off.push(key); answer(i >= 0 ? '✅ ' + ddmm_(date) : '❌ ' + ddmm_(date)); }
    rtSave_(all);
    const v = rtPreview_(Number(m), Number(y));
    return tg('editMessageText', { chat_id: chat, message_id: mid, text: v.text, reply_markup: { inline_keyboard: v.kb } });
  }
  if (k === 'add') { // day picker for a staff meeting
    const [m, y] = arg.split('.').map(Number), days = new Date(y, m, 0).getDate(), kb = [];
    for (let d = 1; d <= days; d++) {
      if (d === 1 || new Date(y, m - 1, d).getDay() === 0) kb.push([]);
      kb[kb.length - 1].push({ text: HE_DAY_LETTER[new Date(y, m - 1, d).getDay()] + ' ' + d, callback_data: 'rt:sd:' + m + '.' + y + '.' + d });
    }
    kb.push([{ text: '↩️ חזרה', callback_data: 'rt:back:' + m + '.' + y }]);
    answer();
    return tg('editMessageText', { chat_id: chat, message_id: mid, text: 'באיזה תאריך הייתה ישיבת צוות? (' + m + '.' + String(y % 100).padStart(2, '0') + ')', reply_markup: { inline_keyboard: kb } });
  }
  if (k === 'sd' || k === 'back') {
    const [m, y, d] = arg.split('.').map(Number);
    if (k === 'sd') {
      const all = rtEdits_(), ed = rtMonth_(all, m, y), date = String(d).padStart(2, '0') + '/' + String(m).padStart(2, '0') + '/' + y;
      if (ed.staff.indexOf(date) < 0) ed.staff.push(date);
      rtSave_(all);
      answer('➕ ישיבת צוות ' + ddmm_(date));
    } else answer();
    const v = rtPreview_(m, y);
    return tg('editMessageText', { chat_id: chat, message_id: mid, text: v.text, reply_markup: { inline_keyboard: v.kb } });
  }
  const [m, y] = (k === 'go' ? arg : k).split('.').map(Number);
  if (k !== 'go') { answer(); tg('editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: [] } }); return retornoPreview(m, y); }
  answer('יוצר...');
  tg('editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: [] } });
  retornoRun(m, y);
}

function retornoRun(m, y) {
  const tid = prop('RETORNO_TEMPLATE_ID'), fid = prop('RETORNO_FOLDER_ID');
  if (!tid || !fid) return send('חסר RETORNO_TEMPLATE_ID או RETORNO_FOLDER_ID ב-Script Properties.');
  const lock = LockService.getUserLock(); // a double tap must not create the files twice (tick holds the script lock)
  if (!lock.tryLock(30000)) return send('כבר יוצר את הדוחות, רגע...');
  try {
    const template = DriveApp.getFileById(tid).getBlob(), folder = DriveApp.getFolderById(fid), ed = rtMonth_(rtEdits_(), m, y);
    const hol = holidays_(m, y), lines = ['📄 דוחות רטורנו ' + m + '.' + String(y % 100).padStart(2, '0')], files = [], old = [];
    let th = 0, tp = 0;
    const warn = {};
    RETORNO_PROJECTS.forEach(([project], pi) => {
      const name = retornoName_(project, m, y), ex = folder.getFilesByName(name);
      if (ex.hasNext()) { old.push(name.replace('.docx', '')); files.push(ex.next().getBlob()); return; }
      const rows = retornoMonthRows_(pi, m, y, ed).filter(r => r.on);
      if (!rows.length) { lines.push('• ' + project + ': אין מפגשים, לא נוצר דוח'); return; }
      const { docx } = retornoDocx_(template, project, rows, m, y);
      folder.createFile(docx);
      files.push(docx);
      const h = rows.reduce((s, r) => s + Number(r.hours), 0), p = rows.reduce((s, r) => s + Number(r.price), 0);
      th += h; tp += p;
      const off = retornoMonthRows_(pi, m, y, ed).filter(r => !r.on).length;
      lines.push('• ' + project + ': ' + rows.length + ' מפגשים, ' + h + ' שעות, ' + p + ' ₪' + (off ? ' (' + off + ' בוטלו)' : ''));
      rows.forEach(r => { if (hol[r.date]) warn[r.date] = hol[r.date]; });
    });
    if (files.length > old.length) lines.push('סה״כ: ' + th + ' שעות, ' + tp + ' ₪', 'נשמר בדרייב.');
    if (old.length) lines.push('כבר היו קיימים ולא נגעתי בהם: ' + old.join(', '));
    const w = Object.keys(warn);
    if (w.length) lines.push('', '⚠️ מפגשים בימי חג, אולי לא התקיימו:', ...w.map(d => d.slice(0, 5) + ' ' + warn[d]));
    send(lines.join('\n'));
    files.forEach(f => { try { sendDoc_(f, f.getName().replace('.docx', '')); } catch (e) { send('לא הצלחתי לשלוח את ' + f.getName() + ': ' + e.message); } });
  } catch (e) {
    log('retorno error', String(e && e.stack || e));
    send('יצירת דוחות רטורנו נכשלה: ' + e.message);
  } finally { lock.releaseLock(); }
}

// run once by hand after setting the two properties: checks access and builds one test report in memory (nothing saved or sent)
function retornoCheck() {
  const t = DriveApp.getFileById(prop('RETORNO_TEMPLATE_ID')), f = DriveApp.getFolderById(prop('RETORNO_FOLDER_ID'));
  const { docx, rows } = retornoDocx_(t.getBlob(), RETORNO_PROJECTS[0][0], retornoRows_(RETORNO_PROJECTS[0][1], 12, 2026), 12, 2026);
  Logger.log('template: ' + t.getName() + ' | folder: ' + f.getName() + ' | test ' + docx.getName() + ': ' + rows.length + ' rows, ' + docx.getBytes().length + ' bytes. OK');
}
