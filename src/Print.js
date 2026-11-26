// ===== Office Manager Cloud: stage 2, print queue =====
// Flow: a PDF sent to OM -> row in the "jobs" tab + a copy in Drive ("Secretary print queue")
//   -> the laptop (print_agent.py) calls doGet ?action=pull every 30 s -> prints -> ?action=done -> status to Pablo.
// Statuses: waiting -> sent (laptop took it) -> printed | failed | cancelled.
// 'sent' with no answer for 10 min goes back to waiting (max 3 tries); the laptop skips a job it already printed.
// Uses the same URL_SECRET as the Worker. Optional Script Property: PRINT_MAX_MB (default 10).
// Queue edits use the user lock, so a slow tick() (Gemini) never blocks printing.

const JOBS_H = ['id', 'time', 'name', 'caption', 'status', 'tries', 'file_id', 'drive_id', 'msg_id', 'bot_msg_id', 'sent_at', 'done_at', 'note', 'source'];
const J = {}; JOBS_H.forEach((h, i) => { J[h] = i; }); // 0-based column of each field
const SENT_TIMEOUT = 10 * 60000, MAX_TRIES = 3, ONLINE_MS = 2 * 60000;
const jobsTab_ = () => tab_('jobs', JOBS_H);
const json_ = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
const laptopOnline_ = () => Date.now() - Number(prop('LAPTOP_SEEN') || 0) < ONLINE_MS;
const setCell_ = (t, row, field, v) => t.getRange(row, J[field] + 1).setValue(v);

// ---------- web app for the laptop ----------
function doGet(e) {
  const q = e.parameter || {};
  if (q.s !== prop('URL_SECRET')) return out_('no');
  try {
    if (q.action === 'pull') return printPull_(q);
    if (q.action === 'done') return printDone_(q);
  } catch (err) { log('doGet error', q.action, String(err && err.stack || err)); return out_('error'); }
  return out_('?');
}

function printPull_(q) {
  P.setProperty('LAPTOP_SEEN', String(Date.now())); // every pull is also the heartbeat
  if (!prop('JOBS_PENDING')) return json_({ job: null, fetch: fetchPull_() }); // Bills.gs: web requests the cloud cannot make
  const lock = LockService.getUserLock();
  if (!lock.tryLock(5000)) return json_({ job: null, busy: true });
  try {
    const t = jobsTab_(), rows = t.getDataRange().getValues();
    let i = -1, open = 0;
    for (let k = 1; k < rows.length; k++) {
      const st = rows[k][J.status];
      if (st === 'waiting' || st === 'sent') open++;
      if (st === 'waiting' && i < 0) i = k; // oldest first
    }
    if (!open) P.deleteProperty('JOBS_PENDING');
    if (i < 0) return json_({ job: null, fetch: fetchPull_() });
    const r = rows[i], row = i + 1, tries = Number(r[J.tries] || 0) + 1;
    let bytes;
    try {
      bytes = DriveApp.getFileById(r[J.drive_id] || toDrive_(t, row, r)).getBlob().getBytes();
    } catch (err) { // Telegram or Drive is down: count it as a try so one bad file never blocks the queue
      setCell_(t, row, 'tries', tries);
      setCell_(t, row, 'note', 'download: ' + err);
      if (tries >= MAX_TRIES) failJob_(t, row, r, 'לא הצלחתי להוריד את הקובץ מטלגרם');
      return json_({ job: null });
    }
    setCell_(t, row, 'status', 'sent');
    setCell_(t, row, 'tries', tries);
    setCell_(t, row, 'sent_at', new Date());
    log('print sent', r[J.id], r[J.name], 'try ' + tries, q.host || '');
    return json_({ job: { id: String(r[J.id]), name: String(r[J.name]), caption: String(r[J.caption] || ''), try: tries,
      b64: Utilities.base64Encode(bytes) } });
  } finally { lock.releaseLock(); }
}

function printDone_(q) {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(10000)) return out_('busy'); // the laptop keeps the answer and sends it again
  try {
    const t = jobsTab_(), row = rowOf_(t, q.id);
    if (!row) return out_('ok');
    const r = t.getRange(row, 1, 1, JOBS_H.length).getValues()[0];
    if (r[J.status] === 'printed' || r[J.status] === 'cancelled') return out_('ok'); // repeated answer
    const note = String(q.msg || '').slice(0, 300);
    if (q.status === 'ok') {
      setCell_(t, row, 'status', 'printed');
      setCell_(t, row, 'done_at', new Date());
      setCell_(t, row, 'note', note);
      notify_(r, '✅ הודפס: ' + r[J.name] + (note ? '\n' + note : ''));
    } else {
      failJob_(t, row, r, note || 'שגיאה במחשב');
    }
    log('print done', r[J.id], q.status, note);
    return out_('ok');
  } finally { lock.releaseLock(); }
}

