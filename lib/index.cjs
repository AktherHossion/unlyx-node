'use strict';

/**
 * Official Node.js SDK for the Unlyx REST API v1.
 * Zero dependencies: built-in fetch (Node 18+) and node:crypto.
 */

const crypto = require('node:crypto');

const VERSION = '1.0.2';
const MAX_BULK = 100;
const SERVICE_TYPES = ['imei', 'server', 'file', 'remote'];
const ORDER_FILTERS = ['status', 'since', 'imei', 'page', 'per_page', 'perPage'];
const SIGNATURE_HEADER = 'X-Unlyx-Signature';
const DEFAULT_TOLERANCE = 300;

/** Network error codes that happen before a single request byte is written. */
const NOT_SENT_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER',
]);

// ------------------------------------------------------------------ errors

/**
 * The one error the SDK throws.
 * `code` is the API's error.code (low_balance, invalid_input, not_found, service_disabled, idempotency_conflict,
 * limit, temporary, rate_limited, unauthorized, forbidden …) or an SDK code: connection_error, invalid_response,
 * unexpected_redirect, invalid_signature, invalid_argument.
 */
class UnlyxError extends Error {
  constructor(message, code, { httpStatus = 0, body = null, rawBody = '', retryAfter = null, cause } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'UnlyxError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.body = body;
    this.rawBody = rawBody;
    this.retryAfter = retryAfter;
  }

  /** Short support reference the API attaches to every error. Quote it to the shop. */
  get reference() {
    const ref = this.body && this.body.error && this.body.error.reference;
    return typeof ref === 'string' ? ref : null;
  }
}

/** No complete HTTP response. `sent` = false: the request certainly never left; true: it may have been processed. */
class TransportError extends Error {
  constructor(message, sent, cause) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'TransportError';
    this.sent = sent;
  }
}

// ------------------------------------------------------------------ transport

/** Default transport: global fetch, HTTPS only, redirects never followed. */
class FetchTransport {
  async send(req) {
    if (!/^https:\/\//i.test(req.url)) throw new TransportError('Only https:// URLs are allowed', false);
    let res;
    try {
      res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body === null ? undefined : req.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(Math.max(1, Math.round(req.timeout * 1000))),
      });
    } catch (err) {
      const code = (err && err.cause && err.cause.code) || (err && err.code) || '';
      const sent = !NOT_SENT_CODES.has(code);
      throw new TransportError(`Connection failed: ${(err && err.cause && err.cause.message) || (err && err.message) || err}${code ? ` (${code})` : ''}`, sent, err);
    }
    let body;
    try {
      body = await res.text();
    } catch (err) {
      throw new TransportError(`Connection lost while reading the answer: ${err && err.message}`, true, err);
    }
    const headers = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    return { status: res.status, headers, body };
  }
}

// ------------------------------------------------------------------ models

const str = (v, d = '') => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : d);
const nstr = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);
const int = (v, d = 0) => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? Math.trunc(n) : d; };
const nint = (v) => { const n = int(v, NaN); return Number.isNaN(n) ? null : n; };
const bool = (v, d = false) => (v === undefined || v === null ? d : Boolean(v));
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const arr = (v) => (Array.isArray(v) ? v : []);
/** Money stays an exact decimal string ("1.25"). */
const money = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '0');

function toAccount(d) {
  const k = obj(d.key);
  return {
    email: str(d.email), name: str(d.name), username: nstr(d.username), type: nstr(d.type),
    balance: money(d.balance), currency: str(d.currency),
    keyName: str(k.name), scopes: arr(k.scopes).map(String), sandbox: bool(k.sandbox), keyExpiresAt: nstr(k.expires_at),
    rateLimitPerMin: int(k.rate_limit_per_min, 60), dailyOrderLimit: int(k.daily_order_limit),
    raw: d,
  };
}

function toService(d) {
  const q = obj(d.quantity);
  return {
    id: int(d.id), name: str(d.name), type: str(d.type), group: nstr(d.group), price: money(d.price), currency: str(d.currency),
    deliveryTime: nstr(d.delivery_time),
    quantity: { enabled: bool(q.enabled), min: int(q.min), max: int(q.max), options: arr(q.options).map((o) => int(o, NaN)).filter((n) => !Number.isNaN(n)) },
    fields: arr(d.fields).filter((f) => f && typeof f === 'object').map((f) => ({
      key: str(f.key), label: str(f.label), type: str(f.type, 'text'), required: bool(f.required), help: nstr(f.help),
      options: arr(f.options).filter((o) => typeof o === 'string' || typeof o === 'number').map(String),
    })),
    canCancel: bool(d.can_cancel), description: nstr(d.description),
    raw: d,
  };
}

