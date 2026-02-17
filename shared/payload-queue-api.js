'use strict';

function createPayloadQueueApi(options = {}) {
  const sendSimpleCommand = options.sendSimpleCommand;
  const sendCommandExpectPayload = options.sendCommandExpectPayload;
  const sendCommandWithPayload = options.sendCommandWithPayload;
  if (typeof sendSimpleCommand !== 'function') {
    throw new Error('createPayloadQueueApi requires sendSimpleCommand');
  }
  if (typeof sendCommandExpectPayload !== 'function') {
    throw new Error('createPayloadQueueApi requires sendCommandExpectPayload');
  }
  if (typeof sendCommandWithPayload !== 'function') {
    throw new Error('createPayloadQueueApi requires sendCommandWithPayload');
  }

  async function queueExtract(ip, port, src, dst, opts = {}) {
    const cleanupPath = typeof opts.cleanupPath === 'string' ? opts.cleanupPath.trim() : '';
    const deleteSource = opts.deleteSource === true;
    const requestedMode = typeof opts.unrarMode === 'string' ? opts.unrarMode.trim().toUpperCase() : '';
    let modeFlag = '';
    if (requestedMode === 'SAFE') modeFlag = 'RAR_SAFE';
    else if (requestedMode === 'FAST') modeFlag = 'RAR_FAST';
    else if (requestedMode === 'TURBO') modeFlag = 'RAR_TURBO';
    else if (requestedMode === 'AUTO') modeFlag = 'RAR_AUTO';

    const tokens = [src, dst];
    const flagTokens = [];
    if (deleteSource) flagTokens.push('DEL');
    if (modeFlag) flagTokens.push(modeFlag);
    if (cleanupPath || flagTokens.length > 0) {
      tokens.push(cleanupPath);
      tokens.push(flagTokens.join(','));
    }
    const cmd = `QUEUE_EXTRACT ${tokens.join('\t')}\n`;
    const response = await sendSimpleCommand(ip, port, cmd);
    if (response.startsWith('OK ')) {
      return parseInt(response.substring(3).trim(), 10);
    }
    throw new Error(`Queue extract failed: ${response}`);
  }

  async function queuePause(ip, port, id) {
    const response = await sendSimpleCommand(ip, port, `QUEUE_PAUSE ${id}\n`);
    if (!response.startsWith('OK')) throw new Error(`Queue pause failed: ${response}`);
    return true;
  }

  async function queueRetry(ip, port, id) {
    const response = await sendSimpleCommand(ip, port, `QUEUE_RETRY ${id}\n`);
    if (!response.startsWith('OK')) throw new Error(`Queue retry failed: ${response}`);
    return true;
  }

  async function queueRemove(ip, port, id) {
    const response = await sendSimpleCommand(ip, port, `QUEUE_REMOVE ${id}\n`);
    if (!response.startsWith('OK')) throw new Error(`Queue remove failed: ${response}`);
    return true;
  }

  async function uploadQueueSync(ip, port, payload) {
    const data = Buffer.from(String(payload || ''), 'utf8');
    const response = await sendCommandWithPayload(ip, port, `UPLOAD_QUEUE_SYNC ${data.length}\n`, data);
    if (!response.startsWith('OK')) throw new Error(`Upload queue sync failed: ${response}`);
    return true;
  }

  async function historySync(ip, port, payload) {
    const data = Buffer.from(String(payload || ''), 'utf8');
    const response = await sendCommandWithPayload(ip, port, `HISTORY_SYNC ${data.length}\n`, data);
    if (!response.startsWith('OK')) throw new Error(`History sync failed: ${response}`);
    return true;
  }

  async function uploadQueueGet(ip, port) {
    const payload = await sendCommandExpectPayload(ip, port, 'UPLOAD_QUEUE_GET\n');
    return payload || '{}';
  }

  async function historyGet(ip, port) {
    const payload = await sendCommandExpectPayload(ip, port, 'HISTORY_GET\n');
    return payload || '{}';
  }

  async function syncInfo(ip, port) {
    const payload = await sendCommandExpectPayload(ip, port, 'SYNC_INFO\n');
    return payload || '{}';
  }

  return {
    queueExtract,
    queuePause,
    queueRetry,
    queueRemove,
    uploadQueueSync,
    historySync,
    uploadQueueGet,
    historyGet,
    syncInfo,
  };
}

module.exports = {
  createPayloadQueueApi,
};
