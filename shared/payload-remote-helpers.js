'use strict';

function createPayloadRemoteHelpers(options) {
  const createSocketWithTimeout = options && options.createSocketWithTimeout;
  const sendSimpleCommand = options && options.sendSimpleCommand;
  const commandForRemoteHashAlgorithm = options && options.commandForRemoteHashAlgorithm;
  const transferPort = Number(options && options.transferPort) || 9113;

  async function downloadRemoteFileToBuffer(ip, remotePath, maxBytes = 8 * 1024 * 1024) {
    const limit = typeof maxBytes === 'number' ? maxBytes : 8 * 1024 * 1024;
    const socket = await createSocketWithTimeout(ip, transferPort);
    socket.setTimeout(0);
    return new Promise((resolve, reject) => {
      let headerDone = false;
      let expectedSize = 0;
      let headerBuf = Buffer.alloc(0);
      const chunks = [];
      let received = 0;
      let settled = false;

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        if (err) {
          reject(err);
          return;
        }
        resolve(value);
      };

      socket.on('data', (chunk) => {
        if (!headerDone) {
          headerBuf = Buffer.concat([headerBuf, chunk]);
          const nl = headerBuf.indexOf('\n');
          if (nl === -1) return;
          const line = headerBuf.slice(0, nl).toString('utf8').trim();
          const remainder = headerBuf.slice(nl + 1);
          headerBuf = Buffer.alloc(0);
          if (line.startsWith('ERROR')) {
            finish(new Error(line));
            return;
          }
          const match = line.match(/^(?:OK|READY)\s+(\d+)/i);
          if (!match) {
            finish(new Error(`Unexpected response: ${line}`));
            return;
          }
          expectedSize = Number.parseInt(match[1], 10) || 0;
          if (expectedSize > limit) {
            finish(new Error(`File too large for scan: ${remotePath}`));
            return;
          }
          headerDone = true;
          if (remainder.length) {
            chunks.push(remainder);
            received += remainder.length;
          }
        } else {
          chunks.push(chunk);
          received += chunk.length;
        }
        if (received > limit) {
          finish(new Error(`File exceeded scan limit: ${remotePath}`));
          return;
        }
        if (headerDone && received >= expectedSize) {
          finish(null, Buffer.concat(chunks, received).subarray(0, expectedSize));
        }
      });

      socket.on('error', (err) => finish(err));
      socket.on('close', () => {
        if (!headerDone) {
          finish(new Error(`Connection closed before response for ${remotePath}`));
          return;
        }
        if (received >= expectedSize) {
          finish(null, Buffer.concat(chunks, received).subarray(0, expectedSize));
          return;
        }
        finish(new Error(`Incomplete download for ${remotePath}: ${received}/${expectedSize}`));
      });

      socket.write(`DOWNLOAD ${remotePath}\n`);
    });
  }

  async function hashFileRemote(ip, port, filePath, optionsOrAlgorithm = 'sha256') {
    let signal = null;
    let algorithm = 'sha256';

    if (optionsOrAlgorithm && typeof optionsOrAlgorithm === 'object') {
      signal = optionsOrAlgorithm.signal || null;
      algorithm = String(optionsOrAlgorithm.algorithm || 'sha256');
    } else {
      algorithm = String(optionsOrAlgorithm || 'sha256');
    }

    const cmd = commandForRemoteHashAlgorithm(algorithm);
    let response;
    try {
      response = await sendSimpleCommand(ip, port, `${cmd} ${filePath}\n`, signal);
    } catch (err) {
      if (cmd !== 'HASH_FILE') {
        response = await sendSimpleCommand(ip, port, `HASH_FILE ${filePath}\n`, signal);
      } else {
        throw err;
      }
    }

    if (!String(response || '').startsWith('OK ') && cmd !== 'HASH_FILE') {
      response = await sendSimpleCommand(ip, port, `HASH_FILE ${filePath}\n`, signal);
    }
    if (String(response).startsWith('OK ')) {
      return String(response).substring(3).trim().toLowerCase();
    }
    throw new Error(`Hash failed: ${response}`);
  }

  return {
    downloadRemoteFileToBuffer,
    hashFileRemote,
  };
}

module.exports = {
  createPayloadRemoteHelpers,
};
