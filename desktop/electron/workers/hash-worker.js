'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { parentPort } = require('worker_threads');
let hashWasm = null;
try {
  hashWasm = require('hash-wasm');
} catch {
  hashWasm = null;
}

function hashFileWithSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function hashFileWithHashWasm(filePath, algorithm) {
  if (!hashWasm) {
    throw new Error('hash-wasm not available');
  }
  let hasher = null;
  if (algorithm === 'blake3') {
    if (typeof hashWasm.createBLAKE3 !== 'function') {
      throw new Error('BLAKE3 not available');
    }
    hasher = await hashWasm.createBLAKE3();
  } else if (algorithm === 'xxh64') {
    if (typeof hashWasm.createXXHash64 !== 'function') {
      throw new Error('XXH64 not available');
    }
    hasher = await hashWasm.createXXHash64();
  } else {
    throw new Error(`Unsupported hash algorithm: ${algorithm}`);
  }

  if (typeof hasher.init === 'function') {
    hasher.init();
  }

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hasher.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(String(hasher.digest('hex')).toLowerCase()));
  });
}

async function hashFile(filePath, algorithm) {
  if (algorithm === 'sha256') {
    return hashFileWithSha256(filePath);
  }
  return hashFileWithHashWasm(filePath, algorithm);
}

parentPort.on('message', async (msg) => {
  const taskId = msg && typeof msg.taskId === 'number' ? msg.taskId : 0;
  const filePath = msg && msg.filePath ? String(msg.filePath) : '';
  const algorithm = msg && msg.algorithm ? String(msg.algorithm) : 'sha256';
  if (!taskId || !filePath) {
    parentPort.postMessage({ taskId, ok: false, error: 'Invalid hash task' });
    return;
  }
  try {
    const hash = await hashFile(filePath, algorithm);
    parentPort.postMessage({ taskId, ok: true, hash });
  } catch (err) {
    parentPort.postMessage({ taskId, ok: false, error: err?.message || String(err) });
  }
});
