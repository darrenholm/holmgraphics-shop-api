# Inbound call screen pop — rollout

Phase 1: a Grandstream desk phone rings, a card appears in the shop app showing
who is calling, their open jobs, and what they owe — before the handset is
picked up. Nothing here depends on SkySwitch, the NetSapiens API, or A2P
registration. The phones talk plain http to a small relay on DesignCentre4,
which forwards to the API over https -- see below for why.

---

## Two things that will waste your afternoon

### 1. The phones cannot speak https

Settled by experiment on 2026-08-26, GXP1630 firmware 1.0.7.67:

| URL | Result |
|---|---|
| `https://api.holmgraphics.ca/t/<12-char token>?r=$remote&e=$active_user` (67 ch) | nothing fired |
| `https://api.holmgraphics.ca/t/<12-char token>?r=$remote` (52 ch) | nothing fired |
| `http://10.10.1.24:8080/b?r=$remote&e=$active_user` (49 ch) | fired instantly |

Length was the obvious suspect and it was wrong — the 52-character URL failed
too. The firmware will not do TLS on an Action URL, and will not follow the
301 that Railway returns on plain http either.

Hence **phone-bridge** (`phone-bridge/`, installed at
`C:\holmgraphics\phone-bridge\` on DesignCentre4): the handsets speak plain
http to the LAN, the bridge speaks https to Railway. It also keeps the ingest
token off the handsets, which is what gets the phone URL down to 49
characters:

```
http://10.10.1.24:8085/t?r=$remote&e=$active_user
```

Runs as the scheduled task **Holm Phone Bridge** (SYSTEM / AtStartup /
restart 999x, same shape as Holm Files Bridge). Health check:
`curl http://10.10.1.24:8085/health`. Log: `C:\holmgraphics\phone-bridge\bridge.log`.

⚠ If DesignCentre4 is off, every pop stops. Same exposure as files-bridge.

### 2. The Action URL length ceiling

**The Action URL field silently stops firing above roughly 60-70 characters.**
The phone accepts a longer URL, stores it, shows it back to you in the GUI,
and then never sends a request. No error, no log line, nothing.

Every design decision below that looks strange is because of this: the path is
`/t/<token>`, not `/api/telephony/grandstream/<token>`; the query is
`?r=…&e=…`, not `?remote=…&extension=…`; and the ingest token is twelve
characters instead of forty.

Before you paste anything into a phone, get the exact strings from the API:

```bash
curl -H "Authorization: Bearer <your staff JWT>" https://api.holmgraphics.ca/api/telephony/config
```

It returns each Action URL with its character count and an `overBudget` flag.
If anything reports `overBudget: true`, shorten `TELEPHONY_INGEST_TOKEN`.

---

## 1. Environment

Set in Railway (and locally in `.env` if you want to test against a real DB):

```
TELEPHONY_INGEST_TOKEN=<12 random characters>
TELEPHONY_PUBLIC_BASE=https://api.holmgraphics.ca
```

Generate the token:

```bash
node -e "const c=require('crypto'),A='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';let s='',b=c.randomBytes(64),i=0;while(s.length<12){const v=b[i++];if(v<248)s+=A[v%62]}console.log(s)"
```

Twelve characters from that alphabet is ~71 bits. With an unset token the
ingest endpoints are closed — every request 401s.

`TELEPHONY_PUBLIC_BASE` matters: the Railway hostname
(`holmgraphics-shop-api-production.up.railway.app`) is 46 characters and blows
the URL budget on its own. The phones must dial `api.holmgraphics.ca`, which
already CNAMEs to Railway.

## 2. Migrations

`057_client_phone_index.sql` and `058_calls.sql` apply automatically on API
boot (`db/migrate.js` runs before the server listens). Nothing to do.

## 3. Backfill the phone index

Caller ID arrives as a bare `15198891343`. Client numbers are stored as
`519-889-1343`, `(519) 889 1343`, `5198891343`, and worse. The match happens
against `client_phone_index`, which holds the E.164 form of every number from
both `client_phones.number` and `clients.phone`.

```bash
node scripts/backfill-client-phones.js --dry-run   # report only
node scripts/backfill-client-phones.js             # write the index
```

Every number that fails to parse goes to `scripts/unparseable-phones.csv` with
the client it belongs to — that file is the cleanup worklist, and it's
gitignored because it's full of customer names and numbers. The script also
prints numbers shared by more than one client; those calls pop a "which of
these?" card rather than a name, which is correct but worth eyeballing.

Re-running is safe: the index is rebuilt from scratch each time. Day to day it
stays in step on its own — every write path that touches a phone number calls
`syncClientPhoneIndex()` (`routes/clients.js` phones endpoints,
`routes/customer-auth.js` register and profile update).

## 4. Configure ONE phone

Web GUI → **Settings → Outbound Notification → Action URL**. Point at the
LAN bridge, NOT at api.holmgraphics.ca — see the https note above:

| GUI field | URL |
|---|---|
| Incoming Call | `http://10.10.1.24:8085/t?r=$remote&e=$active_user` |
| Answered Call | `http://10.10.1.24:8085/ta?r=$remote&e=$active_user` |
| Call Terminated | `http://10.10.1.24:8085/te?r=$remote&e=$active_user` |
| Outgoing Call | `http://10.10.1.24:8085/to?r=$remote&e=$active_user` |

No token on the handset — the bridge adds it. `/api/telephony/config` still
prints the direct public URLs, which are useful for testing with curl but are
NOT what the phones can use.

Only **Incoming Call** is required for the pop. Answered Call is what fills in
`handled_by` and turns the card green. Call Terminated is what starts the 45s
auto-dismiss — without it, cards linger until a 5-minute backstop.

`$remote` and `$active_user` are the only dynamic variables this firmware
supports. `$call_id` and `$callid` are **not** supported and arrive as literal
text; nothing in this system depends on them.

Phone admin login is `admin` / `649` (provisioned via `P2`).

## 5. Verify

Ring the phone from a known number and watch:

```bash
curl -H "Authorization: Bearer <staff JWT>" "https://api.holmgraphics.ca/api/telephony/recent?limit=10"
```

Rows appearing there means ingest works. A card appearing in the shop app
means the whole chain works. If rows appear but no card does, the browser's
SSE connection is the problem — `/api/telephony/config` reports the live
subscriber count.

## 6. Roll out to the rest

Only after the first phone passes. Six phones by hand is about twenty minutes.

Pushing the Action URL via SkySwitch NDP device overrides does **not** work
yet: the override saves, renders into the generated config, and the phone
syncs it, but nothing fires. P8304-P8314 were tried from an older GXP21xx
manual; the GXP2170's real GUI field list has a "Register Failed" entry that
manual doesn't, so the positional mapping is probably off by one. Correct
P-code requested from SkySwitch (ticket T20260826.0394). Overrides need a phone
reboot regardless — this fleet doesn't re-sync on its own.

---

## What the card shows, and what it doesn't

**"Unpaid orders" is not accounts receivable.** It's the unpaid total of
online orders (`orders.paid_at IS NULL`, excluding cancelled/refunded). This
database has no AR ledger — invoiced shop work is billed through QuickBooks. A
client with a $12,000 overdue QBO invoice and no web orders shows $0. The card
is labelled "unpaid orders" rather than "balance" for exactly that reason.
Wiring the real number means polling the QBO customer balance on
`clients.qb_customer_id`; that's a separate piece of work.

**Open jobs** are `projects.status_id` 2..10 (Ordered → Billing), the same
definition the job board's stat strip uses.

## Do not scale the API past one replica

`lib/call-hub.js` (SSE subscribers) and `routes/telephony.js` (the correlator)
both hold state in process memory. On a second Railway replica, a phone event
landing on replica A will not reach a browser held open by replica B, and a
ringing event on A won't correlate with the answered event on B. Half the shop
stops getting pops, silently.

The fix, when that day comes, is Postgres `LISTEN/NOTIFY`: `hub.publish()`
becomes a `NOTIFY`, each replica holds one dedicated pg client on `LISTEN`
feeding its local subscriber set, and the correlator moves to a query over the
`calls` table instead of a Map. Nothing above those two files changes.

## Tests

```bash
npm test
```

`routes/telephony.test.js` runs the real router over real HTTP with a real SSE
connection and a faked Postgres — ring-group collapse, retry dedupe,
blocked caller ID, answered/ended correlation, bad tokens, reconnect. Every
acceptance criterion in the Phase 1 spec has a case there or in
`lib/phone.test.js`.

## Files

| | |
|---|---|
| `db/migrations/057_client_phone_index.sql` | normalized E.164 lookup surface |
| `db/migrations/058_calls.sql` | call event log |
| `lib/phone.js` | strict E.164 normalization, blocked/extension detection |
| `lib/phone-index.js` | keeps the index in step on every write path |
| `lib/call-correlate.js` | retry dedupe, ring-group collapse, lifecycle correlation |
| `lib/call-hub.js` | SSE subscriber registry |
| `lib/screen-pop.js` | caller → client → open jobs → unpaid total |
| `routes/telephony.js` | ingest endpoints + browser stream |
| `scripts/backfill-client-phones.js` | one-off index build + unparseable report |
| `phone-bridge/server.js` | LAN plain-http relay (the phones cannot do TLS) |

Shop side: `src/lib/stores/call-pop.js`, `src/lib/components/CallPop.svelte`,
mounted in `src/routes/+layout.svelte`.
