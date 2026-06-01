// lib/facebook.js
// Posts a single gallery photo to the Holm Graphics Facebook *Page* via the
// Meta Graph API. Used as an optional second destination when a project photo
// is published to the website gallery (see routes/projects.js PATCH photos).
//
// Setup (one-time, manual — NOT code; the module only consumes the token):
//   1. Create/reuse a Facebook App at developers.facebook.com.
//   2. Request permissions: pages_manage_posts, pages_read_engagement,
//      pages_show_list (pages_manage_posts needs App Review for production).
//   3. Get a long-lived *Page* access token:
//        a. Graph API Explorer → short-lived User token with those scopes.
//        b. Exchange for a long-lived User token:
//           GET /oauth/access_token?grant_type=fb_exchange_token
//               &client_id=APP_ID&client_secret=APP_SECRET
//               &fb_exchange_token=SHORT_LIVED_TOKEN
//        c. GET /me/accounts?access_token=LONG_LIVED_USER_TOKEN → the Page
//           and its access_token. That Page token is effectively non-expiring
//           and is the one to store.
//   4. In Railway, set FB_PAGE_ID and FB_PAGE_ACCESS_TOKEN. These are SERVER
//      ONLY — never commit them and never expose them to the SvelteKit client
//      bundle. (Recall the prior .env-in-repo issue.)
//
// Without those two env vars the module is "not configured": postPhotoToPage
// throws a clear error so the caller records it as a retryable fb_post_error.

'use strict';

// Pin the Graph API version explicitly — don't rely on Facebook's
// default-oldest-version behaviour, which changes under us over time.
const GRAPH_VERSION        = process.env.FB_GRAPH_VERSION || 'v21.0';
const FB_PAGE_ID           = process.env.FB_PAGE_ID || '';
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || '';

function isConfigured() {
  return Boolean(FB_PAGE_ID && FB_PAGE_ACCESS_TOKEN);
}

// Post a photo to the Page by URL. Facebook fetches the image itself, which
// is simplest because gallery photos are already publicly served from WHC.
// (If images ever stop being publicly reachable, this is where a multipart
// upload fallback would go.)
//
//   postPhotoToPage({ imageUrl, caption }) → { post_id }
//
// Throws with the Facebook error message on any failure — the caller decides
// whether that's fatal (here it never is: it's recorded and retryable).
async function postPhotoToPage({ imageUrl, caption } = {}) {
  if (!isConfigured()) {
    throw new Error('Facebook not configured (FB_PAGE_ID / FB_PAGE_ACCESS_TOKEN missing)');
  }
  if (!imageUrl) {
    throw new Error('postPhotoToPage: imageUrl is required');
  }

  const endpoint = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(FB_PAGE_ID)}/photos`;
  const body = new URLSearchParams();
  body.set('url', imageUrl);
  if (caption) body.set('caption', caption);
  body.set('access_token', FB_PAGE_ACCESS_TOKEN);

  let res, json;
  try {
    res = await fetch(endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    body.toString(),
    });
    json = await res.json().catch(() => null);
  } catch (err) {
    throw new Error(`Facebook request failed: ${err.message}`);
  }

  // Success: { id, post_id }. Failure: { error: { message, type, code, ... } }.
  if (!res.ok || !json || json.error) {
    throw new Error(json?.error?.message || `Facebook HTTP ${res.status}`);
  }

  // For /photos, post_id is "<pageId>_<postId>" (links to the visible post);
  // id is the photo node id. Prefer post_id, fall back to id.
  return { post_id: json.post_id || json.id };
}

module.exports = { postPhotoToPage, isConfigured };