// ---------- incoming PDF (called from onMessage) ----------
function printAdd(m) {
  const d = m.document, name = d.file_name || 'file.pdf';
  if (d.mime_type !== 'application/pdf' && !/\.pdf$/i.test(name)) return send('כרגע אני מדפיס רק PDF.');
  const maxMb = Number(prop('PRINT_MAX_MB') || 10);
  if ((d.file_size || 0) > maxMb * 1048576) return send('הקובץ גדול מ-' + maxMb + 'MB. כרגע קבצים גדולים מדפיסים דרך הבוט הישן במחשב.');
  const id = Utilities.getUuid().slice(0, 8), caption = (m.caption || '').trim();
  const t = jobsTab_();
  // no lock before the row exists: the job must be saved even if something else is busy
  t.appendRow([id, new Date(m.date * 1000), name, caption, 'waiting', 0, d.file_id, '', m.message_id, '', '', '', '', 'telegram']);
  P.setProperty('JOBS_PENDING', '1');
  const where = laptopOnline_() ? '💻 המחשב מחובר, יודפס בעוד פחות מדקה.' : '💤 המחשב לא מחובר כרגע. אדפיס כשיחזור ואעדכן.';
  const r = tg('sendMessage', { chat_id: m.chat.id, text: '🖨️ בתור להדפסה: ' + name + '\n' + captionSummary_(caption) + '\n' + where,
    reply_parameters: { message_id: m.message_id, allow_sending_without_reply: true },
    reply_markup: { inline_keyboard: [[{ text: 'בטל הדפסה', callback_data: 'pc:' + id }]] } });
  const lock = LockService.getUserLock();
  if (!lock.tryLock(3000)) return; // tick() saves the Drive copy later
  try {
    const row = rowOf_(t, id);
    if (!row) return;
    if (r.ok) setCell_(t, row, 'bot_msg_id', r.result.message_id);
    const cur = t.getRange(row, 1, 1, JOBS_H.length).getValues()[0];
    if (!cur[J.drive_id]) toDrive_(t, row, cur);
  } catch (err) { log('print drive copy', id, String(err)); }
  finally { lock.releaseLock(); }
}

// mirrors parse_caption in bot.py (defaults: black and white, double-sided)
function captionSummary_(c) {
  const low = (c || '').toLowerCase();
  const pages = (c || '').match(/\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*/);
  const parts = [/צבע|color/.test(low) ? 'צבע' : 'שחור-לבן', /צד אחד|simplex/.test(low) ? 'צד אחד' : 'דו-צדדי',
    pages ? 'עמודים ' + pages[0].replace(/\s+/g, '') : 'כל העמודים'];
  if (/בלי תמונות|no images/.test(low)) parts.push('בלי תמונות');
  return parts.join(' · ');
}

// ---------- buttons pc:<id> (cancel), pr:<id> (retry), pa:<id> (approve a job waiting in 'ask'), called from onButton ----------
function printButton(q, act, id) {
  const answer = text => tg('answerCallbackQuery', { callback_query_id: q.id, text });
  const lock = LockService.getUserLock();
  if (!lock.tryLock(10000)) return answer('עסוק, נסה שוב בעוד רגע');
  try {
    const t = jobsTab_(), row = rowOf_(t, id);
    if (!row) return answer('לא מצאתי את ההדפסה');
    const st = t.getRange(row, J.status + 1).getValue();
    let line;
    if (act === 'pc') {
      if (st === 'sent') return answer('המחשב כבר מדפיס אותו');
      if (st === 'printed') return answer('כבר הודפס');
      if (st !== 'cancelled') { setCell_(t, row, 'status', 'cancelled'); setCell_(t, row, 'done_at', new Date()); }
      line = st === 'ask' ? '🚫 לא מדפיס' : '❌ בוטל';
    } else if (act === 'pa') {
      if (st !== 'ask') return answer(st === 'cancelled' ? 'בוטל כבר' : 'כבר בתור');
      setCell_(t, row, 'status', 'waiting');
      P.setProperty('JOBS_PENDING', '1');
      line = '✅ נכנס לתור' + (laptopOnline_() ? ', יודפס בעוד פחות מדקה' : ' (יודפס כשהמחשב יחזור)');
    } else {
      if (st !== 'failed') return answer('אין מה לנסות שוב');
      setCell_(t, row, 'status', 'waiting');
      setCell_(t, row, 'tries', 0);
      P.setProperty('JOBS_PENDING', '1');
      line = '🔁 חזר לתור' + (laptopOnline_() ? '' : ' (יודפס כשהמחשב יחזור)');
    }
    answer(line);
    tg('editMessageText', { chat_id: q.message.chat.id, message_id: q.message.message_id, text: q.message.text + '\n' + line });
  } finally { lock.releaseLock(); }
}