function toOrder(d, extra = {}) {
  const s = obj(d.service);
  const dhruStatus = int(d.dhru_status);
  return {
    reference: str(d.reference), status: str(d.status), dhruStatus,
    service: { id: nint(s.id), name: nstr(s.name), type: nstr(s.type) },
    quantity: int(d.quantity, 1), imei: nstr(d.imei), fields: obj(d.fields), price: money(d.price), currency: nstr(d.currency),
    reply: nstr(d.reply), placedAt: nstr(d.placed_at), completedAt: nstr(d.completed_at), sandbox: bool(d.sandbox),
    replayed: extra.replayed === undefined ? null : extra.replayed,
    balance: extra.balance === undefined ? null : extra.balance,
    /** Done one way or the other (dhruStatus 3 or 4) — stop polling. */
    isFinal: dhruStatus === 3 || dhruStatus === 4,
    /** Delivered (completed / replied). Read the result from `reply`. */
    isSuccess: dhruStatus === 4,
    /** Rejected, cancelled or refunded — the money went back to the balance. */
    isRejected: dhruStatus === 3,
    raw: d,
  };
}

function toBulkLine(d) {
  const ok = bool(d.ok);
  const e = obj(d.error);
  return {
    line: int(d.line), reference: nstr(d.reference_in), ok, order: ok ? toOrder(d) : null,
    errorCode: ok ? null : nstr(e.code), errorMessage: ok ? null : nstr(e.message), raw: d,
  };
}

function toWebhook(d) {
  return {
    id: int(d.id), name: nstr(d.name), url: str(d.url), events: arr(d.events).map(String), active: bool(d.active),
    secretPreview: nstr(d.secret_preview), lastStatus: nint(d.last_status), lastAttemptAt: nstr(d.last_attempt_at),
    secret: nstr(d.secret), raw: d,
  };
}

function toUsage(d) {
  const by = {};
  for (const [k, v] of Object.entries(obj(d.by_action))) { const n = int(v, NaN); if (!Number.isNaN(n)) by[k] = n; }
  return {
    since: nstr(d.since), calls: int(d.calls), errors: int(d.errors), byAction: by,
    recent: arr(d.recent).filter((r) => r && typeof r === 'object'), rateLimitPerMin: int(d.rate_limit_per_min, 60), raw: d,
  };
}

// ------------------------------------------------------------------ signing helpers

/**
 * hex HMAC-SHA256 over "{METHOD}\n{path}\n{timestamp}\n{rawBody}". Since 1.0.1 `path` is the canonical request
 * target: the URL path, plus "?" and the canonical query string when there are query params (see canonicalQuery).
 */
function requestSignature(secret, method, path, timestamp, rawBody) {
  return crypto.createHmac('sha256', secret)
    .update(`${String(method).toUpperCase()}\n${path}\n${timestamp}\n`)
    .update(rawBody || '')
    .digest('hex');
}

