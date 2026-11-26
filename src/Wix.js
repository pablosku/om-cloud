// ===== Office Manager Cloud: yoga class recording -> Wix =====
// Google Meet mails "Meeting records: “Yoga online” Nov 24, 2026" (meetings-noreply@google.com) when the recording
// is in Drive. On the tick (every WIX_EVERY_MIN minutes) OM finds that mail, picks the class by the weekday of the
// class date (Tuesday = Beginners -b, Thursday = Advanced -a), queues a job in the "wix" tab and moves the mail to
// OM/טופל. The laptop print agent takes the job on its next pull and runs the existing tool
// (C:\Users\ASUS\Downloads\ZOOM\wix_upload.js -a|-b: Drive -> Wix upload, wait for READY, update the CMS,
// trash last week's video in Wix and this recording in Drive), then answers ?action=wixdone.
// The upload is ~500 MB, too big for Apps Script, so it stays on the laptop (Pablo's choice, 26.11).
// After a good upload the Meet mail goes to the Gmail trash (Pablo, 26.11).
// One Telegram message per class: "🎥 ..." and it is edited to ✅ / ⚠️ when the laptop is done.
// Hooks: tick() in Code.gs calls wixTick(); printPull_ (idlePull_) in Print.gs hands out wixPull_(); doGet routes wixdone.

const WIX_H = ['id', 'time', 'thread_id', 'class_date', 'mode', 'status', 'tries', 'sent_at', 'done_at', 'note', 'bot_msg_id'];
const WJ = {}; WIX_H.forEach((h, i) => { WJ[h] = i; });
const WIX_EVERY_MIN = 10;
const WIX_FROM = 'meetings-noreply@google.com', WIX_MEETING = 'Yoga online';
const WIX_TIMEOUT = 3 * 3600000; // a run takes ~30 min (the tool itself may wait up to 4 h for Drive); 'sent' longer = lost, hand it out again
const WIX_TRIES = 3, WIX_RETRY = 15 * 60000;
const WIX_DAYS = 6; // the tool uploads the LAST class of that weekday, so a job older than 6 days would upload the wrong class
const WIX_CLASS = { 2: { mode: 'b', name: 'מתחילים' }, 4: { mode: 'a', name: 'מתקדמים' } }; // getDay(): 2 = Tuesday, 4 = Thursday
const wixTab_ = () => tab_('wix', WIX_H);
const wixDay_ = v => v instanceof Date ? v : new Date(String(v) + 'T12:00:00'); // Sheets turns 'yyyy-MM-dd' into a Date

function wixTick(force) {
  if (!force && Date.now() - Number(prop('WIX_AT') || 0) < WIX_EVERY_MIN * 60000) return;
  P.setProperty('WIX_AT', String(Date.now()));
  if (!prop('WIX_SINCE')) P.setProperty('WIX_SINCE', String(Date.now())); // first run: only mails from now on, never re-upload old classes
  const since = Number(prop('WIX_SINCE'));
  const done = billLabel_(BILL_DONE); // Bills.gs: the same "handled" label
  GmailApp.search('from:' + WIX_FROM + ' subject:"' + WIX_MEETING + '" newer_than:3d', 0, 10).forEach(th => {
    if (th.getLabels().some(l => l.getName() === BILL_DONE)) return;
    const msg = th.getMessages()[0];
    if (msg.getDate().getTime() < since) return;
    const day = wixClassDate_(msg), cls = WIX_CLASS[Number(Utilities.formatDate(day, HOME_TZ, 'u')) % 7];
    const dstr = Utilities.formatDate(day, HOME_TZ, 'd.M.yy');
    th.addLabel(done);
    if (!cls) { send('🎥 הקלטת יוגה מ-' + dstr + ' (לא יום ג׳ או ה׳), לא העליתי ל-Wix.\nhttps://mail.google.com/mail/#all/' + th.getId()); return; }
    const t = wixTab_();
    if (t.getDataRange().getValues().some((r, i) => i && r[WJ.thread_id] === th.getId())) return; // already queued
    const res = send('🎥 הקלטת יוגה ' + cls.name + ' ' + dstr + ' מוכנה ב-Drive. ' +
      (laptopOnline_() ? 'המחשב מעלה אותה ל-Wix (כחצי שעה)…' : '💤 אעלה ל-Wix כשהמחשב בבית יידלק.'));
    t.appendRow([Utilities.getUuid().slice(0, 8), new Date(), th.getId(), Utilities.formatDate(day, HOME_TZ, 'yyyy-MM-dd'), cls.mode,
      'waiting', 0, '', '', '', res && res.result ? res.result.message_id : '']);
    P.setProperty('WIX_PENDING', '1');
    log('wix queued', cls.mode, dstr, th.getId());
  });
}

