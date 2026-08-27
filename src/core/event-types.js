const HOSTS = Object.freeze({
  CLAUDE: 'claude',
  CODEX: 'codex',
  CURSOR: 'cursor',
});

const EVENT_TYPES = Object.freeze({
  MESSAGE: 'message',
  LIVE_STATUS: 'live_status',
  APPROVAL_REQUEST: 'approval_request',
  INPUT_REQUEST: 'input_request',
  TASK_RESULT: 'task_result',
  SESSION_STATE_CHANGED: 'session_state_changed',
});

module.exports = { HOSTS, EVENT_TYPES };
