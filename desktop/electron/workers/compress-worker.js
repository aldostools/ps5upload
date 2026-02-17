'use strict';

const { parentPort } = require('worker_threads');

function tryRequire(name) {
  try {
    return require(name);
  } catch {
    return null;
  }
}

const lz4 = tryRequire('lz4');
const fzstd = tryRequire('fzstd');
const lzma = tryRequire('lzma-native');

parentPort.on('message', async (msg) => {
  const taskId = msg && typeof msg.taskId === 'number' ? msg.taskId : 0;
  const codec = msg && msg.codec ? String(msg.codec) : '';
  const payload = Buffer.isBuffer(msg?.payload) ? msg.payload : Buffer.from(msg?.payload || []);
  if (!taskId || !codec || payload.length === 0) {
    parentPort.postMessage({ taskId, ok: false, error: 'Invalid compression task' });
    return;
  }

  try {
    let compressed;
    if (codec === 'lz4') {
      if (!lz4) throw new Error('lz4 module unavailable');
      compressed = lz4.encode(payload);
    } else if (codec === 'zstd') {
      if (!fzstd) throw new Error('fzstd module unavailable');
      compressed = fzstd.compress(payload);
    } else if (codec === 'lzma') {
      if (!lzma) throw new Error('lzma-native module unavailable');
      compressed = await lzma.compress(payload);
    } else {
      throw new Error(`Unsupported codec: ${codec}`);
    }
    parentPort.postMessage({ taskId, ok: true, compressed });
  } catch (err) {
    parentPort.postMessage({ taskId, ok: false, error: err?.message || String(err) });
  }
});
