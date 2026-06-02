// lib/inbound-email-parser.js
// Helpers for the inbound-email webhook (routes/inbound-email.js).

'use strict';

// Extract a project id from a To address shaped like
//   anything+job1234@reply.holmgraphics.ca   (reply case)
//   job1234@reply.holmgraphics.ca            (forward case)
// Returns null if no /jobNNN/ marker is found.
function extractJobId(toAddress) {
  if (!toAddress) return null;
  const localPart = String(toAddress).split('@')[0] || '';
  // Match either the bare `jobNNN` or `+jobNNN` form.
  const m = localPart.match(/(?:^|[+.])(?:job)(\d+)$/i)
         || localPart.match(/(?:^|[+.])(?:job)(\d+)(?=[+.])/i)
         || localPart.match(/^job(\d+)$/i);
  if (!m) return null;
  const id = parseInt(m[1], 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

// True for emails that are forwarded INTO the system (staff filing a
// customer email into the Messages tab). For these we want to KEEP
// the original content — the whole point of the forward is to capture
// what the other party wrote. Detect via subject prefix or any
// forwarded-message banner in the body.
function isForwardedEmail(subject, text) {
  if (subject && /^\s*(fwd?|fw):/i.test(subject)) return true;
  if (text && /(?:-{2,}\s*Forwarded message\s*-{2,}|Begin forwarded message:)/i.test(text)) return true;
  return false;
}

// Strip the quoted-reply / forward trail from a plaintext email body.
// Imperfect (email clients vary wildly) but handles the dominant
// patterns from Gmail, Outlook, Apple Mail, and Resend's own templates.
// What we keep: everything up to the first line that looks like a
// reply/forward marker. Everything from that line onward gets dropped.
function stripReplyTrail(text) {
  if (!text) return '';
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  // Markers that, on their own line, indicate "everything below is
  // quoted history". Conservative — we don't break on a single quoted
  // ">" line because some clients quote inside the live reply.
  const markers = [
    /^On\s.+wrote:\s*$/i,                     // Gmail / Apple Mail
    /^On\s.+\bat\b.+\s.+\s.+wrote:\s*$/i,     // Gmail with locale
    /^From:\s+.+<[^>]+>\s*$/,                 // Outlook block start
    /^From:\s+.+@.+\s*$/,                     // Outlook block start (no name)
    /^Sent:\s+\w+,\s/,                        // Outlook "Sent: Monday, ..."
    /^-{2,}\s*Original\s+Message\s*-{2,}\s*$/i,
    /^-{2,}\s*Forwarded\s+message\s*-{2,}\s*$/i,
    /^Begin forwarded message:\s*$/i,
    /^_{5,}\s*$/,                             // 5+ underscores often delimits
    /^Get Outlook for /i,
    /^Sent from my (iPhone|iPad|Android|mobile|Galaxy)/i,
  ];

  const cut = lines.findIndex((line) => markers.some((re) => re.test(line.trim())));
  const kept = cut === -1 ? lines : lines.slice(0, cut);
  // Trim trailing blanks left behind after slicing.
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.join('\n').trim();
}

// Pull "Name <email>" pieces out of a From header. Returns
// { name, email } — both may be empty strings.
function parseFromHeader(raw) {
  if (!raw) return { name: '', email: '' };
  const s = String(raw).trim();
  const m = s.match(/^\s*"?([^"<]+?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim(), email: m[2].trim().toLowerCase() };
  // Bare email
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return { name: '', email: s.toLowerCase() };
  return { name: s, email: '' };
}

module.exports = { extractJobId, stripReplyTrail, parseFromHeader, isForwardedEmail };
