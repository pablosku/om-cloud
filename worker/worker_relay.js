// Cloudflare Worker: Telegram webhook relay -> Apps Script web app (spike S3c)
// Telegram cannot follow the 302 that Apps Script returns. The Worker follows it,
// and answers Telegram 200 ONLY after Apps Script answered "ok".
// Otherwise it answers 500, so Telegram retries and nothing is lost.
// Worker secrets (Settings -> Variables, type Secret): GAS_URL, URL_SECRET, TG_SECRET
export default {
  async fetch(req, env) {
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
