# Inbound email setup — `reply.holmgraphics.ca`

This brings customer email replies and staff email forwards back into
the **Messages** tab on each project automatically.

The pieces:

```
  Customer hits reply → MX for reply.holmgraphics.ca picks it up
   → webhook source (Resend Inbound OR Cloudflare Email Worker)
   → POST /api/projects/messages/inbound (this API)
   → insert row in project_messages
   → notify the OTHER party so the thread feels live
```

There are two supported webhook sources:

- **Resend Inbound** (recommended for the Holm Graphics setup since
  Cloudflare's Email Routing would conflict with the M365 MX records
  on the apex `holmgraphics.ca`). Resend handles MX + parsing +
  signature-signing.
- **Cloudflare Email Worker** (alternative — only works if your apex
  email isn't already routing through another MX provider). Code
  for it lives next to this README in `inbound-email-worker.js`.

The API webhook handler in `routes/inbound-email.js` accepts both
shapes; pick whichever fits your DNS situation.

---

## Path A — Resend Inbound (recommended)

### Step 1 — Pick the inbound subdomain & confirm Resend Inbound is enabled

We use `reply.holmgraphics.ca` so the apex zone's M365 MX records
stay untouched.

In Resend: **Domains → Add domain → `reply.holmgraphics.ca`**. On the
domain's detail page, look for an **Inbound** or **Receiving**
section. If it's there, you're set. If not, contact Resend support to
have inbound enabled on your account — Pro plan typically includes
it.

### Step 2 — Add the MX + SPF DNS records in Cloudflare

Resend will give you MX records to add (something like
`feedback-smtp.us-east-1.amazonses.com` with priority 10, plus a SPF
TXT). Add them in Cloudflare DNS:

1. Cloudflare dashboard → DNS → Records → **Add record**.
2. Type: **MX**, Name: `reply`, Mail server: (the host Resend gave
   you), Priority: (per Resend), Proxy: DNS only (orange-cloud OFF).
3. Add any additional MX or SPF/TXT records Resend lists. Keep them
   scoped to the `reply` subdomain — never edit the apex MX.
4. Wait a minute, then in Resend's domain page click **Verify** /
   re-check status.

### Step 3 — Configure the webhook endpoint in Resend

In Resend: **Webhooks → Add Endpoint**:

- URL: `https://<your-railway-api>.up.railway.app/api/projects/messages/inbound`
- Events: `email.received` (and any other inbound events Resend
  shows).

After saving, Resend gives you a **Signing Secret** that starts with
`whsec_`. Copy it.

### Step 4 — Railway env vars

In Railway → `holmgraphics-shop-api` → Variables:

| Variable | Value |
|---|---|
| `INBOUND_EMAIL_DOMAIN` | `reply.holmgraphics.ca` |
| `INBOUND_EMAIL_SVIX_SECRET` | `whsec_…` (the Resend signing secret from step 3) |

Save — Railway redeploys. The outbound `Reply-To` will now use the
inbound subdomain, and the webhook will verify Resend's signature on
every inbound POST.

### Step 5 — Test

1. From `/jobs/<id>` → Messages tab, post a test message to a job
   whose `contact_email` you control.
2. Hit reply in the customer's mailbox, send.
3. Within ~30 seconds the reply should land in that same Messages
   tab as a customer message.
4. Forward an unrelated customer email to
   `job<id>@reply.holmgraphics.ca` and confirm it appears too,
   authored as you.

If something's off, check **Resend → Webhooks → your endpoint →
Logs** — it shows every POST attempt and the API's response code.

---

## Path B — Cloudflare Email Worker (only if your apex MX is unused)

**Don't use this path if you have apex MX records you can't touch
(e.g. M365 / Outlook).** Cloudflare Email Routing onboarding wants
to own the whole zone's MX. Skip to Path A.

If apex email IS available to take over, the Worker code in
`inbound-email-worker.js` posts to the same webhook. Setup:

1. Generate a long random secret (e.g.
   `-join (1..64 | % { '0123456789abcdef'[(Get-Random -Max 16)] })`
   in PowerShell), and set it as both:
   - Railway env `INBOUND_EMAIL_SECRET`
   - Cloudflare Worker env `INBOUND_SECRET` (plus `API_WEBHOOK_URL`
     for the API endpoint URL).
2. In Cloudflare → Email → Email Routing → enable for the zone (this
   replaces your apex MX with Cloudflare's). Add a Custom Address
   route `*@reply.holmgraphics.ca` → **Send to Worker**.
3. Deploy `inbound-email-worker.js` (it depends on the `postal-mime`
   npm package for MIME parsing). Point the route at this worker.

---

## What the webhook does

For every inbound:

1. Extracts the job id from the To address (`...+job1234@…` or
   `job1234@…`).
2. Looks up the project + assigned staff + customer contact.
3. Classifies the sender as **staff** (matches `employees.email`) or
   **customer**.
4. Strips the quoted-reply trail using a heuristic that covers Gmail,
   Outlook, Apple Mail, and Resend's own templates.
5. Inserts a row in `project_messages` with the appropriate
   `author_type`. Dedupes via `Message-ID`.
6. Sends a notification email to the OTHER party so they see the
   message in real time — customer reply → notify assigned staff,
   staff forward → notify customer.

---

## Troubleshooting

- **401 svix signature mismatch**: the signing secret on Railway
  doesn't match what Resend has for that endpoint. Regenerate in
  Resend, paste fresh into `INBOUND_EMAIL_SVIX_SECRET`, redeploy.
- **400 "no recognizable job tag"**: the address didn't have
  `jobNNN` in the local part. Customer changed the To field on
  their reply, or the forward target was mistyped.
- **404 "job not found"**: id extracted but project was deleted.
- **No notification reaches the customer/staff side**: open Resend
  logs (the *outbound* side) and confirm the notification email was
  accepted. Check Railway logs around the same timestamp.
- **Reply trail still appears in the stored body**: the heuristic
  missed the marker your client uses. Forward me an example email
  and I'll widen the regex.