/** RFC3986 percent-encoding (matches PHP rawurlencode / Python quote(safe="")): also encodes ! ' ( ) *. */
function rfc3986(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Canonical query for signing: params sorted by key, each key and value RFC3986-encoded, joined by "&". */
function canonicalQuery(query) {
  const entries = Object.entries(query || {}).filter(([, v]) => v !== undefined && v !== null);
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const parts = [];
  for (const [k, v] of entries) {
    for (const vv of Array.isArray(v) ? v : [v]) parts.push(`${rfc3986(k)}=${rfc3986(vv)}`);
  }
  return parts.join('&');
}

// ------------------------------------------------------------------ client

class Client {
  /**
   * @param {string} baseUrl your shop, e.g. "https://yourshop.com" ("/api/v1" is added for you)
   * @param {string} apiKey the key from Account → API
   * @param {object} [options]
   */
  constructor(baseUrl, apiKey, options = {}) {
    this._apiBase = normaliseBaseUrl(baseUrl);
    if (typeof apiKey !== 'string' || apiKey === '' || /\s/.test(apiKey)) {
      throw new UnlyxError('apiKey must be a non-empty string without spaces', 'invalid_argument');
    }
    this._apiKey = apiKey;
    this._timeout = Number(options.timeout ?? 30);
    this._maxRetries = Math.max(0, Math.trunc(Number(options.maxRetries ?? 2)));
    this._maxRetryWait = Math.max(0, Math.trunc(Number(options.maxRetryWait ?? 60)));
    const kid = options.signingKeyId || null;
    const ksec = options.signingSecret || null;
    if (Boolean(kid) !== Boolean(ksec)) throw new UnlyxError('signingKeyId and signingSecret must be set together', 'invalid_argument');
    if (kid && /[\r\n]/.test(kid)) throw new UnlyxError('signingKeyId must not contain line breaks', 'invalid_argument');
    this._signingKeyId = kid;
    this._signingSecret = ksec;
    const ua = `unlyx-node/${VERSION} (Node ${process.versions.node})`;
    this._userAgent = options.userAgent ? `${String(options.userAgent).replace(/[\r\n]/g, '').trim()} ${ua}` : ua;
    this._transport = options.transport || new FetchTransport();
    this._sleep = options.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._newId = options.idGenerator || (() => crypto.randomUUID());
  }

  // ---- account

  /** GET /account — needs scope account.read. */
  async account() {
    return toAccount(data(await this.request('GET', '/account')));
  }

  /** GET /usage — calls, errors and recent requests for this key over the last `days` (1–90). */
  async usage(days = 7) {
    return toUsage(data(await this.request('GET', '/usage', { query: { days: Math.max(1, Math.min(90, Math.trunc(days))) } })));
  }

  // ---- services

  /** GET /services — services this key may order, at its API price. type: imei | server | file | remote. */
  async services(type) {
    if (type !== undefined && type !== null && !SERVICE_TYPES.includes(type)) {
      throw new UnlyxError('type must be imei, server, file or remote', 'invalid_argument');
    }
    const rows = data(await this.request('GET', '/services', { query: type ? { type } : undefined }));
    return arr(rows).filter((r) => r && typeof r === 'object').map(toService);
  }

  /** GET /services/{id} — one service, with its description. */
  async service(id) {
    return toService(data(await this.request('GET', `/services/${positiveInt(id, 'id')}`)));
  }

  // ---- orders

  /**
   * POST /orders — place one order (scope orders.place).
   * order: { service, imei?, quantity?, fields?, note?, file?: { name, data(base64) } }
   * Pass your own idempotencyKey (e.g. your internal order id) so re-running your code can never charge twice.
   */
  async placeOrder(order, { idempotencyKey } = {}) {
    if (!order || typeof order !== 'object' || (order.service === undefined && order.service_id === undefined)) {
      throw new UnlyxError('order needs a "service" id', 'invalid_argument');
    }
    const key = idempotencyKey ?? this._newId();
    checkIdempotencyKey(key);
    const env = await this.request('POST', '/orders', { body: order, headers: { 'Idempotency-Key': key } });
    return toOrder(data(env), { replayed: Boolean(env.replayed), balance: env.balance === undefined || env.balance === null ? null : String(env.balance) });
  }

  /**
   * POST /orders/bulk — up to 100 lines; each answers on its own.
   * A line's `reference` is its idempotency key; lines without one get a random reference so retries are safe.
   */
  async placeOrders(orders) {
    if (!Array.isArray(orders) || orders.length === 0 || orders.length > MAX_BULK) {
      throw new UnlyxError(`orders must hold 1 to ${MAX_BULK} lines`, 'invalid_argument');
    }
    const lines = orders.map((line, i) => {
      if (!line || typeof line !== 'object' || Array.isArray(line)) throw new UnlyxError(`order line ${i} must be an object`, 'invalid_argument');
      return line.reference ? { ...line } : { ...line, reference: this._newId() };
    });
    const env = await this.request('POST', '/orders/bulk', { body: { orders: lines } });
    const rows = arr(data(env)).filter((r) => r && typeof r === 'object').map(toBulkLine);
    return {
      lines: rows,
      balance: env.balance === undefined || env.balance === null ? '0' : String(env.balance),
      succeeded: rows.filter((l) => l.ok),
      failed: rows.filter((l) => !l.ok),
    };
  }

  /** GET /orders — newest first. filters: { status, since (string|Date), imei, page, perPage } */
  async orders(filters = {}) {
    const unknown = Object.keys(filters).filter((k) => !ORDER_FILTERS.includes(k));
    if (unknown.length) throw new UnlyxError(`Unknown order filter: ${unknown.join(', ')}`, 'invalid_argument');
    const query = {};
    if (filters.status) query.status = filters.status;
    if (filters.since) query.since = filters.since instanceof Date ? filters.since.toISOString() : String(filters.since);
    if (filters.imei) query.imei = filters.imei;
    if (filters.page !== undefined && filters.page !== null) query.page = filters.page;
    const pp = filters.perPage ?? filters.per_page;
    if (pp !== undefined && pp !== null) query.per_page = pp;
    const env = await this.request('GET', '/orders', { query });
    const orders = arr(data(env)).filter((r) => r && typeof r === 'object').map((r) => toOrder(r));
    const page = int(env.page, 1);
    const perPage = int(env.per_page, orders.length);
    const total = int(env.total, orders.length);
    return { orders, page, perPage, total, hasMore: page * perPage < total };
  }

  /** GET /orders/{reference} (scope orders.read). */
  async order(reference) {
    return toOrder(data(await this.request('GET', `/orders/${ref(reference)}`)));
  }

  /** POST /orders/{reference}/cancel — only inside the service's cancel window (scope orders.cancel). */
  async cancelOrder(reference) {
    const env = await this.request('POST', `/orders/${ref(reference)}/cancel`);
    return toOrder(data(env), { balance: env.balance === undefined || env.balance === null ? null : String(env.balance) });
  }

  // ---- webhooks

  /** GET /webhooks (scope webhooks.manage). */
  async webhooks() {
    return arr(data(await this.request('GET', '/webhooks'))).filter((r) => r && typeof r === 'object').map(toWebhook);
  }

  /** POST /webhooks — at most 5 per key. The result's `secret` is shown only now: store it. */
  async createWebhook(url, events = ['order.*'], name) {
    const body = { url, events: Array.isArray(events) && events.length ? events : ['order.*'] };
    if (name !== undefined && name !== null) body.name = name;
    return toWebhook(data(await this.request('POST', '/webhooks', { body })));
  }

  /** DELETE /webhooks/{id}. */
  async deleteWebhook(id) {
    return Boolean(obj(data(await this.request('DELETE', `/webhooks/${positiveInt(id, 'id')}`))).deleted);
  }

  // ---- raw

  /**
   * Escape hatch: call any v1 endpoint; resolves to the whole decoded envelope ({ ok: true, data, … }).
   * path is relative to /api/v1, e.g. "/orders". Errors still throw UnlyxError.
   */
  async request(method, path, { query, body, headers } = {}) {
    method = String(method).toUpperCase();
    if (!/^[A-Z]+$/.test(method)) throw new UnlyxError('Bad HTTP method', 'invalid_argument');
    path = String(path);
    if (!path.startsWith('/')) path = `/${path}`;
    // eslint-disable-next-line no-control-regex
    if (path.includes('://') || path.includes('..') || path.includes('?') || path.includes('#') || /[\x00-\x20\x7f]/.test(path)) {
      throw new UnlyxError('path must be a plain API path like "/orders" (put the query in { query })', 'invalid_argument');
    }
    const extra = { ...(headers || {}) };
    for (const [k, v] of Object.entries(extra)) {
      if (/[\r\n]/.test(`${k}${v}`)) throw new UnlyxError('Header values must not contain line breaks', 'invalid_argument');
    }
    // Signed requests cover the query too; build the URL from the same canonical (sorted, RFC3986) string we sign.
    const cq = canonicalQuery(query);
    const url = this._apiBase + path + (cq ? `?${cq}` : '');
    let raw = null;
    if (body !== undefined && body !== null) {
      try {
        raw = JSON.stringify(body);
      } catch (err) {
        throw new UnlyxError(`Body cannot be encoded as JSON: ${err.message}`, 'invalid_argument', { cause: err });
      }
    }
    if (method === 'POST' && findHeader(extra, 'Idempotency-Key') === null) {
      extra['Idempotency-Key'] = this._newId(); // made once; every retry re-sends it
    }
    return this._send(method, url, raw, extra);
  }

  // ---- internals

  async _send(method, url, raw, extra) {
    const safe = method === 'GET' || method === 'HEAD';
    let attempt = 0;
    for (;;) {
      const req = { method, url, headers: this._headers(method, url, raw, extra), body: raw, timeout: this._timeout };
      let res;
      try {
        res = await this._transport.send(req);
      } catch (err) {
        const sent = err instanceof TransportError ? err.sent : true;
        if ((!sent || safe) && attempt < this._maxRetries) {
          await this._sleep(backoff(attempt++));
          continue;
        }
        const hint = sent && !safe ? ' The request may have reached the shop: check the order (or repeat it with the SAME Idempotency-Key) before placing it again.' : '';
        throw new UnlyxError(`${(err && err.message) || err}${hint}`, 'connection_error', { cause: err });
      }
      const status = res.status;
      if (status >= 300 && status < 400) {
        throw new UnlyxError(`The API answered with a redirect (HTTP ${status}). Check the base URL; redirects are never followed.`, 'unexpected_redirect', { httpStatus: status, rawBody: res.body || '' });
      }
      const retryAfter = parseRetryAfter(res);
      if (status === 429 && retryAfter !== null && retryAfter <= this._maxRetryWait && attempt < this._maxRetries) {
        attempt++;
        await this._sleep(retryAfter * 1000);
        continue;
      }
      if (status >= 500 && safe && attempt < this._maxRetries) {
        await this._sleep(backoff(attempt++));
        continue;
      }
      if (status === 503 && method === 'POST' && findHeader(extra, 'Idempotency-Key') !== null
        && errorCodeOf(res) === 'temporary' && attempt < this._maxRetries) {
        await this._sleep(backoff(attempt++));
        continue;
      }
      return decode(res, retryAfter);
    }
  }

  _headers(method, url, raw, extra) {
    const h = { Authorization: `Bearer ${this._apiKey}`, Accept: 'application/json', 'User-Agent': this._userAgent };
    if (raw !== null) h['Content-Type'] = 'application/json';
    if (this._signingKeyId && this._signingSecret) {
      const ts = String(Math.floor(Date.now() / 1000)); // fresh on every attempt
      h['X-Key-Id'] = this._signingKeyId;
      h['X-Timestamp'] = ts;
      const u = new URL(url); // u.search is the canonical query (already RFC3986) with its leading "?", or ""
      h['X-Signature'] = requestSignature(this._signingSecret, method, u.pathname + u.search, ts, raw ?? '');
    }
    for (const [k, v] of Object.entries(extra)) h[k] = String(v);
    return h;
  }
}

// ------------------------------------------------------------------ webhooks

function headerOf(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function' && typeof headers.has === 'function') { // WHATWG Headers
    const v = headers.get(name);
    return v === null ? null : String(v).trim();
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      const val = Array.isArray(v) ? v[0] : v;
      return typeof val === 'string' ? val.trim() : null;
    }
  }
  return null;
}

