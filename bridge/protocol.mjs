/**
 * Wire protocol constants of the extension <-> bridge link.
 *
 * Data only: no functions. `test/protocol.test.js` compares this object with
 * `extension/protocol.js` through JSON, and JSON cannot carry behaviour.
 *
 * The second copy exists because the MV3 background script cannot import an ES
 * module; the test is what keeps both copies honest.
 */
export const PROTOCOL = Object.freeze({
  VERSION: 1,
  TYPES: Object.freeze({
    HELLO: "hello",
    WELCOME: "welcome",
    REQUEST: "request",
    RESPONSE: "response",
  }),
  // Methods the extension answers in this increment. Anything else is replied to
  // with `ok:false, code:"unsupported_method"` rather than silently ignored.
  METHODS: Object.freeze({
    STATUS: "status",
    NAVIGATE: "navigate",
    READ: "read",
    CLICK: "click",
    TYPE: "type",
    FOCUS: "focus",
    INSPECT: "inspect",
    OPEN_TAB: "open_tab",
    CLOSE_TAB: "close_tab",
    EVAL: "eval",
    SCREENSHOT: "screenshot",
    FRAMES: "frames",
    TRANSCRIPT: "transcript",
  }),
  CLOSE: Object.freeze({
    AUTH_FAILED: 4401,
    HELLO_TIMEOUT: 4408,
    REPLACED: 4409,
    PROTOCOL_ERROR: 1002,
    UNSUPPORTED_DATA: 1003,
    MESSAGE_TOO_BIG: 1009,
  }),
  MAX_MESSAGE_BYTES: 5242880,
  HELLO_TIMEOUT_MS: 5000,
  CALL_TIMEOUT_MS: 20000,
  RECONNECT_BASE_MS: 1000,
  RECONNECT_MAX_MS: 30000,
  RECONNECT_JITTER_MS: 250,
});
