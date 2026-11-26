"""Print agent: pulls PDFs from the cloud print queue (Office Manager Cloud) and prints them.
Runs next to bot.py and reuses its printing code (SumatraPDF, caption rules, pdfclean).
Needs two lines in .env:  PRINT_QUEUE_URL=<web app /exec url>   PRINT_QUEUE_SECRET=<URL_SECRET>
Pulls and answers are GET requests: Apps Script answers with a 302, and a redirected POST turns into a GET.
The one POST is the answer to a fetch job (web requests the cloud cannot make, e.g. Mei Avivim refuses Google's
servers): the body is too big for a URL. doPost runs on the POST itself; the redirect only fetches its "ok".
v3: also adds items to the Google Keep shopping list (keep jobs, see keep_ops.py)."""
import base64, json, re, socket, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime

import bot  # only the helpers; bot.main() does not run on import

bot.LOG_FILE = bot.BASE / "print_agent.log"
log = bot.log
URL = bot.ENV.get("PRINT_QUEUE_URL", "").strip()
SECRET = bot.ENV.get("PRINT_QUEUE_SECRET", "").strip()
POLL = 30  # seconds between pulls when the queue is empty
STATE = bot.BASE / "print_agent_state.json"  # ids already printed + answers not yet delivered
VERSION = "3.1"


def load_state():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:
        return {"printed": [], "pending": []}


def save_state(st):
    st["printed"] = st["printed"][-500:]
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")
    for i in range(10):  # OneDrive locks the file for a moment while it syncs (WinError 5 / 32)
        try:
            tmp.replace(STATE)
            return
        except PermissionError:
            if i == 9:
                raise
            time.sleep(0.5)


def get(params, timeout=90):
    q = urllib.parse.urlencode({"s": SECRET, **params})
    with urllib.request.urlopen(f"{URL}?{q}", timeout=timeout) as r:
        return r.read().decode("utf-8")


def send_done(st, answer):
    """answer = {"id", "status": ok|fail, "msg"}. Kept in the state file until the cloud says ok."""
    if answer not in st["pending"]:
        st["pending"].append(answer)
        save_state(st)
    flush(st)


def flush(st):
    for a in list(st["pending"]):
        try:
            res = get({"action": "done", **a}, timeout=60).strip()  # a keep answer carries its own action
        except Exception as e:
            log("AGENT done not delivered yet:", a["id"], e)
            return
        if res != "ok":
            log("AGENT done answer:", res)
            return
        st["pending"].remove(a)
        save_state(st)


def run_fetch(f):
    """f = {"id", "reqs": [{url, method?, body?, type?}]} -> posts {"answers": [{code, b64}]} or {"error"} back."""
    answers = []
    try:
        for r in f["reqs"]:
            data = r.get("body", "").encode("utf-8") if r.get("method", "GET").upper() == "POST" else None
            req = urllib.request.Request(r["url"], data=data, method=r.get("method", "GET").upper(),
                                         headers={"Content-Type": r.get("type", "application/json"), "User-Agent": "Mozilla/5.0"})
            try:
                with urllib.request.urlopen(req, timeout=90) as res:
                    answers.append({"code": res.status, "b64": base64.b64encode(res.read()).decode("ascii")})
            except urllib.error.HTTPError as e:
                answers.append({"code": e.code, "b64": ""})
        body = {"answers": answers}
    except Exception as e:
        body = {"error": str(e)[:300]}
    log(f"AGENT FETCH id={f['id']} " + (f"answers={[a['code'] for a in answers]}" if "answers" in body else f"error={body['error']}"))
    q = urllib.parse.urlencode({"s": SECRET, "action": "fetched", "id": f["id"]})
    req = urllib.request.Request(f"{URL}?{q}", data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:  # if this fails, the cloud hands the job out again later
        log("AGENT FETCH answer:", r.read().decode("utf-8")[:50])


def run_keep(st, k):
    """k = {"id", "list", "items"} -> adds them to Keep, answers ?action=keepdone. A job done before is only answered again."""
    st.setdefault("kept", [])
    if k["id"] in st["kept"]:
        log("AGENT KEEP already done", k["id"], "- answering again")
        return send_done(st, {"id": k["id"], "status": "ok", "msg": "{}", "action": "keepdone"})
    try:
        import keep_ops  # here, so a missing gkeepapi never stops printing
        res = keep_ops.add_items(k["list"], k["items"])
    except Exception as e:
        log("AGENT KEEP failed", k["id"], e)
        return send_done(st, {"id": k["id"], "status": "fail", "msg": str(e)[:300], "action": "keepdone"})
    log(f"AGENT KEEP id={k['id']} list={k['list']} {res}")
    st["kept"] = (st["kept"] + [k["id"]])[-500:]
    save_state(st)  # before answering, so a lost answer never adds twice
    send_done(st, {"id": k["id"], "status": "ok", "msg": json.dumps(res, ensure_ascii=False), "action": "keepdone"})


def print_job(job):
    """Returns the note for Pablo. Raises on failure."""
    caption = job.get("caption") or ""
    settings, _ = bot.parse_caption(caption)
    no_images = "בלי תמונות" in caption or "no images" in caption.lower()
    safe = re.sub(r"[^\w.\-]", "_", job["name"])
    path = bot.INBOX / f"{datetime.now():%Y%m%d_%H%M%S}_q{job['id']}_{safe}"
    path.write_bytes(base64.b64decode(job["b64"]))
    note = ""
    if no_images:
        stripped, graphics_ok = bot.strip_images(path)
        if stripped is None:
            note = "אין בקובץ טקסט, הדפסתי אותו כמו שהוא"
        else:
            path = stripped
            note = "בלי תמונות" if graphics_ok else "התמונות הוסרו, הבלוקים הצבעוניים נשארו"
    log(f"AGENT PRINT id={job['id']} try={job.get('try')} file={path.name} settings={settings} images={'REMOVED' if no_images else 'KEPT'}")
    bot.print_pdf(path, settings)
    return note


def main():
    if not URL or not SECRET:
        sys.exit("Missing PRINT_QUEUE_URL / PRINT_QUEUE_SECRET in .env")
    if not bot.find_sumatra():
        log("AGENT warning: SumatraPDF not found, every job will fail")
    host = socket.gethostname()
    log(f"AGENT v{VERSION} running on {host}. Printer: {bot.PRINTER or '(default)'}")
    st = load_state()
    errors = 0
    while True:
        try:
            flush(st)
            res = get({"action": "pull", "host": host, "v": VERSION})
            res = json.loads(res)
            job = res.get("job")
            errors = 0
            if not job and res.get("fetch"):
                run_fetch(res["fetch"])
                continue
            if not job and res.get("keep"):
                run_keep(st, res["keep"])
                continue
            if job:
                if job["id"] in st["printed"]:  # printed before, only the answer got lost
                    log("AGENT already printed", job["id"], "- answering again")
                    send_done(st, {"id": job["id"], "status": "ok", "msg": ""})
                    continue
                try:
                    note = print_job(job)
                except Exception as e:
                    log("AGENT print failed", job["id"], e)
                    send_done(st, {"id": job["id"], "status": "fail", "msg": str(e)[:300]})
                    continue
                st["printed"].append(job["id"])
                save_state(st)  # before answering, so a lost answer never prints twice
                send_done(st, {"id": job["id"], "status": "ok", "msg": note})
                continue  # maybe more jobs are waiting
        except Exception as e:
            errors += 1
            if errors in (1, 10) or errors % 120 == 0:  # no flood in the log while offline
                log("AGENT pull error:", e)
        time.sleep(POLL)


if __name__ == "__main__":
    main()
