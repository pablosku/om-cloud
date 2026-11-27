// ===== Board: Pablo's one-page TODO board (web page served by doGet, data in the "secretary db" sheet) =====
// Page: BoardPage.html (google.script.run -> boardGet / boardOp). Opened from a separate web-app deployment
// with access "Only myself"; every call also checks that the viewer is the script owner (boardOwner_).
// Sheet tabs: board_lists, board_items, inspiration. Deletes are soft (deleted = time) and purged after 30 days.
// Reminders: read from the Reminders calendar (next 7 days); done / undo / cancel / move / to-list act on it
// the same way the Telegram buttons in Code.js do (tag state=done, ✅ title prefix, setTime, deleteEvent).
// Display settings (font and size per device kind, colours, bold, quote open) live in Script Property BOARD_VIEW.

const BL_H = ['id', 'name', 'order', 'note', 'kind', 'deleted'];
const BI_H = ['id', 'list', 'text', 'done', 'star', 'color', 'last_color', 'wait_note', 'wait_since', 'created', 'updated', 'deleted'];
const BQ_H = ['sentence', 'commentary', 'source'];
const BL = col_(BL_H), BI = col_(BI_H);
const BOARD_DEFAULT_LISTS = ['טווח קצר', 'טווח ארוך', 'רעיונות'];
const BOARD_PURGE_DAYS = 30;
function col_(h) { const o = {}; h.forEach((k, i) => o[k] = i); return o; }

function boardOwner_() {
  try { const a = Session.getActiveUser().getEmail(); return !!a && a === Session.getEffectiveUser().getEmail(); }
  catch (e) { return false; }
}
function boardGuard_() { if (!boardOwner_()) throw new Error('not allowed'); }