// ---------- every minute (called from tick) ----------
function printTick() {
  const online = laptopOnline_(), was = prop('LAPTOP_STATE') === 'on';
  if (online !== was) P.setProperty('LAPTOP_STATE', online ? 'on' : 'off');
  if (!prop('JOBS_PENDING')) return;
  const lock = LockService.getUserLock();
  if (!lock.tryLock(1000)) return;
  try {
    const t = jobsTab_(), rows = t.getDataRange().getValues(), now = Date.now();
    let open = 0, copies = 0;
    for (let k = 1; k < rows.length; k++) {
      const r = rows[k], row = k + 1, st = r[J.status];
      if (st === 'sent' && now - new Date(r[J.sent_at]).getTime() > SENT_TIMEOUT) {
        if (Number(r[J.tries]) >= MAX_TRIES) { failJob_(t, row, r, 'המחשב לקח את הקובץ ' + MAX_TRIES + ' פעמים ולא אישר הדפסה'); continue; }
        setCell_(t, row, 'status', 'waiting');
        setCell_(t, row, 'note', 'no answer from laptop, retry');
        r[J.status] = 'waiting';
      }
      if (r[J.status] === 'waiting' && !r[J.drive_id] && copies < 3) {
        copies++;
        try { toDrive_(t, row, r); } catch (err) { log('print drive copy', r[J.id], String(err)); }
      }
      if (r[J.status] === 'waiting' || r[J.status] === 'sent') open++;
    }
    if (!open) P.deleteProperty('JOBS_PENDING');
    else if (online && !was) send('💻 המחשב חזר. מדפיס ' + (open === 1 ? 'קובץ אחד' : open + ' קבצים') + ' מהתור.');
  } finally { lock.releaseLock(); }
}

// ---------- /queue ----------
function queueText() {
  const seen = Number(prop('LAPTOP_SEEN') || 0);
  const head = laptopOnline_() ? '💻 המחשב מחובר' : '💤 המחשב לא מחובר' + (seen ? ' (נראה לאחרונה ' + fmt(new Date(seen)) + ')' : '');
  const rows = jobsTab_().getDataRange().getValues().slice(1);
  const icon = { waiting: '⏳', sent: '🖨️', failed: '❌' };
  const week = Date.now() - 7 * 864e5; // failed jobs stay on the list for a week
  const open = rows.filter(r => icon[r[J.status]] && (r[J.status] !== 'failed' || new Date(r[J.done_at]).getTime() > week));
  if (!open.length) return head + '\nאין קבצים שמחכים להדפסה.';
  return head + '\n' + open.map(r => icon[r[J.status]] + ' ' + r[J.name] + ' · ' + fmt(new Date(r[J.time]))).join('\n') +
    '\n\n⏳ מחכה  🖨️ נשלח למחשב  ❌ נכשל (יש כפתור "נסה שוב" בהודעה שלו)';
}

// ---------- helpers ----------
function rowOf_(t, id) {
  const last = t.getLastRow();
  if (last < 2) return 0;
  const ids = t.getRange(2, 1, last - 1, 1).getValues();
  for (let i = ids.length - 1; i >= 0; i--) if (String(ids[i][0]) === String(id)) return i + 2;
  return 0;
}

function printFolder_() {
  const id = prop('PRINT_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder('Secretary print queue');
  P.setProperty('PRINT_FOLDER_ID', f.getId());
  return f;
}

function toDrive_(t, row, r) {
  const info = tg('getFile', { file_id: r[J.file_id] });
  if (!info.ok) throw new Error('getFile: ' + info.description);
  const res = UrlFetchApp.fetch('https://api.telegram.org/file/bot' + prop('TG_TOKEN') + '/' + info.result.file_path, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('download HTTP ' + res.getResponseCode());
  const stamp = Utilities.formatDate(new Date(r[J.time]), HOME_TZ, 'yyyy-MM-dd HHmm');
  const id = printFolder_().createFile(res.getBlob().setName(stamp + ' ' + r[J.name]).setContentType('application/pdf')).getId();
  setCell_(t, row, 'drive_id', id);
  return id;
}

function failJob_(t, row, r, why) {
  setCell_(t, row, 'status', 'failed');
  setCell_(t, row, 'done_at', new Date());
  setCell_(t, row, 'note', why);
  notify_(r, '❌ ההדפסה נכשלה: ' + r[J.name] + '\n' + why,
    [[{ text: '🔁 נסה שוב', callback_data: 'pr:' + r[J.id] }, { text: 'בטל', callback_data: 'pc:' + r[J.id] }]]);
}

// status as a reply to Pablo's own PDF message; the "cancel" button on the queue message goes away
function notify_(r, text, kb) {
  if (r[J.bot_msg_id]) tg('editMessageReplyMarkup', { chat_id: prop('ALLOWED_USER_ID'), message_id: Number(r[J.bot_msg_id]), reply_markup: { inline_keyboard: [] } });
  tg('sendMessage', { chat_id: prop('ALLOWED_USER_ID'), text,
    reply_parameters: r[J.msg_id] ? { message_id: Number(r[J.msg_id]), allow_sending_without_reply: true } : undefined,
    reply_markup: kb ? { inline_keyboard: kb } : undefined });
}

// run once from the editor after pasting: asks for the Drive permission and creates the folder + jobs tab
function printSetup() {
  printFolder_();
  jobsTab_();
  tg('setMyCommands', { commands: BOT_COMMANDS });
  send('תור ההדפסה מוכן ✅ שלח לי PDF.');
}
