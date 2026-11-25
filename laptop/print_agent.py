"""Print agent: pulls PDFs from the cloud print queue (Office Manager Cloud) and prints them.
Runs next to bot.py and reuses its printing code (SumatraPDF, caption rules, pdfclean).
Needs two lines in .env:  PRINT_QUEUE_URL=<web app /exec url>   PRINT_QUEUE_SECRET=<URL_SECRET>
Only GET requests: Apps Script answers with a 302, and a redirected POST turns into a GET."""
import base64, json, re, socket, sys, time, urllib.parse, urllib.request
from datetime import datetime

import bot  # only the helpers; bot.main() does not run on import

bot.LOG_FILE = bot.BASE / "print_agent.log"
log = bot.log
URL = bot.ENV.get("PRINT_QUEUE_URL", "").strip()
SECRET = bot.ENV.get("PRINT_QUEUE_SECRET", "").strip()
POLL = 30  # seconds between pulls when the queue is empty
STATE = bot.BASE / "print_agent_state.json"  # ids already printed + answers not yet delivered
VERSION = "1"


def load_state():
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:
        return {"printed": [], "pending": []}


def save_state(st):
    st["printed"] = st["printed"][-500:]
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(st, ensure_ascii=False), encoding="utf-8")
    tmp.replace(STATE)


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
            res = get({"action": "done", **a}, timeout=60).strip()
        except Exception as e:
            log("AGENT done not delivered yet:", a["id"], e)
            return
        if res != "ok":
            log("AGENT done answer:", res)
            return
        st["pending"].remove(a)
        save_state(st)


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
            job = json.loads(res).get("job")
            errors = 0
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
