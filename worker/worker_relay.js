// Cloudflare Worker "om-relay"
// 1. Telegram webhook relay -> Apps Script web app (spike S3c)
//    Telegram cannot follow the 302 that Apps Script returns. The Worker follows it,
//    and answers Telegram 200 ONLY after Apps Script answered "ok".
//    Otherwise it answers 500, so Telegram retries and nothing is lost.
// 2. (27.11, v26) The family shopping page: GET /shop?f=FAMILY_KEY shows only the "לקנות" note of Pablo's board.
//    The page talks to /shop/api, and the Worker passes it on to Apps Script (?action=shop) with URL_SECRET,
//    which never reaches the browser. Apps Script checks FAMILY_KEY and allows only: read, add, tick, clear bought.
//    The HTML comes from Apps Script (FamilyPage.html, ?action=shoppage) so changes need no Worker paste.
//    Served from here (not as an Apps Script page) so there is no Google banner, and "Add to Home Screen" works on iPhone and Android.
// 3. (28.11) Microphone test: GET /mictest?k=MIC_KEY is a blank page with a chat box and two mic tests
//    (speech-to-text in the browser, and a recording sent to Gemini through Apps Script ?action=mictest).
//    Separate key, nothing is saved. Delete this route (and MIC_KEY) once the test is over.
// Worker secrets (Settings -> Variables, type Secret): GAS_URL, URL_SECRET, TG_SECRET, MIC_KEY
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/shop')) return shop(req, env, url);
    if (url.pathname.startsWith('/mictest')) return micTest(req, env, url);
    if (req.method !== 'POST' ||
        req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_SECRET) {
      return new Response('forbidden', { status: 403 });
    }
    const body = await req.text();
    try {
      const r = await fetch(env.GAS_URL + '?s=' + encodeURIComponent(env.URL_SECRET), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        redirect: 'follow',
      });
      const ok = (await r.text()).trim().toLowerCase() === 'ok';
      return new Response(ok ? 'ok' : 'gas-error', { status: ok ? 200 : 500 });
    } catch (e) {
      return new Response('relay-error', { status: 502 });
    }
  },
};

const KEY_RE = /^[0-9a-f]{32}$/;

async function shop(req, env, url) {
  const f = url.searchParams.get('f') || '';
  const p = url.pathname;
  if (p === '/shop/icon.png') {
    const bin = Uint8Array.from(atob(ICON), c => c.charCodeAt(0));
    return new Response(bin, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' } });
  }
  if (!KEY_RE.test(f)) return new Response('לא נמצא', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  if (p === '/shop/manifest.json') {
    return Response.json({
      name: 'לקנות', short_name: 'לקנות', lang: 'he', dir: 'rtl', display: 'standalone',
      start_url: '/shop?f=' + f, scope: '/shop', background_color: '#f6e6d6', theme_color: '#f6e6d6',
      icons: [{ src: '/shop/icon.png', sizes: '180x180', type: 'image/png' }],
    });
  }
  if (p === '/shop/api' && req.method === 'POST') {
    const op = await req.text();
    if (op.length > 2000) return new Response('too big', { status: 413 });
    try {
      const r = await fetch(env.GAS_URL + '?s=' + encodeURIComponent(env.URL_SECRET) + '&action=shop&f=' + f +
        '&op=' + encodeURIComponent(op), { redirect: 'follow' });
      return new Response(await r.text(), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    } catch (e) {
      return Response.json({ error: 'relay' }, { status: 502 });
    }
  }
  if (p === '/shop') { // the page itself lives in Apps Script (FamilyPage.html), so changing it needs no paste here
    let page;
    try {
      const r = await fetch(env.GAS_URL + '?s=' + encodeURIComponent(env.URL_SECRET) + '&action=shoppage&f=' + f, { redirect: 'follow' });
      page = await r.text();
    } catch (e) { page = ''; }
    if (!page.startsWith('<!doctype')) return new Response('לא זמין כרגע. נסו שוב בעוד דקה.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' } });
  }
  return new Response('לא נמצא', { status: 404 });
}


// ---------- microphone test (28.11) ----------
async function micTest(req, env, url) {
  const nf = () => new Response('לא נמצא', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const k = url.searchParams.get('k') || '';
  if (!env.MIC_KEY || env.MIC_KEY.length < 16 || k !== env.MIC_KEY) return nf();
  if (url.pathname === '/mictest/stt' && req.method === 'POST') {
    const buf = await req.arrayBuffer();
    if (buf.byteLength > 4e6) return Response.json({ error: 'ההקלטה ארוכה מדי לבדיקה' }, { status: 413 });
    const u = new Uint8Array(buf); let bin = '';
    for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    try {
      const r = await fetch(env.GAS_URL + '?s=' + encodeURIComponent(env.URL_SECRET) + '&action=mictest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'follow',
        body: JSON.stringify({ mime: req.headers.get('Content-Type') || '', b64: btoa(bin) }),
      });
      const t = await r.text();
      if (!t.startsWith('{')) return Response.json({ error: 'OM עוד לא מכיר את הבדיקה (צריך עדכון גרסה)' });
      return new Response(t, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    } catch (e) {
      return Response.json({ error: 'relay' }, { status: 502 });
    }
  }
  if (url.pathname === '/mictest') {
    return new Response(MIC_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'microphone=(self)' } });
  }
  return nf();
}

