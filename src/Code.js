// ===== Office Manager Cloud: stage 1, reminders =====
// Stage 2 (print queue) lives in Print.gs: doGet, printAdd, printButton, printTick, queueText.
// Flow: Telegram -> Cloudflare Worker -> doPost (must answer "ok") -> inbox sheet -> Gemini -> Calendar.
// A 1-minute trigger (tick) sends alerts, retries Gemini when it was busy, nags, and sends the morning summary.
// Script Properties: TG_TOKEN, ALLOWED_USER_ID, CALENDAR_ID, GEMINI_KEY, URL_SECRET, TG_SECRET, WORKER_URL
// Optional: GEMINI_MODELS (default "gemini-flash-lite-latest,gemini-flash-latest"),
//           NAG_MIN (default 10, 0 = off), NAG_MAX (default 3), MORNING_AT (default 04:30), USER_TZ (set by /tz)

const P = PropertiesService.getScriptProperties();
const prop = k => P.getProperty(k);
const HOME_TZ = 'Asia/Jerusalem';
const DAYS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
const REP = { daily: 'כל יום', weekly: 'כל שבוע', monthly: 'כל חודש', workdays: 'א׳–ה׳' };
const INBOX_H = ['time', 'msg_id', 'text', 'status', 'tries'];
const VOICE = '🎤voice:'; // inbox text of a voice message not transcribed yet: VOICE + file_id|mime
const userTz = () => prop('USER_TZ') || HOME_TZ;
const models = () => (prop('GEMINI_MODELS') || 'gemini-flash-lite-latest,gemini-flash-latest').split(',').map(s => s.trim()).filter(String);
const out_ = s => ContentService.createTextOutput(s);
const cal_ = () => CalendarApp.getCalendarById(prop('CALENDAR_ID'));
const RETORNO_RE = /^(דוחות |דו״חות |דוח |דו״ח |צור |תכין )?(ה)?רטורנו|(דוחות|דו״חות|דוח|דו״ח) (ה)?רטורנו/;
const KLINKA_RE = /^(סיכום |דוח |דו״ח |שעות )?(ה)?קליניק|(שעות|סיכום|דוח|דו״ח) (ה)?קליניק/;

// ---------- storage ----------
function ss_() {
  let id = prop('DB_SHEET_ID');
  if (!id) { id = SpreadsheetApp.create('secretary db').getId(); P.setProperty('DB_SHEET_ID', id); }
  return SpreadsheetApp.openById(id);
}
function tab_(name, header) {
  const s = ss_();
  let t = s.getSheetByName(name);
  if (!t) { t = s.insertSheet(name); t.appendRow(header); }
  return t;
}
function log(...a) {
  try { tab_('log', ['time', 'what']).appendRow([new Date(), ...a.map(x => typeof x === 'string' ? x : JSON.stringify(x))]); } catch (e) {}
}
// callback_data is limited to 64 bytes, so buttons carry a short key that points to {id, t, s}
function key_(o) {
  const k = Utilities.getUuid().slice(0, 8);
  P.setProperty('k_' + k, JSON.stringify(Object.assign({ c: Date.now() }, o)));
  return k;
}
function unkey_(k) { const v = prop('k_' + k); return v ? JSON.parse(v) : null; }
function rekey_(k, o) { P.setProperty('k_' + k, JSON.stringify(o)); }

