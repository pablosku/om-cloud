# Deploys

One line per deployed version (the cloud session cannot push git tags; tag from the laptop if wanted).
Live web-app deployment: `AKfycbwtF-…BQwCyDVpIQ` (same URL every time, the Worker never changes).

| OM version | Date | Apps Script version | Commit | Changes |
|---|---|---|---|---|
| v15 | 26.11.2026 | @16 | 3b10773 | multi-line reminders, voice messages, custom snooze, reminder queries, Retorno asks first, clinic calendar, release notes |
| v14 | before 26.11.2026 | @14 | 8010116 | reconstructed baseline (live code as pulled 26.11) |

v15: the 4 file hashes on the laptop matched `src/` at commit 3b10773 before `clasp push`.
TODO: `src/appsscript.json` is not in the repo yet (unchanged in v15); add it from the laptop clasp folder.
