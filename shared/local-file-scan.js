'use strict';

function createLocalFileScan(options) {
  const fs = options && options.fs;
  const path = options && options.path;

  async function walkLocalFiles(basePath, walkOptions = {}) {
    const onFile = typeof walkOptions.onFile === 'function' ? walkOptions.onFile : null;
    const shouldCancel = typeof walkOptions.shouldCancel === 'function' ? walkOptions.shouldCancel : null;
    const cancelBehavior = walkOptions.cancelBehavior === 'return' ? 'return' : 'throw';
    const cancelErrorMessage = String(walkOptions.cancelErrorMessage || 'Transfer cancelled');
    const treatDirectoryAsFile = typeof walkOptions.treatDirectoryAsFile === 'function'
      ? walkOptions.treatDirectoryAsFile
      : null;
    const includeMtime = Boolean(walkOptions.includeMtime);
    const normalizeRelPath = walkOptions.normalizeRelPath !== false;
    const ensureSafeInteger = Boolean(walkOptions.ensureSafeInteger);

    const maybeCancelled = () => {
      if (!shouldCancel || !shouldCancel()) return false;
      if (cancelBehavior === 'return') return true;
      throw new Error(cancelErrorMessage);
    };

    const buildItem = (absPath, relPath, stat) => {
      const size = Number(stat && stat.size);
      if (ensureSafeInteger && !Number.isSafeInteger(size)) {
        throw new Error(`File too large for safe integer math: ${absPath}`);
      }
      const item = {
        abs_path: absPath,
        rel_path: normalizeRelPath ? String(relPath || '').replace(/\\/g, '/') : relPath,
        size,
      };
      if (includeMtime) {
        item.mtime = Math.floor(Number(stat && stat.mtimeMs) / 1000) || 0;
      }
      return item;
    };

    if (maybeCancelled()) return { cancelled: true };

    const baseStat = await fs.promises.stat(basePath);
    if (baseStat.isFile()) {
      const item = buildItem(basePath, path.basename(basePath), baseStat);
      if (onFile) await onFile(item);
      return { cancelled: false };
    }

    const stack = [{ abs: basePath, rel: '' }];
    while (stack.length > 0) {
      if (maybeCancelled()) return { cancelled: true };
      const current = stack.pop();
      if (!current) continue;
      const dirEntries = await fs.promises.readdir(current.abs, { withFileTypes: true });
      for (const entry of dirEntries) {
        if (maybeCancelled()) return { cancelled: true };
        const abs = path.join(current.abs, entry.name);
        const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (treatDirectoryAsFile && treatDirectoryAsFile(entry, abs, rel)) {
            const st = await fs.promises.stat(abs);
            const item = buildItem(abs, rel, st);
            if (onFile) await onFile(item);
          } else {
            stack.push({ abs, rel });
          }
        } else if (entry.isFile()) {
          const st = await fs.promises.stat(abs);
          const item = buildItem(abs, rel, st);
          if (onFile) await onFile(item);
        }
      }
    }
    return { cancelled: false };
  }

  return {
    walkLocalFiles,
  };
}

module.exports = {
  createLocalFileScan,
};
