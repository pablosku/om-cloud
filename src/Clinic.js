// ===== Office Manager Cloud: clinic calendar changes ("קליניקה בכפר") =====
// "תוסיף טיפול לעדי ביום שלישי ב-11" / "תמחק טיפול של עדי ביום שלישי" / "תזיז טיפול של עדי ביום שלישי ל-12"
// "מה יש בקליניקה ביום שלישי" / "אילו טיפולים יש לעדי"
// Event title = therapist name only. A new event gets the color of that therapist's latest event, 1 hour by default.
// NOTHING changes without ✅: every change is shown first (who, full date, times, overlaps), then the button does it.
// This file is the only place that writes to the clinic calendar (Reports.gs only reads it).
// Recurring series (מיכל, פבלו): only that day's occurrence is deleted / moved, never the series.
// Hooks: Code.gs handle() -> clinicHandle(); onButton() 'kc' -> clinicButton(). State: CLINIC_PENDING (30 min follow-up).

const CLINIC_RE = /טיפול|שריון|תשריין|לשריין|בקליניקה/;
const KC_DAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const kcCal_ = () => {
  const cal = CalendarApp.getCalendarById(prop('KLINKA_CAL_ID') || KLINKA_CAL_DEFAULT);
  if (!cal) throw new Error('לא מוצא את יומן הקליניקה');
  return cal;
};
const kcHm_ = d => Utilities.formatDate(new Date(d), HOME_TZ, 'HH:mm');
const kcDay_ = d => 'יום ' + DAYS[Number(Utilities.formatDate(new Date(d), HOME_TZ, 'u')) % 7] + ' ' + Utilities.formatDate(new Date(d), HOME_TZ, 'd.M');
const kcSpan_ = (n, s, e) => n + ', ' + kcDay_(s) + ', ' + kcHm_(s) + '–' + kcHm_(e);
const kcAt_ = (date, time) => Utilities.parseDate(date + ' ' + time, HOME_TZ, 'yyyy-MM-dd HH:mm');
const kcTitle_ = ev => { const n = String(ev.getTitle() || '').trim(); return KLINKA_ALIASES[n] || n; };
const kcLine_ = ev => '  ' + kcHm_(ev.getStartTime()) + '–' + kcHm_(ev.getEndTime()) + ' ' + kcTitle_(ev);

// timed events of one day (Israel time)
function kcDayEvents_(date) {
  const a = kcAt_(date, '00:00');
  const b = kcAt_(Utilities.formatDate(new Date(a.getTime() + 30 * 36e5), HOME_TZ, 'yyyy-MM-dd'), '00:00');
  return kcCal_().getEvents(a, b).filter(ev => !ev.isAllDayEvent())
    .sort((p, q) => p.getStartTime() - q.getStartTime());
}

// the exact occurrence (a series shares one id, so the start time picks the day)
function kcFind_(id, t) {
  return kcCal_().getEvents(new Date(t - 60000), new Date(t + 60000))
    .find(ev => ev.getId() === id && ev.getStartTime().getTime() === t) || null;
}

// color of that therapist's latest event ('' = calendar default)
function kcColor_(n) {
  const now = Date.now();
  const evs = kcCal_().getEvents(new Date(now - 180 * 864e5), new Date(now + 60 * 864e5)).filter(ev => kcTitle_(ev) === n);
  if (!evs.length) return '';
  const past = evs.filter(ev => ev.getStartTime().getTime() <= now);
  const ev = (past.length ? past : evs).sort((p, q) => q.getStartTime() - p.getStartTime())[0];
  return ev.getColor() || '';
}

// "לעדי" / "של עדי" / "עדי" -> {n, known}
function kcName_(who, names) {
  const w = String(who || '').trim().replace(/^של\s+/, '');
  if (!w) return null;
  if (names.includes(w)) return { n: w, known: true };
  const bare = w.replace(/^[לש]/, '');
  if (names.includes(bare)) return { n: bare, known: true };
  const hit = names.find(n => w.includes(n));
  return hit ? { n: hit, known: true } : { n: w, known: false };
}

