"""One-time: get a Google Keep master token for keep_ops.py and save it in .env (next to this file).
1. In Chrome open https://accounts.google.com/EmbeddedSetup and sign in (the page may end blank or with an error: fine).
2. F12 -> Application -> Cookies -> https://accounts.google.com -> copy the value of "oauth_token" (starts with oauth2_4/).
3. Run:  python keep_token.py   and paste it (the input is hidden). The cookie works once and only for a few minutes.
To cancel the token later: change the Google password, or remove the device at https://myaccount.google.com/device-activity"""
import getpass, re, secrets
from pathlib import Path

import gpsoauth

email = input("Gmail address: ").strip().strip("\\/'\" ")
if not re.fullmatch(r"[\w.+-]+@[\w-]+(\.[\w-]+)+", email):
    raise SystemExit(f"Not an email address: {email!r}")
oauth = getpass.getpass("oauth_token (hidden): ").strip().strip("'\" ")
if not oauth.startswith("oauth2_4/"):
    raise SystemExit("The value should start with oauth2_4/ - copy the oauth_token cookie value again")
res = gpsoauth.exchange_token(email, oauth, secrets.token_hex(8))
token = res.get("Token", "")
if not token.startswith("aas_et/"):
    raise SystemExit(f"Google did not give a token: {res.get('Error') or res}")
env = Path(__file__).resolve().parent / ".env"
old = env.read_text(encoding="utf-8-sig").splitlines() if env.exists() else []
lines = [l for l in old if not l.startswith(("KEEP_EMAIL=", "KEEP_MASTER_TOKEN="))]
lines += [f"KEEP_EMAIL={email}", f"KEEP_MASTER_TOKEN={token}"]
env.write_text("\n".join(lines) + "\n", encoding="utf-8")
print("Saved to .env. Test:  python keep_ops.py \"OM TEST\" חלב")
