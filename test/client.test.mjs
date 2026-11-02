import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Client, UnlyxError } from '../lib/index.mjs';
import { MockTransport } from './mock-transport.mjs';

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const orderRow = (over = {}) => ({
  reference: 'UX-1001', status: 'processing', dhru_status: 1,
  service: { id: 42, name: 'iPhone Carrier Check (GSX)', type: 'imei' },
  quantity: 1, imei: '356938035643809', fields: {}, price: '1.25', currency: 'USD',
  reply: null, placed_at: '2026-11-01T10:00:00+00:00', completed_at: null, ...over,
});
const placed = (over = {}) => ({ ok: true, data: orderRow(over), replayed: false, balance: '248.75' });

let http;
let slept;
const client = (opts = {}) => new Client('https://yourshop.com', 'live_test_key_123', { transport: http, sleep: (ms) => { slept.push(ms); }, ...opts });
const header = (req, name) => {
  const k = Object.keys(req.headers).find((h) => h.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : req.headers[k];
};
const sentBody = () => JSON.parse(http.last.body);

async function rejects(promise, code) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof UnlyxError, `expected UnlyxError, got ${err}`);
    if (code) assert.equal(err.code, code);
    return err;
  }
  assert.fail('expected an UnlyxError');
}

beforeEach(() => {
  http = new MockTransport();
  slept = [];
});

describe('construction', () => {
  test('rejects plain http', () => {
    assert.throws(() => new Client('http://yourshop.com', 'k'), (e) => e instanceof UnlyxError && e.code === 'invalid_argument');
  });
  test('strips /api/v1 suffix', async () => {
    http.json(200, { ok: true, data: { key: {} } });
    await new Client('https://YourShop.com/api/v1/', 'k', { transport: http }).account();
    assert.equal(http.last.url, 'https://yourshop.com/api/v1/account');
  });
  test('signing needs both parts', () => {
    assert.throws(() => new Client('https://yourshop.com', 'k', { signingKeyId: 'kid_1' }), UnlyxError);
  });
});

describe('endpoints', () => {
  test('account', async () => {
    http.json(200, { ok: true, data: {
      email: 'reseller@example.com', name: 'North Unlock', username: 'north', type: 'reseller', balance: '250.40', currency: 'USD',
      key: { name: 'Panel', scopes: ['account.read', 'orders.place'], sandbox: false, expires_at: null, rate_limit_per_min: 120, daily_order_limit: 0 },
    } });
    const a = await client().account();
    assert.equal(http.last.method, 'GET');
    assert.equal(header(http.last, 'Authorization'), 'Bearer live_test_key_123');
    assert.equal(http.last.body, null);
    assert.equal(a.balance, '250.40');
    assert.equal(a.rateLimitPerMin, 120);
    assert.deepEqual(a.scopes, ['account.read', 'orders.place']);
  });

  test('services with type', async () => {
    http.json(200, { ok: true, count: 1, data: [{
      id: 7, name: 'Samsung FRP Remove (Server)', type: 'server', group: 'Samsung', price: 3.5, currency: 'USD', delivery_time: '1-30 min',
      quantity: { enabled: true, min: 1, max: 10, options: [1, 5, 10] },
      fields: [{ key: 'serial', label: 'Serial number', type: 'text', required: true, help: null, options: [] }], can_cancel: true,
    }] });
    const rows = await client().services('server');
    assert.ok(http.last.url.endsWith('/api/v1/services?type=server'));
    assert.equal(rows[0].price, '3.5');
    assert.deepEqual(rows[0].quantity.options, [1, 5, 10]);
    assert.equal(rows[0].fields[0].required, true);
  });

  test('services rejects unknown type', async () => {
    await rejects(client().services('phone'), 'invalid_argument');
  });

  test('place order', async () => {
    http.json(201, placed());
    const o = await client().placeOrder({ service: 42, imei: '356938035643809' }, { idempotencyKey: 'shop-order-1001' });
    assert.equal(http.last.method, 'POST');
    assert.equal(http.last.url, 'https://yourshop.com/api/v1/orders');
    assert.equal(header(http.last, 'Idempotency-Key'), 'shop-order-1001');
    assert.equal(header(http.last, 'Content-Type'), 'application/json');
    assert.deepEqual(sentBody(), { service: 42, imei: '356938035643809' });
    assert.equal(o.reference, 'UX-1001');
    assert.equal(o.replayed, false);
    assert.equal(o.balance, '248.75');
    assert.equal(o.isFinal, false);
  });

  test('place order generates a uuid key', async () => {
    http.json(201, placed());
    await client().placeOrder({ service: 42, imei: '356938035643809' });
    assert.match(header(http.last, 'Idempotency-Key'), UUID4);
  });
});

