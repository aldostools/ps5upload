'use strict';

function createClientRuntimeHelpers(options) {
  const payloadRpc = options && options.payloadRpc;
  const transferCore = options && options.transferCore;
  const transferConstants = options && options.transferConstants;
  const hashWasm = options && options.hashWasm;
  const uploadSocketBufferSize = Number(options && options.uploadSocketBufferSize) || (8 * 1024 * 1024);
  const connectionTimeoutMs = Number(options && options.connectionTimeoutMs) || 30000;

  function createSocketWithTimeout(ip, port, timeout = connectionTimeoutMs) {
    return payloadRpc.createSocketWithTimeout(ip, port, timeout);
  }

  function tuneUploadSocket(socket) {
    if (!socket) return;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 1000);
    socket.setTimeout(15 * 60 * 1000, () => {
      try {
        socket.destroy(new Error('Upload socket timeout'));
      } catch {
        // ignore double-destroy
      }
    });
    if (typeof socket.setSendBufferSize === 'function') {
      socket.setSendBufferSize(uploadSocketBufferSize);
    }
    if (typeof socket.setRecvBufferSize === 'function') {
      socket.setRecvBufferSize(uploadSocketBufferSize);
    }
  }

  function createSocketLineReader(socket) {
    return payloadRpc.createSocketLineReader(socket);
  }

  function createSocketReader(socket) {
    return payloadRpc.createSocketReader(socket);
  }

  function buildUploadStartPayload(remotePath, totalSize, offset) {
    return transferCore.buildUploadStartPayload(remotePath, totalSize, offset);
  }

  function isLocalHashAlgorithmSupported(algorithm) {
    if (algorithm === 'sha256') return true;
    if (algorithm === 'blake3') return Boolean(hashWasm && typeof hashWasm.createBLAKE3 === 'function');
    if (algorithm === 'xxh64') return Boolean(hashWasm && typeof hashWasm.createXXHash64 === 'function');
    return false;
  }

  function getLaneChunkSize(totalSize) {
    return transferCore.getLaneChunkSize(totalSize, transferConstants);
  }

  function getMadMaxChunkSize(totalSize) {
    return transferCore.getMadMaxChunkSize(totalSize, transferConstants);
  }

  function classifyPayloadUploadBottleneck(status, clientSendBps = 0) {
    return transferCore.classifyPayloadUploadBottleneck(status, clientSendBps);
  }

  return {
    createSocketWithTimeout,
    tuneUploadSocket,
    createSocketLineReader,
    createSocketReader,
    buildUploadStartPayload,
    isLocalHashAlgorithmSupported,
    getLaneChunkSize,
    getMadMaxChunkSize,
    classifyPayloadUploadBottleneck,
  };
}

module.exports = {
  createClientRuntimeHelpers,
};
