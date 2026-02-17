'use strict';

function createSocketLineReader(socket, options = {}) {
  const defaultTimeoutMs = Number(options.defaultTimeoutMs || 120000);
  const maxBufferedBytes = Math.max(1024, Number(options.maxBufferedBytes || (8 * 1024 * 1024)));
  const chunks = [];
  let total = 0;
  const pending = [];
  let socketError = null;
  let closed = false;

  const pushChunk = (chunk) => {
    chunks.push(chunk);
    total += chunk.length;
  };
  const consume = (length) => {
    if (length <= 0) return Buffer.alloc(0);
    const out = Buffer.allocUnsafe(length);
    let copied = 0;
    while (copied < length && chunks.length > 0) {
      const head = chunks[0];
      const take = Math.min(head.length, length - copied);
      head.copy(out, copied, 0, take);
      copied += take;
      total -= take;
      if (take === head.length) chunks.shift();
      else chunks[0] = head.subarray(take);
    }
    return out;
  };
  const findNewline = () => {
    let offset = 0;
    for (const chunk of chunks) {
      const idx = chunk.indexOf(0x0a);
      if (idx >= 0) return offset + idx;
      offset += chunk.length;
    }
    return -1;
  };
  const rejectAll = (err) => {
    while (pending.length > 0) {
      const { reject, timer } = pending.shift();
      clearTimeout(timer);
      reject(err);
    }
  };
  const flush = () => {
    while (pending.length > 0) {
      const idx = findNewline();
      if (idx < 0) return;
      const line = consume(idx + 1).subarray(0, idx).toString('utf8').trim();
      const { resolve, timer } = pending.shift();
      clearTimeout(timer);
      resolve(line);
    }
  };
  const onData = (data) => {
    if (closed) return;
    pushChunk(data);
    if (total > maxBufferedBytes) {
      socketError = new Error('Response too large');
      closed = true;
      rejectAll(socketError);
      try {
        socket.destroy(socketError);
      } catch {
        // ignore
      }
      return;
    }
    flush();
  };
  const onErr = (err) => {
    if (closed) return;
    socketError = err;
    closed = true;
    rejectAll(err);
  };
  const onClose = () => {
    if (closed) return;
    closed = true;
    flush();
    if (total > 0 && pending.length > 0) {
      const line = consume(total).toString('utf8').trim();
      const { resolve, timer } = pending.shift();
      clearTimeout(timer);
      resolve(line);
    }
    rejectAll(new Error('Socket closed before response'));
  };

  socket.on('data', onData);
  socket.on('error', onErr);
  socket.on('close', onClose);
  socket.on('end', onClose);

  return {
    readLine: (timeoutMs = defaultTimeoutMs) => new Promise((resolve, reject) => {
      if (socketError) return reject(socketError);
      const idx = findNewline();
      if (idx >= 0) {
        const line = consume(idx + 1).subarray(0, idx).toString('utf8').trim();
        return resolve(line);
      }
      if (closed) return reject(new Error('Socket closed before response'));
      const timer = setTimeout(() => {
        const i = pending.findIndex((p) => p.resolve === resolve);
        if (i >= 0) pending.splice(i, 1);
        reject(new Error('Read timed out'));
      }, timeoutMs);
      pending.push({ resolve, reject, timer });
    }),
    close: () => {
      closed = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
      socket.removeListener('close', onClose);
      socket.removeListener('end', onClose);
      rejectAll(new Error('Reader closed'));
    },
  };
}

function createSocketReader(socket) {
  const chunks = [];
  let total = 0;
  let ended = false;
  let error = null;
  const waiters = new Set();

  const pushChunk = (chunk) => {
    chunks.push(chunk);
    total += chunk.length;
  };
  const consume = (length) => {
    if (length <= 0) return Buffer.alloc(0);
    const out = Buffer.allocUnsafe(length);
    let copied = 0;
    while (copied < length && chunks.length > 0) {
      const head = chunks[0];
      const take = Math.min(head.length, length - copied);
      head.copy(out, copied, 0, take);
      copied += take;
      total -= take;
      if (take === head.length) chunks.shift();
      else chunks[0] = head.subarray(take);
    }
    return out;
  };
  const notify = () => {
    for (const waiter of Array.from(waiters)) waiter();
  };
  const onData = (chunk) => {
    pushChunk(chunk);
    notify();
  };
  const onError = (err) => {
    error = err;
    notify();
  };
  const onClose = () => {
    ended = true;
    notify();
  };

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);
  socket.on('end', onClose);

  const awaitCondition = (predicate, timeoutMs) => new Promise((resolve, reject) => {
    if (error) return reject(error);
    if (predicate()) return resolve();
    if (ended) return reject(new Error('Connection closed'));

    const waiter = () => {
      if (error) {
        cleanup();
        reject(error);
        return;
      }
      if (predicate()) {
        cleanup();
        resolve();
        return;
      }
      if (ended) {
        cleanup();
        reject(new Error('Connection closed'));
      }
    };

    let timeout = null;
    if (timeoutMs) {
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Read timeout'));
      }, timeoutMs);
    }

    const cleanup = () => {
      waiters.delete(waiter);
      if (timeout) clearTimeout(timeout);
    };

    waiters.add(waiter);
  });

  return {
    readExact: async (length, timeoutMs) => {
      if (length === 0) return Buffer.alloc(0);
      await awaitCondition(() => total >= length, timeoutMs);
      return consume(length);
    },
    close: () => {
      error = error || new Error('Reader closed');
      ended = true;
      notify();
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      socket.removeListener('end', onClose);
      waiters.clear();
    },
  };
}

