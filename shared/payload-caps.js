'use strict';

const DEFAULT_COMMANDS = [
  'VERSION',
  'CAPS',
  'PAYLOAD_STATUS',
  'HASH_FILE',
  'HASH_FILE_FAST',
  'HASH_FILE_B3',
  'QUEUE_EXTRACT',
  'QUEUE_CANCEL',
  'QUEUE_CLEAR',
  'QUEUE_CLEAR_ALL',
  'QUEUE_CLEAR_FAILED',
  'QUEUE_REORDER',
  'QUEUE_PROCESS',
  'QUEUE_PAUSE',
  'QUEUE_RETRY',
  'QUEUE_REMOVE',
  'UPLOAD_QUEUE_GET',
  'UPLOAD_QUEUE_SYNC',
  'HISTORY_GET',
  'HISTORY_SYNC',
  'MAINTENANCE',
  'CHMOD777',
];

const DEFAULT_FEATURES = {
  status: true,
  queue: true,
  queue_extract: true,
  queue_extract_auto: true,
  upload_queue_sync: true,
  history_sync: true,
  maintenance: true,
  chmod: true,
  games_scan_meta: true,
  hash_sha256: true,
  hash_fast: false,
  hash_blake3: false,
};

function createDefaultPayloadCaps(version = null) {
  return {
    schema_version: 1,
    source: 'compat',
    payload_version: version || null,
    firmware: null,
    features: { ...DEFAULT_FEATURES },
    limits: {},
    commands: [...DEFAULT_COMMANDS],
    notes: [],
    updated_at_ms: Date.now(),
  };
}

function normalizePayloadCaps(raw, fallbackVersion = null) {
  const base = createDefaultPayloadCaps(fallbackVersion);
  if (!raw || typeof raw !== 'object') return base;
  const next = {
    ...base,
    ...raw,
    schema_version: parseInt(String(raw.schema_version || base.schema_version), 10) || 1,
    source: typeof raw.source === 'string' && raw.source.trim() ? raw.source : 'payload',
    payload_version: raw.payload_version != null ? String(raw.payload_version) : base.payload_version,
    firmware: raw.firmware != null ? String(raw.firmware) : null,
    updated_at_ms: Date.now(),
  };
  if (raw.features && typeof raw.features === 'object') {
    next.features = { ...base.features, ...raw.features };
  } else {
    next.features = { ...base.features };
  }
  if (raw.limits && typeof raw.limits === 'object') {
    next.limits = { ...raw.limits };
  } else {
    next.limits = {};
  }
  if (Array.isArray(raw.commands)) {
    next.commands = raw.commands.map((item) => String(item));
  } else {
    next.commands = [...base.commands];
  }
  if (Array.isArray(raw.notes)) {
    next.notes = raw.notes.map((item) => String(item));
  } else {
    next.notes = [];
  }
  return next;
}

module.exports = {
  createDefaultPayloadCaps,
  normalizePayloadCaps,
};
