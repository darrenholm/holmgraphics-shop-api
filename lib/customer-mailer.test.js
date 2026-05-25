// lib/customer-mailer.test.js
//
// Run with:
//   node --test lib/customer-mailer.test.js
//
// Locks the recipient-precedence rules for project-related notifications
// (proof, status, ready-for-pickup, shipped). The actual mailer touches
// Resend + the DB; the resolution logic is factored into pickRecipientEmail
// so the precedence can be tested without either dependency.
//
// Precedence (most specific wins):
//   1. project.contact_email
//   2. order.notification_email
//   3. client.email

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const { _internals } = require('./customer-mailer');
const { pickRecipientEmail } = _internals;

// ─── Happy path: each tier wins when set ─────────────────────────────────────

test('pickRecipientEmail: project contact wins when all three are set', () => {
  const got = pickRecipientEmail({
    projectContactEmail:    'project-mgr@acme.com',
    orderNotificationEmail: 'order-override@acme.com',
    clientEmail:            'ap@acme.com',
  });
  assert.equal(got, 'project-mgr@acme.com');
});

test('pickRecipientEmail: order override wins when project contact is blank', () => {
  const got = pickRecipientEmail({
    projectContactEmail:    '',
    orderNotificationEmail: 'order-override@acme.com',
    clientEmail:            'ap@acme.com',
  });
  assert.equal(got, 'order-override@acme.com');
});

test('pickRecipientEmail: client email is the last-resort default', () => {
  const got = pickRecipientEmail({
    projectContactEmail:    null,
    orderNotificationEmail: undefined,
    clientEmail:            'ap@acme.com',
  });
  assert.equal(got, 'ap@acme.com');
});

// ─── Whitespace handling ────────────────────────────────────────────────────

test('pickRecipientEmail: treats whitespace-only as unset', () => {
  // Whitespace in the higher-priority field shouldn't shadow a real
  // lower-priority address. Common when staff hits backspace on an input
  // field and accidentally leaves a space.
  const got = pickRecipientEmail({
    projectContactEmail:    '   ',
    orderNotificationEmail: '\t',
    clientEmail:            'ap@acme.com',
  });
  assert.equal(got, 'ap@acme.com');
});

test('pickRecipientEmail: trims surrounding whitespace from the winning address', () => {
  // The mailer downstream normalises again, but trimming here means logs
  // and email_log rows record the canonical address from the start.
  const got = pickRecipientEmail({
    projectContactEmail:    '  project-mgr@acme.com  ',
    orderNotificationEmail: '',
    clientEmail:            '',
  });
  assert.equal(got, 'project-mgr@acme.com');
});

// ─── Nullable shapes ────────────────────────────────────────────────────────

test('pickRecipientEmail: returns null when nothing is set', () => {
  assert.equal(
    pickRecipientEmail({ projectContactEmail: null, orderNotificationEmail: null, clientEmail: null }),
    null
  );
  assert.equal(
    pickRecipientEmail({ projectContactEmail: '', orderNotificationEmail: '', clientEmail: '' }),
    null
  );
  assert.equal(
    pickRecipientEmail({}),
    null
  );
});
