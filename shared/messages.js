// Message type constants shared across extension contexts.
// Loaded as a classic script; exposes a global MESSAGE_TYPES object.

/** @enum {string} */
const MESSAGE_TYPES = {
  GET_GROUP_INFO: 'GET_GROUP_INFO',
  GROUP_INFO_RESPONSE: 'GROUP_INFO_RESPONSE',
  START_RECORDING: 'START_RECORDING',
  STOP_RECORDING: 'STOP_RECORDING',
  CAPTURE_TAB: 'CAPTURE_TAB',
  SAVE_FILES: 'SAVE_FILES',
  AUTO_STOPPED: 'AUTO_STOPPED',
  PING: 'PING',
  PONG: 'PONG'
};
