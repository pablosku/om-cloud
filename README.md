# om-cloud

Office Manager (OM): Pablo's personal Telegram secretary.

| Path | What |
|---|---|
| `src/` | Google Apps Script project "Office Manager Cloud" (pushed with clasp) |
| `worker/worker_relay.js` | Cloudflare Worker `om-relay` (Telegram webhook -> Apps Script) |
| `laptop/` | Windows laptop side: `print_agent.py` (pulls the print queue), `pdfclean.py` |

Secrets live only in Apps Script **Script Properties**, Worker secrets and the laptop `.env`.
Never commit them (see `.gitignore`).

## Workflow

1. **Change** on a branch, open a PR against `main`. Every PR bumps `VERSION` + `RELEASE_NOTES` in `src/Code.js` when it is meant for a release.
2. **Approve**: before every deploy, Pablo gets the full numbered list of changes since the last tag (`git log vN..main`) and says OK.
3. **Merge** the PR(s) into `main`.
4. **Deploy from `main`** on the laptop (clasp clone): copy `src/*` into the clasp folder, `clasp push`, then
   `clasp deploy -i <live deploymentId> -d "vN: ..."` (same URL, the Worker does not change).
   Note: `clasp push` alone is already live for the 1-minute `tick` trigger, so push needs the same OK.
5. **Tag** the deployed commit: `git tag -a vN -m "..." && git push --tags`.

Rollback: `clasp deploy -i <id> -V <previous version>`, then `git checkout vN-1 -- src/` if the code should go back too.

## History

Commits before v15 were reconstructed on 26.11.2026 from the `.bak` snapshots.
`v14` matches the live code as pulled with clasp on 26.11 (normalized hash).
