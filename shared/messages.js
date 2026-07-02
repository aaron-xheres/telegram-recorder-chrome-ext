// Message type constants shared across extension contexts.
// Loaded as a classic script; exposes a global MESSAGE_TYPES object.
// Using globalThis and a guard makes reinjection safe (no redeclaration error).

if (typeof globalThis.MESSAGE_TYPES === 'undefined') {
  /** @enum {string} */
  globalThis.MESSAGE_TYPES = Object.freeze({
    GET_GROUP_INFO: 'GET_GROUP_INFO',
    GROUP_INFO_RESPONSE: 'GROUP_INFO_RESPONSE',
    GET_SESSION: 'GET_SESSION',
    GET_ACTIVE_SESSIONS: 'GET_ACTIVE_SESSIONS',
    START_RECORDING: 'START_RECORDING',
    STOP_RECORDING: 'STOP_RECORDING',
    CAPTURE_TAB: 'CAPTURE_TAB',
    SAVE_FILES: 'SAVE_FILES',
    AUTO_STOPPED: 'AUTO_STOPPED',
    PING: 'PING',
    PONG: 'PONG'
  });
}