function writeAll(socket, buffer, timeoutMs = 120000) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      socket.removeListener('drain', onDrain);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const finish = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve();
    };
    const onError = (err) => {
      finish(err);
    };
    const onDrain = () => {
      finish();
    };
    const onClose = () => {
      finish(new Error('Connection closed'));
    };
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        finish(new Error('Socket write timed out'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
    socket.once('error', onError);
    socket.once('close', onClose);
    if (!socket.write(data)) {
      socket.once('drain', onDrain);
    } else {
      finish();
    }
  });
}

function buildUploadStartPayload(remotePath, totalSize, offset) {
  const pathBuf = Buffer.from(String(remotePath || ''), 'utf8');
  const payload = Buffer.alloc(pathBuf.length + 1 + 8 + 8);
  pathBuf.copy(payload, 0);
  payload.writeBigUInt64LE(BigInt(totalSize), pathBuf.length + 1);
  payload.writeBigUInt64LE(BigInt(offset), pathBuf.length + 9);
  return payload;
}

async function readBinaryResponse(reader, timeoutMs) {
  const header = await reader.readExact(5, timeoutMs);
  const code = header.readUInt8(0);
  const len = header.readUInt32LE(1);
  const data = len > 0 ? await reader.readExact(len, timeoutMs) : Buffer.alloc(0);
  return { code, data };
}

async function writeBinaryCommand(socket, cmd, payload, writeTimeoutMs = 120000) {
  const body = payload == null
    ? Buffer.alloc(0)
    : (Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
  const header = Buffer.alloc(5);
  header[0] = cmd;
  header.writeUInt32LE(body.length, 1);
  await writeAll(socket, header, writeTimeoutMs);
  if (body.length > 0) {
    await writeAll(socket, body, writeTimeoutMs);
  }
}

function getLaneChunkSize(totalSize, constants) {
  if (totalSize >= constants.LANE_HUGE_FILE_BYTES) return constants.LANE_HUGE_CHUNK_BYTES;
  if (totalSize >= constants.LANE_LARGE_FILE_BYTES) return constants.LANE_LARGE_CHUNK_BYTES;
  return constants.LANE_DEFAULT_CHUNK_BYTES;
}

function getMadMaxChunkSize(totalSize, constants) {
  if (totalSize >= constants.LANE_HUGE_FILE_BYTES) return constants.MAD_MAX_HUGE_CHUNK_BYTES;
  if (totalSize >= constants.LANE_LARGE_FILE_BYTES) return constants.MAD_MAX_LARGE_CHUNK_BYTES;
  return constants.MAD_MAX_DEFAULT_CHUNK_BYTES;
}

function classifyPayloadUploadBottleneck(status, clientSendBps = 0) {
  const transfer = status && status.transfer ? status.transfer : null;
  if (!transfer) return 'unknown';
  const recvBps = Number(transfer.recv_rate_bps || 0);
  const writeBps = Number(transfer.write_rate_bps || 0);
  const backpressureMs = Number(transfer.backpressure_wait_ms || 0);
  const backpressureEvents = Number(transfer.backpressure_events || 0);
  const writerQueue = Number(transfer.queue_count || 0);
  const packQueue = Number(transfer.pack_queue_count || 0);
  const payloadCpu = Number(status?.system?.cpu_percent ?? -1);
  const payloadProcCpu = Number(status?.system?.proc_cpu_percent ?? -1);
  const payloadNetRx = Number(status?.system?.net_rx_bps ?? -1);
  const hasBackpressure = backpressureEvents > 0 || backpressureMs > 0;
  const queueBusy = writerQueue > 0 || packQueue > 0;

  if (hasBackpressure && queueBusy) return 'payload_disk';
  if (writeBps > 0 && recvBps > writeBps * 1.5) return 'payload_disk';
  if (payloadCpu >= 85 || payloadProcCpu >= 85) return 'payload_cpu';
  if (payloadNetRx >= 0 && clientSendBps > 0 && payloadNetRx < clientSendBps * 0.7) return 'network';
  if (clientSendBps > 0 && clientSendBps < 2 * 1024 * 1024) return 'client';
  return 'unknown';
}

module.exports = {
  buildUploadStartPayload,
  classifyPayloadUploadBottleneck,
  createSocketLineReader,
  createSocketReader,
  getLaneChunkSize,
  getMadMaxChunkSize,
  readBinaryResponse,
  writeAll,
  writeBinaryCommand,
};