const MIC_PAGE = String.raw`<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>בדיקת מיקרופון</title>
<style>
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{font:16px/1.4 system-ui,-apple-system,"Segoe UI",Arial,sans-serif;background:#f6e6d6;color:#333;display:flex;flex-direction:column}
header{padding:12px 16px 4px;font-weight:600}#diag{font-size:12px;color:#7a6a5a;padding:0 16px 6px;white-space:pre-line}
#chat{flex:1;overflow-y:auto;padding:8px 16px;display:flex;flex-direction:column;gap:8px}
.b{max-width:85%;padding:8px 12px;border-radius:16px;background:#fff;box-shadow:0 1px 3px #0001;align-self:flex-start;word-wrap:break-word}
.b.sys{align-self:center;background:transparent;box-shadow:none;color:#7a6a5a;font-size:13px;text-align:center}
.b audio{display:block;width:240px;max-width:100%;margin-top:6px}.b small{color:#7a6a5a;display:block;margin-top:4px}
footer{display:flex;gap:8px;padding:10px 12px calc(10px + env(safe-area-inset-bottom));background:#fff8f1;border-top:1px solid #ead7c4;align-items:center}
#txt{flex:1;min-width:0;font:inherit;padding:10px 14px;border-radius:22px;border:1px solid #ddc8b3;background:#fff}
button{font:inherit;border:0;border-radius:50%;width:44px;height:44px;flex:none;background:#fff;box-shadow:0 1px 3px #0002;font-size:20px;cursor:pointer}
button.on{background:#e8553e;color:#fff;animation:p 1s infinite}@keyframes p{50%{opacity:.6}}
button:disabled{opacity:.35}
</style></head><body>
<header>בדיקת מיקרופון</header>
<div id="diag"></div>
<div id="chat"><div class="b sys">🗣 = דיבור לטקסט בדפדפן (המילים נכתבות בתיבה)<br>🎙 = הקלטה, ואז Gemini מתמלל<br>➤ = שליחה לצ'אט (לא נשלח לשום מקום אחר)</div></div>
<footer>
<button id="stt" title="דיבור לטקסט">🗣</button>
<button id="rec" title="הקלטה">🎙</button>
<input id="txt" placeholder="כתוב או דבר…" autocomplete="off">
<button id="send" title="שליחה">➤</button>
</footer>
<script>
const $ = id => document.getElementById(id), chat = $('chat'), txt = $('txt');
const KEY = new URLSearchParams(location.search).get('k') || '';
function bubble(html, cls) { const d = document.createElement('div'); d.className = 'b' + (cls ? ' ' + cls : ''); d.innerHTML = html; chat.appendChild(d); chat.scrollTop = chat.scrollHeight; return d; }
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sys = s => bubble(esc(s), 'sys');

// what this browser can do
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const MIMES = ['audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
const MIME = window.MediaRecorder ? (MIMES.find(m => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '') : null;
$('diag').textContent = [
  'מאובטח (https): ' + (window.isSecureContext ? '✅' : '❌'),
  'גישה למיקרופון: ' + (navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? '✅' : '❌'),
  'דיבור לטקסט: ' + (SR ? '✅' : '❌ לא נתמך בדפדפן הזה'),
  'הקלטה: ' + (MIME === null ? '❌' : '✅ ' + (MIME || 'ברירת מחדל')),
].join('   ·   ');
if (navigator.permissions) navigator.permissions.query({ name: 'microphone' }).then(p => {
  const show = () => { $('diag').dataset.p = p.state; }; show(); p.onchange = () => sys('הרשאת מיקרופון: ' + p.state);
}).catch(() => {});

function send() { const t = txt.value.trim(); if (!t) return; bubble(esc(t)); txt.value = ''; }
$('send').onclick = send; txt.onkeydown = e => { if (e.key === 'Enter') send(); };

// 1. speech-to-text in the browser (he-IL)
let rec = null, base = '';
$('stt').disabled = !SR;
$('stt').onclick = () => {
  if (rec) { rec.stop(); return; }
  rec = new SR(); rec.lang = 'he-IL'; rec.interimResults = true; rec.continuous = true;
  base = txt.value ? txt.value + ' ' : ''; const t0 = Date.now();
  rec.onresult = e => { let s = ''; for (const r of e.results) s += r[0].transcript; txt.value = base + s; };
  rec.onerror = e => sys('דיבור לטקסט: שגיאה ' + e.error);
  rec.onend = () => { $('stt').classList.remove('on'); sys('דיבור לטקסט נעצר אחרי ' + Math.round((Date.now() - t0) / 1000) + ' שניות'); rec = null; };
  try { rec.start(); $('stt').classList.add('on'); } catch (e) { sys('לא הצלחתי להתחיל: ' + e.message); rec = null; }
};

// 2. record -> play back -> Gemini
let mr = null, stream = null, chunks = [], t1 = 0;
$('rec').disabled = MIME === null;
$('rec').onclick = async () => {
  if (mr) { mr.stop(); return; }
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch (e) { sys('אין גישה למיקרופון: ' + e.name + (e.message ? ' (' + e.message + ')' : '')); return; }
  chunks = []; mr = MIME ? new MediaRecorder(stream, { mimeType: MIME }) : new MediaRecorder(stream);
  mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  mr.onstop = () => {
    stream.getTracks().forEach(t => t.stop()); $('rec').classList.remove('on');
    const type = mr.mimeType || MIME || 'audio/webm', blob = new Blob(chunks, { type }), sec = Math.round((Date.now() - t1) / 1000); mr = null;
    const b = bubble('🎙 הקלטה ' + sec + ' שנ׳<audio controls src="' + URL.createObjectURL(blob) + '"></audio><small>מתמלל…</small>');
    fetch('/mictest/stt?k=' + encodeURIComponent(KEY), { method: 'POST', headers: { 'Content-Type': type }, body: blob })
      .then(r => r.json()).then(j => { b.querySelector('small').textContent = j.error ? '⚠️ ' + j.error : (j.text ? '📝 ' + j.text : '(לא נשמע דיבור)'); if (j.text) txt.value = j.text; })
      .catch(e => { b.querySelector('small').textContent = '⚠️ ' + e.message; });
  };
  mr.start(); t1 = Date.now(); $('rec').classList.add('on');
};
</script></body></html>`;


const ICON = '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';
