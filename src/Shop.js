// Shopping: the "לקנות" note of the board, as the family page (via the Cloudflare Worker) and OM voice (Keep.js) use it.
// Data lives in board_items like any note (Board.js); the order is the same pos as on the board.

// ---------- shopping: the family page (via the Worker) and OM voice ----------
// "לקנות" in the order the board shows it: rows = [{id, t, k ('sep' = a line), done, pos}], seps = the lines only.
function shopRead_() {
  const id = boardShopList_(), t = boardItemsTab_(), v = t.getDataRange().getValues();
  boardNorm_(t, v, id);
  const rows = [];
  v.forEach((r, i) => { if (i && r[BI.id] && !r[BI.deleted] && String(r[BI.list]) === id)
    rows.push({ id: String(r[BI.id]), t: String(r[BI.text]), k: r[BI.kind] === 'sep' ? 'sep' : '', done: r[BI.done] === true, pos: Number(r[BI.pos] || 0), n: i }); });
  const seq = boardSeq_(rows).map(x => ({ id: x.id, t: x.t, k: x.k, done: x.done, pos: x.pos }));
  return { rows: seq, seps: seq.filter(x => x.k === 'sep').map(x => ({ id: x.id, t: x.t })) };
}
// add items to "לקנות" (OM voice and the family page). store = a line label ("טמבור") or '': the items go at the end
// of that part (a new label makes a line at the bottom), else at the end of the top part.
// Returns {added: [], dup: []}: an item already open on the list is not added twice.
function shopAdd_(names, store) {
  const id = boardShopList_(), now = new Date(), t = boardItemsTab_();
  const rows = shopRead_().rows, norm = x => String(x).replace(/\s+/g, ' ').trim();
  let at = rows.findIndex(x => x.k === 'sep'); if (at < 0) at = rows.length;
  if (store) {
    const s = rows.findIndex(x => x.k === 'sep' && norm(x.t) === norm(store));
    if (s >= 0) { at = s + 1; while (at < rows.length && rows[at].k !== 'sep') at++; }
    else { const p = (rows.length ? Math.max.apply(null, rows.map(x => x.pos)) : 0) + 1;
      t.appendRow([bid_(), id, norm(store).slice(0, 60), false, false, '', '', '', '', now, now, '', 'sep', '', p]);
      rows.push({ k: 'sep', pos: p }); at = rows.length; }
  }
  let lo = at > 0 ? rows[at - 1].pos : 0;
  const hi = at < rows.length ? rows[at].pos : null;
  const open = {}; rows.forEach(x => { if (x.k !== 'sep' && !x.done) open[norm(x.t)] = 1; });
  const res = { added: [], dup: [] };
  names.map(norm).filter(String).forEach(n => {
    if (open[n]) { res.dup.push(n); return; }
    open[n] = 1; res.added.push(n);
    const p = hi === null ? lo + 1 : (lo + hi) / 2; lo = p;
    t.appendRow([bid_(), id, n.slice(0, 200), false, false, '', '', '', '', now, now, '', '', '', p]);
  });
  return res;
}
// doGet ?s=URL_SECRET&action=shop&f=FAMILY_KEY&op=<json> (the Worker calls it). Family ops only: read, add, tick, new order, clear.
function shopApi_(q) {
  if (!prop('FAMILY_KEY') || q.f !== prop('FAMILY_KEY')) return json_({ error: 'key' });
  const op = q.op ? JSON.parse(q.op) : { t: 'get' };
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (op.t === 'add') { const st = String(op.store || ''); // a store only if that line exists (the family does not make lines)
      shopAdd_([String(op.text || '').slice(0, 200)], shopRead_().seps.some(x => x.t === st) ? st : ''); }
    if (op.t === 'order') { const mine = {}; shopRead_().rows.forEach(x => mine[x.id] = 1); // ↑ ↓: the rows top to bottom
      const ids = (op.ids || []).map(String); if (ids.length && ids.every(x => mine[x])) boardDo_({ t: 'list.reorder', ids }); }
    if (op.t === 'done' && shopRead_().rows.some(x => x.id === op.id && x.k !== 'sep')) rowSet_('board_items', BI_H, op.id, { done: !!op.done, updated: new Date() });
    if (op.t === 'clear') { const t = boardItemsTab_(), v = t.getDataRange().getValues(), id = boardShopList_();
      v.forEach((r, i) => { if (i && String(r[BI.list]) === id && r[BI.done] === true && !r[BI.deleted]) t.getRange(i + 1, BI.deleted + 1).setValue(new Date()); }); }
  } finally { lock.releaseLock(); }
  return json_(shopRead_());
}
// doGet ?s=URL_SECRET&action=shoppage&f=FAMILY_KEY: the family page as plain HTML text (the Worker serves it)
function shopPage_(q) {
  if (!prop('FAMILY_KEY') || q.f !== prop('FAMILY_KEY')) return out_('no');
  return ContentService.createTextOutput(HtmlService.createHtmlOutputFromFile('FamilyPage').getContent());
}
// the family link: the Worker's address (from the Telegram webhook) + /shop?f=FAMILY_KEY. "/family חדש" makes a new key.
function familyLink_(fresh) {
  if (fresh || !prop('FAMILY_KEY')) P.setProperty('FAMILY_KEY', Utilities.getUuid().replace(/-/g, ''));
  const w = tg('getWebhookInfo', {}), u = w && w.result && w.result.url;
  if (!u) return null;
  return u.replace(/^(https:\/\/[^\/]+).*$/, '$1') + '/shop?f=' + prop('FAMILY_KEY');
}
