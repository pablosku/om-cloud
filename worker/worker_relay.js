// Cloudflare Worker "om-relay"
// 1. Telegram webhook relay -> Apps Script web app (spike S3c)
//    Telegram cannot follow the 302 that Apps Script returns. The Worker follows it,
//    and answers Telegram 200 ONLY after Apps Script answered "ok".
//    Otherwise it answers 500, so Telegram retries and nothing is lost.
// 2. (27.11, v26) The family shopping page: GET /shop?f=FAMILY_KEY shows only the "לקנות" note of Pablo's board.
//    The page talks to /shop/api, and the Worker passes it on to Apps Script (?action=shop) with URL_SECRET,
//    which never reaches the browser. Apps Script checks FAMILY_KEY and allows only: read, add, tick, clear bought.
//    Served from here (not from Apps Script) so there is no Google banner, and "Add to Home Screen" works on iPhone and Android.
// Worker secrets (Settings -> Variables, type Secret): GAS_URL, URL_SECRET, TG_SECRET
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/shop')) return shop(req, env, url);
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
  if (p === '/shop') {
    return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' } });
  }
  return new Response('לא נמצא', { status: 404 });
}

const PAGE = `<!doctype html>
<html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>לקנות</title>
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="לקנות">
<meta name="theme-color" content="#f6e6d6">
<link rel="apple-touch-icon" href="/shop/icon.png">
<link id="mf" rel="manifest">
<style>
:root{--bg:#f6e6d6;--note:#fbf3ec;--edge:#e8d6c6;--ink:#3a2a1f;--muted:#9a8676;--line:#e3d0be;--accent:#b5541c;--done:#b3a191}
@media (prefers-color-scheme:dark){:root{--bg:#231b16;--note:#2e241e;--edge:#43352b;--ink:#efe3d8;--muted:#a8978a;--line:#4a3b30;--accent:#e08a55;--done:#7c6d62}}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{margin:0;background:var(--bg);color:var(--ink);font-family:Rubik,"Segoe UI",Arial,sans-serif;
  padding:max(14px,env(safe-area-inset-top)) 16px max(24px,env(safe-area-inset-bottom))}
.note{background:var(--note);border:1px solid var(--edge);border-radius:16px;box-shadow:0 1px 2px rgba(90,50,20,.16),0 4px 14px rgba(90,50,20,.07);
  padding:6px 16px 14px;max-width:560px;margin:0 auto}
h1{font-weight:500;font-size:1.5rem;margin:10px 0 6px}
ul{list-style:none;margin:0;padding:0}
li.it{display:flex;align-items:flex-start;gap:10px;font-size:1.1rem;line-height:1.3;padding:7px 0}
li.it input{appearance:none;-webkit-appearance:none;width:20px;height:20px;border:1.5px solid var(--muted);border-radius:4px;flex:none;margin:2px 0 0;display:grid;place-content:center;background:transparent}
li.it input:checked{border-color:var(--accent)}
li.it input:checked::after{content:"";width:10px;height:6px;border:2px solid var(--accent);border-top:0;border-right:0;transform:rotate(-45deg) translate(1px,-1px)}
li.it.done span{text-decoration:line-through;color:var(--done)}
li.sep{display:flex;align-items:center;gap:6px;margin:12px 0 2px;color:var(--muted);font-size:.85rem}
li.sep::after{content:"";flex:1;border-top:1px solid var(--line)}
form{display:flex;gap:8px;margin-top:10px}
form input{flex:1;min-width:0;font:inherit;font-size:1.05rem;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--ink);padding:8px 2px}
form input:focus{outline:none;border-bottom-color:var(--accent)}
form button{font:inherit;border:0;background:var(--accent);color:#fff;border-radius:10px;padding:6px 14px}
.bought{margin-top:14px;color:var(--muted);font-size:.9rem;display:flex;align-items:center;gap:10px}
.bought button{font:inherit;font-size:.85rem;border:0;background:none;color:var(--muted);text-decoration:underline;padding:4px}
.msg{text-align:center;color:var(--muted);padding:30px 0}
.toast{position:fixed;bottom:max(16px,env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:8px 14px;border-radius:10px;font-size:.9rem}
.hint{color:var(--muted);font-size:.8rem;margin-top:6px}
</style></head><body>
<main class="note"><h1>לקנות</h1><ul id="list"><li class="msg">טוען…</li></ul>
<form id="f" autocomplete="off"><input id="t" placeholder="+ מה לקנות?" enterkeyhint="done" aria-label="פריט חדש"><button>הוסף</button></form>
<div class="hint" id="h">אפשר לכתוב "טמבור: ברגים" כדי להוסיף מתחת לחנות.</div>
<div class="bought" id="b" hidden></div><ul id="dl" hidden></ul></main>
<script>
const F=new URLSearchParams(location.search).get('f')||'';
document.getElementById('mf').href='/shop/manifest.json?f='+F;
let D=null,busy=0,showDone=false;
const $=id=>document.getElementById(id);
function toast(t){const d=document.createElement('div');d.className='toast';d.textContent=t;document.body.append(d);setTimeout(()=>d.remove(),3000)}
async function api(op){
  busy++;
  try{const r=await fetch('/shop/api?f='+F,{method:'POST',body:JSON.stringify(op)});const j=await r.json();
    if(j.error){render(j.error==='key'?'הקישור הזה כבר לא פעיל. בקשו מפבלו קישור חדש.':'משהו השתבש. נסו שוב.');return}
    D=j;render()}
  catch(e){toast('אין חיבור. נסו שוב.')}
  finally{busy--}
}
function el(tag,cls,txt){const e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e}
function itemEl(i){
  const li=el('li','it'+(i.done?' done':''));const cb=el('input');cb.type='checkbox';cb.checked=i.done;cb.setAttribute('aria-label','נקנה: '+i.t);
  cb.addEventListener('change',()=>{i.done=cb.checked;render();api({t:'done',id:i.id,done:i.done})});
  li.append(cb,el('span',null,i.t));return li}
function render(err){
  const ul=$('list');ul.innerHTML='';
  if(err){ul.append(el('li','msg',err));$('f').hidden=$('h').hidden=$('b').hidden=$('dl').hidden=true;return}
  if(!D)return;
  const open=D.items.filter(i=>!i.done),done=D.items.filter(i=>i.done);
  open.filter(i=>!i.sec).forEach(i=>ul.append(itemEl(i)));
  D.seps.forEach(s=>{const its=open.filter(i=>i.sec===s.id);if(!its.length)return;ul.append(el('li','sep',s.t));its.forEach(i=>ul.append(itemEl(i)))});
  if(!open.length)ul.append(el('li','msg','הרשימה ריקה 🎉'));
  $('h').hidden=!D.seps.length;
  const b=$('b'),dl=$('dl');b.hidden=!done.length;b.innerHTML='';dl.innerHTML='';dl.hidden=!(done.length&&showDone);
  if(done.length){
    const t=el('button',null,(showDone?'הסתר':'הצג')+' נקנו ('+done.length+')');t.type='button';t.onclick=()=>{showDone=!showDone;render()};
    const c=el('button',null,'נקה את מה שנקנה');c.type='button';c.onclick=()=>{D.items=D.items.filter(i=>!i.done);render();api({t:'clear'})};
    b.append(t,c);if(showDone)done.forEach(i=>dl.append(itemEl(i)))}
}
$('f').addEventListener('submit',e=>{e.preventDefault();const v=$('t').value.trim();if(!v)return;$('t').value='';
  let text=v,sec='';const m=v.match(/^([^:]{1,30}):\\s*(.+)$/),hit=m&&D&&D.seps.find(s=>s.t.trim()===m[1].trim());if(hit){sec=hit.id;text=m[2].trim()}
  const n=x=>x.replace(/\\s+/g,' ').trim();
  if(D&&D.items.some(i=>!i.done&&n(i.t)===n(text))){toast('כבר ברשימה: '+text);return} // no double "חלב"
  if(D)D.items.push({id:'tmp',t:text,done:false,sec});render();api({t:'add',text,sec})});
api({t:'get'});
setInterval(()=>{if(!busy&&!document.hidden&&document.activeElement!==$('t'))api({t:'get'})},20000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)api({t:'get'})});
</script></body></html>`;

const ICON = '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';
