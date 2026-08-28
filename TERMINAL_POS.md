# Counter POS — Stripe Terminal

Front-counter credit and Interac debit on a BBPOS WisePad 3, driven from the
shop app on the counter tablet, written back to QuickBooks automatically.
Replaces the Chase Desk/5000.

- **API** (this repo) — `routes/terminal.js`, `routes/stripe-webhook.js`,
  `lib/stripe-client.js`, `lib/qbo-terminal-writeback.js`, migration
  `059_terminal_payments.sql`
- **Tablet** (`holmgraphics-shop`) — `src/lib/pos/*`,
  `src/lib/components/TakePaymentModal.svelte`, `src/routes/pos/+page.svelte`,
  `android/app/src/main/java/ca/holmgraphics/shop/HgPosPlugin.java`

---

## How it fits together

```
Counter tablet (Capacitor)
  ├── @capgo/capacitor-stripe-terminal ──BLE──► WisePad 3
  └── HgPos (local plugin)             ──SPP──► thermal printer ──► cash drawer

  ▲ POST /api/terminal/connection-token   (staff bearer token)
  │ POST /api/terminal/payment-intent
  ▼
Express API (Railway)
  ├── Stripe
  └── Supabase/Railway Postgres — terminal_payments

Stripe ──webhook──► POST /webhooks/stripe
                      ├── completes the terminal_payments row (fee, EMV block)
                      └── writes to QuickBooks
```

**The tablet never holds a Stripe secret key and never writes to QuickBooks.**
Everything that decides where money ends up happens server-side off the
webhook, so a tablet that loses WiFi between "approved" on the reader and
"printed" on the receipt cannot lose the payment.

---

## Setup

### 1. Railway variables

```
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_TERMINAL_LOCATION_ID=tml_...

# Optional — only if the QuickBooks accounts are named differently
QBO_STRIPE_CLEARING_ACCOUNT=Stripe Clearing
QBO_STRIPE_FEE_ACCOUNT=Merchant Account Fees
QBO_STRIPE_VENDOR=Stripe

# Optional — QBO TaxCode id to claim the HST on Stripe's fees as an ITC.
# Unset posts the fee gross with no tax. See "The HST on Stripe's fees".
QBO_STRIPE_FEE_TAX_CODE=
```

Railway variables **only**. Do not put these in a committed `.env` — this repo
has prior history of a committed `.env` and these are live-money keys.

Test vs live is derived from the shape of `STRIPE_SECRET_KEY`; there is no
separate flag to keep in sync. The tablet reads it from
`GET /api/terminal/config` and initialises the SDK to match.

### 2. Create the Terminal Location

On the **Holm Graphics** Stripe account — not the Rodeo one.

```bash
curl https://api.stripe.com/v1/terminal/locations \
  -u $STRIPE_SECRET_KEY: \
  -d display_name="Holm Graphics — Walkerton" \
  -d "address[line1]"="2-43 Eastridge Rd" \
  -d "address[city]"="Walkerton" \
  -d "address[state]"="ON" \
  -d "address[country]"="CA" \
  -d "address[postal_code]"="N0G 2V0"
```

Store the returned `tml_...` as `STRIPE_TERMINAL_LOCATION_ID`.

The WisePad 3 is a Bluetooth reader, so it is not registered to an account
with a pairing code — it binds to a Location at connect time. Nothing has to
be removed from the Rodeo account first. The first connect on the new Location
pulls the Canadian firmware and language pack automatically and **takes
several minutes**; the tablet shows the progress bar for it.

### 3. Register the webhook

Stripe Dashboard → Developers → Webhooks → `https://api.holmgraphics.ca/webhooks/stripe`

Events:

- `payment_intent.succeeded`
- `payment_intent.payment_failed`
- `payment_intent.canceled`
- `charge.refunded`

Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

The endpoint verifies the signature over `req.rawBody`, which the global
`express.json({ verify })` hook in `server.js` stashes. Do not change that
route to read `req.body` — the re-serialised object fails every signature
check.

