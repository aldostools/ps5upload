'use strict';

function createPayloadFsApi(options = {}) {
  const sendSimpleCommand = options.sendSimpleCommand;
  const sendCommandReadAll = options.sendCommandReadAll;
  if (typeof sendSimpleCommand !== 'function') {
    throw new Error('createPayloadFsApi requires sendSimpleCommand');
  }
  const readAllCommand = typeof sendCommandReadAll === 'function' ? sendCommandReadAll : sendSimpleCommand;

  async function readJsonList(ip, port, command, signal) {
    const response = await readAllCommand(ip, port, command, signal);
    const text = String(response || '').trim();
    if (!text) return [];
    if (text.startsWith('ERROR:') || text.startsWith('ERROR ')) {
      throw new Error(text);
    }
    const parseFromSlice = (src, startToken, endToken) => {
      const start = src.indexOf(startToken);
      const end = src.lastIndexOf(endToken);
      if (start < 0 || end < start) return null;
      const sliced = src.slice(start, end + 1).trim();
      if (!sliced) return null;
      try {
        return JSON.parse(sliced);
      } catch {
        return null;
      }
    };
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error('Unexpected JSON payload');
      return parsed;
    } catch {
      const parsedArray = parseFromSlice(text, '[', ']');
      if (Array.isArray(parsedArray)) return parsedArray;
      const snippet = text.length > 240 ? `${text.slice(0, 240)}...` : text;
      throw new Error(`Invalid JSON response: ${snippet}`);
    }
  }

  async function listStorage(ip, port, signal) {
    return readJsonList(ip, port, 'LIST_STORAGE\n', signal);
  }

  async function listDir(ip, port, dirPath, signal) {
    return readJsonList(ip, port, `LIST_DIR ${dirPath}\n`, signal);
  }

  async function deletePath(ip, port, filePath, signal) {
    const response = await sendSimpleCommand(ip, port, `DELETE_ASYNC ${filePath}\n`, signal);
    if (!String(response || '').startsWith('OK')) throw new Error(`Delete failed: ${response}`);
    return true;
  }

  async function movePath(ip, port, src, dst, signal) {
    const response = await sendSimpleCommand(ip, port, `MOVE ${src}\t${dst}\n`, signal);
    if (!String(response || '').startsWith('OK')) throw new Error(`Move failed: ${response}`);
    return true;
  }

  async function createPath(ip, port, dirPath, signal) {
    const response = await sendSimpleCommand(ip, port, `CREATE_PATH ${dirPath}\n`, signal);
    if (!String(response || '').startsWith('SUCCESS')) throw new Error(`Create folder failed: ${response}`);
    return true;
  }

  async function chmod777(ip, port, filePath, signal) {
    const response = await sendSimpleCommand(ip, port, `CHMOD777 ${filePath}\n`, signal);
    if (!String(response || '').startsWith('OK')) throw new Error(`Chmod failed: ${response}`);
    return true;
  }

  async function getPayloadVersion(ip, port, signal) {
    const response = await sendSimpleCommand(ip, port, 'VERSION\n', signal);
    if (String(response || '').startsWith('VERSION ')) {
      return String(response).substring(8).trim();
    }
    throw new Error(`Unexpected response: ${response}`);
  }

  async function payloadReset(ip, port, signal) {
    const response = await sendSimpleCommand(ip, port, 'RESET\n', signal);
    if (!String(response || '').startsWith('OK')) throw new Error(`Payload reset failed: ${response}`);
    return String(response || '').trim();
  }

  async function payloadClearTmp(ip, port, signal) {
    const response = await sendSimpleCommand(ip, port, 'CLEAR_TMP\n', signal);
    if (!String(response || '').startsWith('OK')) throw new Error(`Clear tmp failed: ${response}`);
    return String(response || '').trim();
  }

  async function payloadMaintenance(ip, port, signal) {
    const response = await sendSimpleCommand(ip, port, 'MAINTENANCE\n', signal);
    const text = String(response || '').trim();
    if (text.startsWith('BUSY')) return text;
    if (!text.startsWith('OK')) throw new Error(`Maintenance failed: ${response}`);
    return text;
  }

  async function queueCancel(ip, port, id, signal) {
    const response = await sendSimpleCommand(ip, port, `QUEUE_CANCEL ${id}\n`, signal);
    if (!String(response || '').startsWith('OK')) throw new Error(`Queue cancel failed: ${response}`);
    return true;
  }

  async function queueClear(ip, port, signal) {
    const response = await sendSimpleCommand(ip, port, 'QUEUE_CLEAR\n', signal);
    if (!String(response || '').startsWith('OK')) throw new Error(`Queue clear failed: ${response}`);
    return true;
  }

  async function queueClearAll(ip, port, signal) {
    const response = await sendSimpleCommand(ip, port, 'QUEUE_CLEAR_ALL\n', signal);
    if (!String(response || '').startsWith('OK')) throw new Error(`Queue clear all failed: ${response}`);
    return true;
  }

  async function queueClearFailed(ip, port, signal) {
    const response = await sendSimpleCommand(ip, port, 'QUEUE_CLEAR_FAILED\n', signal);
    if (!String(response || '').startsWith('OK')) throw new Error(`Queue clear failed: ${response}`);
    return true;
  }

  async function queueReorder(ip, port, ids, signal) {
    const list = Array.isArray(ids) ? ids.join(',') : '';
    const response = await sendSimpleCommand(ip, port, `QUEUE_REORDER ${list}\n`, signal);
    if (!String(response || '').startsWith('OK')) throw new Error(`Queue reorder failed: ${response}`);
    return true;
  }

  async function queueProcess(ip, port, signal) {
    const response = await sendSimpleCommand(ip, port, 'QUEUE_PROCESS\n', signal);
    if (!String(response || '').startsWith('OK')) throw new Error(`Queue process failed: ${response}`);
    return true;
  }

  return {
    listStorage,
    listDir,
    deletePath,
    movePath,
    createPath,
    chmod777,
    getPayloadVersion,
    payloadReset,
    payloadClearTmp,
    payloadMaintenance,
    queueCancel,
    queueClear,
    queueClearAll,
    queueClearFailed,
    queueReorder,
    queueProcess,
  };
}

module.exports = {
  createPayloadFsApi,
};
