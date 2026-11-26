"""Shopping list in Google Keep for the print agent (add only).
Needs in .env:  KEEP_EMAIL=<gmail address>   KEEP_MASTER_TOKEN=<aas_et/...>   (keep_token.py writes both)
The master token gives wide access to the Google account: it stays in this .env only, never in the cloud or git.
Imported lazily by print_agent.py, so a missing gkeepapi never stops printing.
Test by hand:  python keep_ops.py "OM TEST" חלב "2 לחם"   (creates the list if it does not exist)"""
import re, sys

import bot

_keep = None


def _login():
    global _keep
    if _keep is None:
        import gkeepapi
        email = bot.ENV.get("KEEP_EMAIL", "").strip()
        token = bot.ENV.get("KEEP_MASTER_TOKEN", "").strip()
        if not email or not token:
            raise RuntimeError("חסר KEEP_EMAIL / KEEP_MASTER_TOKEN ב-.env במחשב")
        k = gkeepapi.Keep()
        if hasattr(k, "authenticate"):
            k.authenticate(email, token)  # gkeepapi >= 0.15
        else:
            k.resume(email, token)
        _keep = k
    else:
        _keep.sync()  # pick up what changed in the phone app since the last job
    return _keep


def _norm(text):
    """"חלב ", "חלב." and "חלב" are the same item."""
    return " ".join(re.sub(r"[^\w\s]", " ", str(text)).lower().split())


def add_items(list_name, items, create=False):
    """Adds items to the bottom of the list. Returns {"added": [...], "dup": [...]} (dup = already open in the list, not added again)."""
    global _keep
    import gkeepapi
    try:
        keep = _login()
    except Exception:
        _keep = None  # log in again next time
        raise
    name = list_name.strip()
    lists = [n for n in keep.all() if isinstance(n, gkeepapi.node.List) and not n.trashed and not n.archived
             and n.title.strip() == name]
    if not lists:
        if not create:
            raise RuntimeError(f'לא מצאתי בקיפ רשימה בשם "{name}"')
        lst = keep.createList(name, [])
    else:
        lst = lists[0]
    have = {_norm(i.text) for i in lst.items if not i.checked}
    done = {_norm(i.text): i for i in lst.items if i.checked}  # bought before: un-check it instead of a second copy
    added, dup = [], []
    for it in items:
        it = str(it).strip()
        if not it:
            continue
        n = _norm(it)
        if n in have:
            dup.append(it)
            continue
        if n in done:
            done.pop(n).checked = False
        else:
            lst.add(it, False, gkeepapi.node.NewListItemPlacementValue.Bottom)
        have.add(n)
        added.append(it)
    if added:
        try:
            keep.sync()
        except Exception:
            _keep = None  # unsynced local changes must not leak into the next job
            raise
    return {"added": added, "dup": dup}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit('usage: python keep_ops.py "OM TEST" item [item ...]')
    print(add_items(sys.argv[1], sys.argv[2:], create=True))
