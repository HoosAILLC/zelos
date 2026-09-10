# Zelos 1.8 QA notes

The release tests use temporary homes and synthetic messages. Live Gmail,
Microsoft, iCloud and task-provider acceptance still requires configured test
accounts. Publisher signing and notarisation require publisher credentials.

## Archive performance

On an Apple silicon Mac with Node 26.3.0, a synthetic archive of 50,000 messages
(roughly 800 characters each), 1,000 board items and 2,000 history revisions gave:

| Operation | Measurement |
| --- | --- |
| Import 50,000 messages before the indexing change | 360.1 seconds |
| Same import after the change | 3.3 seconds |
| Open, migrate and close the populated database | 6.2 ms median |
| Search a common term, returning 20 results | 67.6 ms median |
| Search a selective term, returning 20 results | 5.7 ms median |
| Read a 500-item board | 3.1 ms median |
| Read one item's history | 0.01 ms median |
| Three unchanged assessments of 1,000 items | Zero history rows or database growth |
| Storage for 1,000 real revisions | About 200 KiB |

These are warm local-disk measurements, not network timings, cold-cache guarantees
or full-window render timings. The change scans existing search references once
per source batch instead of scanning the growing archive for every new record.
Replacements, orphaned references, duplicates and transaction rollback retain
their previous behavior and have regression coverage.

Run `node scripts/benchmark-archive.mjs` to repeat the synthetic benchmark. It
prints JSON, uses a fresh temporary directory and removes only that directory.
It does not connect to accounts or read the installed app's data.

## Recovery and interaction coverage

The local release suite passed 1,811 checks with four platform-specific skips.
The Mac packaged runtime (Electron 43.3.0, Node 24.18.1) also passed first-run
HTTP checks and backup/restore round-trips through both the core and native
background-worker paths.

- Backups round-trip all database tables and the full-text index, plus portable encrypted credentials. Corrupted, truncated, unsupported and unsafe-path archives are rejected before replacement.
- Child processes interrupted at journal creation, database replacement and commit exercise startup recovery. A recovery copy remains available, and other active clients prevent replacement.
- Native Mac checks exercise Save/Cancel, restore preview/Cancel, confirmed restore and automatic restart against the isolated sample archive.
- Scheduled checks skip missed sleep slots, report an outage and recover on the next slot. A delayed keychain response cannot revive a stopped schedule.
- Command-menu tests cover filtering, arrow keys, Enter, Escape, focus containment, focus return and explicit action activation.
- Item history records observed changes without inventing earlier revisions. Source evidence, task-selection absence and user completion remain distinct.
- Website demo interactions use in-memory data and make no real provider or update requests.

## AI evaluation

The eight-case [synthetic triage corpus](../evals/README.md) exports real assessment
prompts and scores supplied responses. Its automated checks cover structured
constraints; semantic review remains required even after a passing score.
Hand-authored scorer fixtures verify the tooling, not live model accuracy.