// doGet (Print.js) calls this when the request has no URL secret.
function boardPage_() {
  if (!boardOwner_()) return HtmlService.createHtmlOutput('<p dir="rtl">אין גישה.</p>');
  return HtmlService.createHtmlOutputFromFile('BoardPage')
    .setTitle('הדף של פבלו')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

// ---------- read ----------
function boardGet() {
  boardGuard_();
  const lt = tab_('board_lists', BL_H), it = tab_('board_items', BI_H);
  let lrows = lt.getDataRange().getValues().slice(1).filter(r => r[BL.id]);
  if (!lrows.length) { // first open: the three paper lists
    BOARD_DEFAULT_LISTS.forEach((n, i) => lt.appendRow([bid_(), n, i, '', 'list', '']));
    lrows = lt.getDataRange().getValues().slice(1).filter(r => r[BL.id]);
  }
  const lists = lrows.filter(r => !r[BL.deleted]).sort((a, b) => a[BL.order] - b[BL.order])
    .map(r => ({ id: String(r[BL.id]), name: String(r[BL.name]), note: String(r[BL.note] || ''), kind: String(r[BL.kind] || 'list'), items: [] }));
  const byId = {}; lists.forEach(l => byId[l.id] = l);
  it.getDataRange().getValues().slice(1).forEach(r => {
    if (!r[BI.id] || r[BI.deleted] || !byId[r[BI.list]]) return;
    byId[r[BI.list]].items.push({
      id: String(r[BI.id]), t: String(r[BI.text]), done: r[BI.done] === true, star: r[BI.star] === true,
      c: String(r[BI.color] || ''), lastC: String(r[BI.last_color] || ''),
      wait: r[BI.wait_since] ? { note: String(r[BI.wait_note] || ''), since: dstr_(r[BI.wait_since]) } : null
    });
  });
  return { lists, cal: boardCal_(), quote: boardQuote_(), view: JSON.parse(prop('BOARD_VIEW') || '{}'), today: dstr_(new Date()) };
}

function boardCal_() {
  const tz = userTz(), now = new Date();
  const from = Utilities.parseDate(Utilities.formatDate(now, tz, 'yyyy-MM-dd') + ' 00:00', tz, 'yyyy-MM-dd HH:mm');
  return cal_().getEvents(from, new Date(from.getTime() + 8 * 864e5)).filter(e => !e.isAllDayEvent()).map(e => {
    const s = e.getStartTime(), st = e.getTag('state') === 'done' ? (e.getTag('board') ? 'task' : 'done') : '';
    return { id: e.getId(), at: s.getTime(), date: Utilities.formatDate(s, tz, 'yyyy-MM-dd'), time: Utilities.formatDate(s, tz, 'HH:mm'),
      t: e.getTitle().replace(/^✅\s*/, ''), st, to: e.getTag('board') || '', series: e.isRecurringEvent() };
  });
}

function boardQuote_() {
  const t = tab_('inspiration', BQ_H);
  let rows = t.getDataRange().getValues().slice(1).filter(r => r[0]);
  if (!rows.length) { t.getRange(2, 1, BOARD_QUOTES.length, 3).setValues(BOARD_QUOTES); rows = BOARD_QUOTES; }
  const day = Math.floor(Utilities.parseDate(dstr_(new Date()), HOME_TZ, 'yyyy-MM-dd').getTime() / 864e5);
  const r = rows[day % rows.length];
  return { s: String(r[0]), c: String(r[1]), src: String(r[2]) };
}

// ---------- write: one small operation per call, in the order the page sent them ----------
function boardOp(op) {
  boardGuard_();
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try { return boardDo_(op) || 'ok'; }
  catch (err) { log('board op error', op, String(err && err.stack || err)); throw err; }
  finally { lock.releaseLock(); }
}

function boardDo_(op) {
  const now = new Date();
  switch (op.t) {
    case 'item.add': {
      tab_('board_items', BI_H).appendRow([op.id, op.list, String(op.text).slice(0, 500), false, false, '', '', '', '', now, now, '']);
      return;
    }
    case 'item.set': { // fields: text, done, star, c, lastC, wait (null | {note, since}), list
      const f = op.f || {}, set = {};
      if ('text' in f) set.text = String(f.text).slice(0, 500);
      if ('done' in f) set.done = !!f.done;
      if ('star' in f) set.star = !!f.star;
      if ('c' in f) set.color = f.c || '';
      if ('lastC' in f) set.last_color = f.lastC || '';
      if ('list' in f) set.list = f.list;
      if ('wait' in f) { set.wait_note = f.wait ? f.wait.note || '' : ''; set.wait_since = f.wait ? f.wait.since : ''; }
      set.updated = now;
      return rowSet_('board_items', BI_H, op.id, set);
    }
    case 'item.del': return rowSet_('board_items', BI_H, op.id, { deleted: now });
    case 'list.clear': { // delete the done items of one list
      const t = tab_('board_items', BI_H), v = t.getDataRange().getValues();
      v.forEach((r, i) => { if (i && r[BI.list] === op.id && r[BI.done] === true && !r[BI.deleted]) t.getRange(i + 1, BI.deleted + 1).setValue(now); });
      return;
    }
    case 'list.add': {
      const t = tab_('board_lists', BL_H);
      const max = t.getDataRange().getValues().slice(1).reduce((m, r) => Math.max(m, Number(r[BL.order]) || 0), 0);
      t.appendRow([op.id, String(op.name).slice(0, 80), max + 1, '', 'list', '']);
      return;
    }
    case 'list.set': {
      const set = {};
      if ('name' in op) set.name = String(op.name).slice(0, 80);
      if ('note' in op) set.note = op.note || '';
      return rowSet_('board_lists', BL_H, op.id, set);
    }
    case 'list.del': return rowSet_('board_lists', BL_H, op.id, { deleted: now });
    case 'view.set': P.setProperty('BOARD_VIEW', JSON.stringify(op.view || {})); return;
    case 'rem.done': case 'rem.undo': case 'rem.cancel': case 'rem.move': case 'rem.tolist': return boardRem_(op);
  }
  throw new Error('unknown op ' + op.t);
}

function boardRem_(op) {
  const ev = findOcc_({ id: op.id, t: op.at }); // Reminders.js
  if (!ev) return 'gone';
  if (op.t === 'rem.cancel') { ev.deleteEvent(); return; } // a series occurrence: only this time
  if (op.t === 'rem.move') {
    const ns = Utilities.parseDate(op.date + ' ' + op.time, userTz(), 'yyyy-MM-dd HH:mm');
    if (isNaN(ns.getTime())) throw new Error('bad time');
    ev.setTime(ns, new Date(ns.getTime() + 15 * 60000));
    ev.setTag('alerted', '');
    return String(ns.getTime());
  }
  if (op.t === 'rem.undo') {
    ev.setTag('state', ''); ev.setTag('board', '');
    if (!ev.isRecurringEvent()) ev.setTitle(ev.getTitle().replace(/^✅\s*/, ''));
    return;
  }
  // done, or moved into a list (decided 27.11: the reminder is marked done, not deleted)
  if (op.t === 'rem.tolist') {
    tab_('board_items', BI_H).appendRow([op.item, op.list, ev.getTitle().replace(/^✅\s*/, ''), false, false, '', '', '', '', new Date(), new Date(), '']);
    ev.setTag('board', String(op.listName || '').slice(0, 80) || '-');
  }
  if (ev.getTag('state') !== 'done') {
    ev.setTag('state', 'done');
    if (!ev.isRecurringEvent()) ev.setTitle('✅ ' + ev.getTitle());
  }
}

// ---------- helpers ----------
function rowSet_(name, header, id, set) {
  const t = tab_(name, header), ids = t.getRange(1, 1, t.getLastRow(), 1).getValues();
  const i = ids.findIndex(r => String(r[0]) === String(id));
  if (i < 1) return 'gone';
  Object.keys(set).forEach(k => t.getRange(i + 1, header.indexOf(k) + 1).setValue(set[k]));
}
function bid_() { return Utilities.getUuid().slice(0, 12); }
function dstr_(d) { return d instanceof Date ? Utilities.formatDate(d, userTz(), 'yyyy-MM-dd') : String(d).slice(0, 10); }

// run from the editor (or a daily trigger) to drop rows deleted more than 30 days ago
function boardPurge() {
  const cut = Date.now() - BOARD_PURGE_DAYS * 864e5;
  [['board_items', BI_H, BI.deleted], ['board_lists', BL_H, BL.deleted]].forEach(([n, h, c]) => {
    const t = tab_(n, h), v = t.getDataRange().getValues();
    for (let i = v.length - 1; i >= 1; i--) if (v[i][c] && new Date(v[i][c]).getTime() < cut) t.deleteRow(i + 1);
  });
}

// Daily inspiration, seeded into the "inspiration" tab on first use; Pablo can edit or add rows there.
// Short passages from classical yoga texts in Claude's own Hebrew rendering, with a short commentary.
const BOARD_QUOTES = [
  ['יוגה היא השקטת התנודות של התודעה.', 'זו ההגדרה שפטנג׳לי פותח בה. התודעה דומה לאגם: כשהגלים נרגעים רואים את הקרקעית. התרגול בבוקר נותן לגלים לשקוע לפני שהיום מתחיל.', 'יוגה סוטרות של פטנג׳לי 1.2'],
  ['אז הרואה שוכן בטבעו האמיתי.', 'כשהתודעה שקטה, מה שנשאר הוא העד השקט שתמיד היה שם. לא צריך להשיג אותו, רק להפסיק לכסות עליו.', 'יוגה סוטרות של פטנג׳לי 1.3'],
  ['התנודות נרגעות בעזרת תרגול ואי-היאחזות.', 'אבהיאסה ווראגיה, שתי כנפיים של אותה ציפור. התרגול נותן כיוון, והשחרור מונע מהמאמץ להפוך למאבק.', 'יוגה סוטרות של פטנג׳לי 1.12'],
  ['התרגול נעשה יציב כשמתמידים בו זמן רב, בלי הפסקה ובמסירות.', 'שלושה תנאים: זמן, רציפות ויחס. עשר דקות כל יום בונות יותר משעתיים פעם בשבוע.', 'יוגה סוטרות של פטנג׳לי 1.14'],
  ['אמונה, כוח, זיכרון, ריכוז וחוכמה.', 'חמשת הכלים שפטנג׳לי מונה למי שמתקדם בדרך. אמונה פותחת, כוח מחזיק, זיכרון מחזיר אותנו לכוונה, והריכוז מוליד הבנה.', 'יוגה סוטרות של פטנג׳לי 1.20'],
  ['ידידות כלפי השמחים, חמלה כלפי הסובלים, שמחה עם הטובים ושוויון נפש כלפי הרעים.', 'ארבע עמדות לב שמנקות את התודעה. פטנג׳לי לא מבקש לשנות את האנשים סביבנו, רק את התגובה שלנו אליהם.', 'יוגה סוטרות של פטנג׳לי 1.33'],
  ['משמעת, לימוד עצמי והתמסרות הם יוגה של פעולה.', 'טפס, סוואדהיאיה ואישוורה פרנידהנה. להתאמץ, להכיר את עצמך ולהניח את התוצאה בידיים גדולות ממך.', 'יוגה סוטרות של פטנג׳לי 2.1'],
  ['את הסבל שעוד לא בא אפשר למנוע.', 'את מה שכבר קרה אי אפשר לשנות, אבל אפשר לשים לב עכשיו. רוב התרגול הוא מניעה עדינה, לא תיקון.', 'יוגה סוטרות של פטנג׳לי 2.16'],
  ['כשמחשבות מטרידות עולות, טפח את ההפך שלהן.', 'פרטיפקשה בהוונה. לא נלחמים במחשבה ולא מדחיקים אותה, אלא נותנים מקום לכיוון ההפוך: לכעס מול סבלנות, לדאגה מול אמון.', 'יוגה סוטרות של פטנג׳לי 2.33'],
  ['במי שאי-אלימות מושרשת בו, העוינות סביבו נעלמת.', 'אהימסה מתחילה במחשבה ובדיבור. אנשים מרגישים מתי לא מאיימים עליהם, ומתרככים בעצמם.', 'יוגה סוטרות של פטנג׳לי 2.35'],
  ['מן הסתפקות במה שיש באה שמחה עליונה.', 'סנטושה איננה ויתור על שאיפות. היא היכולת ליהנות ממה שכבר כאן, בזמן שממשיכים ללכת.', 'יוגה סוטרות של פטנג׳לי 2.42'],
  ['התנוחה צריכה להיות יציבה ונוחה.', 'סטהירה וסוקהה: יציבות וקלות יחד. אם יש רק מאמץ, הגוף נלחם. אם יש רק נוחות, אין נוכחות.', 'יוגה סוטרות של פטנג׳לי 2.46'],
  ['התנוחה מושלמת כשהמאמץ מתרכך והתודעה פוגשת את האינסופי.', 'הרגע שבו מפסיקים "לעשות" את התנוחה ומתחילים לשהות בה. זה קורה דרך הנשימה, לא דרך הכוח.', 'יוגה סוטרות של פטנג׳לי 2.47'],
  ['כשהנשימה נודדת, גם התודעה נודדת. כשהנשימה שקטה, גם התודעה שקטה.', 'הנשימה היא הגשר הזמין ביותר לתודעה. כמה נשימות איטיות לפני משימה קשה משנות את איכות העבודה.', 'הטהה יוגה פרדיפיקה 2.2'],
  ['ההצלחה באה מתרגול, לא מקריאה בספרים.', 'צעיר או זקן, חולה או חלש, מי שמתרגל מתקדם. הידע חשוב, אבל רק הגוף והנשימה הופכים אותו לשלך.', 'הטהה יוגה פרדיפיקה 1.64–66'],
  ['יש לך זכות לפעולה, אבל לא לפירותיה.', 'קרישנה אומר לארג׳ונה לעשות את חלקו במלואו ולשחרר את התוצאה. כשהתוצאה לא מחזיקה אותנו, אפשר לפעול בשקט ובלב שלם.', 'בהגוד גיטה 2.47'],
  ['יוגה היא שוויון נפש.', 'סמטבם. להישאר באותו מקום פנימי בהצלחה ובכישלון, בשבח ובביקורת. לא קל, ולכן זה תרגול של כל החיים.', 'בהגוד גיטה 2.48'],
  ['יוגה היא מיומנות בפעולה.', 'יוגה כרמסו קאושלם. לא רק על המזרן: לעשות כל דבר בתשומת לב מלאה, בלי פיזור ובלי היאחזות.', 'בהגוד גיטה 2.50'],
  ['מגע החושים מביא חום וקור, הנאה וכאב. הם באים והולכים, שאת אותם בסבלנות.', 'כל תחושה זמנית. כשזוכרים את זה, אפשר לעבור דרך אי-נוחות בלי להיבהל ממנה.', 'בהגוד גיטה 2.14'],
  ['ירומם אדם את עצמו בעצמו. העצמי הוא ידידו של אדם, והעצמי הוא גם אויבו.', 'אף אחד לא יעשה את התרגול במקומנו. אותה תודעה שמפילה יכולה גם להרים.', 'בהגוד גיטה 6.5'],
  ['יוגה איננה למי שאוכל יותר מדי או פחות מדי, ישן יותר מדי או ער יותר מדי.', 'הגיטה מציעה את דרך האמצע: מידה בכל דבר. האיזון הקטן של היומיום הוא הבסיס לשקט הגדול.', 'בהגוד גיטה 6.16–17'],
  ['כמו מנורה במקום שאין בו רוח, שהלהבה שלה לא מרצדת.', 'כך מתוארת התודעה של המתרגל בריכוז. לא כוח שמחזיק את הלהבה, אלא היעדר רוח שמזיזה אותה.', 'בהגוד גיטה 6.19'],
  ['התודעה אכן חסרת מנוחה, אבל בתרגול ובאי-היאחזות אפשר לרסן אותה.', 'גם ארג׳ונה התלונן שהתודעה קשה לאילוף כמו הרוח. התשובה היא אותה תשובה של פטנג׳לי: תרגול ושחרור.', 'בהגוד גיטה 6.35'],
  ['טוב לאדם הדרך שלו, גם אם אינה מושלמת, מדרכו של אחר שנעשית היטב.', 'סוואדהרמה. להשוות את עצמך לאחרים מרחיק אותך מהדבר שרק אתה יכול לעשות.', 'בהגוד גיטה 3.35'],
  ['דע שהעצמי הוא הנוסע, הגוף הוא המרכבה, השכל הוא הרכב והתודעה היא המושכות.', 'משל המרכבה. החושים הם הסוסים, וכשהשכל ער והמושכות בידו, הנסיעה בטוחה.', 'קטהה אופנישד 1.3.3–4'],
  ['קום, התעורר, לך אל החכמים ולמד. הדרך חדה כלהב התער.', 'האופנישד לא מבטיח דרך קלה. הוא מבטיח שהיא אפשרית למי שמתעורר אליה.', 'קטהה אופנישד 1.3.14'],
  ['כל זה שרוי באלוהי. תיהנה בוויתור, ואל תחמוד את רכושו של איש.', 'הפסוק הראשון של האישה אופנישד. הנאה אמיתית באה כשלא מחזיקים חזק מדי.', 'אישה אופנישד 1'],
  ['שתי ציפורים יושבות על אותו עץ. אחת אוכלת את הפירות, והשנייה מתבוננת.', 'שני חלקים בנו: זה שחווה ומגיב, וזה שרק רואה. התרגול מחזק את הציפור המתבוננת.', 'מונדקה אופנישד 3.1.1'],
  ['הובל אותי מן הלא-אמיתי אל האמיתי, מן החושך אל האור, מן המוות אל האלמוות.', 'אחת התפילות העתיקות ביותר. אפשר לומר אותה כבקשה פשוטה לבהירות לפני שהיום מתחיל.', 'בריהדארניאקה אופנישד 1.3.28'],
  ['מן האושר נולדים כל היצורים, באושר הם חיים, ואל האושר הם שבים.', 'האופנישד מציע שהשמחה איננה פרס בסוף הדרך אלא החומר שממנו היא עשויה.', 'טאיטיריה אופנישד 3.6']
];
