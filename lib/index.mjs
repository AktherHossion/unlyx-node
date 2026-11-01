// ESM entry: the implementation lives in index.cjs so `import` and `require` share one copy (no dual-package hazard).
import sdk from './index.cjs';

export const {
  VERSION,
  Client,
  UnlyxError,
  TransportError,
  FetchTransport,
  Webhook,
  verifyWebhook,
  isValidWebhook,
  requestSignature,
} = sdk;

export default sdk;
