// ===== Office Manager Cloud: bills from email -> Telegram =====
// A bill email from a known sender gets the Gmail label OM/חשבונות. On the tick (every BILL_EVERY_MIN minutes)
// OM takes every thread with that label, runs the sender's rule from BILL_RULES (fetch the bill PDF, send it on
// Telegram, optionally print / save to Drive), then moves the thread to OM/טופל so nothing runs twice.
// OM puts the label on by itself (search by sender, last BILL_LOOKBACK days), so no Gmail filter is needed.
// Pablo can also put OM/חשבונות on any email by hand: it is handled if its sender has a rule.
// A rule that fails is retried on the next ticks; after BILL_TRIES failures Pablo gets the email link and the
// thread moves to OM/טופל (the email itself is never deleted or changed, only labels).
// Some sites refuse Google's servers (Mei Avivim: "Address unavailable"). A rule with via: 'laptop' does not fetch
// from the cloud: it queues the web requests in the "fetch" tab, the laptop print agent picks them up on its next pull
// (doGet ?action=pull), runs them from home and posts the answers back (doPost ?action=fetched). Then the rule
// builds the PDF and handles it as usual. So such a bill arrives only while the laptop is on, like printing.
// Hooks in Code.gs: tick() calls billsTick(), command() routes /bills to billsCmd(), doPost routes action=fetched.
// Print.gs printPull_ hands out fetch jobs. Permissions: GmailApp, UrlFetchApp, DriveApp (all already granted).

const BILL_TODO = 'OM/חשבונות', BILL_DONE = 'OM/טופל';
const BILL_EVERY_MIN = 15;
const BILL_LOOKBACK = '14d'; // an older email is handled only if labeled by hand
const BILL_TRIES = 3;
const FETCH_H = ['id', 'time', 'thread_id', 'rule', 'reqs', 'status', 'tries', 'sent_at', 'note'];
const FJ = {}; FETCH_H.forEach((h, i) => { FJ[h] = i; });
const FETCH_TIMEOUT = 10 * 60000, FETCH_DAYS = 3; // 'sent' with no answer goes back to waiting; give up after 3 days

// one row per sender. from: one or more addresses; subject: optional words the subject must contain.
// get(msg) -> { blob, caption }, or with via: 'laptop': reqs(msg) -> [{url, method?, body?, type?}] and
// build(msg, answers) -> { blob, caption } (answers[i] = {code, text} of reqs[i]). telegram: send the PDF here. print: a print-queue caption ('' = defaults,
// '1 בלי תמונות' = first page, no images), or false. ask: print only after Pablo taps 🖨️ הדפס. drive: also a copy in the Drive folder "OM חשבונות".
const BILL_RULES = [
  { id: 'meiavivim', name: 'מי אביבים (מים)', from: ['noreply@meiavivim.co.il'], via: 'laptop', reqs: meiAvivimReqs_, build: meiAvivimBuild_,
    telegram: true, print: false, drive: false },
  { id: 'meimodiin', name: 'מי מודיעין (מים)', from: ['btm@mei-modiin.co.il', 'btm.mei-modiin@printernet.co.il'], subject: 'חשבון תקופתי',
    get: attachedPdf_('💧 חשבון מים, מי מודיעין'), telegram: false, print: '1 בלי תמונות', ask: true, drive: false }, // page = one template image: pdfclean keeps its dark parts
];

function billLabel_(name) {
  return GmailApp.getUserLabelByName(name) || (GmailApp.getUserLabelByName('OM') || GmailApp.createLabel('OM'), GmailApp.createLabel(name));
}
const billRule_ = m => BILL_RULES.find(r => r.from.some(a => String(m.getFrom()).toLowerCase().indexOf(a) >= 0) &&
  (!r.subject || String(m.getSubject()).indexOf(r.subject) >= 0));
const billQuery_ = r => 'from:(' + r.from.join(' OR ') + ')' + (r.subject ? ' subject:"' + r.subject + '"' : '');