### 4. Create the QuickBooks accounts

Two accounts must exist before the first sale, and the write-back deliberately
does **not** create them: picking a GL account's type and place in the chart of
accounts on the bookkeeper's behalf is far more expensive to unwind than a
failed sync.

| Account | Type | Why |
|---|---|---|
| `Stripe Clearing` | **Bank** | Counter sales deposit here, not to the bank |
| `Merchant Account Fees` | Expense | Where the Stripe fee lands |

**Make the clearing account a Bank account, not an Other Current Asset.** It is
book-only — do not connect it to a bank feed — but the type matters twice:

* QBO's **Transfer** form only lists Bank and Credit Card accounts, and step 3
  of the reconciliation below (matching the Stripe payout as a transfer from
  clearing into the real bank) *is* that form. On an Other Current Asset it
  becomes a hand-written journal entry on every payout.
* The fee `Purchase` is drawn on this account. Intuit's spec allows Bank or
  Other Current Asset for a `Cash` purchase, but Bank is the case that is
  unambiguously supported.

QBO does not let an account's type be changed after creation, so if one already
exists with the wrong type and a zero balance, make it inactive and create a
new one.

The name is matched **exactly** against the QBO account `Name`. Either name the
account `Stripe Clearing`, or set `QBO_STRIPE_CLEARING_ACCOUNT` to whatever you
actually called it.

#### Or use Undeposited Funds

`QBO_STRIPE_CLEARING_ACCOUNT=Undeposited Funds` is supported and needs no new
account. **The trade-off is the fee.** QBO reserves Undeposited Funds for the
payment→deposit flow and won't let an expense be drawn on it, so the automatic
fee posting is off and the fee becomes a negative `Merchant Account Fees` line
the bookkeeper adds on each Bank Deposit.

The code detects this by `AccountSubType`, not by name, and reports it as a
standing to-do on the POS screen rather than failing after a customer has been
charged. The preflight names which mode is active.

| | Dedicated clearing account | Undeposited Funds |
|---|---|---|
| Sale posts | automatic | automatic |
| Fee posts | automatic | **by hand, per payout** |
| Payout | match the bank feed to a transfer | build a Bank Deposit, tick the Stripe items, add the negative fee line |
| "Did it reconcile?" | one number — the account balance | inspect the Undeposited Funds list |
| Shares the account with | nothing | cash, cheques, and the DTF online orders |

That last row is the reason the dedicated account is the default: nothing else
in this codebase sets `DepositToAccountRef`, so the QB Payments charges from
the online store (`lib/qbo-sync.js` → `createSalesReceiptFromOrder`) already
land in whatever the company default is — usually Undeposited Funds. Sharing
it means picking Stripe items out of a mixed list on every payout.

Optionally a **Vendor** named `Stripe`, so the fee expenses have a payee. If it
doesn't exist the fee still posts, just without one.

Then run the preflight from the tablet — **Counter POS → QuickBooks readiness →
Run preflight** (`GET /api/terminal/qbo-preflight`). Every check that fails
there would otherwise fail as a webhook, with a customer already charged and
gone.

### 5. Tablet

```bash
npm i                 # picks up @capgo/capacitor-stripe-terminal
npm run build
npx cap sync android
cd android && ./gradlew assembleDebug
```

`minSdkVersion` is **26** (`android/variables.gradle`) — the Stripe Terminal
AARs declare it, and Capacitor's default of 24 fails the manifest merge. The
counter tablet is API 28.

On first run, grant location when asked. The reader must **not** be paired in
Android's Bluetooth settings; the SDK discovers and bonds it itself and a
manual pairing interferes. The **printer** is paired by hand, once.

---

## Where the money goes

Stripe pays out net of fees, in batches, so a single counter sale never
matches a single bank deposit. Nothing posts to the bank account.

