// ===== Mom's account: "לאמא 260 דלק" -> new row (date, amount, item) above the total, after Pablo's OK =====
// Script Property MOM_SHEET_ID = the Google Sheet "אמא חשבון" (columns: תאריך | לאמא | פרטים, a 'סה"כ' row under the data).
// Read without Gemini. Buttons: mm:<key>:y (add) / n (cancel) / u (undo).

// "לאמא 260 דלק", "תוסיף לאמא 260 דלק", "לאמא -3000 משכורת 11.26", "לאמא דלק 260", "לאמא ₪260 דלק"
const MOM_RE = /^(?:(?:תוסיף|תוסיפי|הוסף|תרשום|רשום)\s+)?לאמא[\s:,]+([\s\S]+)$/;
const MOM_AMT = '(-?\\d+(?:[.,]\\d+)?)';
const MOM_CUR = '(?:\\s*(?:₪|ש"ח|ש״ח|שח|שקלים|שקל))?';

// text -> { amount, item } or null when it is not "לאמא <amount> <item>"
function momParse_(text) {
  const m = String(text).trim().match(MOM_RE);
  if (!m) return null;
  const rest = m[1].trim().replace(/[.!]$/, '');
  const a = rest.match(new RegExp('^₪?\\s*' + MOM_AMT + MOM_CUR + '\\s+(.+)$')) ||  // amount first
    rest.match(new RegExp('^(.+?)\\s+₪?\\s*' + MOM_AMT + MOM_CUR + '$'));          // item first
  if (!a) return null;
  const first = /^₪?\s*-?\d/.test(rest);
  const amount = Number((first ? a[1] : a[2]).replace(',', '.')), item = (first ? a[2] : a[1]).trim();
  return isFinite(amount) && item ? { amount, item } : null;
}

function momSheet_() {
  const id = prop('MOM_SHEET_ID');
  return id ? SpreadsheetApp.openById(id).getSheets()[0] : null;
}

// rows of the sheet: total = the 'סה"כ' row, last = the last row with data above it
function momRows_(sh) {
  const vals = sh.getRange(1, 1, sh.getLastRow(), 3).getDisplayValues();
  let total = 0;
  for (let i = vals.length - 1; i >= 0; i--) if (/סה.?כ/.test(vals[i][0])) { total = i + 1; break; }
  if (!total) return null;
  let last = total - 1;
  while (last > 1 && !vals[last - 1].join('').trim()) last--;
  return { total, last };
}

// called from onMessage / a transcribed voice message. false = not this command
function momCmd(text) {
  const p = momParse_(text);
  if (!p) return false;
  if (!prop('MOM_SHEET_ID')) { send('⚠️ חשבון אמא לא מוגדר (חסר MOM_SHEET_ID).'); return true; }
  const date = Utilities.formatDate(new Date(), HOME_TZ, 'd.M.yy');
  const k = key_({ date, amount: p.amount, item: p.item }), b = (t, a) => ({ text: t, callback_data: 'mm:' + k + ':' + a });
  send('💰 לחשבון אמא:\n' + date + ' · ' + p.amount + ' · ' + p.item + '\n\nלהוסיף?', [[b('✅ כן', 'y'), b('❌ לא', 'n')]]);
  return true;
}

function momButton(q, k, arg) {
  const msg = q.message;
  const finish = (note, line, kb) => {
    tg('answerCallbackQuery', { callback_query_id: q.id, text: note });
    tg('editMessageText', { chat_id: msg.chat.id, message_id: msg.message_id, text: msg.text + (line ? '\n' + line : ''),
      reply_markup: { inline_keyboard: kb || [] } });
  };
  const o = unkey_(k);
  if (!o) return finish('לא מצאתי, אולי פג תוקף', '');
  if (arg === 'n') return finish('לא הוספתי', '❌ לא הוספתי');
  const undoKb = [[{ text: '↩️ בטל', callback_data: 'mm:' + k + ':u' }]];
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
    const sh = momSheet_();
    if (!sh) return finish('', '⚠️ חשבון אמא לא מוגדר (חסר MOM_SHEET_ID).');
    if (arg === 'y') {
      if (o.row) return finish('כבר נוסף', '', o.undone ? [] : undoKb);
      const r = momRows_(sh);
      if (!r) return finish('', '⚠️ לא מצאתי את שורת הסה״כ בקובץ. לא הוספתי.');
      sh.insertRowAfter(r.last);
      const row = r.last + 1, cells = sh.getRange(row, 1, 1, 3);
      sh.getRange(r.last, 1, 1, 3).copyTo(cells, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
      sh.getRange(row, 1).setNumberFormat('@'); // the dates in the file are text like "27.11.26"
      cells.setValues([[o.date, o.amount, o.item]]);
      momFixSum_(sh, row);
      SpreadsheetApp.flush();
      o.row = row; rekey_(k, o);
      return finish('נוסף', '✅ נוסף. סה״כ יתרה: ' + momTotal_(sh), undoKb);
    }
    if (arg === 'u') {
      if (o.undone || !o.row) return finish('כבר בוטל', '');
      const got = sh.getRange(o.row, 1, 1, 3).getValues()[0];
      if (String(got[0]) !== o.date || Number(got[1]) !== o.amount || String(got[2]) !== o.item)
        return finish('', '⚠️ השורה זזה או השתנתה בקובץ. לא מחקתי, אפשר למחוק ידנית.');
      sh.deleteRow(o.row);
      SpreadsheetApp.flush();
      o.undone = true; rekey_(k, o);
      return finish('בוטל', '↩️ בוטל. סה״כ יתרה: ' + momTotal_(sh));
    }
  } catch (e) {
    log('mom error', String(e && e.stack || e));
    return finish('', '⚠️ לא הצלחתי לעדכן את הקובץ: ' + String(e).slice(0, 150));
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// a row added right above the total is not inside SUM(B2:B<row-1>): stretch every range that ends just above it
function momFixSum_(sh, row) {
  const r = momRows_(sh);
  if (!r) return;
  const cell = sh.getRange(r.total, 2), f = cell.getFormula();
  if (!f) return;
  const nf = f.replace(/:([A-Z]+\$?)(\d+)/g, (all, col, n) => Number(n) === row - 1 ? ':' + col + row : all);
  if (nf !== f) cell.setFormula(nf);
}

function momTotal_(sh) {
  const r = momRows_(sh);
  return r ? sh.getRange(r.total, 2).getDisplayValue() : '?';
}