function billsTick(force) {
  if (!force && Date.now() - Number(prop('BILLS_AT') || 0) < BILL_EVERY_MIN * 60000) return;
  P.setProperty('BILLS_AT', String(Date.now()));
  const todo = billLabel_(BILL_TODO), done = billLabel_(BILL_DONE);
  // 1. label new bill emails
  BILL_RULES.forEach(r => GmailApp.search(billQuery_(r) + ' newer_than:' + BILL_LOOKBACK, 0, 20).forEach(th => {
    const names = th.getLabels().map(l => l.getName());
    if (names.indexOf(BILL_DONE) < 0 && names.indexOf(BILL_TODO) < 0) th.addLabel(todo);
  }));
  // 2. handle everything under OM/חשבונות
  let n = 0;
  todo.getThreads(0, 20).forEach(th => {
    const msgs = th.getMessages(), msg = msgs.slice().reverse().find(m => billRule_(m)) || msgs[msgs.length - 1];
    const rule = billRule_(msg), tk = 'bill_try_' + th.getId();
    if (!rule) {
      if (!prop('bill_nr_' + th.getId())) {
        P.setProperty('bill_nr_' + th.getId(), '1');
        send('📬 יש מייל בתווית ' + BILL_TODO + ' בלי כלל טיפול:\n' + mailFrom_(msg.getFrom()) + ': ' + mailCut_(msg.getSubject(), 60) +
          '\nhttps://mail.google.com/mail/#all/' + th.getId());
      }
      return;
    }
    if (n++ >= 3) return; // a few per tick, the rest next time
    try {
      if (rule.via === 'laptop') {
        fetchQueue_(th.getId(), rule, rule.reqs(msg));
        send('🧾 ' + rule.name + ': הגיע חשבון. ' + (laptopOnline_() ? 'המחשב מוריד אותו עכשיו.' : '💤 אוריד אותו כשהמחשב יידלק.'));
      } else billDeliver_(rule, rule.get(msg));
      th.removeLabel(todo); th.addLabel(done); // a laptop job is kept in the "fetch" tab until it is done
      P.deleteProperty(tk);
      log('bill done', rule.id, th.getId());
    } catch (e) {
      const t = Number(prop(tk) || 0) + 1;
      log('bill error', rule.id, th.getId(), t, String(e));
      if (t < BILL_TRIES) return P.setProperty(tk, String(t));
      P.deleteProperty(tk);
      th.removeLabel(todo); th.addLabel(done);
      send('⚠️ לא הצלחתי להוריד את החשבון מ' + rule.name + ' (' + mailCut_(String(e && e.message || e), 80) + ').\nהמייל: https://mail.google.com/mail/#all/' + th.getId());
    }
  });
}

function billDeliver_(rule, b) {
  if (rule.telegram) sendDoc_(b.blob, b.caption);
  if (rule.drive) billFolder_().createFile(b.blob.copyBlob());
  if (rule.print !== false) mailPrint_(b.blob, 'bill:' + rule.id, rule.print, rule.telegram ? '' : b.caption, rule.ask);
}

// ---------- requests run by the laptop ----------
const fetchTab_ = () => tab_('fetch', FETCH_H);

function fetchQueue_(threadId, rule, reqs) {
  const t = fetchTab_(), rows = t.getDataRange().getValues();
  if (rows.some((r, i) => i && r[FJ.thread_id] === threadId && /^(waiting|sent)$/.test(r[FJ.status]))) return; // already queued
  t.appendRow([Utilities.getUuid().slice(0, 8), new Date(), threadId, rule.id, JSON.stringify(reqs), 'waiting', 0, '', '']);
  P.setProperty('FETCH_PENDING', '1');
}

// called from printPull_ when no print job waits: the oldest fetch job, or null
function fetchPull_() {
  if (!prop('FETCH_PENDING')) return null;
  const t = fetchTab_(), rows = t.getDataRange().getValues();
  let pick = -1, open = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i], st = r[FJ.status];
    if (st === 'sent' && Date.now() - new Date(r[FJ.sent_at]).getTime() > FETCH_TIMEOUT) t.getRange(i + 1, FJ.status + 1).setValue(st = 'waiting');
    if (st === 'waiting' && Date.now() - new Date(r[FJ.time]).getTime() > FETCH_DAYS * 864e5) { fetchFail_(t, i + 1, r, 'המחשב לא הוריד את החשבון 3 ימים'); continue; }
    if (st === 'waiting' || st === 'sent') open++;
    if (st === 'waiting' && pick < 0) pick = i;
  }
  if (!open) P.deleteProperty('FETCH_PENDING');
  if (pick < 0) return null;
  const r = rows[pick], row = pick + 1;
  t.getRange(row, FJ.status + 1, 1, 3).setValues([['sent', Number(r[FJ.tries] || 0) + 1, new Date()]]);
  return { id: String(r[FJ.id]), reqs: JSON.parse(r[FJ.reqs]) };
}

// doPost ?action=fetched&id=..., body {answers: [{code, b64}]} (b64 = the response bytes) or {error}
function fetchDone_(id, body) {
  const t = fetchTab_(), rows = t.getDataRange().getValues();
  const i = rows.findIndex((r, k) => k && String(r[FJ.id]) === String(id));
  if (i < 0) return 'ok';
  const r = rows[i], row = i + 1;
  if (r[FJ.status] === 'done' || r[FJ.status] === 'failed') return 'ok'; // repeated answer
  const rule = BILL_RULES.find(x => x.id === r[FJ.rule]);
  try {
    if (body.error) throw new Error('המחשב: ' + body.error);
    const answers = (body.answers || []).map(a => ({ code: a.code, bytes: Utilities.base64Decode(a.b64 || ''),
      get text() { return Utilities.newBlob(this.bytes).getDataAsString('UTF-8'); } }));
    const msg = GmailApp.getThreadById(r[FJ.thread_id]).getMessages().slice().reverse().find(m => billRule_(m));
    billDeliver_(rule, rule.build(msg, answers));
    t.getRange(row, FJ.status + 1).setValue('done');
    log('fetch done', id, rule.id);
  } catch (e) {
    log('fetch error', id, String(e));
    if (Number(r[FJ.tries] || 0) < BILL_TRIES) { t.getRange(row, FJ.status + 1, 1, 4).setValues([['waiting', r[FJ.tries], '', String(e).slice(0, 200)]]); P.setProperty('FETCH_PENDING', '1'); }
    else fetchFail_(t, row, r, String(e && e.message || e));
  }
  return 'ok';
}