1. The sale posts to **Stripe Clearing** — as a `Payment` applied to the job's
   existing Invoice (matched on `DocNumber = project id`, which is what
   `routes/quickbooks.js` sets), or as a `SalesReceipt` when the job was never
   invoiced.
2. The Stripe fee posts as a `Purchase` **paid from Stripe Clearing**. Without
   this the clearing account grows by the fee on every sale and never
   reconciles.
3. When the payout lands, the bookkeeper matches the bank-feed deposit as a
   transfer from Stripe Clearing. **This step is manual and deliberate** — it
   is the point where the books meet the bank, and automating it would create
   transfers the bank feed then double-matches.

In Undeposited Funds mode, steps 2 and 3 collapse into one Bank Deposit: tick
the Stripe sales, add the fee as a negative line, and the deposit total matches
the payout on the bank feed.

### The HST on Stripe's fees

`balance_transaction.fee` is the **total** Stripe deducted, tax included. That
single fact drives the whole design here:

* By default (`QBO_STRIPE_FEE_TAX_CODE` unset) the fee posts gross with
  `GlobalTaxCalculation: 'NotApplicable'` — all expense, no input tax credit.
* Set it to a QBO TaxCode id and the Purchase posts
  `GlobalTaxCalculation: 'TaxInclusive'`, so QBO backs the tax **out** of the
  amount. Expense plus ITC still sum to exactly what Stripe took.

**The tax treatment is set explicitly on every payload and is deliberately not
inherited from the fee account's default tax code in QBO.** Under QBO's usual
tax-exclusive rule an account default of HST 13% would add 13% *on top* of an
amount that already includes it — the Purchase would draw more out of the
clearing account than Stripe drew out of the payout, and the account would
drift by the tax on every single sale and never zero. Setting it here means a
dropdown in the QBO UI cannot break the reconciliation.

Set the account default to whatever suits manual entries; it has no effect on
these postings. The preflight reports which treatment is active.

### Tax on the SalesReceipt path

The counter charges a **tax-inclusive** total — that's the number on the reader
and on the receipt. QuickBooks builds its total up from tax-exclusive lines, so
the line goes in at subtotal with `TaxCodeRef 7` and QBO recomputes the HST.
When the tablet sends an explicit split it's used; otherwise the subtotal is
backed out at 13%.

If QBO's recalculated total lands a cent away from what was charged, the row
gets a `qbo_warning` and it shows on the POS screen. Fix the receipt in QBO —
otherwise the clearing account is permanently off by that cent.

---

## Testing, in order

Work through this on the actual counter tablet, **before Chase is cancelled**.
There is no interim way to take a payment on a WisePad 3 if this stalls.

1. **Simulated reader** — Counter POS → *Use simulator*. Proves connection
   token → PaymentIntent → collect → confirm → webhook → QuickBooks row with
   no hardware at all.
2. **Test mode, real reader** — point the server at `sk_test_…`, connect the
   real WisePad, use Stripe test cards.
3. **Live, small** — a real $1 credit sale, refunded from the Dashboard.
   Confirm the refund lands as a RefundReceipt.
4. **Live Interac, over $100** — confirms the insert-and-PIN path, which is the
   majority case here.
5. **Failure paths, deliberately** — WiFi off mid-payment; reader powered off
   mid-payment; location permission denied; reader below 50% battery.
6. **Reconciliation** — one full day of counter sales, then confirm Stripe
   Clearing in QBO holds exactly the day's gross less fees, and zeroes when the
   payout is matched.

Only after step 6 passes for a full day should Chase be cancelled.

---

## Interac behaviour to expect at the counter

Worth telling staff before they hit it and think something is broken.

- Interac Flash (contactless) is capped at **$250**, and about three
  consecutive taps.
- Anything over **$100**, or the fourth tap in a row, forces insert + PIN.
- The average Interac ticket here is ~$190, so **most debit transactions will
  ask for insert and PIN.** That is normal.
