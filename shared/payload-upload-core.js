'use strict';

function createPayloadUploadCore(options = {}) {
  const createSocketWithTimeout = options.createSocketWithTimeout;
  const tuneUploadSocket = options.tuneUploadSocket;
  const readBinaryResponse = options.readBinaryResponse;
  const writeBinaryCommand = options.writeBinaryCommand;
  const writeAll = options.writeAll;
  const buildUploadStartPayload = options.buildUploadStartPayload;
  const joinRemotePath = options.joinRemotePath;
  const getLaneChunkSize = options.getLaneChunkSize;
  const transferPort = Number(options.transferPort || 9113);
  const readTimeoutMs = Number(options.readTimeoutMs || 10000);
  const laneMinFileSize = Number(options.laneMinFileSize || 128 * 1024 * 1024);
  const laneConnections = Number(options.laneConnections || 4);
  const writeTimeoutMs = Number(options.writeTimeoutMs || 120000);
  const uploadCmd = options.uploadCmd || {};
  const uploadResp = options.uploadResp || {};
  const fs = options.fs;
  if (
    typeof createSocketWithTimeout !== 'function' ||
    typeof tuneUploadSocket !== 'function' ||
    typeof readBinaryResponse !== 'function' ||
    typeof writeBinaryCommand !== 'function' ||
    typeof writeAll !== 'function' ||
    typeof buildUploadStartPayload !== 'function' ||
    typeof joinRemotePath !== 'function' ||
    typeof getLaneChunkSize !== 'function' ||
    !fs
  ) {
    throw new Error('createPayloadUploadCore missing required dependencies');
  }

  const isRetryableError = (err) => {
    const msg = String((err && err.message) || err || '').toLowerCase();
    return msg.includes('timeout') || msg.includes('timed out') || msg.includes('econnreset') || msg.includes('epipe') || msg.includes('connection closed');
  };

  async function uploadFastOneFile(ip, destRoot, file, options = {}) {
    const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : null;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const chmodAfterUpload = Boolean(options.chmodAfterUpload);
    const chmodAfterUploadFn = typeof options.chmodAfterUploadFn === 'function' ? options.chmodAfterUploadFn : null;
    const noProgressTimeoutMs = Math.max(5000, Number(options.noProgressTimeoutMs || 45000));

    const socket = await createSocketWithTimeout(ip, transferPort);
    tuneUploadSocket(socket);
    const reader = options.createSocketReader(socket);
    let lastProgressAt = Date.now();

    try {
      const remotePath = joinRemotePath(destRoot, file.rel_path);
      const startPayload = buildUploadStartPayload(remotePath, file.size, 0);
      await writeBinaryCommand(socket, uploadCmd.StartUpload, startPayload, writeTimeoutMs);
      const readyResp = await readBinaryResponse(reader, readTimeoutMs);
      if (readyResp.code !== uploadResp.Ready) {
        const msg = readyResp.data?.length ? readyResp.data.toString('utf8') : 'no response';
        throw new Error(`Upload rejected: ${msg}`);
      }

      if (Number(file.size) > 0) {
        const fd = await fs.promises.open(file.abs_path, 'r');
        try {
          const buf = Buffer.allocUnsafe(5 + 8 * 1024 * 1024);
          let remaining = Number(file.size);
          let pos = 0;
          while (remaining > 0) {
            if (shouldCancel && shouldCancel()) throw new Error('Transfer cancelled');
            if (Date.now() - lastProgressAt > noProgressTimeoutMs) {
              throw new Error('Upload stalled');
            }
            const take = Math.min(buf.length - 5, remaining);
            const { bytesRead } = await fd.read(buf, 5, take, pos);
            if (bytesRead <= 0) throw new Error('Read failed');
            buf[0] = uploadCmd.UploadChunk;
            buf.writeUInt32LE(bytesRead, 1);
            await writeAll(socket, buf.subarray(0, 5 + bytesRead), writeTimeoutMs);
            remaining -= bytesRead;
            pos += bytesRead;
            lastProgressAt = Date.now();
            if (onProgress) onProgress(bytesRead);
          }
        } finally {
          await fd.close().catch(() => {});
        }
      }

      await writeBinaryCommand(socket, uploadCmd.EndUpload, Buffer.alloc(0), writeTimeoutMs);
      const endResp = await readBinaryResponse(reader, readTimeoutMs);
      if (endResp.code !== uploadResp.Ok) {
        const msg = endResp.data?.length ? endResp.data.toString('utf8') : 'unknown response';
        throw new Error(`Upload failed: ${msg}`);
      }

      if (chmodAfterUpload && chmodAfterUploadFn) {
        try {
          await chmodAfterUploadFn(remotePath);
        } catch {
          // non-fatal
        }
      }
      return true;
    } finally {
      try { reader.close(); } catch {}
      try { socket.destroy(); } catch {}
    }
  }

  async function uploadLaneSingleFile(ip, destRoot, file, options = {}) {
    const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : null;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const chmodAfterUpload = Boolean(options.chmodAfterUpload);
    const chmodAfterUploadFn = typeof options.chmodAfterUploadFn === 'function' ? options.chmodAfterUploadFn : null;
    const connections = Math.max(1, Math.min(8, Number(options.connections) || laneConnections));
    const noProgressTimeoutMs = Math.max(5000, Number(options.noProgressTimeoutMs || 45000));
    const totalSize = Number(file.size || 0);
    if (totalSize <= 0) return;
    const chunkSize = Math.max(4 * 1024 * 1024, Number(options.chunkSize) || getLaneChunkSize(totalSize));
    const chunks = [];
    for (let offset = 0; offset < totalSize; offset += chunkSize) {
      chunks.push({ offset, len: Math.min(chunkSize, totalSize - offset) });
    }
    const workerQueues = Array.from({ length: connections }, () => []);
    for (let i = 0; i < chunks.length; i += 1) workerQueues[i % connections].push(chunks[i]);
    const activeQueues = workerQueues.filter((q) => q.length > 0);
    const workerProgress = new Array(activeQueues.length).fill(0);
    let lastProgressAt = Date.now();
    let preallocResolved = false;
    let preallocResolve;
    let preallocReject;
    const preallocPromise = new Promise((resolve, reject) => {
      preallocResolve = resolve;
      preallocReject = reject;
    });

    const runWorker = async (queue, idx) => {
      const socket = await createSocketWithTimeout(ip, transferPort);
      tuneUploadSocket(socket);
      const reader = options.createSocketReader(socket);
      const fd = await fs.promises.open(file.abs_path, 'r');
      try {
        for (const chunk of queue) {
          if (shouldCancel && shouldCancel()) throw new Error('Transfer cancelled');
          if (chunk.offset !== 0) await preallocPromise;
          const remotePath = joinRemotePath(destRoot, file.rel_path);
          const startPayload = buildUploadStartPayload(remotePath, totalSize, chunk.offset);
          await writeBinaryCommand(socket, uploadCmd.StartUpload, startPayload, writeTimeoutMs);
          const readyResp = await readBinaryResponse(reader, readTimeoutMs);
          if (readyResp.code !== uploadResp.Ready) {
            const msg = readyResp.data?.length ? readyResp.data.toString('utf8') : 'no response';
            throw new Error(`Connection rejected: ${msg}`);
          }
          if (chunk.offset === 0 && !preallocResolved) {
            preallocResolved = true;
            preallocResolve();
          }

          let remaining = chunk.len;
          let pos = chunk.offset;
          const buf = Buffer.allocUnsafe(5 + 8 * 1024 * 1024);
          while (remaining > 0) {
            if (shouldCancel && shouldCancel()) throw new Error('Transfer cancelled');
            if (Date.now() - lastProgressAt > noProgressTimeoutMs) throw new Error('Upload stalled');
            const take = Math.min(buf.length - 5, remaining);
            const { bytesRead } = await fd.read(buf, 5, take, pos);
            if (bytesRead <= 0) throw new Error('Read failed');
            buf[0] = uploadCmd.UploadChunk;
            buf.writeUInt32LE(bytesRead, 1);
            await writeAll(socket, buf.subarray(0, 5 + bytesRead), writeTimeoutMs);
            remaining -= bytesRead;
            pos += bytesRead;
            workerProgress[idx] += bytesRead;
            lastProgressAt = Date.now();
            if (onProgress) {
              const sent = workerProgress.reduce((sum, value) => sum + value, 0);
              onProgress(sent);
            }
          }
          await writeBinaryCommand(socket, uploadCmd.EndUpload, Buffer.alloc(0), writeTimeoutMs);
          const endResp = await readBinaryResponse(reader, readTimeoutMs);
          if (endResp.code !== uploadResp.Ok) {
            const msg = endResp.data?.length ? endResp.data.toString('utf8') : 'unknown response';
            throw new Error(`Connection failed: ${msg}`);
          }
        }
      } catch (err) {
        if (!preallocResolved) {
          preallocResolved = true;
          preallocReject(err);
        }
        throw err;
      } finally {
        await fd.close().catch(() => {});
        try { reader.close(); } catch {}
        try { socket.destroy(); } catch {}
      }
    };

    await Promise.all(activeQueues.map((queue, idx) => runWorker(queue, idx)));
    if (chmodAfterUpload && chmodAfterUploadFn) {
      try {
        await chmodAfterUploadFn(joinRemotePath(destRoot, file.rel_path));
      } catch {
        // non-fatal
      }
    }
  }

  async function uploadFastMultiFile(ip, destRoot, files, options = {}) {
    const connections = Math.max(1, Math.min(8, Number(options.connections) || 8));
    const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : null;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const onFileStart = typeof options.onFileStart === 'function' ? options.onFileStart : null;
    const onFileDone = typeof options.onFileDone === 'function' ? options.onFileDone : null;
    const chmodAfterUpload = Boolean(options.chmodAfterUpload);
    const chmodAfterUploadFn = typeof options.chmodAfterUploadFn === 'function' ? options.chmodAfterUploadFn : null;
    const maxRetries = Math.max(0, Number(options.retryAttempts == null ? 1 : options.retryAttempts));
    const retryDelayMs = Math.max(50, Number(options.retryDelayMs || 300));
    const noProgressTimeoutMs = Math.max(5000, Number(options.noProgressTimeoutMs || 45000));
    const onSkipFile = typeof options.onSkipFile === 'function' ? options.onSkipFile : null;
    const acquireRemoteLock = typeof options.acquireRemoteLock === 'function' ? options.acquireRemoteLock : null;

    const queue = Array.isArray(files) ? [...files] : [];
    let totalSent = 0;
    let laneLocked = false;
    let laneWaiters = [];

    const acquireLaneLock = async () => {
      while (laneLocked) await new Promise((resolve) => laneWaiters.push(resolve));
      laneLocked = true;
    };
    const releaseLaneLock = () => {
      laneLocked = false;
      const waiters = laneWaiters;
      laneWaiters = [];
      for (const resolve of waiters) resolve();
    };
    const waitIfLaneBusy = async () => {
      while (laneLocked) await new Promise((resolve) => laneWaiters.push(resolve));
    };

    const uploadWithRetry = async (file, laneMode) => {
      let attempt = 0;
      let releaseRemote = null;
      const remotePath = joinRemotePath(destRoot, file.rel_path);
      while (true) {
        try {
          if (!releaseRemote && acquireRemoteLock) {
            releaseRemote = await acquireRemoteLock(remotePath, file);
          }
          if (laneMode) {
            const laneBaseBytes = totalSent;
            await uploadLaneSingleFile(ip, destRoot, file, {
              connections,
              shouldCancel,
              chmodAfterUpload,
              chmodAfterUploadFn,
              noProgressTimeoutMs,
              createSocketReader: options.createSocketReader,
              onProgress: (sent) => {
                totalSent = laneBaseBytes + sent;
                if (onProgress) onProgress(totalSent, file);
              },
            });
          } else {
            await uploadFastOneFile(ip, destRoot, file, {
              shouldCancel,
              chmodAfterUpload,
              chmodAfterUploadFn,
              noProgressTimeoutMs,
              createSocketReader: options.createSocketReader,
              onProgress: (delta) => {
                totalSent += delta;
                if (onProgress) onProgress(totalSent, file);
              },
            });
          }
          if (releaseRemote) {
            try { releaseRemote(); } catch {}
            releaseRemote = null;
          }
          return;
        } catch (err) {
          const code = String((err && err.code) || '');
          if (code === 'ENOENT' || code === 'EACCES') {
            if (releaseRemote) {
              try { releaseRemote(); } catch {}
              releaseRemote = null;
            }
            if (onSkipFile) onSkipFile(file, err);
            return;
          }
          if (attempt >= maxRetries || !isRetryableError(err)) {
            if (releaseRemote) {
              try { releaseRemote(); } catch {}
              releaseRemote = null;
            }
            throw err;
          }
          attempt += 1;
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
        }
      }
    };

    const runWorker = async () => {
      while (queue.length > 0) {
        if (shouldCancel && shouldCancel()) throw new Error('Transfer cancelled');
        await waitIfLaneBusy();
        const file = queue.shift();
        if (!file) continue;
        if (onFileStart) onFileStart(file);
        const laneMode = Number(file.size || 0) >= laneMinFileSize;
        if (laneMode) {
          await acquireLaneLock();
          try {
            await uploadWithRetry(file, true);
          } finally {
            releaseLaneLock();
          }
        } else {
          await uploadWithRetry(file, false);
        }
        if (onFileDone) onFileDone(file);
      }
    };

    const workers = Array.from({ length: Math.min(connections, queue.length || 1) }, () => runWorker());
    await Promise.all(workers);
    return { bytes: totalSent, files: Array.isArray(files) ? files.length : 0 };
  }

  return {
    uploadFastOneFile,
    uploadFastMultiFile,
    uploadLaneSingleFile,
  };
}

module.exports = {
  createPayloadUploadCore,
};