describe('retry rules', () => {
  test('POST retried when not sent, same key', async () => {
    http.fail(false, 'getaddrinfo ENOTFOUND').json(201, placed());
    await client().placeOrder({ service: 42, imei: '356938035643809' });
    assert.equal(http.requests.length, 2);
    assert.equal(header(http.requests[0], 'Idempotency-Key'), header(http.requests[1], 'Idempotency-Key'));
  });

  test('POST never retried when maybe sent', async () => {
    http.fail(true, 'timed out');
    const e = await rejects(client().placeOrder({ service: 42, imei: '356938035643809' }), 'connection_error');
    assert.equal(e.httpStatus, 0);
    assert.match(e.message, /SAME Idempotency-Key/);
    assert.equal(http.requests.length, 1);
  });

  test('POST not retried on plain 5xx', async () => {
    http.json(502, { ok: false, error: { code: 'server_error', message: 'Bad gateway' } });
    await rejects(client().placeOrder({ service: 42 }), 'server_error');
    assert.equal(http.requests.length, 1);
  });

  test('POST retried on shop temporary 503, same key', async () => {
    http.json(503, { ok: false, error: { code: 'temporary', message: 'Temporary error' } }).json(201, placed());
    await client().placeOrder({ service: 42 }, { idempotencyKey: 'k-503' });
    assert.equal(http.requests.length, 2);
    assert.equal(header(http.requests[1], 'Idempotency-Key'), 'k-503');
  });

  test('GET retried on 5xx and lost response', async () => {
    http.json(503, {}).fail(true, 'reset').json(200, { ok: true, data: orderRow({ status: 'completed', dhru_status: 4, reply: 'CODE: 12345678' }) });
    const o = await client().order('UX-1001');
    assert.equal(http.requests.length, 3);
    assert.equal(slept.length, 2);
    assert.equal(o.isSuccess, true);
    assert.equal(o.reply, 'CODE: 12345678');
  });

  test('retries stop at maxRetries', async () => {
    http.json(500, {}).json(500, {}).json(500, { ok: false, error: { code: 'server_error', message: 'down' } });
    const e = await rejects(client().account(), 'server_error');
    assert.equal(e.httpStatus, 500);
    assert.equal(http.requests.length, 3);
  });

  test('429 Retry-After honoured with the same key', async () => {
    http.json(429, { ok: false, error: { code: 'rate_limited', message: 'Rate limit exceeded' } }, { 'Retry-After': '3' }).json(201, placed());
    await client().placeOrder({ service: 42 }, { idempotencyKey: 'k-1' });
    assert.deepEqual(slept, [3000]);
    assert.equal(header(http.requests[1], 'Idempotency-Key'), 'k-1');
  });

  test('429 without Retry-After, or too long, throws', async () => {
    http.json(429, { ok: false, error: { code: 'limit', message: 'Daily API order limit reached for this account' } });
    await rejects(client().placeOrder({ service: 42 }), 'limit');
    http.json(429, { ok: false, error: { code: 'rate_limited', message: 'x' } }, { 'Retry-After': '600' });
    const e = await rejects(client().account(), 'rate_limited');
    assert.equal(e.retryAfter, 600);
    assert.deepEqual(slept, []);
  });

  test('maxRetries 0', async () => {
    http.fail(false);
    await rejects(client({ maxRetries: 0 }).account(), 'connection_error');
    assert.equal(http.requests.length, 1);
  });
});

describe('errors', () => {
  test('error envelope', async () => {
    http.json(402, { ok: false, error: { code: 'low_balance', message: 'Insufficient Credit', reference: 'a1b2c3d4' } });
    const e = await rejects(client().placeOrder({ service: 42, imei: '356938035643809' }), 'low_balance');
    assert.equal(e.httpStatus, 402);
    assert.equal(e.message, 'Insufficient Credit');
    assert.equal(e.reference, 'a1b2c3d4');
    assert.equal(e.body.error.code, 'low_balance');
  });

  test('redirect never followed', async () => {
    http.raw(301, '', { Location: 'https://elsewhere.example/' });
    await rejects(client().account(), 'unexpected_redirect');
    assert.equal(http.requests.length, 1);
  });

  test('non-JSON answer', async () => {
    http.raw(200, '<html>maintenance</html>');
    const e = await rejects(client().account(), 'invalid_response');
    assert.equal(e.rawBody, '<html>maintenance</html>');
  });
});