- Interac does not work in Stripe's offline mode. WiFi down means debit down.
- Stripe reports `payment_method_type: 'interac_present'` for **all** Canadian
  debit, including co-branded cards whose `brand` still reads "visa". That
  field — not the brand — is how debit is told from credit on the receipt, in
  QuickBooks, and when auditing processing cost.

---

## Refunds

**Interac refunds must be done in person with the original card present.** They
cannot be issued from the Stripe API or the Stripe Dashboard.

`@capgo/capacitor-stripe-terminal@8.0.3` **does not expose**
`collectRefundPaymentMethod` / `processRefund` — verified against
`dist/esm/definitions.d.ts` in the installed package; the plugin's whole method
list is initialize / discoverReaders / setConnectionToken /
setSimulatorConfiguration / connectReader / getConnectedReader /
disconnectReader / cancelDiscoverReaders / collectPaymentMethod /
cancelCollectPaymentMethod / confirmPaymentIntent / installAvailableUpdate /
cancelInstallUpdate / setReaderDisplay / clearReaderDisplay / rebootReader /
cancelReaderReconnection. Nothing refund-related.

**Launch position:**

- **Credit-card refunds** — issue from the Stripe Dashboard. They work
  normally, no card present required, and `charge.refunded` posts a
  RefundReceipt to QuickBooks automatically.
- **Interac refunds** — out of band: cash, cheque or e-transfer, recorded
  manually in QuickBooks. Workable at ~5 debit transactions a month.

The permanent fix is to fork the plugin and bridge the two native methods —
they exist in the underlying Stripe Terminal Android SDK, so it's a small,
well-defined native addition. Not done here.

---

## Hardware limits of the WisePad 3

Confirmed on the counter reader, not from the docs:

* **`setReaderDisplay` is not supported.** It rejects with "Reader does not
  support setting display", so the itemised cart never appears on the reader.
  The spec's §4.5 includes the call; it is kept as best-effort and never
  fatal. The customer still sees the **amount** during collection, because
  that comes from the PaymentIntent itself.
* **The idle screen is a Terminal *splash screen*, not account branding.**
  Settings → Business → Branding has no effect on it. It is set per reader
  type on a Terminal Configuration, and a Location without one inherits the
  account default; with neither, the reader shows "Stripe".

  Dashboard → Terminal → **Locations** → the location → the ✏ next to the
  **Splash screen** row under *Local configurations* (or *Inherited
  configurations* for the account-wide default) → choose the **BBPOS
  WisePad 3** reader type → upload → Done → **Apply changes** on the
  configuration drawer. That last step is easy to miss and nothing takes
  effect without it. A single image cannot be applied across reader types.

  WisePad 3 image spec — the tightest of any Stripe reader:

  | | |
  |---|---|
  | Resolution | **320 × 240** (landscape), must be cropped to fit exactly |
  | Format | **PNG only** — no JPG, no GIF |
  | Size | under 2 MB |
  | Colour | **converted to black and white automatically**, and repositioned slightly |

  So supply a high-contrast black-on-white mark. Anything relying on colour,
  gradients or fine detail will come out as mud.

  Being a *mobile* reader, the WisePad picks the splash screen up **when it
  next connects to the Terminal SDK** — a reconnect from /pos is enough, no
  power cycle needed. (Smart readers take up to 10 minutes instead.)

  Docs: https://docs.stripe.com/terminal/fleet/splash-screen

## Plugin gotchas that shaped the code

Three things about `@capgo/capacitor-stripe-terminal` are easy to get wrong
from its README, and all three are load-bearing:

1. **`initialize({ tokenProviderEndpoint })` is unauthenticated.** It fetches
   the connection token with a bare header-less Volley POST and logs the
   returned secret to logcat. A connection token is the ability to take
   payments on the account, so `src/lib/pos/terminal.js` leaves that option
   unset and answers the SDK's `RequestedConnectionToken` event with an
   authenticated fetch followed by `setConnectionToken()`.
