# @unlyx/sdk (Node.js)

Official Node.js SDK for the **Unlyx REST API v1** — balance, services, orders (single and bulk), cancel, webhooks and usage for any Unlyx shop.

- Node 18+, zero dependencies (built-in `fetch` and `node:crypto`).
- ESM and CommonJS, TypeScript types included.
- HTTPS only, redirects never followed.
- Every POST carries an `Idempotency-Key`; retries re-send the same key, so a network hiccup can never charge an order twice.
- One error type: `UnlyxError`.
- `verifyWebhook()` checks signed webhook deliveries.

## Install

```bash
npm install @unlyx/sdk
```

npm: https://www.npmjs.com/package/@unlyx/sdk

## Quick start

```js
import { Client } from '@unlyx/sdk';          // or: const { Client } = require('@unlyx/sdk');

const unlyx = new Client('https://yourshop.com', process.env.UNLYX_API_KEY);

const account = await unlyx.account();
console.log(account.balance, account.currency);

for (const s of await unlyx.services('imei')) {
  console.log(s.id, s.name, s.price, s.currency);
}

// Use your own order id as the idempotency key: running the same code twice
// returns the first order, never a second charge.
let order = await unlyx.placeOrder(
  { service: 42, imei: '356938035643809' },
  { idempotencyKey: 'my-order-1001' },
);
console.log(order.reference, order.status);

order = await unlyx.order(order.reference);
if (order.isSuccess) console.log('Result:', order.reply);
```

Get a key in the shop: **Account → API**. Tick *Sandbox* to build without spending money — sandbox orders get a `SANDBOX-` reference and never reach a supplier.

## All methods

| Method | Endpoint | Resolves to |
|---|---|---|
| `account()` | `GET /account` | `Account` |
| `usage(days = 7)` | `GET /usage` | `Usage` |
| `services(type?)` | `GET /services` | `Service[]` |
| `service(id)` | `GET /services/{id}` | `Service` |
| `placeOrder(order, { idempotencyKey })` | `POST /orders` | `Order` (`replayed`, `balance` set) |
| `placeOrders(orders)` | `POST /orders/bulk` | `BulkResult` |
| `orders({ status, since, imei, page, perPage })` | `GET /orders` | `OrderPage` |
| `order(reference)` | `GET /orders/{reference}` | `Order` |
| `cancelOrder(reference)` | `POST /orders/{reference}/cancel` | `Order` |
| `webhooks()` | `GET /webhooks` | `WebhookEndpoint[]` |
| `createWebhook(url, events?, name?)` | `POST /webhooks` | `WebhookEndpoint` (`secret` set once) |
| `deleteWebhook(id)` | `DELETE /webhooks/{id}` | `boolean` |
| `request(method, path, { query, body, headers })` | anything under `/api/v1` | decoded JSON envelope |

Order input: `service` (required), `imei`, `quantity`, `fields` (`{ serial: 'R58M12ABCDE' }`), `note`, `file` (`{ name: 'backup.bin', data: base64 }`). Money (`balance`, `price`) is an exact decimal string.

Bulk: up to 100 lines; each succeeds or fails on its own. A line's `reference` is its idempotency key; lines without one get a random reference so the SDK's retries are safe.

```js
const result = await unlyx.placeOrders([
  { reference: 'batch7-1', service: 42, imei: '356938035643809' },
  { reference: 'batch7-2', service: 42, imei: '359070071234567' },
]);
for (const line of result.failed) console.log(line.reference, line.errorMessage);
```

## Options

```js
new Client('https://yourshop.com', key, {
  timeout: 30,          // seconds for the whole call
  maxRetries: 2,        // 0 turns retries off
  maxRetryWait: 60,     // never wait longer than this for a Retry-After
  signingKeyId: null,   // optional request signing, see below
  signingSecret: null,
  userAgent: 'my-panel/2.3',
  transport: undefined, // your own { send(req) } — e.g. to use a proxy
});
```

### When the SDK retries

| Situation | GET | POST |
|---|---|---|
| Connection failed before anything was sent (DNS, refused, TLS) | retried | retried, same Idempotency-Key |
| HTTP 429 with `Retry-After` (≤ `maxRetryWait`) | retried after that wait | retried after that wait, same key |
| HTTP 5xx | retried with backoff | **not retried** (except below) |
| HTTP 503 with error code `temporary` (shop database busy, nothing placed) | retried | retried, same key |
| Timeout / connection lost after sending | retried | **not retried** — check the order, or repeat with the same key |

### Request signing (optional)

If the shop turned on signed requests for your key, pass `signingKeyId` and `signingSecret`. Every request then carries `X-Key-Id`, `X-Timestamp` (unix seconds) and `X-Signature` = hex HMAC-SHA256 of `"{METHOD}\n{path}\n{timestamp}\n{rawBody}"` (path without the query string, e.g. `/api/v1/orders`; empty body for GET).

## Errors

```js
import { UnlyxError } from '@unlyx/sdk';

try {
  await unlyx.placeOrder({ service: 42, imei: '356938035643809' }, { idempotencyKey: 'my-order-1002' });
} catch (e) {
  if (!(e instanceof UnlyxError)) throw e;
  e.code;        // 'low_balance', 'invalid_input', 'not_found', 'service_disabled', 'rate_limited', 'connection_error' …
  e.httpStatus;  // 402, 404, 409, 422, 429 … (0 = no response)
  e.message;     // readable text from the shop
  e.reference;   // short support reference — quote it to the shop
  e.retryAfter;  // seconds, on 429
  e.body;        // decoded JSON body
}
```

## Webhooks

```js
import express from 'express';
import { verifyWebhook, UnlyxError } from '@unlyx/sdk';

const app = express();

// Keep the RAW body: verify before anything parses it.
app.post('/hooks/unlyx', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = verifyWebhook(req.body, req.headers, process.env.UNLYX_WEBHOOK_SECRET);
  } catch (e) {
    if (e instanceof UnlyxError) return res.sendStatus(400);
    throw e;
  }
  // event.event === 'order.completed'; event.data.reference, event.data.reply …
  // Use the X-Unlyx-Delivery header to ignore a delivery you already handled.
  res.sendStatus(200);
});
```

`verifyWebhook` takes the raw body as a string or Buffer, any headers object (Node's `req.headers`, a WHATWG `Headers`), refuses timestamps more than 5 minutes off (`{ tolerance }`), and accepts an array of secrets while you rotate.

## Tests

```bash
npm test
```

The suite uses `node:test` with a mocked transport and never calls a real shop.

## License

MIT
