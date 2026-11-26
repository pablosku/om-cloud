# Deploys

One line per deployed version (the cloud session cannot push git tags; tag from the laptop if wanted).
Live web-app deployment: `AKfycbwtF-…BQwCyDVpIQ` (same URL every time, the Worker never changes).

| OM version | Date | Apps Script version | Commit | Changes |
|---|---|---|---|---|
| v17 | 26.11.2026 | @18 | 698af69 | snooze reply fix: quick time parsing, snooze question kept when parsing fails |
| v16 | 26.11.2026 | @17 | 050c9f2 | Mail: read-only Gmail + Drive search, summaries, follow-up questions, print PDFs from mail |
| v15 | 26.11.2026 | @16 | 3b10773 | multi-line reminders, voice messages, custom snooze, reminder queries, Retorno asks first, clinic calendar, release notes |
| v14 | before 26.11.2026 | @14 | 8010116 | reconstructed baseline (live code as pulled 26.11) |

v15: the 4 file hashes on the laptop matched `src/` at commit 3b10773 before `clasp push`.
v16: the 5 file hashes on the laptop matched `src/` at commit 050c9f2.
v17: the 5 file hashes matched `src/` at commit 698af69 (committed after deploy, no PR).
TODO: `src/appsscript.json` is not in the repo yet (unchanged in v15); add it from the laptop clasp folder.