2. **`collectPaymentMethod({ paymentIntent })` wants the client secret**, not
   the id — it passes the value straight to
   `Terminal.retrievePaymentIntent()`. The API returns both so the caller
   can't get it wrong.
3. **`discoverReaders()` resolves on the first discovery callback**, which on
   Bluetooth often fires before the WisePad has answered. `discover()` also
   listens to the `DiscoveredReaders` event and waits for the remembered
   serial, which is what makes auto-reconnect reliable rather than a coin
   flip.

Also: the plugin's Android `onUpdateDiscoveredReaders` logs `readers[0]`
without a length check, so an empty discovery callback can throw inside the
SDK's own listener. Nothing to do about it from JS — if reader discovery ever
crashes the app, that's where to look.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Location permission is denied" | Runtime grant missing. The SDK disables payments outright without it — Counter POS has a button straight to the settings screen. |
| Discovery finds nothing | Reader off; or it was paired manually in Android Bluetooth settings — unpair it, the SDK bonds it itself. |
| Reader stuck "Installing firmware" | Normal, and it can run for minutes. It will not install below 50% battery. Leave it on the charger. |
| Reader disconnects every ~24h | It reboots itself daily. `autoReconnectOnUnexpectedDisconnect` is on and the UI shows the reconnect. |
| Payment succeeded but "not synced" on the POS screen | QuickBooks write-back failed. The reason is on the row; hit **Retry**, which is idempotent. Usually a missing clearing account or an expired QBO token. |
| `QuickBooks has no account named "Stripe Clearing"` | The QBO account name and `QBO_STRIPE_CLEARING_ACCOUNT` disagree. The match is exact — check for a trailing space or a different spelling. |
| Every row warns that the fee wasn't posted | Expected in Undeposited Funds mode — the fee is a Bank Deposit line. Switch `QBO_STRIPE_CLEARING_ACCOUNT` to a dedicated account to automate it. |
| Every Interac transaction declines | Someone set `capture_method: 'manual'`. Interac only accepts `automatic`, `automatic_async` or `manual_preferred`. `routes/terminal.js` will not emit plain `manual`. |
| Webhook 400s on every event | Something changed `req.rawBody` handling in `server.js`. |
| Receipt prices don't sit flush right | Wrong column width. Counter POS → Receipt printer → Width (32 = 58mm, 48 = 80mm). |
| Drawer doesn't open on cash | It's almost certainly wired to RJ11 pin 5 rather than pin 2 — change `KICK_DRAWER` in `src/lib/pos/escpos.js` from `1B 70 00 …` to `1B 70 01 …`. |

---

## Endpoints

All under `/api/terminal`, all staff-authenticated.

| Method | Path | Purpose |
|---|---|---|
| GET | `/config` | `{ configured, isTest, locationId, ready }` — read at tablet startup |
| POST | `/connection-token` | Answers the SDK's token callback |
| POST | `/payment-intent` | Creates **or reuses** the PaymentIntent for a job |
| POST | `/payment-intent/:piId/cancel` | Staff backed out before the card was presented |
| GET | `/payments` | `?jobId= &status= &unsynced=1 &limit=` |
| GET | `/payments/:id` | One row, incl. fee and EMV block, for the receipt |
| POST | `/payments/:id/resync` | Retry the QuickBooks write-back (idempotent) |
| GET | `/qbo-preflight` | Checks the accounts and connection before go-live |

Plus `POST /webhooks/stripe` at the app root — no CORS, no session auth; the
`stripe-signature` header over the raw body is the authentication.

### Reusing a PaymentIntent

After a decline, staff collect against the **same** PaymentIntent. That's
Stripe's explicit guidance for Interac and it's what stops a customer being
charged twice for a tap that failed. `POST /payment-intent` returns the
existing in-flight intent when the job and amount match; a partial unique index
on `terminal_payments` makes "one open attempt per job" structural rather than
a convention. A different amount cancels the old intent and mints a new one; an
intent that already succeeded returns **409** rather than starting a second
sale while the webhook is still landing.
