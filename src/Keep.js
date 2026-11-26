// ===== Office Manager Cloud: shopping list in Google Keep (add only) =====
// Pablo says "תוסיף לקניות חלב, ביצים ולחם" (usually by voice, while driving). Gemini splits the items,
// they wait in the "keep" tab, and the laptop print agent adds them to the Keep list on its next pull
// (Keep has no API for a personal account, so gkeepapi runs on the laptop; its master token never leaves it).
// One Telegram message per request: "🛒 נשמר" and it is edited to "✅ בקיפ" when the laptop is done.
// Showing / checking off / deleting stays in the Keep app on the phone (Pablo's choice).
// Hooks: handle() in Code.gs calls keepHandle(); printPull_ in Print.gs hands out keepPull_(); doGet routes keepdone.
// Optional Script Property: KEEP_LIST (default "לקנות").

const KEEP_H = ['id', 'time', 'items', 'status', 'tries', 'sent_at', 'done_at', 'note', 'bot_msg_id'];
const KJ = {}; KEEP_H.forEach((h, i) => { KJ[h] = i; });
const KEEP_TIMEOUT = 10 * 60000, KEEP_RETRY = 5 * 60000, KEEP_DAYS = 3, KEEP_TRIES = 5; // a failed try waits 5 min
const KEEP_RE = /קניות|לקנות|לסופר|למכולת|רשימה/;
// command words Gemini sometimes leaves at the start of an item ("קניות חלב" -> "חלב")
const KEEP_CMD_RE = /^(?:(?:תוסיף|תוסיפי|הוסף|להוסיף|תכניס|תרשום)\s+)?(?:ל?רשימת\s+(?:ה)?(?:קניות|לקנות)|ל?(?:ה)?קניות|לרשימה|לקנות)\s*[:,\-–]?\s*(?=\S)/;
const keepList_ = () => prop('KEEP_LIST') || 'לקנות';
const keepTab_ = () => tab_('keep', KEEP_H);

// true = handled, false = not a shopping-list add (go on as usual), null = Gemini busy (retry later)
function keepHandle(text) {
  if (!KEEP_RE.test(text) || /תזכיר|תזכורת/.test(text)) return false;
  const r = gemini_([{ text: 'The user keeps a shopping list called "' + keepList_() + '". Hebrew message: "' + text + '"\n' +
    'Is the user asking to ADD items to the shopping list? A reminder ("remind me to buy...", or any message with a time or date ' +
    'like "מחר ב-8 לקנות חלב"), a question or anything else is NOT. ' +
    'If yes, split it into separate items exactly as said, in Hebrew, one product per item, keeping a quantity or detail with its item ' +
    '("2 חלב", "שמן זית", "לחם מלא"). Drop the command words ("תוסיף", "קניות", "לקניות", "לרשימת קניות", "לרשימה"): "קניות חלב" = ["חלב"]. ' +
    'Answer JSON only: {"add": true, "items": ["..."]} or {"add": false}.' }]);
  if (r === null) return null;
  const items = (r.add && Array.isArray(r.items) ? r.items : []).map(s => String(s).replace(KEEP_CMD_RE, '').trim()).filter(String).slice(0, 30);
  if (!items.length) return false;
  const online = laptopOnline_(); // Print.gs
  const res = send('🛒 ' + items.join(', ') + '\n' + (online ? 'מוסיף לקיפ…' : 'נשמר. אוסיף לקיפ כשהמחשב בבית יידלק.'));
  const msgId = res && res.result ? res.result.message_id : '';
  keepTab_().appendRow([Utilities.getUuid().slice(0, 8), new Date(), JSON.stringify(items), 'waiting', 0, '', '', '', msgId]);
  P.setProperty('KEEP_PENDING', '1');
  log('keep queued', items);
  return true;
}