// the class date from the subject ("... Nov 24, 2026"), else the mail date
function wixClassDate_(msg) {
  const m = String(msg.getSubject()).match(/([A-Z][a-z]{2}) (\d{1,2}), (\d{4})/);
  const mon = m ? 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(m[1]) / 3 : -1;
  return mon >= 0 ? new Date(Number(m[3]), mon, Number(m[2]), 12) : msg.getDate();
}

// called from idlePull_: the oldest waiting job, or null. One at a time: nothing while a job is running on the laptop.
function wixPull_() {
  if (!prop('WIX_PENDING')) return null;
  const t = wixTab_(), rows = t.getDataRange().getValues(), now = Date.now();
  let pick = -1, open = 0, running = false;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    let st = r[WJ.status];
    if (st === 'sent' && now - new Date(r[WJ.sent_at]).getTime() > WIX_TIMEOUT) t.getRange(i + 1, WJ.status + 1).setValue(st = 'waiting');
    if (st === 'waiting' && (now - wixDay_(r[WJ.class_date]).getTime() > WIX_DAYS * 864e5 || Number(r[WJ.tries] || 0) >= WIX_TRIES)) {
      wixFail_(t, i + 1, r, r[WJ.note] || 'המחשב לא היה דלוק עד השיעור הבא'); continue;
    }
    if (st === 'sent') running = true;
    if (st === 'waiting' || st === 'sent') open++;
    const resting = r[WJ.sent_at] && now - new Date(r[WJ.sent_at]).getTime() < WIX_RETRY; // failed a moment ago
    if (st === 'waiting' && pick < 0 && !resting) pick = i;
  }
  if (!open) P.deleteProperty('WIX_PENDING');
  if (pick < 0 || running) return null;
  const r = rows[pick], row = pick + 1;
  t.getRange(row, WJ.status + 1, 1, 3).setValues([['sent', Number(r[WJ.tries] || 0) + 1, new Date()]]);
  log('wix sent', r[WJ.id], r[WJ.mode], r[WJ.class_date]);
  return { id: String(r[WJ.id]), mode: String(r[WJ.mode]), date: Utilities.formatDate(wixDay_(r[WJ.class_date]), HOME_TZ, 'yyyy-MM-dd') };
}

// doGet ?action=wixdone&id=..&status=ok|fail&msg=..  (msg = the last lines of the tool's output)
function wixDone_(q) {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(10000)) return out_('busy'); // the laptop keeps the answer and sends it again
  try {
    const t = wixTab_(), rows = t.getDataRange().getValues();
    const i = rows.findIndex((r, k) => k && String(r[WJ.id]) === String(q.id));
    if (i < 0) return out_('ok');
    const r = rows[i], row = i + 1, note = String(q.msg || '').slice(0, 300);
    if (r[WJ.status] === 'done' || r[WJ.status] === 'failed') return out_('ok'); // repeated answer
    if (q.status === 'ok') {
      t.getRange(row, WJ.status + 1, 1, 5).setValues([['done', r[WJ.tries], r[WJ.sent_at], new Date(), note]]);
      wixEdit_(r, '✅ הקלטת יוגה ' + wixName_(r) + ' עלתה ל-Wix ועודכנה באתר.');
      try { GmailApp.getThreadById(r[WJ.thread_id]).moveToTrash(); } catch (e) { log('wix trash mail', String(e)); } // Pablo: the Meet mail is not needed after a good upload (Gmail keeps it 30 days in the trash)
    } else { // try again later; wixPull_ gives up after WIX_TRIES
      t.getRange(row, WJ.status + 1, 1, 5).setValues([['waiting', r[WJ.tries], new Date(), '', note || 'שגיאה במחשב']]); // sent_at = when it failed
      P.setProperty('WIX_PENDING', '1');
    }
    log('wix done', r[WJ.id], q.status, note);
    return out_('ok');
  } finally { lock.releaseLock(); }
}

const wixName_ = r => (r[WJ.mode] === 'a' ? 'מתקדמים' : 'מתחילים') + ' ' + Utilities.formatDate(wixDay_(r[WJ.class_date]), HOME_TZ, 'd.M.yy');

function wixFail_(t, row, r, why) {
  t.getRange(row, WJ.status + 1).setValue('failed');
  t.getRange(row, WJ.note + 1).setValue(why);
  send('⚠️ הקלטת יוגה ' + wixName_(r) + ' לא עלתה ל-Wix:\n' + String(why).slice(0, 200) + // a new message, so it is noticed
    '\nאפשר להריץ ידנית: run_upload.bat -' + r[WJ.mode]);
}

function wixEdit_(r, text) {
  const id = Number(r[WJ.bot_msg_id] || 0);
  const j = id ? tg('editMessageText', { chat_id: prop('ALLOWED_USER_ID'), message_id: id, text }) : null;
  if (!j || !j.ok) send(text);
}
