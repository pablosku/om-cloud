// ===== Office Manager Cloud: reminders =====
// Moved out of Code.js as is (no behavior change). Code.js keeps the core: doPost/inbox/handle/onButton/tick,
// Telegram, Gemini, storage. Apps Script shares one global scope, so these functions are called from Code.js unchanged.

// ---------- understanding a reminder ----------
// a plain time -> 'yyyy-MM-dd HH:mm' (user time zone), or '' when it is not just a time.
// "13:15", "ב-13:15", "היום 13:15", "מחר ב-9", "ל-17:10", "תדחה ל17:10", "בעוד 20 דקות", "בעוד שעה", "בעוד חצי שעה", "בעוד שעתיים"
function quickWhen_(text, now) {
  now = now || new Date();
  const tz = userTz();
  const s = String(text || '').trim().replace(/[.!?]+$/, '').replace(/^(תדחה|דחה|תזיז|הזז|תעביר)\s*/, '').trim();
  let m = s.match(/^בעוד\s*(חצי שעה|שעתיים|שעה|רבע שעה|(\d{1,3})\s*(דקות|דק׳|דק'|דק|שעות|שעה))$/);
  if (m) {
    const min = { 'חצי שעה': 30, 'שעתיים': 120, 'שעה': 60, 'רבע שעה': 15 }[m[1]] || Number(m[2]) * (/^ש/.test(m[3]) ? 60 : 1);
    return Utilities.formatDate(new Date(Math.ceil((now.getTime() + min * 60000) / 60000) * 60000), tz, 'yyyy-MM-dd HH:mm');
  }
  m = s.match(/^(?:(היום|מחר)\s*)?(?:ב|ל)?\s*-?\s*(\d{1,2})(?:[:.](\d{2}))?\s*(היום|מחר)?$/);
  if (!m) return '';
  let h = Number(m[2]);
  const min = Number(m[3] || 0), dayWord = m[1] || m[4] || '';
  if (h > 23 || min > 59) return '';
  if (!m[3] && h >= 1 && h <= 6) h += 12; // a bare "ב-3" = 15:00, as in parse()
  const day = off => Utilities.formatDate(new Date(now.getTime() + off * 864e5), tz, 'yyyy-MM-dd');
  const hm = String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
  let when = (dayWord === 'מחר' ? day(1) : day(0)) + ' ' + hm;
  if (!dayWord && Utilities.parseDate(when, tz, 'yyyy-MM-dd HH:mm').getTime() <= now.getTime()) when = day(1) + ' ' + hm; // passed today = tomorrow
  return when;
}

// "כל חודשיים" / "כל 3 שבועות" / "כל חצי שנה" -> {repeat, every}; null when the text has no interval
const UNITS_ = [['יום', 'ימים', 'יומיים', 'daily'], ['שבוע', 'שבועות', 'שבועיים', 'weekly'], ['חודש', 'חודשים', 'חודשיים', 'monthly'], ['שנה', 'שנים', 'שנתיים', 'yearly']];
function interval_(s) {
  s = String(s || '');
  if (/כל\s+חצי\s+שנה/.test(s)) return { repeat: 'monthly', every: 6 };
  if (/כל\s+רבעון/.test(s)) return { repeat: 'monthly', every: 3 };
  for (const [one, many, two, rep] of UNITS_) {
    if (new RegExp('כל\\s+' + two + '(?![א-ת])').test(s)) return { repeat: rep, every: 2 };
    const m = s.match(new RegExp('כל\\s+(\\d{1,2})\\s*(?:' + many + '|' + one + ')(?![א-ת])'));
    if (m && Number(m[1]) >= 2) return { repeat: rep, every: Number(m[1]) };
  }
  return null;
}
const repLabel_ = (rep, n) => {
  const u = UNITS_.find(x => x[3] === rep);
  return !u || !(n > 1) ? REP[rep] : 'כל ' + (n === 2 ? u[2] : n + ' ' + u[1]);
};

// Gemini slips, fixed after parse():
// 1. "תזכיר לי ב15 ..." read as the 15th of the month at 09:00 -> 15:00 today (or tomorrow if it passed)
// 2. a prefix letter cut off the first word of the text ("לקנות חלב" -> "קנות חלב") -> put back as written
function fixParse_(text, at, p) {
  if (!p || p.intent !== 'reminder') return p;
  const s = String(text || '');
  const iv = interval_(s); // 3. "כל חודשיים" read as every month -> the interval comes from the words themselves
  if (iv && (p.repeat !== iv.repeat || Number(p.every || 1) !== iv.every)) { log('fixParse every', s.slice(0, 100), p.repeat, p.every, '->', iv); p.repeat = iv.repeat; p.every = iv.every; }
  const m = s.match(/(?:^|\s)ב\s*-?\s*(\d{1,2})(?![\d.\/:])/);
  const hasDate = /\d{1,2}\s*[.\/]\s*\d{1,2}|ינואר|פברואר|מרץ|מרס|אפריל|מאי|יוני|יולי|אוגוסט|ספטמבר|אוקטובר|נובמבר|דצמבר|לחודש|בחודש/.test(s);
  const d = String(p.when || '').match(/^(\d{4}-\d\d-(\d\d)) (\d\d:\d\d)$/);
  if (m && !hasDate && d && Number(d[2]) === Number(m[1]) && d[3] === '09:00') {
    const tz = userTz(), near = [0, 1].map(o => Utilities.formatDate(new Date(at.getTime() + o * 864e5), tz, 'yyyy-MM-dd'));
    const q = near.indexOf(d[1]) < 0 && quickWhen_((/מחר/.test(s) ? 'מחר ' : '') + 'ב' + m[1], at);
    if (q) { log('fixParse hour', s.slice(0, 100), p.when, '->', q); p.when = q; }
  }
  if (p.text) {
    const words = s.split(/[\s,.!?:;"״]+/).filter(String);
    const parts = String(p.text).split(/(\s+)/), first = parts[0];
    if (first && words.indexOf(first) < 0) {
      const full = words.find(w => w.length === first.length + 1 && 'לבהוש'.indexOf(w[0]) >= 0 && w.slice(1) === first);
      if (full) { parts[0] = full; p.text = parts.join(''); log('fixParse prefix', first, '->', full); }
    }
  }
  return p;
}

function parse(text, at, prev) {
  const tz = userTz();
  const now = Utilities.formatDate(at, tz, 'yyyy-MM-dd HH:mm EEEE');
  const prompt = `You parse Hebrew reminder requests for an Israeli user. Current local time: ${now} (${tz}).
Week starts Sunday. "workdays" = Sunday to Thursday. "ביום רביעי הבא" = the next Wednesday after today.
Defaults: בבוקר=09:00, בצהריים=13:00, אחה"צ=16:00, בערב=19:00, בלילה=22:00, a date without a time=09:00.
A bare hour without בבוקר/בערב: 7-12 = morning (ב8 = 08:00), 1-6 = afternoon (ב3 = 15:00).
A bare number after ב (ב15, ב-15, ב 15) is always an hour (ב15 = 15:00), never a day of the month. A date needs a month (15.12, 15/12, 15 בדצמבר) or the word לחודש.
The text keeps the user's words exactly as written, prefix letters included ("לקנות חלב" stays "לקנות חלב", never "קנות חלב").
A time of day that already passed today, without a date, means tomorrow.
The message may have several lines (voice typing). Usually the first line says when, and the next lines are what to remind.
Keep the full content of those lines as the text, even when it is a long list or looks odd. Never drop content.
Answer JSON only:
{"intent":"reminder"|"list"|"other",
 "text": Hebrew description of what to remind, without the time words, or null if missing,
 "when": "YYYY-MM-DD HH:MM" local time or null,
 "repeat": null|"daily"|"weekly"|"monthly"|"yearly"|"workdays",
 "every": how many days/weeks/months/years between repeats, 1 unless he says otherwise (כל יומיים=2 daily, כל שבועיים=2 weekly, כל חודשיים=2 monthly, כל 3 חודשים=3 monthly, כל חצי שנה=6 monthly, כל שנה=1 yearly),
 "from", "to": for intent "list" only, "YYYY-MM-DD" first and last day asked about (one day: same date), else null,
 "search": for intent "list" only, when he asks about a topic: array of short Hebrew keywords and synonyms that may appear in the title (e.g. ["שכירות","שכר דירה","שכ\"ד"]), else null,
 "question": short Hebrew question asking only for what is missing (what, or when), else null}
"list" = the user asks about his existing reminders: what he has, on a date or in a range ("תזכורות ב-15.12", "מה יש לי השבוע"), or whether a reminder about something already exists ("יש כבר תזכורת על שכירות?"). A question is never a new reminder. A request to postpone to a time (like "תדחה ל17:10", "דחה למחר ב-9", "בעוד 20 דקות") is intent "reminder" with that "when" and text null.
A message that is only a time (like "ב-17:30") is intent "reminder" with text null.
You only read the message. You cannot save or do anything, so the question must never say that something was saved or done.
${prev ? `The user is answering my question about his earlier message. Combine both into one reminder.
If the follow-up is a new, complete request on its own, ignore the earlier message.
Earlier message: ${prev}
Follow-up message: ${text}` : `Message: ${text}`}`;
  return gemini_([{ text: prompt }]);
}

// ---------- calendar ----------
function recurrence_(rep, n) {
  const r = CalendarApp.newRecurrence(), W = CalendarApp.Weekday;
  if (rep === 'workdays') { r.addWeeklyRule().onlyOnWeekdays([W.SUNDAY, W.MONDAY, W.TUESDAY, W.WEDNESDAY, W.THURSDAY]); return r; }
  const rule = rep === 'daily' ? r.addDailyRule() : rep === 'weekly' ? r.addWeeklyRule() : rep === 'monthly' ? r.addMonthlyRule() : r.addYearlyRule();
  if (n > 1) rule.interval(n); // every 2 months etc.
  return r;
}

function create(p) {
  p.text = String(p.text).trim().replace(/\s*\n+\s*/g, ' · '); // one-line event title
  const rep = REP[p.repeat] ? p.repeat : null;
  const every = rep && rep !== 'workdays' ? Math.min(Math.max(Math.round(Number(p.every) || 1), 1), 99) : 1;
  const start = Utilities.parseDate(p.when, rep ? HOME_TZ : userTz(), 'yyyy-MM-dd HH:mm'); // series live in Israel time
  if (isNaN(start.getTime())) return send('לא הבנתי את הזמן. תנסח שוב?');
  if (!rep && start.getTime() < Date.now() - 60000) return send(fmt(start) + ' כבר עבר. תנסח שוב?');
  const end = new Date(start.getTime() + 15 * 60000);
  const ev = rep ? cal_().createEventSeries(p.text, start, end, recurrence_(rep, every)) : cal_().createEvent(p.text, start, end);
  const k = key_({ id: ev.getId(), t: start.getTime(), s: rep ? 1 : 0 });
  const r = send('⏰ ' + p.text + '\n' + fmt(start) + (rep ? ' · ' + repLabel_(rep, every) : ''), [[{ text: 'בטל', callback_data: 'x:' + k }]]);
  if (r.ok) P.setProperty('m_' + r.result.message_id, k); // reply "תדחה ל..." to this message = move it
}

function findOcc_(o) {
  return cal_().getEvents(new Date(o.t - 60000), new Date(o.t + 60000))
    .find(e => e.getId() === o.id && e.getStartTime().getTime() === o.t) || null;
}

function moveTo(k, when) {
  const o = unkey_(k), ev = o && findOcc_(o);
  if (!ev) return send('לא מצאתי את התזכורת, אולי כבר טופלה.');
  const ns = Utilities.parseDate(when, userTz(), 'yyyy-MM-dd HH:mm');
  if (isNaN(ns.getTime()) || ns.getTime() < Date.now()) return send('הזמן לא תקין או כבר עבר.');
  ev.setTime(ns, new Date(ns.getTime() + 15 * 60000));
  ev.setTag('alerted', '');
  o.t = ns.getTime(); rekey_(k, o);
  send('💤 ' + ev.getTitle() + '\nנדחה ל' + fmt(ns));
}

// ---------- questions about reminders ----------
// answer to "what do I have on 15.12" / "is there a reminder about rent": date range and/or title keywords, series included
function queryText(p) {
  const tz = userTz(), day = s => Utilities.parseDate(String(s) + ' 00:00', tz, 'yyyy-MM-dd HH:mm');
  const words = (Array.isArray(p.search) ? p.search : []).map(w => String(w).trim()).filter(String);
  if (!p.from && !words.length) return listText(7);
  let from = p.from ? day(p.from) : new Date(Date.now() - 864e5);
  let to = p.from ? new Date(day(p.to || p.from).getTime() + 864e5) : new Date(Date.now() + 400 * 864e5);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || to <= from) return 'לא הבנתי את התאריכים. תנסח שוב?';
  if (to - from > 400 * 864e5) to = new Date(from.getTime() + 400 * 864e5);
  const seen = {};
  const evs = cal_().getEvents(from, to).filter(e => !e.isAllDayEvent())
    .filter(e => !words.length || words.some(w => e.getTitle().includes(w)))
    .filter(e => p.from || !e.isRecurringEvent() || (!seen[e.getId()] && (seen[e.getId()] = 1))); // a search shows a series once
  const dm = s => Utilities.formatDate(day(s), tz, 'd.M.yy');
  const where = (words.length ? ' על "' + words.join('" / "') + '"' : '') +
    (p.from ? ' ב-' + dm(p.from) + (p.to && p.to !== p.from ? '–' + dm(p.to) : '') : ' בשנה הקרובה');
  if (!evs.length) return '🔍 אין תזכורות' + where + '.';
  const lines = evs.slice(0, 30).map(e => (e.getTag('state') === 'done' ? '✅ ' : '• ') + fmt(e.getStartTime()) + '  ' + e.getTitle() + (e.isRecurringEvent() ? ' 🔁' : ''));
  return '🔍 תזכורות' + where + ':\n' + lines.join('\n') + (evs.length > 30 ? '\nועוד ' + (evs.length - 30) + '…' : '');
}

function listText(days) {
  const now = Date.now();
  const evs = cal_().getEvents(new Date(now - 2 * 864e5), new Date(now + days * 864e5))
    .filter(e => !e.isAllDayEvent() && e.getTag('state') !== 'done');
  if (!evs.length) return 'אין תזכורות פתוחות ב-' + days + ' הימים הקרובים.';
  return evs.map(e => (e.getStartTime().getTime() < now ? '⚠️ ' : '• ') + fmt(e.getStartTime()) + '  ' + e.getTitle()).join('\n');
}

// ---------- every minute (called from tick) ----------
function alerts() {
  const now = Date.now();
  const nagMin = Number(prop('NAG_MIN') || 10), nagMax = Number(prop('NAG_MAX') || 3);
  cal_().getEvents(new Date(now - 2 * 864e5), new Date(now + 30000)).forEach(ev => {
    const t = ev.getStartTime().getTime();
    if (t > now + 30000 || ev.isAllDayEvent() || ev.getTag('state') === 'done') return;
    const [at, cnt, last] = String(ev.getTag('alerted') || '').split('|');
    let n = 0;
    if (at === String(t)) {
      if (!nagMin || Number(cnt) >= nagMax || now - Number(last) < nagMin * 60000) return;
      n = Number(cnt) + 1;
    }
    const k = key_({ id: ev.getId(), t, s: ev.isRecurringEvent() ? 1 : 0 });
    const late = !n && now - t > 5 * 60000 ? '\n(באיחור, היה ל' + fmt(new Date(t)) + ')' : '';
    const r = send((n ? '🔔 שוב: ' : '⏰ ') + ev.getTitle() + late, alertKb(k));
    if (r.ok) P.setProperty('m_' + r.result.message_id, k);
    ev.setTag('alerted', [t, n, now].join('|'));
  });
}