describe('bulk, list, cancel, webhooks, usage, raw', () => {
  test('bulk', async () => {
    http.json(200, { ok: true, balance: '200.00', data: [
      { ...orderRow(), line: 0, reference_in: 'a-1', ok: true },
      { line: 1, reference_in: 'gen', ok: false, error: { code: 'invalid_input', message: 'IMEI must be 15 digits' } },
    ] });
    const r = await client({ idGenerator: () => 'gen' }).placeOrders([
      { service: 42, imei: '356938035643809', reference: 'a-1' }, { service: 42, imei: '123' },
    ]);
    assert.ok(http.last.url.endsWith('/api/v1/orders/bulk'));
    assert.deepEqual(sentBody().orders.map((l) => l.reference), ['a-1', 'gen']);
    assert.equal(r.succeeded.length, 1);
    assert.equal(r.failed[0].errorCode, 'invalid_input');
    assert.equal(r.lines[0].order.reference, 'UX-1001');
    assert.equal(r.balance, '200.00');
  });

  test('bulk limits', async () => {
    await rejects(client().placeOrders(Array(101).fill({ service: 1 })), 'invalid_argument');
    await rejects(client().placeOrders([]), 'invalid_argument');
  });

  test('orders filters', async () => {
    http.json(200, { ok: true, page: 1, per_page: 2, total: 5, data: [orderRow(), orderRow({ reference: 'UX-1002' })] });
    const page = await client().orders({ status: 'completed', since: new Date('2026-10-01T00:00:00Z'), perPage: 2 });
    assert.equal(http.last.url, 'https://yourshop.com/api/v1/orders?per_page=2&since=2026-10-01T00%3A00%3A00.000Z&status=completed');
    assert.equal(page.orders.length, 2);
    assert.equal(page.hasMore, true);
  });

  test('orders rejects unknown filter', async () => {
    await rejects(client().orders({ colour: 'red' }), 'invalid_argument');
  });

  test('cancel encodes reference', async () => {
    http.json(200, { ok: true, balance: '10.00', data: orderRow({ status: 'cancelled', dhru_status: 3 }) });
    const o = await client().cancelOrder('UX 1/2');
    assert.equal(http.last.url, 'https://yourshop.com/api/v1/orders/UX%201%2F2/cancel');
    assert.ok(header(http.last, 'Idempotency-Key'));
    assert.equal(o.isRejected, true);
    assert.equal(o.balance, '10.00');
  });

  test('webhooks crud', async () => {
    http.json(201, { ok: true, data: { id: 3, name: 'Main', url: 'https://panel.yourshop.com/hooks/unlyx', events: ['order.completed'], active: true, secret: 'whsec_abcdef' } })
      .json(200, { ok: true, data: [{ id: 3, url: 'https://panel.yourshop.com/hooks/unlyx', events: ['order.completed'], active: true }] })
      .json(200, { ok: true, data: { deleted: true } });
    const c = client();
    const w = await c.createWebhook('https://panel.yourshop.com/hooks/unlyx', ['order.completed'], 'Main');
    assert.equal(w.secret, 'whsec_abcdef');
    assert.deepEqual(sentBody(), { url: 'https://panel.yourshop.com/hooks/unlyx', events: ['order.completed'], name: 'Main' });
    assert.equal((await c.webhooks())[0].id, 3);
    assert.equal(await c.deleteWebhook(3), true);
    assert.equal(http.last.method, 'DELETE');
    assert.ok(http.last.url.endsWith('/webhooks/3'));
  });

  test('usage', async () => {
    http.json(200, { ok: true, data: { since: '2026-10-25T00:00:00+00:00', calls: 120, errors: 3, by_action: { 'v1:orders.store': 40 }, recent: [], rate_limit_per_min: 60 } });
    const u = await client().usage(500);
    assert.ok(http.last.url.endsWith('/usage?days=90'));
    assert.equal(u.calls, 120);
    assert.deepEqual(u.byAction, { 'v1:orders.store': 40 });
  });

  test('raw request', async () => {
    http.json(200, { ok: true, data: [], count: 0 });
    const env = await client().request('get', 'services', { query: { type: 'imei' } });
    assert.equal(env.count, 0);
    assert.ok(http.last.url.endsWith('/api/v1/services?type=imei'));
  });

  test('raw request refuses bad paths', async () => {
    for (const bad of ['https://elsewhere.example/x', '/../admin', '/orders?x=1']) {
      await rejects(client().request('GET', bad), 'invalid_argument');
    }
    assert.equal(http.requests.length, 0);
  });
});

describe('request signing', () => {
  test('adds X-Key-Id / X-Timestamp / X-Signature', async () => {
    http.json(201, placed());
    await client({ signingKeyId: 'kid_1', signingSecret: 'sign-secret' }).placeOrder({ service: 42, imei: '356938035643809' }, { idempotencyKey: 'k-9' });
    const r = http.last;
    const ts = header(r, 'X-Timestamp');
    assert.equal(header(r, 'X-Key-Id'), 'kid_1');
    assert.match(ts, /^\d{10}$/);
    const expected = createHmac('sha256', 'sign-secret').update(`POST\n/api/v1/orders\n${ts}\n${r.body}`).digest('hex');
    assert.equal(header(r, 'X-Signature'), expected);
  });

  test('no signing headers by default', async () => {
    http.json(200, { ok: true, data: { key: {} } });
    await client().account();
    assert.equal(header(http.last, 'X-Signature'), undefined);
  });
});
