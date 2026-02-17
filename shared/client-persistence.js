'use strict';

function createClientPersistence(options) {
  const fs = options && options.fs;
  const path = options && options.path;
  const getAppDataDir = options && options.getAppDataDir;
  const defaultConfig = (options && options.defaultConfig) || {};
  const configFilename = (options && options.configFilename) || 'app-config.json';
  const profilesFilename = (options && options.profilesFilename) || 'ps5upload_profiles.json';
  const queueFilename = (options && options.queueFilename) || 'ps5upload_queue.json';
  const historyFilename = (options && options.historyFilename) || 'ps5upload_history.json';
  const normalizeConfig = typeof (options && options.normalizeConfig) === 'function'
    ? options.normalizeConfig
    : ((cfg) => cfg);
  const queueSaveMode = (options && options.queueSaveMode) || 'preserve';
  const historySaveMode = (options && options.historySaveMode) || 'preserve';
  const historyInsertMode = (options && options.historyInsertMode) || 'prepend';
  const historyLimit = Number.isInteger(options && options.historyLimit)
    ? Math.max(1, Number(options.historyLimit))
    : 500;
  const legacy = (options && options.legacy) || {};

  function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  function readText(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  }

  function readJson(filePath, fallback) {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return fallback;
    }
  }

  function writeJson(filePath, data) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  function configPath() {
    return path.join(getAppDataDir(), configFilename);
  }

  function profilesPath() {
    return path.join(getAppDataDir(), profilesFilename);
  }

  function queuePath() {
    return path.join(getAppDataDir(), queueFilename);
  }

  function historyPath() {
    return path.join(getAppDataDir(), historyFilename);
  }

  function tryMigrateLegacyConfig() {
    const legacyPath = typeof legacy.configPath === 'function' ? legacy.configPath() : '';
    const parseLegacyConfig = legacy.parseConfig;
    if (!legacyPath || typeof parseLegacyConfig !== 'function') return null;
    const text = readText(legacyPath);
    if (!text) return null;
    const parsed = parseLegacyConfig(text, { defaultConfig });
    if (!parsed || typeof parsed !== 'object') return null;
    const merged = normalizeConfig({ ...defaultConfig, ...parsed });
    writeJson(configPath(), merged);
    return merged;
  }

  function tryMigrateLegacyProfiles() {
    const legacyPath = typeof legacy.profilesPath === 'function' ? legacy.profilesPath() : '';
    const parseLegacyProfiles = legacy.parseProfiles;
    if (!legacyPath || typeof parseLegacyProfiles !== 'function') return null;
    const text = readText(legacyPath);
    if (!text) return null;
    const parsed = parseLegacyProfiles(text);
    if (!parsed || typeof parsed !== 'object') return null;
    const next = {
      profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
      default_profile: typeof parsed.default_profile === 'string' ? parsed.default_profile : null,
    };
    writeJson(profilesPath(), next);
    return next;
  }

  function loadConfig() {
    const cfg = readJson(configPath(), null);
    if (cfg && typeof cfg === 'object') {
      return normalizeConfig({ ...defaultConfig, ...cfg });
    }
    const migrated = tryMigrateLegacyConfig();
    if (migrated && typeof migrated === 'object') return migrated;
    return { ...defaultConfig };
  }

  function saveConfig(input) {
    const merged = normalizeConfig({ ...defaultConfig, ...(input || {}) });
    writeJson(configPath(), merged);
  }

  function loadProfiles() {
    const data = readJson(profilesPath(), null);
    if (data && typeof data === 'object') {
      return {
        profiles: Array.isArray(data.profiles) ? data.profiles : [],
        default_profile: typeof data.default_profile === 'string' ? data.default_profile : null,
      };
    }
    const migrated = tryMigrateLegacyProfiles();
    if (migrated && typeof migrated === 'object') return migrated;
    return { profiles: [], default_profile: null };
  }

  function saveProfiles(input) {
    const next = {
      profiles: Array.isArray(input && input.profiles) ? input.profiles : [],
      default_profile: input && typeof input.default_profile === 'string' ? input.default_profile : null,
    };
    writeJson(profilesPath(), next);
  }

  function loadQueue() {
    return readJson(queuePath(), { items: [], next_id: 1, rev: 0, updated_at: 0 });
  }

  function saveQueue(input) {
    const now = Date.now();
    const current = loadQueue();
    const nextId = Number.isFinite(Number(input && input.next_id)) ? Number(input.next_id) : 1;
    let rev = Number.isFinite(Number(input && input.rev)) ? Number(input.rev) : 0;
    if (queueSaveMode === 'increment') {
      rev = Number.isFinite(Number(input && input.rev)) ? Number(input.rev) : ((current.rev || 0) + 1);
    }
    const next = {
      items: Array.isArray(input && input.items) ? input.items : [],
      next_id: nextId,
      rev,
      updated_at: Number(input && input.updated_at) || now,
    };
    writeJson(queuePath(), next);
  }

  function loadHistory() {
    return readJson(historyPath(), { records: [], rev: 0, updated_at: 0 });
  }

  function saveHistory(input) {
    const now = Date.now();
    const current = loadHistory();
    let rev = Number.isFinite(Number(input && input.rev)) ? Number(input.rev) : 0;
    if (historySaveMode === 'increment') {
      rev = Number.isFinite(Number(input && input.rev)) ? Number(input.rev) : ((current.rev || 0) + 1);
    }
    const next = {
      records: Array.isArray(input && input.records) ? input.records : [],
      rev,
      updated_at: Number(input && input.updated_at) || now,
    };
    writeJson(historyPath(), next);
  }

  function addHistoryRecord(record) {
    const current = loadHistory();
    const records = Array.isArray(current.records) ? current.records : [];
    if (historyInsertMode === 'append') {
      records.push(record);
      current.records = records;
    } else {
      current.records = [record, ...records].slice(0, historyLimit);
    }
    current.rev = (Number(current.rev) || 0) + 1;
    current.updated_at = Date.now();
    saveHistory(current);
  }

  function clearHistory() {
    if (historySaveMode === 'increment') {
      saveHistory({ records: [], updated_at: Date.now() });
      return;
    }
    saveHistory({ records: [], rev: 0, updated_at: Date.now() });
  }

  return {
    configPath,
    profilesPath,
    queuePath,
    historyPath,
    loadConfig,
    saveConfig,
    loadProfiles,
    saveProfiles,
    loadQueue,
    saveQueue,
    loadHistory,
    saveHistory,
    addHistoryRecord,
    clearHistory,
  };
}

module.exports = {
  createClientPersistence,
};