function webhookSign(secret, timestamp, payload) {
  return crypto.createHmac('sha256', secret).update(`${Math.trunc(timestamp)}.`).update(payload).digest('hex');
}

function signatureFail(message) {
  return new UnlyxError(message, 'invalid_signature', { httpStatus: 400 });
}

/**
 * Verify a delivery's X-Unlyx-Signature on the RAW body (string or Buffer — never a re-serialised object)
 * and return the decoded event. Throws UnlyxError("invalid_signature") on any failure.
 */
function verifyWebhook(payload, headers, secret, { tolerance = DEFAULT_TOLERANCE, now } = {}) {
  if (typeof payload !== 'string' && !(payload instanceof Uint8Array)) {
    throw new UnlyxError('payload must be the raw body as a string or Buffer', 'invalid_argument');
  }
  const header = headerOf(headers, SIGNATURE_HEADER);
  if (!header) throw signatureFail(`Missing ${SIGNATURE_HEADER} header`);
  let ts = null;
  const sigs = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't' && /^\d+$/.test(v)) ts = Number(v);
    else if (k === 'v1' && v) sigs.push(v.toLowerCase());
  }
  if (ts === null || sigs.length === 0) throw signatureFail(`Malformed ${SIGNATURE_HEADER} header`);
  const current = now === undefined ? Math.floor(Date.now() / 1000) : Math.trunc(now);
  if (tolerance > 0 && Math.abs(current - ts) > tolerance) {
    throw signatureFail('Signature timestamp is outside the allowed window (possible replay or clock drift)');
  }
  const secrets = (Array.isArray(secret) ? secret : [secret]).filter((s) => typeof s === 'string' && s !== '');
  if (secrets.length === 0) throw new UnlyxError('A webhook secret is required', 'invalid_argument');
  let valid = false;
  for (const s of secrets) {
    const expected = Buffer.from(webhookSign(s, ts, payload), 'utf8');
    for (const sig of sigs) {
      const got = Buffer.from(sig, 'utf8');
      if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) valid = true;
    }
  }
  if (!valid) throw signatureFail('Signature does not match');
  let event;
  try {
    event = JSON.parse(typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf8'));
  } catch {
    throw signatureFail('Signed body is not valid JSON');
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) throw signatureFail('Signed body is not a JSON object');
  return event;
}

