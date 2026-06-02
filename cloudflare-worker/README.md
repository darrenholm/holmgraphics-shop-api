# Inbound email setup — `reply.holmgraphics.ca`

This brings customer email replies and staff email forwards back into
the **Messages** tab on each project automatically.

The pieces:

```
  Customer hits reply → Cloudflare Email Routing (reply.holmgraphics.ca)
   → Email Worker → POST /api/projects/messages/inbound (this API)
   → insert row in project_messages
   → notify the OTHER party so the thread feels live
```

## Step 1 — Generate a shared secret

Pick a long random string. On macOS/Linux:

```bash
openssl rand -hex 32
```

You'll paste this string in two places: as `INBOUND_EMAIL_SECRET` on
Railway, and as `INBOUND_SECRET` on the Cloudflare Worker.

## Step 2 — Railway env vars

In Railway → `holmgraphics-shop-api` → Variables, add:

| Variable | Value |
|---|---|
| `INBOUND_EMAIL_SECRET` | (the random string from step 1) |
| `INBOUND_EMAIL_DOMAIN` | `reply.holmgraphics.ca` |

Save — Railway will redeploy automatically. The outbound message
template will now use `Reply-To: <staff>+jobNNN@reply.holmgraphics.ca`.

## Step 3 — DNS for the subdomain

In Cloudflare DNS for `holmgraphics.ca`:

1. Verify the apex `holmgraphics.ca` MX records still point at WHC
   (so the regular `darren@holmgraphics.ca`, `frontdesk@…` mailboxes
   are unaffected). Don't touch them.
2. Cloudflare will add MX records for the `reply` subdomain
   automatically when you enable Email Routing in step 4 — you don't
   add anything manually here.

## Step 4 — Cloudflare Email Routing

1. Cloudflare dashboard → **Email** → **Email Routing**.
2. Pick the `holmgraphics.ca` zone.
3. **Enable Email Routing** if not already on. Cloudflare will prompt
   to add MX records on the apex — **only do this if your existing
   apex email already routes through Cloudflare**. If apex email is
   still on WHC (likely), **skip the apex** and only configure the
   subdomain in the next step.
4. Once enabled, go to **Settings → Custom Address** (or **Routes**)
   and add:
   - Custom address: `*@reply.holmgraphics.ca` (catch-all on the
     subdomain)
   - Destination: **Send to Worker** → pick the worker from step 5.
5. Cloudflare will add MX records for `reply.holmgraphics.ca`
   automatically.

(If Email Routing complains about needing apex MX changes, configure
a subdomain-only zone instead — `reply.holmgraphics.ca` as a child
zone with its own MX. Cloudflare support has a doc on this; ask in
chat if it gets stuck.)

## Step 5 — Deploy the Cloudflare Email Worker

1. Cloudflare dashboard → **Workers & Pages** → **Create application**
   → **Create Worker**. Name it `inbound-email-worker`.
2. Replace the default code with the contents of
   `inbound-email-worker.js` (in this folder).
3. The Worker uses `postal-mime` for MIME parsing — add it to
   **Settings → Bindings → npm packages** (or in `wrangler.toml` if
   you deploy via CLI):
   ```bash
   npm install postal-mime
   ```
4. **Settings → Variables and Secrets** — add:
   - `API_WEBHOOK_URL` = `https://<your-railway-api>.up.railway.app/api/projects/messages/inbound`
     (use your production URL)
   - `INBOUND_SECRET` = (the random string from step 1)
5. **Save and Deploy**.
6. Go back to Email Routing and confirm the route from step 4 points
   at this worker.

## Step 6 — Test

1. Send a message from `/jobs/<id>` Messages tab to a job whose
   contact email you control.
2. The email lands in the customer mailbox. Hit **Reply** in your
   email client — body should auto-include "Re: New message on your
   job #N".
3. Send.
4. Within ~30 seconds the reply should appear in the same job's
   Messages tab as a customer message.
5. Cloudflare Worker logs (Workers → your worker → Logs) show the
   POST result. Railway logs show the webhook hit.

## Forwarding an external email into a job

To file an email you got directly from a customer (outside the
system) into the Messages tab, forward it to:

```
job<id>@reply.holmgraphics.ca
```

e.g., `job1234@reply.holmgraphics.ca`. The same worker + webhook
handles it; it'll show in the Messages tab authored by your name
(since it's coming from your staff email), with the forwarded body.

## Troubleshooting

- **Webhook returns 401**: the Worker's `INBOUND_SECRET` doesn't match
  Railway's `INBOUND_EMAIL_SECRET`. Re-paste, redeploy worker.
- **Webhook returns 400 "no recognizable job tag"**: the To address
  doesn't have `jobNNN` in the local part. Confirm the customer
  replied to the original message and didn't change the To field.
- **Webhook returns 404 "job not found"**: the job id was extracted
  but no such project exists. Did the job get deleted? Was the id
  mangled?
- **Email reaches the customer but reply doesn't come back**: check
  Cloudflare Workers logs for parse errors, and Email Routing log
  for delivery status. The receiving address must match
  `*@reply.holmgraphics.ca`.
- **Quoted-reply trail still appears in stored messages**: our
  `stripReplyTrail` heuristic missed the marker. Forward me an
  example and I'll widen the regex.