function kcParse_(text, at, prev, names) {
  const now = Utilities.formatDate(at, HOME_TZ, 'yyyy-MM-dd HH:mm EEEE');
  const days = [];
  for (let i = 0; i < 21; i++) {
    const d = new Date(at.getTime() + i * 864e5);
    days.push(Utilities.formatDate(d, HOME_TZ, 'yyyy-MM-dd') + ' ' + KC_DAYS_EN[Number(Utilities.formatDate(d, HOME_TZ, 'u')) % 7]);
  }
  const prompt = `You parse Hebrew requests about a therapy clinic's booking calendar (Israel). Each event's title is only the therapist's name.
Known therapists: ${names.join(', ')}.
Current local time: ${now}. The next days are:
${days.join('\n')}
A weekday name ("ביום שלישי", "שלישי הבא") = the nearest such day in this list (today counts if the time has not passed). "מחר" = tomorrow.
A bare hour without בבוקר/בערב: 7-12 = morning (ב11 = 11:00), 1-6 = afternoon (ב3 = 15:00). "ב11 וחצי" = 11:30.
Answer JSON only:
{"intent": "add"|"delete"|"move"|"show"|"other",
 "who": the therapist name, exactly as in the known list when it is one of them (without Hebrew prefixes like ל, ש, של), else as written, or null,
 "date": "YYYY-MM-DD" of the treatment (for delete/move: its current day), or null,
 "time": "HH:MM" start of the treatment (for delete/move: its current start, if said), or null,
 "end": "HH:MM" if an end time was said ("עד 13:00"), else null,
 "minutes": duration in minutes if said ("שעתיים" = 120, "חצי שעה" = 30), else null,
 "new_date": for move only, "YYYY-MM-DD" if the day changes, else null,
 "new_time": for move only, "HH:MM" new start, else null,
 "question": short Hebrew question asking only for what is missing, else null}
"add" = book a treatment (תוסיף/תקבע/תשריין). "delete" = remove one (תמחק/תבטל). "move" = change its time or day (תזיז/תעביר/תדחה).
"show" = asks what is booked ("מה יש בקליניקה ביום שלישי", "מתי יש לעדי טיפול").
"other" = anything that is not about changing or viewing the clinic calendar, e.g. a personal reminder ("תזכיר לי להתקשר לעדי על הטיפול").
You only read the message. You cannot do anything, so the question must never say that something was done.
${prev ? `The user is answering my question about his earlier message. Combine both into one request.
If the follow-up is a new, complete request on its own (or not about the clinic), ignore the earlier message.
Earlier message: ${prev}
Follow-up message: ${text}` : `Message: ${text}`}`;
  return gemini_([{ text: prompt }]);
}

// true = handled, false = not about the clinic (go on as a reminder), null = Gemini busy (retry later)
function clinicHandle(text, at, prev) {
  const names = klinkaNames_().concat(KLINKA_EXCLUDE.filter(n => !klinkaNames_().includes(n)));
  const p = kcParse_(text, at, prev, names);
  if (!p) return null;
  P.deleteProperty('CLINIC_PENDING');
  if (!['add', 'delete', 'move', 'show'].includes(p.intent)) return false;
  P.deleteProperty('PENDING'); // a reminder question that was open is no longer relevant
  const ask = q => {
    P.setProperty('CLINIC_PENDING', JSON.stringify({ text: (prev ? prev + '\n' : '') + text, at: at.getTime() }));
    send('❓ ' + q);
    return true;
  };
  try {
    if (p.intent === 'show') { kcShow_(p, names); return true; }
    const who = kcName_(p.who, names);
    if (!who) return ask(p.question || 'של איזה מטפל?');
    if (!p.date) return ask(p.question || 'באיזה יום?');
    const src = (prev ? prev + '\n' : '') + text; // kept for "🕐 שעה אחרת" after an overlap
    if (p.intent === 'add') return kcAdd_(p, who, ask, src);
    return kcPick_(p, who, ask, src);
  } catch (e) {
    log('clinic error', String(e && e.stack || e));
    send('⚠️ משהו נכשל ביומן הקליניקה: ' + e.message + '\nלא שיניתי כלום.');
    return true;
  }
}

function kcAdd_(p, who, ask, src) {
  if (!p.time) return ask(p.question || 'באיזו שעה?');
  const s = kcAt_(p.date, p.time);
  if (isNaN(s.getTime())) return ask('לא הבנתי את הזמן. באיזה יום ושעה?');
  if (s.getTime() < Date.now()) return ask(kcDay_(s) + ' ' + kcHm_(s) + ' כבר עבר. לאיזה יום ושעה?');
  const e = p.end ? kcAt_(p.date, p.end) : new Date(s.getTime() + (Number(p.minutes) || 60) * 60000);
  if (!(e > s)) return ask('שעת הסיום לפני ההתחלה. עד מתי?');
  const lines = ['➕ להוסיף טיפול?', kcSpan_(who.n, s, e)];
  if (!who.known) lines.push('🆕 "' + who.n + '" לא מופיע ביומן בחודשים האחרונים, ייווצר בצבע ברירת המחדל.');
  const clash = kcOverlap_(lines, p.date, s, e);
  kcConfirm_(lines, { op: 'add', n: who.n, s: s.getTime(), e: e.getTime(), color: who.known ? kcColor_(who.n) : '', src }, clash);
  return true;
}