function fetchFail_(t, row, r, why) {
  t.getRange(row, FJ.status + 1).setValue('failed');
  t.getRange(row, FJ.note + 1).setValue(why);
  const rule = BILL_RULES.find(x => x.id === r[FJ.rule]) || { name: r[FJ.rule] };
  send('⚠️ לא הצלחתי להוריד את החשבון מ' + rule.name + ' (' + mailCut_(why, 80) + ').\nהמייל: https://mail.google.com/mail/#all/' + r[FJ.thread_id]);
}

function billFolder_() {
  const id = prop('BILLS_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const f = DriveApp.createFolder('OM חשבונות');
  P.setProperty('BILLS_FOLDER_ID', f.getId());
  return f;
}

// /bills: run now and show the rules
function billsCmd() {
  billsTick(true);
  const waiting = billLabel_(BILL_TODO).getThreads(0, 20).length;
  send('🧾 חשבונות ממייל (בדיקה כל ' + BILL_EVERY_MIN + ' דקות):\n' +
    BILL_RULES.map(r => '• ' + r.name + ': ' + [r.telegram && 'PDF לטלגרם', r.print !== false && (r.ask ? 'הדפסה אחרי אישור (' : 'הדפסה (') + captionSummary_(r.print) + ')',
      r.drive && 'שמירה בדרייב'].filter(Boolean).join(' + ')).join('\n') +
    '\n\nמחכים לטיפול בתווית ' + BILL_TODO + ': ' + waiting);
}

// ---------- Mei Avivim: the email links (via webversion.net, base64 in lstr=) to invoice.html?uid=UUID; no login ----------
// The site refuses Google's servers, so the two requests run on the laptop (via: 'laptop').
const MEI_AVIVIM = 'https://mei-avivim.digitalnow.co.il';
function meiAvivimUid_(msg) {
  const html = msg.getBody();
  let uid = '';
  (html.match(/lstr=[A-Za-z0-9+\/=%_-]+/g) || []).some(s => {
    try {
      const v = Utilities.newBlob(Utilities.base64Decode(decodeURIComponent(s.slice(5)).replace(/-/g, '+').replace(/_/g, '/'))).getDataAsString();
      const m = v.match(/invoice\.html\?uid=([0-9a-f-]{36})/i);
      if (m) uid = m[1];
    } catch (e) {}
    return !!uid;
  });
  if (!uid) { const m = html.match(/invoice\.html\?uid=([0-9a-f-]{36})/i); if (m) uid = m[1]; }
  if (!uid) throw new Error('לא מצאתי במייל קישור לחשבונית');
  return uid;
}
function meiAvivimReqs_(msg) {
  const uid = meiAvivimUid_(msg);
  return [{ url: MEI_AVIVIM + '/api/getInvoicePDF?UUID=' + uid },
    { url: MEI_AVIVIM + '/api/GetJSONfromUUID', method: 'POST', type: 'application/json', body: JSON.stringify({ UUID: uid }) }];
}
function meiAvivimBuild_(msg, answers) {
  const a = answers[0] || {};
  if (a.code !== 200) throw new Error('PDF HTTP ' + a.code);
  const pdf = String(JSON.parse(a.text).pdf || '');
  if (pdf.indexOf('base64,') < 0) throw new Error('האתר לא החזיר PDF');
  let info = {};
  try { if (answers[1] && answers[1].code === 200) info = JSON.parse(answers[1].text); } catch (e) { log('meiavivim info', String(e)); }
  const per = String(info.tkufa || '').replace(/\s/g, ''); // "06-2026"
  const name = 'מי אביבים ' + (per || Utilities.formatDate(msg.getDate(), HOME_TZ, 'yyyy-MM')) + '.pdf';
  const blob = Utilities.newBlob(Utilities.base64Decode(pdf.split('base64,')[1]), 'application/pdf', name);
  const caption = '💧 חשבון מים, מי אביבים' + (per ? ', תקופה ' + per : '') +
    (info.sumToPay ? '\nלתשלום: ₪' + info.sumToPay + (info.payDate ? ' עד ' + info.payDate : '') : '') +
    (info.camut ? '\nצריכה: ' + info.camut + ' מ״ק' + (info.dayes ? ' ב-' + info.dayes + ' ימים' : '') : '');
  return { blob, caption };
}

// ---------- a bill that comes as a PDF attachment (Mei Modiin) ----------
function attachedPdf_(title) {
  return msg => {
    const a = msg.getAttachments().find(x => x.getContentType() === 'application/pdf' || /\.pdf$/i.test(x.getName()));
    if (!a) throw new Error('אין PDF מצורף במייל');
    return { blob: a.copyBlob().setName(a.getName()), caption: title + ', ' + Utilities.formatDate(msg.getDate(), HOME_TZ, 'd.M.yy') };
  };
}
