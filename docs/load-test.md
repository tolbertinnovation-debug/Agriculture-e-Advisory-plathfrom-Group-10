# Load test (Sprint 6)

**Question:** can AgriConnect send one advisory to 10,000 farmers, and stay fast for officers and farmers while it does?

**How:** `npm run load-test` (see `services/api/scripts/load-test.js`). It fills a throw-away database with 10,000 farmers, queues one advisory to all of them, and sends the queue through a stand-in SMS provider that takes **50 ms per message**, like a real one over the internet. Then it times USSD screens, the daily advice job and the officer pages. Run it on PostgreSQL with `DATABASE_URL=postgres://…/an-empty-database npm run load-test`.

## Results (21 Nov 2026, 4-core cloud build machine, Node 22)

| Step | SQLite | PostgreSQL 16 |
|---|---|---|
| Register 10,000 farmers | 0.4 s | 4.5 s |
| Preview an advisory to all 10,000 | 0.01 s | 0.01 s |
| **Queue the advisory (10,000 SMS)** | **0.05 s** | **0.33 s** |
| **Send all 10,000 SMS** (10 at a time, 50 ms each) | **60 s** | **54 s** |
| 500 USSD screens | 0.03 s | 0.24 s |
| Daily advice job, 10,000 farmers | 0.7 s | 8.4 s |
| Officer: search farmers | < 0.01 s | 0.01 s |
| Officer: CSV of one county (1,667 farmers) | 0.03 s | 0.03 s |
| Hotspots | < 0.01 s | < 0.01 s |

All 10,000 SMS were sent, none were lost or sent twice.

## What the test found, and what was fixed

| Problem | Before | After | Fix |
|---|---|---|---|
| SMS were sent one at a time, 50 per 2-second tick | 10,000 SMS in **9 min** (19/s) | **1 min** (~170/s) | The sender hands `SMS_CONCURRENCY` (default 10) messages to the provider at once, and keeps sending batch after batch while there is a queue |
| Queueing an advisory wrote one row at a time and re-checked STOP for each farmer | 7.7 s on PostgreSQL (the officer waits) | 0.33 s | 500 rows per insert; the recipient list already leaves out farmers who said STOP |
| The farmer CSV counted messages per farmer with sub-queries PostgreSQL could not index | 5.0 s on PostgreSQL | 0.03 s | Count once per phone, then join; plus new indexes (migration 7) |
| Messages had no index by farmer | 1.4 s CSV on SQLite | 0.03 s | `idx_message_farmer` and indexes for reports and questions by farmer and phone |

## What it means for the pilot
- A pilot of 30–50 farmers, or a full county of thousands, is far inside these numbers.
- **The SMS provider sets the real speed.** At 10 at a time and 50 ms each we send ~170 SMS a second. If the provider allows more, raise `SMS_CONCURRENCY` (max 50); if it complains about speed, lower it.
- The daily advice job on PostgreSQL takes ~8 s for 10,000 farmers. It runs once a day in the background, so this is fine; it could be batched if the platform grows past ~100,000 farmers.
