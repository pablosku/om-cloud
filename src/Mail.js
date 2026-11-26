// ===== Office Manager Cloud: Gmail + Drive search, read only =====
// "מתי הגיעה החשבונית מחברת החשמל?" / "תמצא לי את פוליסת הביטוח" -> Gemini writes a Gmail query + Drive words
// -> up to 6 results with number buttons -> a tap sends the attachments to Telegram, a short summary,
// and the answer to the question (Gemini reads the email text and the attached PDF / image).
// A reply (reply) to that summary = another question about the same email or file.
// Nothing here sends, deletes, labels or marks mail. The only write is a print job (🖨️ button) into the Print.gs queue.
// Hooks in Code.gs: handle() calls mailFollowUp() and mailHandle(), onButton() routes 'ml' and 'mp' to mailButton().
// Needs the Gmail permission: Google asks once, on the first run after this file is added.

const MAIL_RE = /מייל|אימייל|דוא"?ל|דואר|ג'?ימייל|gmail|מסמך|מסמכים|קובץ|קבצים|חשבונית|חשבוניות|קבלה|קבלות|פוליסה|מכתב|הסכם|חוזה|דרייב|drive|תמצא|למצוא|תחפש|חפש/i;
const MAIL_MAX = 6;            // results shown
const MAIL_READ_MB = 8;        // a file larger than this is sent to Telegram but not read by Gemini
const MAIL_READ_TOTAL_MB = 15; // all files read in one Gemini call
const MAIL_SEND_MB = 45;       // Telegram bot upload limit is 50MB
const MAIL_READABLE = /^(application\/pdf|image\/(png|jpeg|webp|heic|heif)|text\/plain)$/;
const mailDate_ = d => Utilities.formatDate(new Date(d), HOME_TZ, 'd.M.yy');
const mailCut_ = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const mailFrom_ = f => mailCut_(String(f || '').replace(/<[^>]*>/g, '').replace(/"/g, '') || f, 30);

// ---------- understanding the request ----------
function mailParse_(text, at) {
  const now = Utilities.formatDate(at, HOME_TZ, 'yyyy-MM-dd EEEE');
  const prompt = `You turn a Hebrew message into a search over the user's own Gmail and Google Drive. Today: ${now} (Israel).
First decide: does he want to FIND an email, a document or a file he has, or ASK something whose answer is in his email or documents
(an amount, a date, what someone wrote)? Then intent is "search".
A request to remind him of something later ("תזכיר לי לשלוח מייל לדני מחר"), a clinic booking, or anything else is intent "other".
Answer JSON only:
{"intent": "search" | "other",
 "gmail": a Gmail search query with Gmail operators (from:, subject:, has:attachment, filename:pdf, after:YYYY/MM/DD, before:YYYY/MM/DD, newer_than:3m).
   Use OR between synonyms and between the Hebrew and English names of companies, e.g. (חשמל OR "חברת החשמל" OR iec).
   Add dates only when he gives a time. Null when he asked only about Drive,
 "gmail_loose": a broader Gmail query to use if the first finds nothing (only the key words, no dates or from:), or null,
 "drive": array of 1-3 short words that would appear in the document's name or text, or null when he asked only about email,
 "question": his question to answer from the content, in Hebrew as he asked it, or null when he only wants the email or file}
Message: ${text}`;
  return gemini_([{ text: prompt }]);
}

// true = handled, false = not a search (go on as a reminder), null = Gemini busy (retry later)
function mailHandle(text, at) {
  const p = mailParse_(text, at);
  if (!p) return null;
  if (p.intent !== 'search' || (!p.gmail && !(p.drive || []).length)) return false;
  P.deleteProperty('PENDING'); // a reminder question that was open is no longer relevant
  try { mailSearch_(p); }
  catch (e) { log('mail error', String(e && e.stack || e)); send('⚠️ החיפוש נכשל: ' + e.message); }
  return true;
}

// ---------- search ----------
function mailSearch_(p) {
  const found = [];
  let q = p.gmail ? String(p.gmail) : '';
  if (q) {
    let threads = GmailApp.search(q, 0, MAIL_MAX);
    if (!threads.length && p.gmail_loose) { q = String(p.gmail_loose); threads = GmailApp.search(q, 0, MAIL_MAX); }
    threads.forEach(th => {
      const msgs = th.getMessages();
      // the newest message that has a file, else the newest message
      const m = msgs.slice().reverse().find(x => x.getAttachments({ includeInlineImages: false }).length) || msgs[msgs.length - 1];
      const n = m.getAttachments({ includeInlineImages: false }).length;
      found.push({ t: 'g', id: m.getId(), line: '📧 ' + mailDate_(m.getDate()) + ' · ' + mailFrom_(m.getFrom()) + ' · ' + mailCut_(m.getSubject() || '(בלי נושא)', 50) + (n ? ' 📎' : '') });
    });
  }
  const words = (Array.isArray(p.drive) ? p.drive : []).map(w => String(w).replace(/['\\]/g, '').trim()).filter(String);
  if (words.length && found.length < MAIL_MAX) {
    driveFind_(words).slice(0, Math.min(3, MAIL_MAX - found.length)).forEach(f =>
      found.push({ t: 'd', id: f.getId(), line: '📁 ' + mailDate_(f.getLastUpdated()) + ' · ' + mailCut_(f.getName(), 60) }));
  }
  const where = (q ? 'במייל: ' + q : '') + (q && words.length ? '\n' : '') + (words.length ? 'ב-Drive: ' + words.join(', ') : '');
  if (!found.length) return send('🔍 לא מצאתי.\nחיפשתי ' + where + '\nתנסח אחרת, למשל עם שם השולח או חודש.');
  const keys = found.map(f => key_({ mail: f.t, id: f.id, q: p.question || '' }));
  if (found.length === 1) return mailRead_(keys[0], p.question || '', true);
  send('🔍 מצאתי:\n' + found.map((f, i) => (i + 1) + '. ' + f.line).join('\n') +
    '\n\n' + (p.question ? 'בחר תוצאה ואענה על: ' + p.question : 'בחר תוצאה לפתוח.') + '\n(חיפשתי ' + where + ')',
    [keys.map((k, i) => ({ text: String(i + 1), callback_data: 'ml:' + k }))]);
}

// Drive files whose name or text has all the words (or, if none, any of them), newest first; no folders, no trash
function driveFind_(words) {
  const base = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
  const one = w => "(title contains '" + w + "' or fullText contains '" + w + "')";
  const run = expr => { const out = [], it = DriveApp.searchFiles(base + ' and (' + expr + ')'); while (it.hasNext() && out.length < 20) out.push(it.next()); return out; };
  let files = run(words.map(one).join(' and '));
  if (!files.length && words.length > 1) files = run(words.map(one).join(' or '));
  return files.sort((a, b) => b.getLastUpdated() - a.getLastUpdated());
}

// ---------- reading one email or file ----------
// the email (or Drive file) behind a key: header line, text, and its files as blobs
function mailItem_(o) {
  if (o.mail === 'g') {
    const m = GmailApp.getMessageById(o.id);
    if (!m) return null;
    const atts = m.getAttachments({ includeInlineImages: false });
    return {
      head: '📧 ' + mailCut_(m.getSubject() || '(בלי נושא)', 120) + '\nמאת: ' + mailFrom_(m.getFrom()) + ' · ' + fmt(m.getDate()),
      text: 'Subject: ' + m.getSubject() + '\nFrom: ' + m.getFrom() + '\nDate: ' + m.getDate() + '\n\n' + String(m.getPlainBody() || '').slice(0, 20000),
      files: atts.map(a => a.copyBlob().setName(a.getName())),
      link: 'https://mail.google.com/mail/u/0/#all/' + m.getThread().getId()
    };
  }
  const f = DriveApp.getFileById(o.id);
  const type = f.getMimeType();
  let blob;
  if (/^application\/vnd\.google-apps\.(document|spreadsheet|presentation)$/.test(type)) blob = f.getAs('application/pdf').setName(f.getName() + '.pdf');
  else blob = f.getBlob();
  return { head: '📁 ' + mailCut_(f.getName(), 120) + '\nעודכן ' + fmt(f.getLastUpdated()), text: 'File name: ' + f.getName(), files: [blob], link: f.getUrl() };
}

// sendFiles: true on the first open (files go to Telegram), false on a follow-up question
function mailRead_(k, question, sendFiles) {
  const o = unkey_(k);
  if (!o || !o.mail) { send('לא מצאתי את התוצאה, אולי עבר יותר משבועיים. תחפש שוב?'); return true; }
  let it;
  try { it = mailItem_(o); } catch (e) { log('mail open', String(e)); }
  if (!it) { send('לא הצלחתי לפתוח את ' + (o.mail === 'g' ? 'המייל' : 'הקובץ') + '. אולי נמחק.'); return true; }
  const mb = b => b.getBytes().length / 1048576;
  if (sendFiles) it.files.slice(0, 5).forEach(b => {
    if (mb(b) > MAIL_SEND_MB) return send('📎 ' + b.getName() + ' גדול מדי לטלגרם. הוא נמצא כאן: ' + it.link);
    try { sendDoc_(b, ''); } catch (e) { send('📎 לא הצלחתי לשלוח את ' + b.getName()); } // Reports.gs
  });
  // Gemini reads the text and the PDF / image files, within the size limits
  let total = 0;
  const parts = [];
  it.files.forEach(b => {
    const type = String(b.getContentType() || '').toLowerCase(), size = mb(b);
    if (!MAIL_READABLE.test(type) || size > MAIL_READ_MB || total + size > MAIL_READ_TOTAL_MB) return;
    total += size;
    parts.push({ inline_data: { mime_type: type, data: Utilities.base64Encode(b.getBytes()) } });
  });
  const q = question || o.q || '';
  parts.push({ text: `You help an Israeli user with one of his own emails or documents. The email text is below and its files are attached above.
Answer in Hebrew, JSON only:
{"summary": 2-4 short lines: who sent it and what it is, the key amounts, dates and numbers, and any action or deadline for him,
 "answer": ${q ? 'a short answer to his question from this content only, or "לא מצאתי את זה כאן" when it is not there' : 'null'}}
${q ? 'His question: ' + q + '\n' : ''}
${it.text}` });
  const r = gemini_(parts);
  const unread = it.files.length - (parts.length - 1);
  const pdfs = it.files.map((b, i) => ({ b, i })).filter(x => /pdf/i.test(x.b.getContentType() || '') || /\.pdf$/i.test(x.b.getName())).slice(0, 3);
  const kb = pdfs.map(x => [{ text: '🖨️ הדפס ' + mailCut_(x.b.getName(), 25), callback_data: 'mp:' + k + ':' + x.i }]);
  let body;
  if (!r) {
    body = '⏳ גוגל עמוס, לא הצלחתי לקרוא עכשיו.';
    kb.unshift([{ text: '🔁 נסה שוב', callback_data: 'ml:' + k }]);
  } else {
    body = String(r.summary || '').trim() + (q && r.answer ? '\n\n❓ ' + q + '\n💡 ' + String(r.answer).trim() : '');
  }
  const res = send(it.head + '\n\n' + body.slice(0, 3000) +
    (unread > 0 ? '\n\n(' + unread + ' קבצים לא נקראו: גדולים מדי או מסוג שאני לא קורא)' : '') +
    '\n\n🔗 ' + it.link + '\n↩️ שאלה נוספת על זה: reply להודעה הזו', kb.length ? kb : undefined);
  if (res.ok) P.setProperty('mm_' + res.result.message_id, k);
  return true;
}

// a reply to a summary message = a question about that email or file. true = handled, null = Gemini busy
function mailFollowUp(replyTo, text) {
  const k = replyTo && prop('mm_' + replyTo);
  if (!k) return false;
  return mailRead_(k, text, false);
}

// ---------- buttons: ml:<k> open a result, mp:<k>:<i> print file i of that result ----------
function mailButton(q, act, k, arg) {
  const answer = text => tg('answerCallbackQuery', { callback_query_id: q.id, text });
  if (act === 'ml') {
    answer('פותח…');
    tg('sendChatAction', { chat_id: q.message.chat.id, action: 'typing' });
    return mailRead_(k, '', true);
  }
  const o = unkey_(k);
  if (!o || !o.mail) return answer('לא מצאתי, תחפש שוב');
  let it;
  try { it = mailItem_(o); } catch (e) { log('mail print', String(e)); }
  const b = it && it.files[Number(arg) || 0];
  if (!b) return answer('לא מצאתי את הקובץ');
  answer('נכנס לתור');
  mailPrint_(b, o.mail === 'g' ? 'gmail' : 'drive');
}

// a file from an email / Drive into the print queue (Print.gs): Drive copy first, so the laptop never needs Telegram
function mailPrint_(blob, source, caption, title) { // caption: print options, e.g. '1 בלי תמונות'; title: first line of the queue message
  caption = caption || '';
  const id = Utilities.getUuid().slice(0, 8), name = blob.getName() || 'file.pdf';
  const stamp = Utilities.formatDate(new Date(), HOME_TZ, 'yyyy-MM-dd HHmm');
  const driveId = printFolder_().createFile(blob.copyBlob().setName(stamp + ' ' + name).setContentType('application/pdf')).getId();
  const t = jobsTab_();
  t.appendRow([id, new Date(), name, caption, 'waiting', 0, '', driveId, '', '', '', '', '', source]);
  P.setProperty('JOBS_PENDING', '1');
  const where = laptopOnline_() ? '💻 המחשב מחובר, יודפס בעוד פחות מדקה.' : '💤 המחשב לא מחובר כרגע. אדפיס כשיחזור ואעדכן.';
  const r = send((title ? title + '\n' : '') + '🖨️ בתור להדפסה: ' + name + '\n' + captionSummary_(caption) + '\n' + where, [[{ text: 'בטל הדפסה', callback_data: 'pc:' + id }]]);
  const row = rowOf_(t, id);
  if (r.ok && row) setCell_(t, row, 'bot_msg_id', r.result.message_id);
}
