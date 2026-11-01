import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Webhook, verifyWebhook, isValidWebhook, UnlyxError } from '../lib/index.mjs';

const SECRET = 'whsec_test_0123456789';
const BODY = '{"event":"order.completed","tenant_id":1,"created_at":"2026-11-01T10:00:00+00:00","data":{"reference":"UX-1001","status":"completed","reply":"CODE: 12345678"}}';
const TS = 1793000000;

/** Same formula as the server (WebhookDispatcher::timedSignature). */
const serverHeader = (secret, ts, body) => `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;

test('valid delivery decodes', () => {
  const event = verifyWebhook(BODY, { 'x-unlyx-signature': serverHeader(SECRET, TS, BODY) }, SECRET, { now: TS + 10 });
  assert.equal(event.event, 'order.completed');
  assert.equal(event.data.reference, 'UX-1001');
});

test('Buffer payload, WHATWG Headers and array values', () => {
  const h = serverHeader(SECRET, TS, BODY);
  assert.ok(isValidWebhook(Buffer.from(BODY), new Headers({ 'X-Unlyx-Signature': h }), SECRET, { now: TS }));
  assert.ok(isValidWebhook(BODY, { 'X-Unlyx-Signature': [h] }, SECRET, { now: TS }));
  assert.ok(Webhook.isValid(BODY, { 'X-Unlyx-Signature': h }, SECRET, { now: TS }));
});

test('tampered body fails', () => {
  const h = serverHeader(SECRET, TS, BODY);
  assert.throws(() => verifyWebhook(BODY.replace('12345678', '00000000'), { 'X-Unlyx-Signature': h }, SECRET, { now: TS }),
    (e) => e instanceof UnlyxError && e.code === 'invalid_signature');
});

test('wrong secret fails', () => {
  assert.equal(isValidWebhook(BODY, { 'X-Unlyx-Signature': serverHeader('whsec_other', TS, BODY) }, SECRET, { now: TS }), false);
});

test('old timestamp rejected; tolerance 0 turns it off', () => {
  const h = serverHeader(SECRET, TS, BODY);
  assert.equal(isValidWebhook(BODY, { 'X-Unlyx-Signature': h }, SECRET, { now: TS + 301 }), false);
  assert.equal(isValidWebhook(BODY, { 'X-Unlyx-Signature': h }, SECRET, { tolerance: 0, now: TS + 99999 }), true);
});

test('missing or malformed header', () => {
  assert.equal(isValidWebhook(BODY, {}, SECRET), false);
  assert.equal(isValidWebhook(BODY, { 'X-Unlyx-Signature': 'garbage' }, SECRET), false);
  assert.equal(isValidWebhook(BODY, { 'X-Unlyx-Signature': 'v1=abc' }, SECRET), false);
});

test('a parsed object is refused (must be the raw body)', () => {
  assert.throws(() => verifyWebhook(JSON.parse(BODY), { 'X-Unlyx-Signature': serverHeader(SECRET, TS, BODY) }, SECRET, { now: TS }),
    (e) => e instanceof UnlyxError && e.code === 'invalid_argument');
});

test('secret rotation', () => {
  assert.ok(isValidWebhook(BODY, { 'X-Unlyx-Signature': serverHeader(SECRET, TS, BODY) }, ['whsec_new', SECRET], { now: TS }));
});

test('signatureHeader matches the server', () => {
  assert.equal(Webhook.signatureHeader(SECRET, TS, BODY), serverHeader(SECRET, TS, BODY));
});