// delete / move: find that therapist's treatment on that day
function kcPick_(p, who, ask, src) {
  if (p.intent === 'move' && !p.new_time && !p.new_date) return ask(p.question || 'לאיזו שעה להזיז?');
  const day = kcDayEvents_(p.date);
  let evs = day.filter(ev => kcTitle_(ev) === who.n);
  if (p.time && evs.length) {
    const t = kcAt_(p.date, p.time).getTime();
    const exact = evs.filter(ev => ev.getStartTime().getTime() === t);
    const inside = evs.filter(ev => ev.getStartTime().getTime() <= t && t < ev.getEndTime().getTime());
    evs = exact.length ? exact : inside;
  }
  const dayName = kcDay_(kcAt_(p.date, '12:00'));
  if (!evs.length) {
    send('🔍 לא מצאתי טיפול של ' + who.n + (p.time ? ' ב-' + p.time : '') + ' ב' + dayName + '. לא שיניתי כלום.\n' +
      (day.length ? 'ביומן באותו יום:\n' + day.map(kcLine_).join('\n') : 'היומן ריק באותו יום.'));
    return true;
  }
  const ops = evs.map(ev => ({ op: p.intent === 'delete' ? 'del' : 'move', n: who.n, id: ev.getId(),
    s: ev.getStartTime().getTime(), e: ev.getEndTime().getTime(), rec: ev.isRecurringEvent() ? 1 : 0,
    color: ev.getColor() || '', nd: p.new_date || p.date, nt: p.new_time || kcHm_(ev.getStartTime()), src }));
  if (ops.length === 1) { kcPrompt_(ops[0]); return true; }
  send('ל' + who.n + ' יש ' + ops.length + ' טיפולים ב' + dayName + '. איזה ' + (p.intent === 'delete' ? 'למחוק' : 'להזיז') + '?',
    ops.map(o => [{ text: kcHm_(o.s) + '–' + kcHm_(o.e), callback_data: 'kc:' + key_(o) + ':p' }]));
  return true;
}

// the confirmation message for one delete / move
function kcPrompt_(o) {
  const lines = [];
  if (o.op === 'del') lines.push('🗑 למחוק טיפול?', kcSpan_(o.n, o.s, o.e));
  else {
    const ns = kcAt_(o.nd, o.nt);
    if (isNaN(ns.getTime())) return send('❓ לא הבנתי לאיזו שעה להזיז. תנסח שוב?');
    if (ns.getTime() < Date.now()) return send('❓ ' + kcDay_(ns) + ' ' + kcHm_(ns) + ' כבר עבר. לא שיניתי כלום.');
    const ne = new Date(ns.getTime() + (o.e - o.s)); // keeps the length
    if (ns.getTime() === o.s) return send('הטיפול כבר בשעה הזו. לא שיניתי כלום.');
    o.ns = ns.getTime(); o.ne = ne.getTime();
    lines.push('↔️ להזיז טיפול?', 'מ: ' + kcSpan_(o.n, o.s, o.e), 'ל: ' + kcSpan_(o.n, ns, ne));
    var clash = kcOverlap_(lines, o.nd, ns, ne, o);
  }
  if (o.rec) lines.push('🔁 זה מופע של סדרה קבועה. ישתנה רק המופע של היום הזה.');
  kcConfirm_(lines, o, clash);
}

function kcOverlap_(lines, date, s, e, self) {
  const hit = kcDayEvents_(date).filter(ev => ev.getStartTime() < e && ev.getEndTime() > s &&
    !(self && ev.getId() === self.id && ev.getStartTime().getTime() === self.s));
  if (hit.length) lines.push('⚠️ יש כבר טיפול בזמן הזה:\n' + hit.map(kcLine_).join('\n'));
  return hit.length > 0;
}

// overlap: ask what to do (do it anyway / another time / cancel)
function kcConfirm_(lines, o, clash) {
  const k = key_(o), b = (text, a) => ({ text, callback_data: 'kc:' + k + ':' + a });
  if (!clash) return send(lines.join('\n'), [[b('✅ כן', 'y'), b('❌ לא', 'n')]]);
  send(lines.concat('מה לעשות?').join('\n'), [[b('⚠️ כן, בכל זאת', 'y')], [b('🕐 שעה אחרת', 'o'), b('❌ לא', 'n')]]);
}

