'use strict';

const transferCore = require('./transfer-core');

function createPayloadRpc(options = {}) {
  const net = options.net;
  const connectionTimeoutMs = Number(options.connectionTimeoutMs || 5000);
  const readTimeoutMs = Number(options.readTimeoutMs || 10000);
  const maxLineResponseBytes = Math.max(1024, Number(options.maxLineResponseBytes || (8 * 1024 * 1024)));
  const maxPayloadResponseBytes = Math.max(1024, Number(options.maxPayloadResponseBytes || (64 * 1024 * 1024)));
  const maxHeaderBytes = Math.max(256, Number(options.maxHeaderBytes || 8192));
  if (!net || typeof net.Socket !== 'function') {
    throw new Error('createPayloadRpc requires Node net module');
  }

  function createSocketWithTimeout(ip, port, timeout = connectionTimeoutMs) {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;
      const cleanup = () => {
        socket.removeListener('timeout', onTimeout);
        socket.removeListener('error', onError);
        socket.removeListener('connect', onConnect);
      };
      const finish = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) {
          try {
            socket.destroy();
          } catch {
            // ignore
          }
          reject(err);
          return;
        }
        resolve(socket);
      };
      const onTimeout = () => {
        finish(new Error('Connection timed out'));
      };
      const onError = (err) => {
        finish(err);
      };
      const onConnect = () => {
        socket.setTimeout(0);
        finish(null);
      };
      socket.setTimeout(timeout);
      socket.once('timeout', onTimeout);
      socket.once('error', onError);
      socket.once('connect', onConnect);
      socket.connect(port, ip);
    });
  }

  async function sendSimpleCommand(ip, port, cmd, signal) {
    const socket = await createSocketWithTimeout(ip, port);
    const reader = transferCore.createSocketLineReader(socket, {
      defaultTimeoutMs: readTimeoutMs,
      maxBufferedBytes: maxLineResponseBytes,
    });
    const onAbort = () => {
      try {
        socket.destroy(new Error('Cancelled'));
      } catch {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
      }
    };
    try {
      if (signal) {
        if (signal.aborted) throw new Error('Cancelled');
        signal.addEventListener('abort', onAbort);
      }
      await transferCore.writeAll(socket, Buffer.from(String(cmd || ''), 'utf8'), readTimeoutMs);
      return await reader.readLine(readTimeoutMs);
    } catch (err) {
      if (signal && signal.aborted) {
        throw new Error('Cancelled');
      }
      throw err;
    } finally {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      try {
        reader.close();
      } catch {
        // ignore
      }
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
  }

  async function sendCommandReadAll(ip, port, cmd, signal) {
    const socket = await createSocketWithTimeout(ip, port);
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let settled = false;
      let abortHandler = null;

      const cleanup = () => {
        if (signal && abortHandler) {
          try {
            signal.removeEventListener('abort', abortHandler);
          } catch {
            // ignore
          }
          abortHandler = null;
        }
        socket.removeAllListeners();
      };
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        if (err) reject(err);
        else resolve(value);
      };
      const onAbort = () => {
        finish(new Error('Cancelled'));
      };

      socket.setTimeout(readTimeoutMs);
      socket.on('timeout', () => {
        finish(new Error('Read timed out'));
      });
      socket.on('data', (chunk) => {
        if (settled) return;
        chunks.push(chunk);
        total += chunk.length;
        if (total > maxPayloadResponseBytes) {
          finish(new Error('Response payload too large'));
        }
      });
      socket.on('error', (err) => {
        finish(err);
      });
      socket.on('close', () => {
        if (settled) return;
        const text = total > 0 ? Buffer.concat(chunks, total).toString('utf8').trim() : '';
        finish(null, text);
      });

      if (signal) {
        if (signal.aborted) {
          finish(new Error('Cancelled'));
          return;
        }
        abortHandler = onAbort;
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      transferCore.writeAll(socket, Buffer.from(String(cmd || ''), 'utf8'), readTimeoutMs).catch((err) => {
        finish(err);
      });
    });
  }

  async function sendCommandWithPayload(ip, port, header, payload) {
    const socket = await createSocketWithTimeout(ip, port);
    const reader = transferCore.createSocketLineReader(socket, {
      defaultTimeoutMs: readTimeoutMs,
      maxBufferedBytes: maxLineResponseBytes,
    });
    const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
    try {
      await transferCore.writeAll(socket, Buffer.from(String(header || ''), 'utf8'), readTimeoutMs);
      if (payloadBuf.length > 0) {
        await transferCore.writeAll(socket, payloadBuf, readTimeoutMs);
      }
      return await reader.readLine(readTimeoutMs);
    } finally {
      try {
        reader.close();
      } catch {
        // ignore
      }
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
  }

  async function sendCommandExpectPayload(ip, port, cmd) {
    const socket = await createSocketWithTimeout(ip, port);
    return new Promise((resolve, reject) => {
      let header = Buffer.alloc(0);
      const bodyChunks = [];
      let bodyLen = 0;
      let expected = -1;
      let resolved = false;

      const cleanup = () => {
        socket.removeAllListeners();
        socket.destroy();
      };

      const finish = (err, value) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        if (err) reject(err);
        else resolve(value);
      };

      const maybeResolveBody = () => {
        if (expected < 0 || bodyLen < expected) return;
        const body = Buffer.concat(bodyChunks, bodyLen).subarray(0, expected);
        finish(null, body.toString('utf8'));
      };

      socket.setTimeout(readTimeoutMs);
      socket.on('timeout', () => {
        finish(new Error('Read timed out'));
      });
      socket.on('data', (chunk) => {
        if (resolved) return;
        if (expected < 0) {
          header = Buffer.concat([header, chunk]);
          if (header.length > maxHeaderBytes) {
            finish(new Error('Response header too large'));
            return;
          }
          const idx = header.indexOf(0x0a);
          if (idx === -1) return;
          const line = header.subarray(0, idx).toString('utf8').trim();
          const rest = header.subarray(idx + 1);
          header = Buffer.alloc(0);
          const parts = line.split(' ');
          if (parts[0] !== 'OK') {
            finish(new Error(line || 'Invalid response'));
            return;
          }
          expected = parseInt(parts[1] || '0', 10);
          if (!Number.isFinite(expected) || expected < 0) {
            expected = 0;
          }
          if (expected > maxPayloadResponseBytes) {
            finish(new Error('Response payload too large'));
            return;
          }
          if (rest.length > 0) {
            bodyChunks.push(rest);
            bodyLen += rest.length;
          }
          maybeResolveBody();
        } else {
          bodyChunks.push(chunk);
          bodyLen += chunk.length;
          if (bodyLen > maxPayloadResponseBytes) {
            finish(new Error('Response payload too large'));
            return;
          }
          maybeResolveBody();
        }
      });
      socket.on('close', () => {
        if (resolved) return;
        if (expected >= 0 && bodyLen >= expected) {
          maybeResolveBody();
          return;
        }
        finish(new Error('Connection closed'));
      });
      socket.on('error', (err) => {
        finish(err);
      });
      transferCore.writeAll(socket, Buffer.from(String(cmd || ''), 'utf8'), readTimeoutMs).catch((err) => {
        finish(err);
      });
    });
  }

  return {
    createSocketWithTimeout,
    sendSimpleCommand,
    sendCommandReadAll,
    sendCommandWithPayload,
    sendCommandExpectPayload,
    createSocketLineReader: (socket) => transferCore.createSocketLineReader(socket, {
      defaultTimeoutMs: readTimeoutMs,
      maxBufferedBytes: maxLineResponseBytes,
    }),
    createSocketReader: (socket) => transferCore.createSocketReader(socket),
  };
}

module.exports = {
  createPayloadRpc,
};
