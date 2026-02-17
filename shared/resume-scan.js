'use strict';

function isRemoteDirEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const entryType = String(entry.entry_type || entry.type || '').toLowerCase();
  return Boolean(entry.is_dir) || entryType === 'd' || entryType === 'dir' || entryType === 'directory';
}

async function listDirRecursiveCompat(options = {}) {
  const listDir = options.listDir;
  const ip = options.ip;
  const port = options.port;
  const dirPath = options.dirPath;
  const signal = options.signal && typeof options.signal.addEventListener === 'function' ? options.signal : null;
  const onLog = typeof options.onLog === 'function' ? options.onLog : null;
  if (typeof listDir !== 'function') {
    throw new Error('listDirRecursiveCompat requires listDir');
  }
  const files = [];
  const stack = [{ path: dirPath, rel: '' }];
  while (stack.length > 0) {
    if (signal && signal.aborted) throw new Error('Cancelled');
    const current = stack.pop();
    if (!current) continue;
    let entries = [];
    try {
      entries = await listDir(ip, port, current.path, signal || undefined);
    } catch {
      continue;
    }
    if (onLog) onLog(`ListDir ${current.path}: ${entries.length} entries`);
    for (const entry of entries) {
      const name = String(entry && entry.name ? entry.name : '');
      if (!name) continue;
      const relPath = current.rel ? `${current.rel}/${name}` : name;
      const remotePath = `${current.path}/${name}`;
      if (isRemoteDirEntry(entry)) {
        stack.push({ path: remotePath, rel: relPath });
      } else {
        files.push({ remotePath, relPath, size: Number(entry.size) || 0 });
      }
    }
  }
  return files;
}

async function filterResumeFiles(options = {}) {
  const files = Array.isArray(options.files) ? options.files : [];
  const remoteIndex = options.remoteIndex instanceof Map ? options.remoteIndex : new Map();
  const resumeMode = String(options.resumeMode || 'none');
  const shouldHashResume = typeof options.shouldHashResume === 'function' ? options.shouldHashResume : () => false;
  const mapWithConcurrency = typeof options.mapWithConcurrency === 'function' ? options.mapWithConcurrency : async (items, _, fn) => Promise.all(items.map(fn));
  const hashLocal = options.hashLocal;
  const hashRemote = options.hashRemote;
  const makeRemotePath = typeof options.makeRemotePath === 'function' ? options.makeRemotePath : () => '';
  const concurrency = Math.max(1, Number(options.concurrency) || 1);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const cancelCheck = typeof options.cancelCheck === 'function' ? options.cancelCheck : null;

  const stats = {
    missing: 0,
    sizeMatched: 0,
    sizeMismatched: 0,
    hashChecked: 0,
    hashMatched: 0,
    hashMismatched: 0,
    hashFailed: 0,
    skipped: 0,
  };
  let processed = 0;
  const total = files.length;

  const results = await mapWithConcurrency(files, concurrency, async (file) => {
    if (cancelCheck && cancelCheck()) throw new Error('Cancelled');
    const rel = String(file && file.rel_path ? file.rel_path : '').replace(/\\/g, '/');
    const remote = remoteIndex.get(rel);
    if (!remote) {
      stats.missing += 1;
      processed += 1;
      if (onProgress) onProgress(processed, total);
      return { keep: true, file, reason: 'missing' };
    }
    const sizeMatch = Number(file.size) === Number(remote.size);
    if (!sizeMatch) {
      stats.sizeMismatched += 1;
      processed += 1;
      if (onProgress) onProgress(processed, total);
      return { keep: true, file, reason: 'size_mismatch' };
    }
    if (resumeMode === 'size' || !shouldHashResume(resumeMode, Number(file.size))) {
      stats.sizeMatched += 1;
      stats.skipped += 1;
      processed += 1;
      if (onProgress) onProgress(processed, total);
      return { keep: false, file, reason: 'size_match' };
    }
    if (typeof hashLocal !== 'function' || typeof hashRemote !== 'function') {
      processed += 1;
      if (onProgress) onProgress(processed, total);
      return { keep: true, file, reason: 'hash_unavailable' };
    }
    const remotePath = makeRemotePath(rel);
    try {
      const [localHash, remoteHash] = await Promise.all([
        hashLocal(file),
        hashRemote(remotePath, file),
      ]);
      stats.hashChecked += 1;
      if (localHash === remoteHash) {
        stats.hashMatched += 1;
        stats.skipped += 1;
        processed += 1;
        if (onProgress) onProgress(processed, total);
        return { keep: false, file, reason: 'hash_match' };
      }
      stats.hashMismatched += 1;
      processed += 1;
      if (onProgress) onProgress(processed, total);
      return { keep: true, file, reason: 'hash_mismatch' };
    } catch {
      stats.hashChecked += 1;
      stats.hashFailed += 1;
      processed += 1;
      if (onProgress) onProgress(processed, total);
      return { keep: true, file, reason: 'hash_error' };
    }
  });

  const filtered = [];
  for (const item of results) {
    if (item && item.keep && item.file) filtered.push(item.file);
  }
  return { filtered, stats, total };
}

module.exports = {
  isRemoteDirEntry,
  listDirRecursiveCompat,
  filterResumeFiles,
};