// "מה יש בקליניקה ביום שלישי" (one day) / "מתי יש לעדי טיפול" (next 14 days)
function kcShow_(p, names) {
  const who = kcName_(p.who, names);
  if (p.date || !who) {
    const date = p.date || Utilities.formatDate(new Date(), HOME_TZ, 'yyyy-MM-dd');
    const evs = kcDayEvents_(date).filter(ev => !who || kcTitle_(ev) === who.n);
    const title = '🏡 ' + (who ? who.n + ', ' : 'קליניקה, ') + kcDay_(kcAt_(date, '12:00'));
    return send(title + (evs.length ? ':\n' + evs.map(kcLine_).join('\n') : ': אין טיפולים.'));
  }
  const now = new Date(), evs = kcCal_().getEvents(now, new Date(now.getTime() + 14 * 864e5))
    .filter(ev => !ev.isAllDayEvent() && kcTitle_(ev) === who.n).sort((p, q) => p.getStartTime() - q.getStartTime());
  send('🏡 ' + who.n + ', שבועיים קרובים' + (evs.length ? ':\n' + evs.map(ev => '  ' + kcDay_(ev.getStartTime()) + ' ' +
    kcHm_(ev.getStartTime()) + '–' + kcHm_(ev.getEndTime())).join('\n') : ': אין טיפולים.'));
}

// buttons kc:<key>:y (do it) / n (cancel) / o (overlap: another time) / p (picked one of several) / u (undo)
function clinicButton(q, k, arg) {
  const msg = q.message;
  const finish = (note, line, kb) => {
    tg('answerCallbackQuery', { callback_query_id: q.id, text: note });
    tg('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: msg.text + (line ? '\n' + line : ''),
      reply_markup: { inline_keyboard: kb || [] } });
  };
  const o = unkey_(k);
  if (!o) return finish('לא מצאתי, אולי פג תוקף', '');
  if (arg === 'p') { finish('', '👆 ' + kcHm_(o.s)); return kcPrompt_(o); }
  if (arg === 'n') return finish('לא שיניתי', '❌ לא שיניתי כלום');
  if (arg === 'o') { // the next message (within 30 min) is read together with the original request
    finish('', '🕐 שעה אחרת');
    P.setProperty('CLINIC_PENDING', JSON.stringify({ text: o.src + '\n(השעה הזו תפוסה, הוא בוחר שעה אחרת)', at: Date.now() }));
    return tg('sendMessage', { chat_id: msg.chat.id, text: '🕐 לאיזו שעה (או יום) במקום?',
      reply_markup: { force_reply: true, input_field_placeholder: 'למשל: ב-13, מחר ב-10' } });
  }
  const undoKb = [[{ text: '↩️ בטל', callback_data: 'kc:' + k + ':u' }]];
  try {
    const cur = o; // a second press finds done / undone already saved
    if (arg === 'y') {
      if (cur.done) return finish('כבר בוצע', '', cur.undone ? [] : undoKb);
      if (o.op === 'add') {
        const ev = kcCal_().createEvent(o.n, new Date(o.s), new Date(o.e));
        if (o.color) ev.setColor(o.color);
        o.id = ev.getId();
      } else {
        const ev = kcFind_(o.id, o.s);
        if (!ev) return finish('לא מצאתי', '⚠️ הטיפול כבר לא שם (אולי השתנה ביומן). לא שיניתי כלום.');
        if (o.op === 'del') ev.deleteEvent();
        else ev.setTime(new Date(o.ns), new Date(o.ne));
      }
      o.done = 1; rekey_(k, o);
      return finish('בוצע', { add: '✅ נוסף ליומן', del: '✅ נמחק', move: '✅ הוזז' }[o.op], undoKb);
    }
    if (arg === 'u') {
      if (!cur.done || cur.undone) return finish('אין מה לבטל', '');
      if (o.op === 'del') {
        const ev = kcCal_().createEvent(o.n, new Date(o.s), new Date(o.e)); // a series occurrence comes back as a single event
        if (o.color) ev.setColor(o.color);
      } else {
        const ev = o.op === 'add' ? kcFind_(o.id, o.s) : kcFind_(o.id, o.ns);
        if (!ev) return finish('לא מצאתי', '⚠️ לא מצאתי את הטיפול כדי לבטל. כדאי לבדוק ביומן.');
        if (o.op === 'add') ev.deleteEvent();
        else ev.setTime(new Date(o.s), new Date(o.e));
      }
      o.undone = 1; rekey_(k, o);
      return finish('בוטל', '↩️ בוטל, חזר למה שהיה');
    }
  } catch (e) {
    log('clinic button error', String(e && e.stack || e));
    return finish('נכשל', '⚠️ נכשל: ' + e.message);
  }
}
