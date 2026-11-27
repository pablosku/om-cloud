# Deploys

One line per deployed version (the cloud session cannot push git tags; tag from the laptop if wanted).
Live web-app deployment: `AKfycbwtF-…BQwCyDVpIQ` (same URL every time, the Worker never changes).

| OM version | Date | Apps Script version | Commit | Changes |
|---|---|---|---|---|
| v22 | 26.11.2026 | @23 | 5993cc4 | Wix: trash the Google Meet recording mail after a good upload |
| v21 | 26.11.2026 | @22 | 95315c6 | Wix upload from the Meet recording mail; Keep item fix; print_agent 3.2 (OneDrive retry) |
| v20 | 26.11.2026 | @21 | dad29ea | Keep shopping list (add only, via laptop gkeepapi); Mei Modiin print asks first; /bills in menu (BOT_COMMANDS); Reminders.js split; print agent v3 |
| v19 | 26.11.2026 | @20 | d7b654b | reminders: "ב15" = hour + fixParse_; Mei Avivim via laptop fetch jobs; pdfclean keeps template images' dark parts; print agent v2 |
| v18 | 26.11.2026 | @19 | 54cd604 | bills from email: labels OM/חשבונות -> OM/טופל, Mei Avivim -> Telegram, Mei Modiin -> print |
| v17 | 26.11.2026 | @18 | 698af69 | snooze reply fix: quick time parsing, snooze question kept when parsing fails |
| v16 | 26.11.2026 | @17 | 050c9f2 | Mail: read-only Gmail + Drive search, summaries, follow-up questions, print PDFs from mail |
| v15 | 26.11.2026 | @16 | 3b10773 | multi-line reminders, voice messages, custom snooze, reminder queries, Retorno asks first, clinic calendar, release notes |
| v14 | before 26.11.2026 | @14 | 8010116 | reconstructed baseline (live code as pulled 26.11) |

v15: the 4 file hashes on the laptop matched `src/` at commit 3b10773 before `clasp push`.
v16: the 5 file hashes on the laptop matched `src/` at commit 050c9f2.
v17: the 5 file hashes matched `src/` at commit 698af69 (committed after deploy, no PR).
TODO: `src/appsscript.json` is not in the repo yet (unchanged in v15); add it from the laptop clasp folder.
v18/v19: Bills.js, Code.js matched src/ hashes. Print.js on the laptop = LIVE file (differs from src/Print.js) + the 2 fetchPull_ lines (hash aa4dd0e09dece25c); live Reports.js also differs from src/. TODO: copy live Print.js/Reports.js from the laptop into src/.
Laptop: print_agent.py v2 + pdfclean.py from laptop/ at d7b654b (backups *.v18.bak in the Secretary folder).
v20: all 8 src/*.js copied byte-for-byte from dad29ea into the clasp folder (live Print.js/Reports.js differed from src/ only in whitespace, so src/ is now the live code; the earlier Print/Reports TODO is closed). Backup of v19 files: C:\Users\ASUS\om-cloud-backup-v19. Laptop: print_agent.py v3 (backup print_agent.v2.py.bak), keep_ops.py + keep_token.py, gkeepapi 0.17.1. Rollback: clasp deploy -i <id> -V 20.
v21: DEPLOYED 26.11.2026 22:38 Israel (Apps Script @22) by Claude via RC after Pablo's in-thread OK. main @95315c6 (PR #10 incl. #9): all 9 src/*.js SHA-256 matched (new Wix.js). Backup of v20 files: C:\Users\ASUS\om-cloud-backup-v20. Laptop: print_agent.py 3.2 (backup print_agent.v3.py.bak); ZOOM\wix_upload.js from laptop/ (backup wix_upload_pre_om.js, keys in ZOOM\wix.env). Dry run `-b 2026-11-25` -> exit 1 "no recording", nothing uploaded. No Windows scheduled task runs run_upload.bat. Rollback: clasp deploy -i <id> -V 21.
v22: DEPLOYED 26.11.2026 23:06 Israel (Apps Script @23) from main @5993cc4 (PR #11). Rollback: clasp deploy -i <id> -V 22.
