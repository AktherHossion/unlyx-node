// Type definitions for @unlyx/sdk 1.0.0

export declare const VERSION: string;

export type ServiceType = 'imei' | 'server' | 'file' | 'remote';

export interface ClientOptions {
  /** Seconds for the whole call. Default 30. */
  timeout?: number;
  /** Retries that cannot cause a second order. 0 turns them off. Default 2. */
  maxRetries?: number;
  /** Never wait longer than this many seconds for a Retry-After. Default 60. */
  maxRetryWait?: number;
  /** Optional request signing: sends X-Key-Id / X-Timestamp / X-Signature. */
  signingKeyId?: string | null;
  signingSecret?: string | null;
  /** Prepended to the SDK's own User-Agent. */
  userAgent?: string;
  /** Plug in your own HTTP stack (or a test double). */
  transport?: Transport;
  /** Wait function in milliseconds (tests). */
  sleep?: (ms: number) => Promise<void> | void;
  /** Idempotency-Key / bulk reference generator. Default crypto.randomUUID. */
  idGenerator?: () => string;
}

export interface TransportRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  /** seconds */
  timeout: number;
}

export interface TransportResponse {
  status: number;
  /** lower-case names */
  headers: Record<string, string>;
  body: string;
}

export interface Transport {
  /** Must not follow redirects. Throw TransportError when no complete response arrived. */
  send(request: TransportRequest): Promise<TransportResponse>;
}

export declare class FetchTransport implements Transport {
  send(request: TransportRequest): Promise<TransportResponse>;
}

export declare class TransportError extends Error {
  constructor(message: string, sent: boolean, cause?: unknown);
  /** false = the request certainly never left; true = it may have been processed. */
  readonly sent: boolean;
}

export type UnlyxErrorCode =
  | 'low_balance' | 'invalid_input' | 'not_found' | 'service_disabled' | 'idempotency_conflict' | 'limit'
  | 'temporary' | 'rate_limited' | 'unauthorized' | 'forbidden'
  | 'connection_error' | 'invalid_response' | 'unexpected_redirect' | 'invalid_signature' | 'invalid_argument'
  | (string & {});

export declare class UnlyxError extends Error {
  constructor(message: string, code: string, extra?: { httpStatus?: number; body?: unknown; rawBody?: string; retryAfter?: number | null; cause?: unknown });
  readonly code: UnlyxErrorCode;
  /** HTTP status, or 0 when no response was received. */
  readonly httpStatus: number;
  /** Decoded JSON body, when there was one. */
  readonly body: Record<string, any> | null;
  readonly rawBody: string;
  /** Seconds from Retry-After (429). */
  readonly retryAfter: number | null;
  /** Short support reference — quote it to the shop. */
  readonly reference: string | null;
}

export interface Account {
  email: string;
  name: string;
  username: string | null;
  type: string | null;
  /** Exact decimal string, e.g. "125.50". */
  balance: string;
  currency: string;
  keyName: string;
  scopes: string[];
  sandbox: boolean;
  keyExpiresAt: string | null;
  rateLimitPerMin: number;
  dailyOrderLimit: number;
  raw: Record<string, any>;
}

export interface ServiceField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  help: string | null;
  options: string[];
}

export interface Service {
  id: number;
  name: string;
  type: ServiceType | string;
  group: string | null;
  price: string;
  currency: string;
  deliveryTime: string | null;
  quantity: { enabled: boolean; min: number; max: number; options: number[] };
  fields: ServiceField[];
  canCancel: boolean;
  /** Only filled by service(id). */
  description: string | null;
  raw: Record<string, any>;
}

export interface Order {
  reference: string;
  /** The shop's state: new, processing, waiting_supplier, completed, replied, rejected, cancelled, refunded … */
  status: string;
  /** Classic Dhru code: 0 new, 1 in process, 3 rejected (refunded), 4 done. */
  dhruStatus: number;
  service: { id: number | null; name: string | null; type: string | null };
  quantity: number;
  imei: string | null;
  fields: Record<string, any>;
  price: string;
  currency: string | null;
  /** Result text (unlock code, reply) once done. */
  reply: string | null;
  placedAt: string | null;
  completedAt: string | null;
  sandbox: boolean;
  /** placeOrder() only: true when the Idempotency-Key matched an earlier order. */
  replayed: boolean | null;
  /** placeOrder() / cancelOrder() only: balance after the call. */
  balance: string | null;
  isFinal: boolean;
  isSuccess: boolean;
  isRejected: boolean;
  raw: Record<string, any>;
}

export interface OrderInput {
  service: number;
  imei?: string;
  quantity?: number;
  fields?: Record<string, string | number>;
  note?: string;
  file?: { name: string; data: string };
  [extra: string]: unknown;
}