function isValidWebhook(payload, headers, secret, opts) {
  try {
    verifyWebhook(payload, headers, secret, opts);
    return true;
  } catch (err) {
    if (err instanceof UnlyxError) return false;
    throw err;
  }
}

const Webhook = Object.freeze({
  SIGNATURE_HEADER,
  DEFAULT_TOLERANCE,
  verify: verifyWebhook,
  isValid: isValidWebhook,
  sign: webhookSign,
  /** A full X-Unlyx-Signature value — handy for testing your own receiver. */
  signatureHeader: (secret, timestamp, payload) => `t=${Math.trunc(timestamp)},v1=${webhookSign(secret, timestamp, payload)}`,
});

// ------------------------------------------------------------------ helpers

function normaliseBaseUrl(baseUrl) {
  let u;
  try {
    u = new URL(String(baseUrl).trim());
  } catch {
    throw new UnlyxError('baseUrl must be an https:// address, e.g. https://yourshop.com', 'invalid_argument');
  }
  if (u.protocol !== 'https:' || !u.hostname) throw new UnlyxError('baseUrl must be an https:// address, e.g. https://yourshop.com', 'invalid_argument');
  if (u.username || u.password || u.search || u.hash) throw new UnlyxError('baseUrl must not contain credentials, a query or a fragment', 'invalid_argument');
  let path = u.pathname.replace(/\/+$/, '');
  if (path.toLowerCase().endsWith('/api/v1')) path = path.slice(0, -7);
  return `https://${u.host}${path}/api/v1`;
}