// ---------- Telegram ----------
function tg(method, payload) {
  const r = UrlFetchApp.fetch('https://api.telegram.org/bot' + prop('TG_TOKEN') + '/' + method,
    { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
  const j = JSON.parse(r.getContentText());
  if (!j.ok) log('tg error', method, j.description);
  return j;
}
function send(text, kb) {
  return tg('sendMessage', { chat_id: prop('ALLOWED_USER_ID'), text, reply_markup: kb ? { inline_keyboard: kb } : undefined });
}
const alertKb = k => [
  [{ text: '10 דק׳', callback_data: 's:' + k + ':10' }, { text: '30 דק׳', callback_data: 's:' + k + ':30' }, { text: 'שעה', callback_data: 's:' + k + ':60' }],
  [{ text: 'מחר', callback_data: 's:' + k + ':1440' }, { text: '🕐 שעה אחרת', callback_data: 'o:' + k }, { text: '✅ בוצע', callback_data: 'd:' + k }]];

function fmt(d) {
  const tz = userTz();
  const day = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
  const hm = Utilities.formatDate(d, tz, 'HH:mm');
  const away = tz === HOME_TZ ? '' : ' (' + tz + ')';
  if (day === Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd')) return 'היום ' + hm + away;
  if (day === Utilities.formatDate(new Date(Date.now() + 864e5), tz, 'yyyy-MM-dd')) return 'מחר ' + hm + away;
  const dow = Number(Utilities.formatDate(d, tz, 'u')) % 7; // u: 1=Mon..7=Sun
  return 'יום ' + DAYS[dow] + ' ' + Utilities.formatDate(d, tz, 'd.M') + ' ' + hm + away;
}

// ---------- incoming ----------
function doPost(e) {
  if ((e.parameter || {}).s !== prop('URL_SECRET')) return out_('no');
  const u = JSON.parse(e.postData.contents);
  const c = CacheService.getScriptCache();
  if (c.get('u' + u.update_id)) return out_('ok'); // Telegram resend
  c.put('u' + u.update_id, '1', 21600);
  try {
    if (u.callback_query) onButton(u.callback_query);
    else if (u.message) onMessage(u.message);
  } catch (err) { log('doPost error', String(err && err.stack || err)); }
  return out_('ok'); // the text is already in the inbox, so tick() retries anything that failed
}

function onMessage(m) {
  if (String(m.from.id) !== prop('ALLOWED_USER_ID')) return;
  if (m.document) return printAdd(m); // Print.gs
  const a = m.voice || m.audio;
  if (a) {
    if (a.file_size > 19e6) return send('ההקלטה ארוכה מדי. אפשר עד כ-20MB, או לשלוח טקסט.');
    tg('sendChatAction', { chat_id: m.chat.id, action: 'typing' });
    const row = inboxAdd(new Date(m.date * 1000), m.message_id, VOICE + a.file_id + '|' + (a.mime_type || 'audio/ogg'), m.reply_to_message ? m.reply_to_message.message_id : '');
    return handle(row, true); // transcribed in handle(), so a busy Gemini is retried by tick() like text
  }
  const text = (m.text || '').trim();
  if (!text) return send('כרגע אני מבין טקסט, הודעות קוליות ו-PDF להדפסה.');
  if (text.startsWith('/')) return command(text);
  if (/כרטיסי{1,2}ה|כרטיסיות/.test(text)) return cardCmd(text); // Reports.gs
  if (KLINKA_RE.test(text)) return klinkaCmd(text); // Reports.gs
  if (RETORNO_RE.test(text)) return retornoCmd(text); // Reports.gs
  tg('sendChatAction', { chat_id: m.chat.id, action: 'typing' }); // instant sign that the message arrived
  const row = inboxAdd(new Date(m.date * 1000), m.message_id, text, m.reply_to_message ? m.reply_to_message.message_id : '');
  handle(row, true);
}

function inboxAdd(time, msgId, text, replyTo) {
  // no script lock here: tick() may hold it for minutes while Gemini is slow, and the text must be saved now
  const t = tab_('inbox', INBOX_H.concat('reply_to'));
  t.appendRow([time, msgId, text, 'working', 0, replyTo]);
  const last = t.getLastRow(), from = Math.max(2, last - 9);
  const ids = t.getRange(from, 2, last - from + 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === String(msgId)) return from + i;
  return last;
}

function handle(row, live) {
  const t = tab_('inbox', INBOX_H.concat('reply_to'));
  const [time, , raw, , tries, replyTo] = t.getRange(row, 1, 1, 6).getValues()[0];
  t.getRange(row, 5).setValue(Number(tries || 0) + 1);
  const busy = () => {
    t.getRange(row, 4).setValue('new');
    P.setProperty('INBOX_PENDING', '1');
    if (live) send('קיבלתי ✍️ גוגל עמוס כרגע, אפענח בדקות הקרובות.');
    if (Number(tries) + 1 >= 20) { t.getRange(row, 4).setValue('failed'); send('לא הצלחתי לפענח: "' + (voice ? 'הודעה קולית' : text) + '". תנסח שוב?'); }
  };
  const voice = String(raw).startsWith(VOICE);
  let text = raw;
  if (voice) {
    const tr = transcribe_(String(raw).slice(VOICE.length));
    if (tr === null) return busy();
    if (!tr) { t.getRange(row, 4).setValue('done'); return send('🎤 לא שמעתי מילים בהקלטה. תנסה שוב?'); }
    text = tr;
    t.getRange(row, 3).setValue('🎤 ' + tr); // the inbox keeps what was understood
    send('🎤 שמעתי: ' + tr);
    // a spoken report request goes where the typed one goes
    if (/כרטיסי{1,2}ה|כרטיסיות/.test(tr)) { t.getRange(row, 4).setValue('done'); return cardCmd(tr); } // Reports.gs
    if (KLINKA_RE.test(tr)) { t.getRange(row, 4).setValue('done'); return klinkaCmd(tr); }
    if (RETORNO_RE.test(tr)) { t.getRange(row, 4).setValue('done'); return retornoCmd(tr); }
  }
  // a reply to an alert / "⏰" confirmation / "🕐 שעה אחרת" question = new time for that reminder.
  // A plain time ("13:15", "היום 13:15", "מחר ב-9", "בעוד 20 דקות") is read here, without Gemini.
  const ask = JSON.parse(prop('SNOOZE_ASK') || 'null');
  const replyKey = (replyTo && prop('m_' + replyTo)) || '';
  const askKey = ask && new Date(time).getTime() - ask.at < 10 * 60000 ? ask.k : '';
  const quick = (replyKey || askKey) && quickWhen_(text);
  if (quick) {
    t.getRange(row, 4).setValue('done');
    P.deleteProperty('SNOOZE_ASK'); P.deleteProperty('PENDING');
    return moveTo(replyKey || askKey, quick);
  }
  // a reply to an email / file summary = another question about it (Mail.gs)
  if (mailFollowUp(replyTo, text)) { t.getRange(row, 4).setValue('done'); return; }
  // clinic calendar: add / delete / move / show a booking (Clinic.gs). false = not about the clinic, go on as a reminder
  const kp = JSON.parse(prop('CLINIC_PENDING') || 'null');
  const kprev = kp && new Date(time).getTime() - kp.at < 30 * 60000 ? kp.text : '';
  if (CLINIC_RE.test(text) || kprev) {
    const r = clinicHandle(text, new Date(time), kprev);
    if (r === null) return busy();
    if (r) { t.getRange(row, 4).setValue('done'); return; }
  }
  // find an email or a document / ask about one (Mail.gs). false = not a search, go on as a reminder
  if (MAIL_RE.test(text)) {
    const r = mailHandle(text, new Date(time));
    if (r === null) return busy();
    if (r) { t.getRange(row, 4).setValue('done'); return; }
  }
  // a follow-up to my question: read it together with the earlier message (kept for 30 min)
  const pend = JSON.parse(prop('PENDING') || 'null');
  const prev = pend && new Date(time).getTime() - pend.at < 30 * 60000 && pend.row !== row ? pend.text : '';
  const p = parse(text, new Date(time), replyKey || askKey ? '' : prev); // an answer about a reminder is not a follow-up
  if (!p) return busy();
  fixParse_(text, new Date(time), p);
  t.getRange(row, 4).setValue('done');
  if (p.intent === 'list') { P.deleteProperty('PENDING'); return send(queryText(p)); }
  // a reply to an alert or to a "⏰" confirmation, or the answer to "🕐 שעה אחרת" = new time for that reminder
  const target = replyKey || (!p.text ? askKey : ''); // a full new reminder is not an answer
  if (target) {
    if (p.when) { P.deleteProperty('SNOOZE_ASK'); P.deleteProperty('PENDING'); return moveTo(target, p.when); }
    // not understood: keep waiting for the time (SNOOZE_ASK stays), so the next message still moves this reminder
    P.setProperty('SNOOZE_ASK', JSON.stringify({ k: target, at: Date.now() }));
    log('snooze not understood', String(text).slice(0, 100), p);
    return send('❓ לא דחיתי. לאיזו שעה? למשל: 17:10, מחר ב-9, בעוד 20 דקות');
  }
  // multi-line message: line 1 = when, the rest = what (also when Gemini lost the text)
  const lines = String(text).split(/\n+/).map(s => s.trim()).filter(String);
  if (p.when && !p.text && lines.length > 1) { p.intent = 'reminder'; p.text = lines.slice(1).join('\n'); }
  if (p.intent !== 'reminder' || !p.when || !p.text) {
    log('not a reminder', String(text).slice(0, 200), prev ? 'prev: ' + prev.slice(0, 200) : '', p);
    P.setProperty('PENDING', JSON.stringify({ text: (prev ? prev + '\n' : '') + text, at: new Date(time).getTime(), row }));
    return send('❓ לא יצרתי תזכורת. ' + (p.question || 'על מה ומתי להזכיר?'));
  }
  P.deleteProperty('PENDING');
  try { create(p); }
  catch (e) { log('create error', String(e && e.stack || e)); send('⚠️ לא הצלחתי לשמור ביומן: "' + p.text + '". תשלח שוב?'); }
}

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

// two Gemini slips, fixed after parse():
// 1. "תזכיר לי ב15 ..." read as the 15th of the month at 09:00 -> 15:00 today (or tomorrow if it passed)
// 2. a prefix letter cut off the first word of the text ("לקנות חלב" -> "קנות חלב") -> put back as written
function fixParse_(text, at, p) {
  if (!p || p.intent !== 'reminder') return p;
  const s = String(text || '');
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

// ---------- brain ----------
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
 "repeat": null|"daily"|"weekly"|"monthly"|"workdays",
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

// Hebrew voice message -> text. null = try again later (Gemini or Telegram busy), '' = no speech
function transcribe_(ref) {
  const [fileId, mime] = ref.split('|');
  const f = tg('getFile', { file_id: fileId });
  if (!f.ok) return null;
  let audio;
  try { audio = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + prop('TG_TOKEN') + '/' + f.result.file_path).getBlob().getBytes(); }
  catch (e) { log('voice download', String(e)); return null; }
  const r = gemini_([{ inline_data: { mime_type: mime || 'audio/ogg', data: Utilities.base64Encode(audio) } },
    { text: 'Transcribe this voice message word for word. It is usually Hebrew. Do not translate, summarize or add anything. Answer JSON only: {"text": "<the transcript>"}, or {"text": ""} if there is no speech.' }]);
  return r ? String(r.text || '').trim() : null;
}

// one Gemini call that answers JSON, trying each model in GEMINI_MODELS; null = all busy
function gemini_(parts) {
  const body = JSON.stringify({ contents: [{ parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 } });
  for (const model of models()) {
    for (let i = 0; i < 2; i++) {
      let r;
      try {
        r = UrlFetchApp.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
          { method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': prop('GEMINI_KEY') }, payload: body, muteHttpExceptions: true });
      } catch (e) { log('gemini fetch', model, String(e)); continue; }
      const code = r.getResponseCode();
      if (code === 200) {
        try { return JSON.parse(JSON.parse(r.getContentText()).candidates[0].content.parts[0].text); }
        catch (e) { log('gemini bad json', model, r.getContentText().slice(0, 300)); break; }
      }
      log('gemini', model, code);
      if (code === 400 || code === 403 || code === 404) break; // this model is gone, try the next one
      Utilities.sleep(1500);
    }
  }
  return null;
}

// ---------- calendar ----------
function recurrence_(rep) {
  const r = CalendarApp.newRecurrence(), W = CalendarApp.Weekday;
  if (rep === 'daily') r.addDailyRule();
  else if (rep === 'weekly') r.addWeeklyRule();
  else if (rep === 'monthly') r.addMonthlyRule();
  else r.addWeeklyRule().onlyOnWeekdays([W.SUNDAY, W.MONDAY, W.TUESDAY, W.WEDNESDAY, W.THURSDAY]);
  return r;
}

function create(p) {
  p.text = String(p.text).trim().replace(/\s*\n+\s*/g, ' · '); // one-line event title
  const rep = REP[p.repeat] ? p.repeat : null;
  const start = Utilities.parseDate(p.when, rep ? HOME_TZ : userTz(), 'yyyy-MM-dd HH:mm'); // series live in Israel time
  if (isNaN(start.getTime())) return send('לא הבנתי את הזמן. תנסח שוב?');
  if (!rep && start.getTime() < Date.now() - 60000) return send(fmt(start) + ' כבר עבר. תנסח שוב?');
  const end = new Date(start.getTime() + 15 * 60000);
  const ev = rep ? cal_().createEventSeries(p.text, start, end, recurrence_(rep)) : cal_().createEvent(p.text, start, end);
  const k = key_({ id: ev.getId(), t: start.getTime(), s: rep ? 1 : 0 });
  const r = send('⏰ ' + p.text + '\n' + fmt(start) + (rep ? ' · ' + REP[rep] : ''), [[{ text: 'בטל', callback_data: 'x:' + k }]]);
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

// ---------- buttons ----------
function onButton(q) {
  if (String(q.from.id) !== prop('ALLOWED_USER_ID')) return;
  const [act, k, arg] = String(q.data).split(':');
  const msg = q.message;
  const finish = (note, line) => {
    tg('answerCallbackQuery', { callback_query_id: q.id, text: note });
    if (line) tg('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: msg.text + '\n' + line });
    else tg('editMessageReplyMarkup', { chat_id: msg.chat.id, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
  };
  if (act === 'pc' || act === 'pr') return printButton(q, act, k); // Print.gs
  if (act === 'rt') return retornoButton(q, k); // Reports.gs
  if (act === 'kc') return clinicButton(q, k, arg); // Clinic.gs
  if (act === 'ml' || act === 'mp') return mailButton(q, act, k, arg); // Mail.gs
  const o = unkey_(k);
  if (!o) return finish('לא מצאתי, אולי כבר טופלה');
  if (act === 'x') {
    if (o.s) { const s = cal_().getEventSeriesById(o.id); if (s) s.deleteEventSeries(); }
    else { const ev = cal_().getEventById(o.id); if (ev) ev.deleteEvent(); }
    return finish('בוטל', '❌ בוטל');
  }
  if (act === 'o') { // ask for a time; the answer (reply, or the next message within 10 min) goes to moveTo via handle()
    tg('answerCallbackQuery', { callback_query_id: q.id });
    P.setProperty('SNOOZE_ASK', JSON.stringify({ k, at: Date.now() }));
    const r = tg('sendMessage', { chat_id: msg.chat.id, text: '🕐 לאיזו שעה לדחות?\nלמשל: 17:10, מחר ב-9, בעוד 20 דקות',
      reply_markup: { force_reply: true, input_field_placeholder: 'לאיזו שעה?' } });
    if (r.ok) P.setProperty('m_' + r.result.message_id, k);
    return;
  }
  const ev = findOcc_(o);
  if (!ev) return finish('לא מצאתי, אולי כבר טופלה');
  if (act === 's') {
    const ns = new Date(Math.ceil((Date.now() + Number(arg) * 60000) / 60000) * 60000);
    ev.setTime(ns, new Date(ns.getTime() + 15 * 60000));
    ev.setTag('alerted', '');
    o.t = ns.getTime(); rekey_(k, o);
    return finish('נדחה', '💤 נדחה ל' + fmt(ns));
  }
  if (act === 'd') {
    if (ev.getTag('state') === 'done') return finish('כבר סומן', '✅ בוצע'); // pressed on an older nag message
    ev.setTag('state', 'done');
    if (!o.s) ev.setTitle('✅ ' + ev.getTitle()); // a series occurrence keeps its title, the tag is enough
    return finish('יפה!', '✅ בוצע');
  }
}

// ---------- commands ----------
function command(text) {
  const [cmd, ...rest] = text.split(/\s+/);
  const c = cmd.toLowerCase().replace(/@.*/, '');
  if (c === '/list') return send(listText(7));
  if (c === '/queue') return send(queueText());
  if (c === '/bills') return billsCmd(); // Bills.gs
  if (c === '/klinka') return klinkaCmd(rest.join(' ')); // Reports.gs
  if (c === '/retorno') return retornoCmd(rest.join(' ')); // Reports.gs
  if (c === '/tz') {
    const z = rest.join('');
    if (!z) return send('אזור זמן נוכחי: ' + userTz() + '\nבחו״ל: /tz Europe/London\nחזרה הביתה: /tz home');
    if (z === 'home') { P.deleteProperty('USER_TZ'); return send('חזרת הביתה 🏠 תזכורות חדשות לפי שעון ישראל.'); }
    try { Utilities.formatDate(new Date(), z, 'HH:mm'); } catch (e) { return send('לא מכיר את אזור הזמן ' + z); }
    if (!/\//.test(z)) return send('צריך שם מלא, למשל Europe/London או America/New_York');
    P.setProperty('USER_TZ', z);
    return send('הבנתי, אתה ב-' + z + '. תזכורות חדשות יפורשו לפי השעון שם. תזכורות קיימות לא זזות.');
  }
  return send('שלח לי תזכורת בטקסט חופשי, למשל:\n"מחר ב-8 להתקשר לאינסטלטור"\n"כל יום א׳–ה׳ ב-7:30 תרופה"\n\nלהדפסה: שלח PDF. בכיתוב (caption) אפשר: 2-4, צבע, צד אחד, בלי תמונות\n\n/list תזכורות קרובות\n/queue מה מחכה להדפסה\nיומן קליניקה: "תוסיף טיפול לעדי ביום שלישי ב-11", "תמחק טיפול של עדי ביום שלישי", "תזיז טיפול של עדי ביום שלישי ל-12", "מה יש בקליניקה מחר" (תמיד מאשר איתך לפני שינוי)\n/klinka שעות קליניקה בחודש שעבר (או: "קליניקה עדי 10.26")\n"כרטיסייה עדי" / "עדי קנתה כרטיסייה 20.11" / "כרטיסיות"\n/retorno דוחות רטורנו לחודש שעבר (או: "רטורנו 11.26")\n/tz אזור זמן בחו״ל\n/bills חשבונות שמגיעים במייל (מי אביבים נשלח לכאן, מי מודיעין להדפסה)\nמייל ומסמכים: "מתי הגיעה החשבונית מחברת החשמל?", "תמצא לי את פוליסת הביטוח" (רק קורא, לא שולח ולא מוחק)\nדחייה לשעה אחרת: כפתור 🕐 שעה אחרת, או תשובה (reply) להתראה או לאישור עם "תדחה ל-17:10"');
}

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

// ---------- every minute ----------
// ---------- release notes: sent once, on the first tick after a new version is pushed ----------
const VERSION = '19';
const RELEASE_NOTES = '🆕 גרסה 19 עלתה. מה חדש:\n\n' +
  '1. "תזכיר לי ב15 ..." = היום ב-15:00 (ולא 15 בחודש). תאריך תמיד עם חודש, למשל 15.12.\n' +
  '2. לא נחתכות יותר אותיות מתחילת מילה בתזכורת ("לקנות" נשאר "לקנות").';
function releaseNotes_() {
  if (prop('VERSION_SEEN') === VERSION) return;
  P.setProperty('VERSION_SEEN', VERSION); // set first: never send twice
  send(RELEASE_NOTES);
}

function tick() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    try { releaseNotes_(); } catch (e) { log('release notes', String(e)); }
    alerts();
    retryInbox();
    morning();
  } catch (e) { log('tick error', String(e && e.stack || e)); }
  try { printTick(); // Print.gs
  } catch (e) { log('tick error', String(e && e.stack || e)); }
  try { reportsTick(); // Reports.gs
  } catch (e) { log('tick error', String(e && e.stack || e)); }
  try { billsTick(); // Bills.gs
  } catch (e) { log('tick error', String(e && e.stack || e)); }
  finally { lock.releaseLock(); }
}

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

function retryInbox() {
  if (!prop('INBOX_PENDING')) return;
  const t = tab_('inbox', INBOX_H.concat('reply_to'));
  const rows = t.getDataRange().getValues();
  let left = 0, done = 0;
  for (let i = rows.length - 1; i >= 1; i--) {
    const st = rows[i][3];
    const stale = st === 'working' && Date.now() - new Date(rows[i][0]).getTime() > 10 * 60000;
    if (st !== 'new' && !stale) continue;
    if (done < 3) { handle(i + 1, false); done++; }
    if (t.getRange(i + 1, 4).getValue() === 'new') left++;
    if (Date.now() - new Date(rows[i][0]).getTime() > 7 * 864e5) break;
  }
  if (!left) P.deleteProperty('INBOX_PENDING');
}

function morning() {
  const tz = userTz(), today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  if (prop('MORNING') === today || Utilities.formatDate(new Date(), tz, 'HH:mm') < (prop('MORNING_AT') || '04:30')) return;
  P.setProperty('MORNING', today);
  const now = new Date();
  const end = Utilities.parseDate(today + ' 23:59', tz, 'yyyy-MM-dd HH:mm');
  const evs = cal_().getEvents(new Date(now.getTime() - 2 * 864e5), end)
    .filter(e => !e.isAllDayEvent() && e.getTag('state') !== 'done');
  const lines = evs.map(e => (e.getStartTime() < now ? '⚠️ ' : '• ') + Utilities.formatDate(e.getStartTime(), tz, 'HH:mm') + '  ' + e.getTitle());
  send('☀️ בוקר טוב. ' + (lines.length ? 'להיום:\n' + lines.join('\n') : 'אין תזכורות להיום.'));
  // housekeeping: forget button keys older than 14 days
  const all = P.getProperties(), old = Date.now() - 14 * 864e5;
  Object.keys(all).forEach(key => {
    if (key.startsWith('k_')) { try { if (JSON.parse(all[key]).c < old) P.deleteProperty(key); } catch (e) {} }
  });
  Object.keys(all).filter(key => (key.startsWith('m_') || key.startsWith('mm_')) && !all['k_' + all[key]]).forEach(key => P.deleteProperty(key));
}

// ---------- setup (run once by hand) ----------
function setup() {
  const need = ['TG_TOKEN', 'ALLOWED_USER_ID', 'CALENDAR_ID', 'GEMINI_KEY', 'URL_SECRET', 'TG_SECRET', 'WORKER_URL'].filter(k => !prop(k));
  if (need.length) throw new Error('חסר ב-Script Properties: ' + need.join(', '));
  if (!cal_()) throw new Error('CALENDAR_ID לא נמצא');
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(1).create();
  log('setup webhook', tg('setWebhook', { url: prop('WORKER_URL'), secret_token: prop('TG_SECRET'), allowed_updates: ['message', 'callback_query'] }));
  tg('setMyCommands', { commands: [
    { command: 'list', description: 'תזכורות קרובות' },
    { command: 'queue', description: 'מה מחכה להדפסה' },
    { command: 'klinka', description: 'שעות קליניקה' },
    { command: 'retorno', description: 'דוחות רטורנו' },
    { command: 'tz', description: 'אזור זמן בחו״ל' },
    { command: 'bills', description: 'חשבונות ממייל' },
    { command: 'help', description: 'עזרה' }] });
  P.setProperty('MORNING', Utilities.formatDate(new Date(), userTz(), 'yyyy-MM-dd')); // first summary tomorrow
  send('המזכירה בענן מוכנה ✅\nשלח לי תזכורת, למשל: "בעוד 5 דקות לבדוק את הבוט"');
}
