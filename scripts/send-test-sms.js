// scripts/send-test-sms.js
// One-off CloudMessage test send — confirms the token, auth header, and sending
// number work before we rely on SMS inside the app flow.
//
// Usage (from the API repo root):
//   node scripts/send-test-sms.js +15195551234 "optional message"
//
// Reads SKYSWITCH_* from .env (or the shell env). Set at minimum:
//   SMS_PROVIDER=cloudmessage
//   SKYSWITCH_API_TOKEN=<your CloudMessage API Access Token>
//   SKYSWITCH_SMS_FROM=+15195073001
//
// Expected success output ends with: { ok: true, provider: 'cloudmessage', ... }
// If you get `cloudmessage send 401`, the auth header is wrong — set
//   SKYSWITCH_AUTH_HEADER=UserToken   and/or   SKYSWITCH_AUTH_PREFIX=
// and re-run. If you see provider:'stub', the token/from aren't loaded.

require('dotenv').config();
const sms = require('../lib/sms');

(async () => {
  const to  = process.argv[2];
  const msg = process.argv[3] || 'Holm Graphics test — SMS is working. \u{1F389}';
  if (!to) {
    console.error('usage: node scripts/send-test-sms.js <+E164number> [message]');
    process.exit(1);
  }
  console.log('provider configured?', sms.isConfigured());
  if (!sms.isConfigured()) {
    console.warn('⚠ not configured — this will run in STUB mode (no real send). '
      + 'Set SMS_PROVIDER=cloudmessage, SKYSWITCH_API_TOKEN, SKYSWITCH_SMS_FROM in .env.');
  }
  const r = await sms.send({ to, body: msg, kind: 'test' });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok && !r.stub ? 0 : 1);
})();
