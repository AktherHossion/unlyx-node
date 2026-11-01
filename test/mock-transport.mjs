import { TransportError } from '../lib/index.mjs';

/** Plays back queued responses (or transport failures) and records every request. */
export class MockTransport {
  constructor() {
    this.queue = [];
    this.requests = [];
  }

  json(status, body, headers = {}) {
    this.queue.push({ status, headers: lower(headers), body: JSON.stringify(body) });
    return this;
  }

  raw(status, body, headers = {}) {
    this.queue.push({ status, headers: lower(headers), body });
    return this;
  }

  fail(sent, message = 'boom') {
    this.queue.push(new TransportError(message, sent));
    return this;
  }

  async send(req) {
    this.requests.push(req);
    if (this.queue.length === 0) throw new Error(`MockTransport: nothing queued for ${req.method} ${req.url}`);
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    return next;
  }

  get last() {
    return this.requests[this.requests.length - 1];
  }
}

function lower(h) {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}
