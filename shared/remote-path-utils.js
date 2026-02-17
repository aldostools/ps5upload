'use strict';

function escapeCommandPath(value) {
  const text = String(value ?? '');
  const escaped = text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}

function joinRemotePath(root, relPath) {
  const base = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const sub = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!base) return sub ? `/${sub}` : '/';
  if (!sub) return base;
  return `${base}/${sub}`;
}

function joinRemoteScanPath() {
  return Array.from(arguments)
    .filter((part) => typeof part === 'string' && part.trim().length > 0)
    .map((part, index) => {
      const value = String(part);
      if (index === 0) return value.replace(/\/+$/, '') || '/';
      return value.replace(/^\/+/, '').replace(/\/+$/, '');
    })
    .join('/');
}

function normalizeRemoteScanSubpath(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  return normalized || null;
}

function getStorageRootFromPath(destPath) {
  const normalized = String(destPath || '').replace(/\\/g, '/').trim();
  if (!normalized.startsWith('/')) return null;
  if (normalized === '/data' || normalized.startsWith('/data/')) return '/data';
  if (normalized.startsWith('/mnt/')) {
    const parts = normalized.split('/').filter(Boolean);
    if (parts.length >= 2) return `/${parts[0]}/${parts[1]}`;
  }
  return null;
}

function buildTempRootForArchive(destPath, tempRootOverride) {
  const override = typeof tempRootOverride === 'string' ? tempRootOverride.trim() : '';
  if (override) {
    if (override.endsWith('/ps5upload/tmp')) return override;
    return `${override.replace(/\/+$/, '')}/ps5upload/tmp`;
  }
  const root = getStorageRootFromPath(destPath) || '/data';
  return `${root}/ps5upload/tmp`;
}

module.exports = {
  escapeCommandPath,
  joinRemotePath,
  joinRemoteScanPath,
  normalizeRemoteScanSubpath,
  getStorageRootFromPath,
  buildTempRootForArchive,
};