// called from printPull_ when no print or fetch job waits: the oldest keep job, or null
function keepPull_() {
  if (!prop('KEEP_PENDING')) return null;
  const t = keepTab_(), rows = t.getDataRange().getValues();
  let pick = -1, open = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    let st = r[KJ.status];
    if (st === 'sent' && Date.now() - new Date(r[KJ.sent_at]).getTime() > KEEP_TIMEOUT) t.getRange(i + 1, KJ.status + 1).setValue(st = 'waiting');
    if (st === 'waiting' && (Date.now() - new Date(r[KJ.time]).getTime() > KEEP_DAYS * 864e5 || Number(r[KJ.tries] || 0) >= KEEP_TRIES)) {
      keepFail_(t, i + 1, r, r[KJ.note] || 'המחשב לא היה דלוק 3 ימים'); continue;
    }
    if (st === 'waiting' || st === 'sent') open++;
    const resting = r[KJ.sent_at] && Date.now() - new Date(r[KJ.sent_at]).getTime() < KEEP_RETRY; // failed a moment ago
    if (st === 'waiting' && pick < 0 && !resting) pick = i;
  }
  if (!open) P.deleteProperty('KEEP_PENDING');
  if (pick < 0) return null;
  const r = rows[pick], row = pick + 1;
  t.getRange(row, KJ.status + 1, 1, 3).setValues([['sent', Number(r[KJ.tries] || 0) + 1, new Date()]]);
  return { id: String(r[KJ.id]), list: keepList_(), items: JSON.parse(r[KJ.items]) };
}

// doGet ?action=keepdone&id=..&status=ok|fail&msg=..  (ok: msg = JSON {added: [], dup: []})
function keepDone_(q) {
  const lock = LockService.getUserLock();
  if (!lock.tryLock(10000)) return out_('busy'); // the laptop keeps the answer and sends it again
  try {
    const t = keepTab_(), rows = t.getDataRange().getValues();
    const i = rows.findIndex((r, k) => k && String(r[KJ.id]) === String(q.id));
    if (i < 0) return out_('ok');
    const r = rows[i], row = i + 1;
    if (r[KJ.status] === 'done' || r[KJ.status] === 'failed') return out_('ok'); // repeated answer
    if (q.status === 'ok') {
      let res = {};
      try { res = JSON.parse(q.msg || '{}'); } catch (e) {}
      const added = res.added || [], dup = res.dup || [];
      t.getRange(row, KJ.status + 1, 1, 5).setValues([['done', r[KJ.tries], r[KJ.sent_at], new Date(), JSON.stringify(res).slice(0, 300)]]);
      keepEdit_(r, '✅ ב"' + keepList_() + '": ' + (added.length ? added.join(', ') : '—') +
        (dup.length ? '\nכבר היו ברשימה: ' + dup.join(', ') : ''));
    } else { // try again on the next pull; keepPull_ gives up after KEEP_TRIES
      t.getRange(row, KJ.status + 1, 1, 5).setValues([['waiting', r[KJ.tries], new Date(), '', String(q.msg || 'שגיאה במחשב').slice(0, 300)]]); // sent_at = when it failed
      P.setProperty('KEEP_PENDING', '1');
    }
    log('keep done', r[KJ.id], q.status, q.msg || '');
    return out_('ok');
  } finally { lock.releaseLock(); }
}

function keepFail_(t, row, r, why) {
  t.getRange(row, KJ.status + 1).setValue('failed');
  t.getRange(row, KJ.note + 1).setValue(why);
  send('⚠️ לא הוספתי לקיפ: ' + JSON.parse(r[KJ.items]).join(', ') + '\n(' + String(why).slice(0, 120) + ')'); // a new message, so it is noticed
}

// edit the "🛒" message in place (one message per request, no extra ping); a new message if the edit fails
function keepEdit_(r, text) {
  const id = Number(r[KJ.bot_msg_id] || 0);
  const j = id ? tg('editMessageText', { chat_id: prop('ALLOWED_USER_ID'), message_id: id, text }) : null;
  if (!j || !j.ok) send(text);
}
