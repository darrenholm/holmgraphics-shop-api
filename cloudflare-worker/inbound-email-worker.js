// cloudflare-worker/inbound-email-worker.js
// Cloudflare Email Worker that receives mail for *@reply.holmgraphics.ca
// and forwards it to the Holm Graphics API webhook so it can be stored
// under the matching job's Messages tab.
//
// Deploy this in the Cloudflare dashboard:
//   1. Workers & Pages → Create → Worker → paste this file.
//   2. Set the Worker's environment variables (Settings → Variables):
//        API_WEBHOOK_URL   = https://holmgraphics-shop-api-production.up.railway.app/api/projects/messages/inbound
//        INBOUND_SECRET    = <the same random string set as INBOUND_EMAIL_SECRET on Railway>
//   3. Email → Email Routing → Routes → create a Custom Address rule:
//        Pattern: *@reply.holmgraphics.ca
//        Destination: Send to Worker → pick this worker
//   4. DNS → add the MX records Cloudflare gives you for the subdomain
//      (Cloudflare will prompt you with the exact values).
//
// The Worker reads the raw MIME, extracts the headers + plaintext body,
// and POSTs JSON to the API. The API verifies the X-Inbound-Secret
// header and inserts a row in project_messages.

import PostalMime from 'postal-mime';

export default {
  async email(message, env, ctx) {
    if (!env.API_WEBHOOK_URL || !env.INBOUND_SECRET) {
      console.error('Worker missing API_WEBHOOK_URL or INBOUND_SECRET; dropping message.');
      return;
    }

    // Read the full raw MIME. message.raw is a ReadableStream.
    const rawBuf = await streamToArrayBuffer(message.raw);
    let parsed;
    try {
      parsed = await new PostalMime().parse(rawBuf);
    } catch (e) {
      console.error('postal-mime parse failed:', e.message);
      return;
    }

    const payload = {
      to:         message.to,                  // already the recipient address Cloudflare matched
      from:       parsed.from?.address
                    ? `${parsed.from.name || ''} <${parsed.from.address}>`.trim()
                    : message.from,
      subject:    parsed.subject || '',
      text:       parsed.text || stripHtml(parsed.html || ''),
      html:       parsed.html || '',
      message_id: parsed.messageId || message.headers.get('Message-ID') || null,
    };

    const res = await fetch(env.API_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'X-Inbound-Secret': env.INBOUND_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`API rejected inbound email (${res.status}): ${detail}`);
      // Throwing here makes Cloudflare retry — only do it for 5xx, not
      // 4xx (a 4xx is "we don't want this email", retrying won't help).
      if (res.status >= 500) {
        throw new Error(`API ${res.status}: ${detail}`);
      }
    }
  },
};

async function streamToArrayBuffer(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out.buffer;
}

function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+\n/g, '\n')
    .trim();
}