function data(env) {
  const d = env && env.data;
  if (d === null || typeof d !== 'object') throw new UnlyxError('The API answer has no "data"', 'invalid_response', { httpStatus: 200, body: env });
  return d;
}

function decode(res, retryAfter) {
  const status = res.status;
  const text = res.body || '';
  let decoded = null;
  if (text) {
    try { decoded = JSON.parse(text); } catch { decoded = null; }
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    if (status >= 400) {
      throw new UnlyxError(`HTTP ${status} from the API (no JSON body)`, status === 429 ? 'rate_limited' : `http_${status}`, { httpStatus: status, rawBody: text, retryAfter });
    }
    throw new UnlyxError(`The API answered with something that is not JSON (HTTP ${status})`, 'invalid_response', { httpStatus: status, rawBody: text });
  }
  if (status >= 400 || decoded.ok === false) {
    const err = obj(decoded.error);
    const code = typeof err.code === 'string' && err.code ? err.code : (status === 429 ? 'rate_limited' : `http_${status}`);
    const message = typeof err.message === 'string' && err.message ? err.message : `HTTP ${status}`;
    throw new UnlyxError(message, code, { httpStatus: status, body: decoded, rawBody: text, retryAfter });
  }
  return decoded;
}

function errorCodeOf(res) {
  try {
    const d = JSON.parse(res.body || '');
    const c = d && d.error && d.error.code;
    return typeof c === 'string' ? c.toLowerCase() : null;
  } catch {
    return null;
  }
}

function headerFrom(res, name) {
  const h = res.headers || {};
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

function parseRetryAfter(res) {
  const v = String(headerFrom(res, 'Retry-After') ?? '').trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((t - Date.now()) / 1000));
}

function backoff(attempt) {
  return Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function findHeader(headers, name) {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === lower) return String(v);
  return null;
}

function ref(reference) {
  const r = String(reference ?? '').trim();
  if (!r || r.length > 120) throw new UnlyxError('reference must be 1–120 characters', 'invalid_argument');
  return encodeURIComponent(r);
}

function positiveInt(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new UnlyxError(`${name} must be a whole number`, 'invalid_argument');
  return n;
}

function checkIdempotencyKey(key) {
  if (typeof key !== 'string' || !key || key.length > 120 || /[\r\n]/.test(key)) {
    throw new UnlyxError('Idempotency-Key must be 1–120 characters on one line', 'invalid_argument');
  }
}

module.exports = {
  VERSION,
  Client,
  UnlyxError,
  TransportError,
  FetchTransport,
  Webhook,
  verifyWebhook,
  isValidWebhook,
  requestSignature,
};
module.exports.default = module.exports;