export interface BulkOrderInput extends OrderInput {
  /** This line's idempotency key. Generated when missing. */
  reference?: string;
}

export interface BulkLine {
  line: number;
  reference: string | null;
  ok: boolean;
  order: Order | null;
  errorCode: string | null;
  errorMessage: string | null;
  raw: Record<string, any>;
}

export interface BulkResult {
  lines: BulkLine[];
  balance: string;
  succeeded: BulkLine[];
  failed: BulkLine[];
}

export interface OrderFilters {
  status?: string;
  since?: string | Date;
  imei?: string;
  page?: number;
  perPage?: number;
  per_page?: number;
}

export interface OrderPage {
  orders: Order[];
  page: number;
  perPage: number;
  total: number;
  hasMore: boolean;
}

export interface WebhookEndpoint {
  id: number;
  name: string | null;
  url: string;
  events: string[];
  active: boolean;
  secretPreview: string | null;
  lastStatus: number | null;
  lastAttemptAt: string | null;
  /** Signing secret ("whsec_..."), returned ONCE by createWebhook(). */
  secret: string | null;
  raw: Record<string, any>;
}

export interface Usage {
  since: string | null;
  calls: number;
  errors: number;
  byAction: Record<string, number>;
  recent: Array<{ at: string; protocol: string; action: string; status: number; ok: boolean; ms: number; error: string | null }>;
  rateLimitPerMin: number;
  raw: Record<string, any>;
}

export interface Envelope<T = any> {
  ok: boolean;
  data: T;
  [extra: string]: any;
}

export declare class Client {
  /** baseUrl: your shop, e.g. "https://yourshop.com" ("/api/v1" is added for you). */
  constructor(baseUrl: string, apiKey: string, options?: ClientOptions);
  account(): Promise<Account>;
  usage(days?: number): Promise<Usage>;
  services(type?: ServiceType | null): Promise<Service[]>;
  service(id: number): Promise<Service>;
  placeOrder(order: OrderInput, options?: { idempotencyKey?: string }): Promise<Order>;
  placeOrders(orders: BulkOrderInput[]): Promise<BulkResult>;
  orders(filters?: OrderFilters): Promise<OrderPage>;
  order(reference: string): Promise<Order>;
  cancelOrder(reference: string): Promise<Order>;
  webhooks(): Promise<WebhookEndpoint[]>;
  createWebhook(url: string, events?: string[], name?: string | null): Promise<WebhookEndpoint>;
  deleteWebhook(id: number): Promise<boolean>;
  request<T = any>(method: string, path: string, options?: {
    query?: Record<string, string | number | boolean | null | undefined>;
    body?: unknown;
    headers?: Record<string, string>;
  }): Promise<Envelope<T>>;
}

export type HeadersLike =
  | { get(name: string): string | null; has(name: string): boolean }
  | Record<string, string | string[] | undefined>;

export interface WebhookEvent<T = Record<string, any>> {
  event: string;
  tenant_id: number;
  created_at: string;
  data: T;
  [extra: string]: any;
}

export interface VerifyOptions {
  /** Seconds; 0 turns the replay check off. Default 300. */
  tolerance?: number;
  /** Unix seconds, for tests. */
  now?: number;
}

export declare function verifyWebhook<T = Record<string, any>>(payload: string | Uint8Array, headers: HeadersLike, secret: string | string[], options?: VerifyOptions): WebhookEvent<T>;
export declare function isValidWebhook(payload: string | Uint8Array, headers: HeadersLike, secret: string | string[], options?: VerifyOptions): boolean;
/** hex HMAC-SHA256 over "{METHOD}\n{path}\n{timestamp}\n{rawBody}". */
export declare function requestSignature(secret: string, method: string, path: string, timestamp: string, rawBody: string): string;

export declare const Webhook: {
  readonly SIGNATURE_HEADER: 'X-Unlyx-Signature';
  readonly DEFAULT_TOLERANCE: number;
  verify: typeof verifyWebhook;
  isValid: typeof isValidWebhook;
  sign(secret: string, timestamp: number, payload: string | Uint8Array): string;
  signatureHeader(secret: string, timestamp: number, payload: string | Uint8Array): string;
};

declare const sdk: {
  VERSION: typeof VERSION;
  Client: typeof Client;
  UnlyxError: typeof UnlyxError;
  TransportError: typeof TransportError;
  FetchTransport: typeof FetchTransport;
  Webhook: typeof Webhook;
  verifyWebhook: typeof verifyWebhook;
  isValidWebhook: typeof isValidWebhook;
  requestSignature: typeof requestSignature;
};
export default sdk;
