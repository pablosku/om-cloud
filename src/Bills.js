// ===== Office Manager Cloud: bills from email -> Telegram =====
// A bill email from a known sender gets the Gmail label OM/חשבונות. On the tick (every BILL_EVERY_MIN minutes)
// OM takes every thread with that label, runs the sender's rule from BILL_RULES (fetch the bill PDF, send it on
// Telegram, optionally print / save to Drive), then moves the thread to OM/טופל so nothing runs twice.
// OM puts the label on by itself (search by sender, last BILL_LOOKBACK days), so no Gmail filter is needed.
// Pablo can also put OM/חשבונות on any email by hand: it is handled if its sender has a rule.
// A rule that fails is retried on the next ticks; after BILL_TRIES failures Pablo gets the email link and the
// thread moves to OM/טופל (the email itself is never deleted or changed, only labels).
// Hooks in Code.gs: tick() calls billsTick(), command() routes /bills to billsCmd().
// Permissions: GmailApp (already granted for Mail.gs) and UrlFetchApp (already granted).

const BILL_TODO = 'OM/חשבונות', BILL_DONE = 'OM/טופל';
const BILL_EVERY_MIN = 15;
const BILL_LOOKBACK = '14d'; // an older email is handled only if labeled by hand
const BILL_TRIES = 3;

// one row per sender. from: one or more addresses; subject: optional words the subject must contain.
// get(msg) -> { blob, caption }. telegram: send the PDF here. print: a print-queue caption ('' = defaults,
// '1 בלי תמונות' = first page, no images), or false. drive: also a copy in the Drive folder "OM חשבונות".
const BILL_RULES = [
  { id: 'meiavivim', name: 'מי אביבים (מים)', from: ['noreply@meiavivim.co.il'], get: meiAvivim_,
    telegram: true, print: false, drive: false },
  { id: 'meimodiin', name: 'מי מודיעין (מים)', from: ['btm@mei-modiin.co.il', 'btm.mei-modiin@printernet.co.il'], subject: 'חשבון תקופתי',
    get: attachedPdf_('💧 חשבון מים, מי מודיעין'), telegram: false, print: '1 בלי תמונות', drive: false },
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
      const b = rule.get(msg);
      if (rule.telegram) sendDoc_(b.blob, b.caption);
      if (rule.drive) billFolder_().createFile(b.blob.copyBlob());
      if (rule.print !== false) mailPrint_(b.blob, 'bill:' + rule.id, rule.print, rule.telegram ? '' : b.caption);
      th.removeLabel(todo); th.addLabel(done);
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
    BILL_RULES.map(r => '• ' + r.name + ': ' + [r.telegram && 'PDF לטלגרם', r.print !== false && 'הדפסה (' + captionSummary_(r.print) + ')',
      r.drive && 'שמירה בדרייב'].filter(Boolean).join(' + ')).join('\n') +
    '\n\nמחכים לטיפול בתווית ' + BILL_TODO + ': ' + waiting);
}

// ---------- Mei Avivim: the email links (via webversion.net, base64 in lstr=) to invoice.html?uid=UUID; no login ----------
function meiAvivim_(msg) {
  const html = msg.getBody(), base = 'https://mei-avivim.digitalnow.co.il';
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
  const r = UrlFetchApp.fetch(base + '/api/getInvoicePDF?UUID=' + uid, { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('PDF HTTP ' + r.getResponseCode());
  const pdf = String(JSON.parse(r.getContentText()).pdf || '');
  if (pdf.indexOf('base64,') < 0) throw new Error('האתר לא החזיר PDF');
  let info = {};
  try {
    const j = UrlFetchApp.fetch(base + '/api/GetJSONfromUUID', { method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ UUID: uid }), muteHttpExceptions: true });
    if (j.getResponseCode() === 200) info = JSON.parse(j.getContentText('UTF-8'));
  } catch (e) { log('meiavivim info', String(e)); }
  const per = String(info.tkufa || (msg.getPlainBody().match(/20\d\d\s*-\s*\d\d/) || [''])[0]).replace(/\s/g, ''); // "06-2026"
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
