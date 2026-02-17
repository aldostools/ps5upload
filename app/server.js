'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { URL } = require('url');
const { getRuntimeConfig } = require('../shared/runtime-config');
const transferCore = require('../shared/transfer-core');
const sharedTransferConstants = require('../shared/transfer-constants');
const sharedPayloadCaps = require('../shared/payload-caps');
const sharedResumeHash = require('../shared/resume-hash');
const sharedPayloadRpc = require('../shared/payload-rpc');
const sharedPayloadQueueApi = require('../shared/payload-queue-api');
const sharedResumeScan = require('../shared/resume-scan');
const sharedPayloadUploadCore = require('../shared/payload-upload-core');
const sharedPayloadFsApi = require('../shared/payload-fs-api');
const sharedRemotePathUtils = require('../shared/remote-path-utils');
const sharedGameMeta = require('../shared/game-meta');
const sharedPayloadFileUtils = require('../shared/payload-file-utils');
const sharedClientRuntimeHelpers = require('../shared/client-runtime-helpers');
const sharedClientPersistence = require('../shared/client-persistence');
const sharedAsyncUtils = require('../shared/async-utils');
const sharedLocalFileScan = require('../shared/local-file-scan');
const sharedPayloadRemoteHelpers = require('../shared/payload-remote-helpers');
const sharedKeyedMutex = require('../shared/keyed-mutex');

function tryRequire(moduleName) {
  try {
    return require(moduleName);
  } catch {}
  try {
    return require(path.join(__dirname, '..', 'desktop', 'node_modules', moduleName));
  } catch {
    return null;
  }
}
const ftp = tryRequire('basic-ftp');
const undici = tryRequire('undici');
const hashWasm = tryRequire('hash-wasm');
const createDefaultPayloadCaps = sharedPayloadCaps.createDefaultPayloadCaps;
const normalizePayloadCaps = sharedPayloadCaps.normalizePayloadCaps;
const commandForRemoteHashAlgorithm = sharedResumeHash.commandForRemoteHashAlgorithm;
const chooseResumeHashAlgorithm = sharedResumeHash.chooseResumeHashAlgorithm;
const isRemoteDirEntry = sharedResumeScan.isRemoteDirEntry;
const escapeCommandPath = sharedRemotePathUtils.escapeCommandPath;
const joinRemotePath = sharedRemotePathUtils.joinRemotePath;
const joinRemoteScanPath = sharedRemotePathUtils.joinRemoteScanPath;
const normalizeRemoteScanSubpath = sharedRemotePathUtils.normalizeRemoteScanSubpath;
const getStorageRootFromPath = sharedRemotePathUtils.getStorageRootFromPath;
const buildTempRootForArchive = sharedRemotePathUtils.buildTempRootForArchive;
const getTitleFromParam = sharedGameMeta.getTitleFromParam;
const parseGameMetaFromParam = sharedGameMeta.parseGameMetaFromParam;
const payloadPathIsElf = sharedPayloadFileUtils.payloadPathIsElf;
const createLocalPayloadElfFinder = sharedPayloadFileUtils.createLocalPayloadElfFinder;
const probePayloadFile = sharedPayloadFileUtils.probePayloadFile;

const ROOT_DIR = path.join(__dirname, '..');
const VERSION_FILE = path.join(ROOT_DIR, 'VERSION');
const FAQ_FILE = path.join(ROOT_DIR, 'FAQ.md');
const DESKTOP_DIST_DIR = path.join(ROOT_DIR, 'desktop', 'dist');
const FALLBACK_PUBLIC_DIR = path.join(__dirname, 'public');
const BRIDGE_FILE = path.join(__dirname, 'web-bridge.js');
const TRANSFER_PORT = 9113;
const PAYLOAD_PORT = 9021;
const CONNECTION_TIMEOUT_MS = sharedTransferConstants.CONNECTION_TIMEOUT_MS;
const READ_TIMEOUT_MS = sharedTransferConstants.READ_TIMEOUT_MS;
const PAYLOAD_STATUS_CONNECT_TIMEOUT_MS = sharedTransferConstants.PAYLOAD_STATUS_CONNECT_TIMEOUT_MS;
const PAYLOAD_STATUS_READ_TIMEOUT_MS = sharedTransferConstants.PAYLOAD_STATUS_READ_TIMEOUT_MS;
const UPLOAD_SOCKET_BUFFER_SIZE = 8 * 1024 * 1024;
const UploadCmd = {
  StartUpload: 0x10,
  UploadChunk: 0x11,
  EndUpload: 0x12,
};
const UploadResp = {
  Ok: 0x01,
  Error: 0x02,
  Data: 0x03,
  Ready: 0x04,
  Progress: 0x05,
};
const LANE_CONNECTIONS = sharedTransferConstants.LANE_CONNECTIONS;
const LANE_HUGE_FILE_BYTES = sharedTransferConstants.LANE_HUGE_FILE_BYTES;
const LANE_LARGE_FILE_BYTES = sharedTransferConstants.LANE_LARGE_FILE_BYTES;
const LANE_HUGE_CHUNK_BYTES = sharedTransferConstants.LANE_HUGE_CHUNK_BYTES;
const LANE_LARGE_CHUNK_BYTES = sharedTransferConstants.LANE_LARGE_CHUNK_BYTES;
const LANE_DEFAULT_CHUNK_BYTES = sharedTransferConstants.LANE_DEFAULT_CHUNK_BYTES;
const LANE_MIN_FILE_SIZE = sharedTransferConstants.LANE_MIN_FILE_SIZE;
const MAD_MAX_WORKERS = sharedTransferConstants.MAD_MAX_WORKERS;
const MAD_MAX_HUGE_CHUNK_BYTES = sharedTransferConstants.MAD_MAX_HUGE_CHUNK_BYTES;
const MAD_MAX_LARGE_CHUNK_BYTES = sharedTransferConstants.MAD_MAX_LARGE_CHUNK_BYTES;
const MAD_MAX_DEFAULT_CHUNK_BYTES = sharedTransferConstants.MAD_MAX_DEFAULT_CHUNK_BYTES;
const MAD_MAX_MIN_FILE_SIZE = sharedTransferConstants.MAD_MAX_MIN_FILE_SIZE;
const RESUME_HASH_LARGE_BYTES = 1024 * 1024 * 1024;
const RESUME_HASH_MED_BYTES = 128 * 1024 * 1024;
const RESUME_HASH_REMOTE_PARALLELISM = 2;
const PRECREATE_MAX_DIRS = 5000;
const PRECREATE_DIR_CONCURRENCY = 4;
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

const payloadRpc = sharedPayloadRpc.createPayloadRpc({
  net,
  connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
  readTimeoutMs: READ_TIMEOUT_MS,
});
const payloadQueueApi = sharedPayloadQueueApi.createPayloadQueueApi({
  sendSimpleCommand: (ip, port, cmd) => payloadRpc.sendSimpleCommand(ip, port, cmd),
  sendCommandExpectPayload: (ip, port, cmd) => payloadRpc.sendCommandExpectPayload(ip, port, cmd),
  sendCommandWithPayload: (ip, port, header, payload) => payloadRpc.sendCommandWithPayload(ip, port, header, payload),
});
const payloadFsApi = sharedPayloadFsApi.createPayloadFsApi({
  sendSimpleCommand: (ip, port, cmd, signal) => payloadRpc.sendSimpleCommand(ip, port, cmd, signal),
  sendCommandReadAll: (ip, port, cmd, signal) => payloadRpc.sendCommandReadAll(ip, port, cmd, signal),
});
const clientRuntimeHelpers = sharedClientRuntimeHelpers.createClientRuntimeHelpers({
  payloadRpc,
  transferCore,
  transferConstants: sharedTransferConstants,
  hashWasm,
  uploadSocketBufferSize: UPLOAD_SOCKET_BUFFER_SIZE,
  connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
});
const createSocketWithTimeout = clientRuntimeHelpers.createSocketWithTimeout;
const tuneUploadSocket = clientRuntimeHelpers.tuneUploadSocket;
const createSocketLineReader = clientRuntimeHelpers.createSocketLineReader;
const createSocketReader = clientRuntimeHelpers.createSocketReader;
const buildUploadStartPayload = clientRuntimeHelpers.buildUploadStartPayload;
const isLocalHashAlgorithmSupported = clientRuntimeHelpers.isLocalHashAlgorithmSupported;
const getLaneChunkSize = clientRuntimeHelpers.getLaneChunkSize;
const getMadMaxChunkSize = clientRuntimeHelpers.getMadMaxChunkSize;
const classifyPayloadUploadBottleneck = clientRuntimeHelpers.classifyPayloadUploadBottleneck;
const findLocalPayloadElf = createLocalPayloadElfFinder({
  pathModule: path,
  baseDir: __dirname,
  includeParentPayload: true,
  payloadRelativePath: '../payload/ps5upload.elf',
  includeCwdPayload: true,
  includeCwdRoot: true,
});
const mapWithConcurrency = sharedAsyncUtils.mapWithConcurrency;
const localFileScan = sharedLocalFileScan.createLocalFileScan({ fs, path });
const walkLocalFiles = localFileScan.walkLocalFiles;
const remoteFileMutex = sharedKeyedMutex.createKeyedMutex();
const payloadRemoteHelpers = sharedPayloadRemoteHelpers.createPayloadRemoteHelpers({
  createSocketWithTimeout,
  sendSimpleCommand: (ip, port, cmd, signal) => payloadRpc.sendSimpleCommand(ip, port, cmd, signal),
  commandForRemoteHashAlgorithm,
  transferPort: TRANSFER_PORT,
});
const downloadRemoteFileToBuffer = payloadRemoteHelpers.downloadRemoteFileToBuffer;
const hashFileRemote = payloadRemoteHelpers.hashFileRemote;

function createTransferStatus(overrides = {}) {
  return {
    run_id: 0,
    status: 'Idle',
    sent: 0,
    total: 0,
    files: 0,
    elapsed_secs: 0,
    current_file: '',
    payload_speed_bps: 0,
    ftp_speed_bps: 0,
    total_speed_bps: 0,
    payload_transfer_path: null,
    payload_workers: null,
    ...overrides,
  };
}

function resetTransferSpeed(runtime) {
  runtime.transferSpeed = {
    last_at_ms: Date.now(),
    last_sent: 0,
    ema_bps: 0,
  };
}

function recordTransferSpeed(runtime, sent, channel) {
  if (!runtime || !runtime.transferStatus) return;
  if (!runtime.transferSpeed) resetTransferSpeed(runtime);
  const speed = runtime.transferSpeed;
  const now = Date.now();
  const dt = (now - Number(speed.last_at_ms || 0)) / 1000;
  const lastSent = Number(speed.last_sent || 0);
  const nextSent = Number(sent || 0);
  if (dt > 0 && nextSent >= lastSent) {
    const delta = nextSent - lastSent;
    const inst = delta > 0 ? delta / dt : 0;
    const alpha = 1 - Math.exp(-dt / 3);
    const prev = Number(speed.ema_bps || 0);
    speed.ema_bps = prev > 0 ? (prev + (inst - prev) * alpha) : inst;
    speed.last_at_ms = now;
    speed.last_sent = nextSent;
  }
  const ema = Number(speed.ema_bps || 0);
  runtime.transferStatus.total_speed_bps = ema;
  if (channel === 'ftp') {
    runtime.transferStatus.ftp_speed_bps = ema;
    runtime.transferStatus.payload_speed_bps = 0;
  } else {
    runtime.transferStatus.payload_speed_bps = ema;
    runtime.transferStatus.ftp_speed_bps = 0;
  }
}

const defaultConfig = {
  address: '192.168.0.100',
  storage: '/data',
  connections: 4,
  ftp_connections: 10,
  use_temp: false,
  auto_connect: false,
  theme: 'dark',
  compression: 'none',
  bandwidth_limit_mbps: 0,
  update_channel: 'stable',
  download_compression: 'none',
  chmod_after_upload: false,
  override_on_conflict: true,
  resume_mode: 'none',
  language: 'en',
  auto_tune_connections: true,
  auto_check_payload: false,
  payload_auto_reload: false,
  payload_reload_mode: 'current',
  payload_local_path: '',
  optimize_upload: false,
  rar_extract_mode: 'turbo',
  rar_temp: '',
  upload_mode: 'payload',
  ftp_port: 'auto',
  window_width: 1440,
  window_height: 960,
  window_x: -1,
  window_y: -1,
};

function readVersion() {
  try {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim();
  } catch {
    return 'dev';
  }
}

function getAppDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'ps5upload');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'ps5upload');
  }
  return path.join(home, '.local', 'share', 'ps5upload');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

const clientPersistence = sharedClientPersistence.createClientPersistence({
  fs,
  path,
  getAppDataDir,
  defaultConfig,
  configFilename: 'app-config.json',
  profilesFilename: 'ps5upload_profiles.json',
  queueFilename: 'ps5upload_queue.json',
  historyFilename: 'ps5upload_history.json',
  queueSaveMode: 'preserve',
  historySaveMode: 'preserve',
  historyInsertMode: 'prepend',
  historyLimit: 500,
});
const loadConfig = clientPersistence.loadConfig;
const saveConfig = clientPersistence.saveConfig;
const loadProfiles = clientPersistence.loadProfiles;
const saveProfiles = clientPersistence.saveProfiles;
const loadQueue = clientPersistence.loadQueue;
const saveQueue = clientPersistence.saveQueue;
const loadHistory = clientPersistence.loadHistory;
const saveHistory = clientPersistence.saveHistory;
const addHistoryRecord = clientPersistence.addHistoryRecord;
const clearHistory = clientPersistence.clearHistory;

function listNetworkInterfaces() {
  const interfaces = os.networkInterfaces();
  const out = [];

  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      out.push({
        name,
        family: entry.family,
        address: entry.address,
        cidr: entry.cidr,
      });
    }
  }

  return out;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function contentTypeFor(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

function safeJoin(baseDir, targetPath) {
  const decoded = decodeURIComponent(targetPath);
  const clean = decoded === '/' ? '/index.html' : decoded;
  const resolved = path.normalize(path.join(baseDir, clean));
  if (!resolved.startsWith(baseDir)) return null;
  return resolved;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function listHostRoots() {
  if (process.platform === 'win32') {
    const roots = [];
    for (let i = 67; i <= 90; i += 1) {
      const drivePath = `${String.fromCharCode(i)}:\\`;
      try {
        if (fs.existsSync(drivePath)) roots.push({ path: drivePath, label: drivePath });
      } catch {
        // ignore
      }
    }
    const home = os.homedir();
    if (home && !roots.find((item) => item.path === home)) {
      roots.unshift({ path: home, label: `Home (${home})` });
    }
    return roots;
  }
  const roots = [{ path: '/', label: '/' }];
  const home = os.homedir();
  if (home && home !== '/') roots.unshift({ path: home, label: `Home (${home})` });
  return roots;
}

async function listHostDirectory(inputPath) {
  const requested = (inputPath && String(inputPath).trim()) || os.homedir() || '/';
  let absolutePath = path.resolve(requested);
  let stat = null;
  try {
    stat = await fs.promises.stat(absolutePath);
  } catch (err) {
    const code = err && err.code ? String(err.code) : '';
    if (code !== 'ENOENT') throw err;
    let cursor = path.resolve(path.dirname(absolutePath));
    while (true) {
      try {
        const candidate = await fs.promises.stat(cursor);
        if (candidate.isDirectory()) {
          absolutePath = cursor;
          stat = candidate;
          break;
        }
      } catch {
        // keep walking up
      }
      const parent = path.dirname(cursor);
      if (!parent || parent === cursor) {
        throw err;
      }
      cursor = parent;
    }
  }
  // If caller passed a file path, browse its parent directory.
  if (!stat.isDirectory()) {
    absolutePath = path.dirname(absolutePath);
    stat = await fs.promises.stat(absolutePath);
    if (!stat.isDirectory()) throw new Error('Path is not a directory');
  }
  const dirents = await fs.promises.readdir(absolutePath, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (dirent) => {
      const entryPath = path.join(absolutePath, dirent.name);
      let size = null;
      let mtime = null;
      let childCount = null;
      try {
        const st = await fs.promises.stat(entryPath);
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
        // ignore
      }
      if (dirent.isDirectory()) {
        try {
          const children = await fs.promises.readdir(entryPath);
          childCount = children.length;
        } catch {
          // ignore
        }
      }
      return {
        name: dirent.name,
        path: entryPath,
        type: dirent.isDirectory() ? 'dir' : dirent.isFile() ? 'file' : 'other',
        size,
        mtime,
        child_count: childCount,
      };
    })
  );
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const parent = path.dirname(absolutePath);
  return {
    path: absolutePath,
    parent: parent && parent !== absolutePath ? parent : null,
    entries,
  };
}

function checkPort(ip, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;

    const finish = (state, error) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ reachable: state, error: error || null });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, null));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (err) => finish(false, err && err.message ? err.message : 'error'));
    socket.connect(port, ip);
  });
}

async function isPortOpen(ip, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(2000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
    socket.connect(port, ip);
  });
}

async function readBinaryResponse(reader, timeoutMs = READ_TIMEOUT_MS) {
  return transferCore.readBinaryResponse(reader, timeoutMs);
}

async function writeBinaryCommand(socket, cmd, payload, timeoutMs) {
  return transferCore.writeBinaryCommand(socket, cmd, payload, timeoutMs);
}

function writeAll(socket, buffer, timeoutMs) {
  return transferCore.writeAll(socket, buffer, timeoutMs);
}

async function sendSimpleCommand(ip, port, cmd) {
  return payloadRpc.sendSimpleCommand(ip, port, cmd);
}

async function sendCommandWithPayload(ip, port, header, payload) {
  return payloadRpc.sendCommandWithPayload(ip, port, header, payload);
}

async function sendCommandExpectPayload(ip, port, cmd) {
  return payloadRpc.sendCommandExpectPayload(ip, port, cmd);
}

async function listStorage(ip, port) {
  return payloadFsApi.listStorage(ip, port);
}

async function listDir(ip, port, dirPath) {
  return payloadFsApi.listDir(ip, port, dirPath);
}

function guessImageMime(filePath) {
  const lower = String(filePath || '').toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

function bufferToDataUrl(buffer, filePath) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return null;
  const mime = guessImageMime(filePath);
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function listDirRecursiveCompat(ip, dirPath) {
  return sharedResumeScan.listDirRecursiveCompat({
    listDir,
    ip,
    port: TRANSFER_PORT,
    dirPath,
  });
}

async function runProgressCommand(ip, command, onProgressLine) {
  const socket = await createSocketWithTimeout(ip, TRANSFER_PORT);
  socket.setTimeout(0);
  return new Promise((resolve, reject) => {
    let lineBuffer = '';
    let settled = false;
    const cleanup = (err) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
      else resolve(true);
    };
    socket.on('data', (chunk) => {
      lineBuffer += chunk.toString('utf8');
      let idx;
      while ((idx = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, idx).trim();
        lineBuffer = lineBuffer.slice(idx + 1);
        if (!line) continue;
        if (line.startsWith('OK')) {
          cleanup();
          return;
        }
        if (line.startsWith('ERROR')) {
          cleanup(new Error(line));
          return;
        }
        if (typeof onProgressLine === 'function') onProgressLine(line);
      }
    });
    socket.on('error', (err) => cleanup(err));
    socket.on('close', () => {
      if (!settled) cleanup(new Error('Connection closed unexpectedly'));
    });
    socket.write(command);
  });
}

async function downloadSingleFile(ip, remotePath, localPath, options = {}) {
  const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : null;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const socket = await createSocketWithTimeout(ip, TRANSFER_PORT);
  socket.setTimeout(0);
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  const fileStream = fs.createWriteStream(localPath, { flags: 'w' });
  return new Promise((resolve, reject) => {
    let headerBuf = Buffer.alloc(0);
    let headerDone = false;
    let totalSize = 0;
    let received = 0;
    let settled = false;

    const cleanup = (err) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      fileStream.end(() => {
        socket.destroy();
        if (err) {
          try {
            fs.unlinkSync(localPath);
          } catch {
            // ignore cleanup errors
          }
          reject(err);
        }
        else resolve(received);
      });
    };

    socket.on('data', (chunk) => {
      if (shouldCancel && shouldCancel()) {
        cleanup(new Error('Download cancelled'));
        return;
      }
      if (!headerDone) {
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const idx = headerBuf.indexOf('\n');
        if (idx === -1) return;
        const line = headerBuf.slice(0, idx).toString('utf8').trim();
        const remainder = headerBuf.slice(idx + 1);
        headerBuf = Buffer.alloc(0);
        if (line.startsWith('ERROR')) {
          cleanup(new Error(line));
          return;
        }
        const match = line.match(/^(?:READY|OK)\s+(\d+)/i);
        if (!match) {
          cleanup(new Error(`Unexpected response: ${line}`));
          return;
        }
        totalSize = Number.parseInt(match[1], 10) || 0;
        headerDone = true;
        if (remainder.length > 0) {
          received += remainder.length;
          fileStream.write(remainder);
        }
      } else {
        received += chunk.length;
        fileStream.write(chunk);
      }
      if (headerDone && received >= totalSize) {
        cleanup();
      }
      if (onProgress) onProgress(received, totalSize);
    });

    socket.on('error', (err) => cleanup(err));
    socket.on('close', () => {
      if (!settled && headerDone && received >= totalSize) cleanup();
      else if (!settled) cleanup(new Error(`Download incomplete: ${received}/${totalSize}`));
    });
    socket.write(`DOWNLOAD_RAW ${remotePath}\n`);
  });
}

async function findFtpPort(ip, preferred = 'auto') {
  const candidates = preferred === 2121 || preferred === '2121' ? [2121, 1337] : preferred === 1337 || preferred === '1337' ? [1337, 2121] : [1337, 2121];
  for (const port of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortOpen(ip, port)) return port;
  }
  return null;
}

async function collectLocalFiles(basePath, options = {}) {
  const entries = [];
  let total = 0;
  await walkLocalFiles(basePath, {
    onFile: (item) => {
      entries.push(item);
      total += Number(item && item.size) || 0;
      if (typeof options.onFile === 'function') options.onFile(item);
    },
    shouldCancel: options.shouldCancel,
  });
  return { files: entries, total };
}

async function createHashWasmHasher(algorithm) {
  if (!hashWasm) {
    throw new Error('hash-wasm not available');
  }
  if (algorithm === 'blake3') {
    if (typeof hashWasm.createBLAKE3 !== 'function') {
      throw new Error('BLAKE3 not available');
    }
    return hashWasm.createBLAKE3();
  }
  if (algorithm === 'xxh64') {
    if (typeof hashWasm.createXXHash64 !== 'function') {
      throw new Error('XXH64 not available');
    }
    return hashWasm.createXXHash64();
  }
  throw new Error(`Unsupported hash algorithm: ${algorithm}`);
}

async function hashFileLocal(filePath, algorithm = 'sha256') {
  const algo = String(algorithm || 'sha256').toLowerCase();
  if (algo === 'sha256') {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolve(hash.digest('hex')));
    });
  }
  const hasher = await createHashWasmHasher(algo);
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

async function precreateRemoteDirectories(ip, destRoot, files, options = {}) {
  const log = typeof options.log === 'function' ? options.log : null;
  const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : null;
  if (!Array.isArray(files) || files.length === 0) return { total: 0, created: 0, skipped: 0 };

  const dirSet = new Set();
  for (const file of files) {
    const rel = String(file && file.rel_path ? file.rel_path : '').replace(/\\/g, '/');
    if (!rel) continue;
    const dir = path.posix.dirname(rel);
    if (!dir || dir === '.') continue;
    dirSet.add(dir);
  }
  const dirs = Array.from(dirSet).sort((a, b) => a.length - b.length);
  if (dirs.length === 0) return { total: 0, created: 0, skipped: 0 };
  if (dirs.length > PRECREATE_MAX_DIRS) {
    if (log) log(`Pre-create: skipping ${dirs.length} directories (exceeds ${PRECREATE_MAX_DIRS}).`);
    return { total: dirs.length, created: 0, skipped: dirs.length };
  }

  const total = dirs.length;
  const logInterval = Math.max(1, Math.floor(total / 10));
  let created = 0;
  let failed = 0;

  const queue = [...dirs];
  const runWorker = async () => {
    while (queue.length > 0) {
      if (shouldCancel && shouldCancel()) throw new Error('Transfer cancelled');
      const dir = queue.shift();
      if (!dir) continue;
      const remoteDir = joinRemotePath(destRoot, dir);
      try {
        await createPath(ip, TRANSFER_PORT, remoteDir);
        created += 1;
      } catch {
        failed += 1;
      }
      const done = created + failed;
      if (log && (done % logInterval === 0 || done === total)) {
        log(`Pre-create: ${done}/${total} directories processed.`);
      }
    }
  };

  const workers = Array.from({ length: PRECREATE_DIR_CONCURRENCY }, () => runWorker());
  await Promise.all(workers);
  if (log) {
    if (failed > 0) {
      log(`Pre-create: done (${created} created, ${failed} failed).`);
    } else {
      log(`Pre-create: done (${created} created).`);
    }
  }
  return { total, created, skipped: failed };
}

const payloadUploadCore = sharedPayloadUploadCore.createPayloadUploadCore({
  createSocketWithTimeout,
  tuneUploadSocket,
  readBinaryResponse,
  writeBinaryCommand,
  writeAll,
  buildUploadStartPayload,
  joinRemotePath,
  getLaneChunkSize,
  transferPort: TRANSFER_PORT,
  readTimeoutMs: READ_TIMEOUT_MS,
  laneMinFileSize: LANE_MIN_FILE_SIZE,
  laneConnections: LANE_CONNECTIONS,
  uploadCmd: UploadCmd,
  uploadResp: UploadResp,
  fs,
  writeTimeoutMs: 300000,
});

async function uploadFastOneFile(ip, destRoot, file, options = {}) {
  return payloadUploadCore.uploadFastOneFile(ip, destRoot, file, {
    ...options,
    createSocketReader,
    chmodAfterUploadFn: async (remotePath) => chmod777(ip, TRANSFER_PORT, remotePath),
  });
}

async function uploadFastMultiFile(ip, destRoot, files, options = {}) {
  return payloadUploadCore.uploadFastMultiFile(ip, destRoot, files, {
    ...options,
    createSocketReader,
    acquireRemoteLock: async (remotePath) => remoteFileMutex.acquire(remotePath),
    noProgressTimeoutMs: 45000,
    retryAttempts: 1,
    retryDelayMs: 300,
    chmodAfterUploadFn: async (remotePath) => chmod777(ip, TRANSFER_PORT, remotePath),
  });
}

async function uploadLaneSingleFile(ip, destRoot, file, options = {}) {
  let attempt = 0;
  const maxAttempts = 2;
  while (true) {
    try {
      return await payloadUploadCore.uploadLaneSingleFile(ip, destRoot, file, {
        ...options,
        createSocketReader,
        noProgressTimeoutMs: 45000,
        chmodAfterUploadFn: async (remotePath) => chmod777(ip, TRANSFER_PORT, remotePath),
      });
    } catch (err) {
      attempt += 1;
      const message = String((err && err.message) || err || '').toLowerCase();
      const retryable =
        message.includes('timeout') ||
        message.includes('timed out') ||
        message.includes('stalled') ||
        message.includes('econnreset') ||
        message.includes('epipe');
      if (!retryable || attempt >= maxAttempts) {
        throw err;
      }
      await sleepMs(250 * attempt);
    }
  }
}

async function uploadFilesViaFtpSimple(ip, ftpPort, destRoot, files, options = {}) {
  if (!ftp) throw new Error('FTP library unavailable. Install app dependencies.');
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const onFileStart = typeof options.onFileStart === 'function' ? options.onFileStart : null;
  const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : null;
  const connections = Math.max(1, Math.min(10, Number(options.connections) || 1));
  const queue = Array.isArray(files) ? [...files] : [];
  let sent = 0;
  let filesUploaded = 0;
  const takeNextFile = () => queue.shift() || null;
  const ensureFtpBinaryMode = async (client) => {
    const res = await client.send('TYPE I');
    if (!res || Number(res.code) >= 400) {
      const code = res && Number.isFinite(Number(res.code)) ? Number(res.code) : -1;
      throw new Error(`Failed to enable FTP binary mode (TYPE I, code=${code})`);
    }
  };
  const runWorker = async () => {
    const client = new ftp.Client(30000);
    client.ftp.verbose = false;
    client.trackProgress((info) => {
      const bytesOverall = Number(info && info.bytesOverall);
      if (Number.isFinite(bytesOverall) && bytesOverall >= sent) {
        sent = bytesOverall;
      }
      if (onProgress) onProgress(sent, null);
    });
    try {
      await client.access({ host: ip, port: ftpPort, user: 'anonymous', password: 'anonymous', secure: false });
      // Some PS5 FTP servers don't support PASS after USER, so retry with USER-only auth.
    } catch (err) {
      const message = err && err.message ? String(err.message) : '';
      if (!message.includes('PASS')) throw err;
      try {
        client.close();
      } catch {}
      await client.connect(ip, ftpPort);
      const res = await client.send('USER anonymous');
      if (res && Number(res.code) === 331) {
        await client.send('PASS anonymous');
      }
    }
    await ensureFtpBinaryMode(client);

    try {
      while (true) {
        if (shouldCancel && shouldCancel()) throw new Error('Transfer cancelled');
        const file = takeNextFile();
        if (!file) break;
        const remotePath = `${destRoot.replace(/\/+$/, '')}/${String(file.rel_path || '').replace(/\\/g, '/')}`;
        const remoteDir = path.posix.dirname(remotePath);
        if (onFileStart) onFileStart(file);
        const releaseRemote = await remoteFileMutex.acquire(remotePath);
        try {
          // eslint-disable-next-line no-await-in-loop
          await client.ensureDir(remoteDir);
          // eslint-disable-next-line no-await-in-loop
          await client.uploadFrom(file.abs_path, remotePath);
        } finally {
          releaseRemote();
        }
        filesUploaded += 1;
        if (onProgress) onProgress(sent, file);
      }
    } finally {
      client.trackProgress();
      client.close();
    }
  };

  try {
    const workers = Array.from({ length: connections }, () => runWorker());
    await Promise.all(workers);
  } catch (err) {
    throw err;
  }
  return { bytes: sent, files: filesUploaded };
}

async function uploadRarForExtractionViaPayload(ip, rarPath, destPath, opts = {}) {
  const shouldCancel = typeof opts.shouldCancel === 'function' ? opts.shouldCancel : null;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : null;
  const overrideOnConflict = opts.overrideOnConflict == null ? true : Boolean(opts.overrideOnConflict);
  const tempRoot = typeof opts.tempRoot === 'string' ? opts.tempRoot.trim() : '';

  const st = await fs.promises.stat(rarPath);
  if (!st.isFile()) throw new Error('RAR source must be a file');
  const fileSize = st.size;
  if (!Number.isSafeInteger(fileSize)) {
    throw new Error(`RAR file too large for safe integer math: ${fileSize}`);
  }

  if (!isSafeRemotePath(destPath)) throw new Error('Invalid destination path');
  if (tempRoot && (!isSafeRemotePath(tempRoot) || /\s/.test(tempRoot))) {
    throw new Error('Temp storage path must be an absolute /data or /mnt path and must not contain spaces.');
  }

  if (!overrideOnConflict) {
    const exists = await sendSimpleCommand(ip, TRANSFER_PORT, `CHECK_DIR ${destPath}\n`);
    if (exists === 'EXISTS') throw new Error('Destination already exists');
  } else {
    // Ensure destination root exists for extraction. (NOOVERWRITE mode relies on the check above instead.)
    await createPath(ip, TRANSFER_PORT, destPath);
  }

  const tempRootPath = buildTempRootForArchive(destPath, tempRoot);
  if (/\s/.test(tempRootPath)) {
    throw new Error('Temp storage path must not contain spaces.');
  }
  const tmpToken = tempRootPath ? ` TMP=${tempRootPath}` : '';
  const flag = overrideOnConflict ? '' : ' NOOVERWRITE';

  const socket = await createSocketWithTimeout(ip, TRANSFER_PORT);
  tuneUploadSocket(socket);
  const reader = createSocketLineReader(socket);
  try {
    if (onLog) onLog('Using payload UPLOAD_RAR fast path (single stream).');
    socket.write(`UPLOAD_RAR_TURBO ${escapeCommandPath(destPath)} ${fileSize}${tmpToken}${flag}\n`);

    const response = await reader.readLine(READ_TIMEOUT_MS);
    if (response !== 'READY') {
      throw new Error(`Server rejected RAR upload: ${response || '(no response)'}`);
    }

    const fd = await fs.promises.open(rarPath, 'r');
    try {
      const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
      let remaining = fileSize;
      let pos = 0;
      let sent = 0;
      let lastProgressAt = 0;
      while (remaining > 0) {
        if (shouldCancel && shouldCancel()) throw new Error('Transfer cancelled');
        const take = Math.min(buf.length, remaining);
        const { bytesRead } = await fd.read(buf, 0, take, pos);
        if (bytesRead <= 0) throw new Error('Read failed');
        await writeAll(socket, buf.subarray(0, bytesRead));
        remaining -= bytesRead;
        pos += bytesRead;
        sent += bytesRead;
        if (onProgress) {
          const now = Date.now();
          if (now - lastProgressAt >= 250 || remaining === 0) {
            lastProgressAt = now;
            onProgress(sent);
          }
        }
      }
    } finally {
      await fd.close().catch(() => {});
    }

    const finalLine = await reader.readLine(10 * 60 * 1000);
    if (finalLine.startsWith('QUEUED ')) {
      const id = parseInt(finalLine.substring('QUEUED '.length), 10) || 0;
      if (onLog) onLog(`Extraction queued (ID ${id}).`);
      return { queuedId: id, fileSize };
    }
    if (finalLine.startsWith('ERROR')) {
      throw new Error(finalLine);
    }
    throw new Error(`Unexpected RAR response: ${finalLine || '(no response)'}`);
  } finally {
    try { socket.destroy(); } catch {}
  }
}

async function uploadLocalPathsViaFtpSimple(ip, ftpPort, destRoot, paths, options = {}) {
  const shouldCancel = typeof options.shouldCancel === 'function' ? options.shouldCancel : null;
  const flattened = [];
  for (const sourcePath of paths) {
    if (shouldCancel && shouldCancel()) throw new Error('Transfer cancelled');
    // eslint-disable-next-line no-await-in-loop
    const sourceStat = await fs.promises.stat(sourcePath);
    if (sourceStat.isFile()) {
      flattened.push({
        abs_path: sourcePath,
        rel_path: path.basename(sourcePath),
        size: sourceStat.size,
      });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await walkLocalFiles(sourcePath, {
      shouldCancel,
      onFile: (file) => flattened.push(file),
    });
  }

  return uploadFilesViaFtpSimple(ip, ftpPort, destRoot, flattened, options);
}

async function deletePath(ip, port, filePath) {
  return payloadFsApi.deletePath(ip, port, filePath);
}

async function movePath(ip, port, src, dst) {
  return payloadFsApi.movePath(ip, port, src, dst);
}

async function createPath(ip, port, dirPath) {
  return payloadFsApi.createPath(ip, port, dirPath);
}

async function chmod777(ip, port, filePath) {
  return payloadFsApi.chmod777(ip, port, filePath);
}

async function getPayloadVersion(ip, port) {
  return payloadFsApi.getPayloadVersion(ip, port);
}

async function getPayloadStatus(ip, port) {
  const socket = await createSocketWithTimeout(ip, port, PAYLOAD_STATUS_CONNECT_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    let headerParsed = false;
    let jsonSize = 0;

    socket.setTimeout(PAYLOAD_STATUS_READ_TIMEOUT_MS);
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('Read timed out'));
    });

    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);

      if (!headerParsed) {
        const str = data.toString('utf8');
        const newlineIdx = str.indexOf('\n');
        if (newlineIdx === -1) return;
        const header = str.substring(0, newlineIdx).trim();
        if (header.startsWith('ERROR')) {
          socket.destroy();
          reject(new Error(`Payload status error: ${header}`));
          return;
        }
        if (!header.startsWith('STATUS ')) {
          socket.destroy();
          reject(new Error(`Unexpected response: ${header}`));
          return;
        }
        jsonSize = Number.parseInt(header.substring(7).trim(), 10);
        headerParsed = true;
        data = data.slice(newlineIdx + 1);
      }

      if (headerParsed && data.length >= jsonSize) {
        socket.destroy();
        try {
          const jsonBuf = data.slice(0, jsonSize);
          resolve(JSON.parse(jsonBuf.toString('utf8')));
        } catch {
          reject(new Error('Invalid JSON response'));
        }
      }
    });

    socket.on('error', (err) => reject(err));
    socket.write('PAYLOAD_STATUS\n');
  });
}

async function getPayloadCaps(ip, port) {
  let version = null;
  let versionErr = null;
  try {
    version = await getPayloadVersion(ip, port);
  } catch (err) {
    versionErr = err;
  }

  try {
    const raw = await sendCommandExpectPayload(ip, port, 'CAPS\n');
    const parsed = JSON.parse(raw);
    return normalizePayloadCaps(parsed, version);
  } catch (err) {
    if (versionErr) {
      throw versionErr;
    }
    const fallback = createDefaultPayloadCaps(version);
    fallback.source = 'compat-defaults';
    fallback.notes = [];
    fallback.updated_at_ms = Date.now();
    return fallback;
  }
}

function isSafeRemotePath(p) {
  const value = String(p || '').replace(/\\/g, '/');
  if (!value.startsWith('/')) return false;
  if (value.includes('..')) return false;
  if (value.startsWith('/data') || value.startsWith('/mnt/')) return true;
  return false;
}

async function payloadReset(ip, port) {
  await payloadFsApi.payloadReset(ip, port);
  return true;
}

async function payloadClearTmp(ip, port) {
  await payloadFsApi.payloadClearTmp(ip, port);
  return true;
}

async function payloadMaintenance(ip, port) {
  const response = await payloadFsApi.payloadMaintenance(ip, port);
  if (!response.startsWith('OK')) throw new Error(`Maintenance failed: ${response}`);
  return true;
}

async function queueExtract(ip, port, src, dst, opts = {}) {
  return payloadQueueApi.queueExtract(ip, port, src, dst, opts);
}

async function queueCancel(ip, port, id) {
  return payloadFsApi.queueCancel(ip, port, id);
}

async function queueClear(ip, port) {
  return payloadFsApi.queueClear(ip, port);
}

async function queueClearAll(ip, port) {
  return payloadFsApi.queueClearAll(ip, port);
}

async function queueClearFailed(ip, port) {
  return payloadFsApi.queueClearFailed(ip, port);
}

async function queueReorder(ip, port, ids) {
  return payloadFsApi.queueReorder(ip, port, ids);
}

async function queueProcess(ip, port) {
  return payloadFsApi.queueProcess(ip, port);
}

async function queuePause(ip, port, id) {
  return payloadQueueApi.queuePause(ip, port, id);
}

async function queueRetry(ip, port, id) {
  return payloadQueueApi.queueRetry(ip, port, id);
}

async function queueRemove(ip, port, id) {
  return payloadQueueApi.queueRemove(ip, port, id);
}

async function syncInfo(ip, port) {
  return payloadQueueApi.syncInfo(ip, port);
}

async function uploadQueueGet(ip, port) {
  return payloadQueueApi.uploadQueueGet(ip, port);
}

async function uploadQueueSync(ip, port, payload) {
  return payloadQueueApi.uploadQueueSync(ip, port, payload);
}

async function historyGet(ip, port) {
  return payloadQueueApi.historyGet(ip, port);
}

async function historySync(ip, port, payload) {
  return payloadQueueApi.historySync(ip, port, payload);
}

async function sendPayloadFile(ip, filepath) {
  if (!payloadPathIsElf(filepath)) throw new Error('Payload must be a .elf or .bin file.');
  const fileContent = fs.readFileSync(filepath);
  const socket = await createSocketWithTimeout(ip, PAYLOAD_PORT);
  return new Promise((resolve, reject) => {
    socket.on('error', (err) => {
      reject(err);
      socket.destroy();
    });
    socket.write(fileContent, (err) => {
      if (err) {
        reject(err);
        socket.destroy();
        return;
      }
      resolve(fileContent.length);
      socket.end();
    });
  });
}

async function waitForPayloadStartup(ip, expectedVersion = null, timeoutMs = 15000, pollMs = 500) {
  const startedAt = Date.now();
  let lastErr = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const version = await getPayloadVersion(ip, TRANSFER_PORT);
      if (!expectedVersion || String(version) === String(expectedVersion)) {
        return { ok: true, version };
      }
      return { ok: false, version, error: `Running ${version}, expected ${expectedVersion}` };
    } catch (err) {
      lastErr = err;
    }
    // eslint-disable-next-line no-await-in-loop
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, Math.max(100, Number(pollMs) || 500)));
  }
  return { ok: false, version: null, error: `Payload did not start in ${Math.round(timeoutMs / 1000)}s: ${lastErr && lastErr.message ? lastErr.message : String(lastErr || 'timeout')}` };
}

function compareVersions(a, b) {
  const ma = String(a || '').match(VERSION_RE);
  const mb = String(b || '').match(VERSION_RE);
  if (!ma || !mb) return 0;
  for (let i = 1; i <= 3; i += 1) {
    const da = Number.parseInt(ma[i], 10);
    const db = Number.parseInt(mb[i], 10);
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function httpsJson(url) {
  if (undici && typeof undici.request === 'function') {
    return (async () => {
      const { statusCode, body } = await undici.request(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'ps5upload-app',
          Accept: 'application/vnd.github+json',
        },
        headersTimeout: 20000,
        bodyTimeout: 20000,
      });
      if (statusCode >= 400) throw new Error(`HTTP ${statusCode}`);
      return body.json();
    })();
  }
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'ps5upload-app',
          Accept: 'application/vnd.github+json',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk.toString('utf8');
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error('Invalid JSON response'));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(20000, () => {
      req.destroy(new Error('Request timeout'));
    });
  });
}

async function fetchLatestRelease(includePrerelease) {
  if (!includePrerelease) {
    return httpsJson('https://api.github.com/repos/phantomptr/ps5upload/releases/latest');
  }
  const releases = await httpsJson('https://api.github.com/repos/phantomptr/ps5upload/releases');
  if (!Array.isArray(releases) || releases.length === 0) throw new Error('No releases found');
  return releases[0];
}

async function fetchReleaseByTag(tag) {
  return httpsJson(`https://api.github.com/repos/phantomptr/ps5upload/releases/tags/${encodeURIComponent(tag)}`);
}

async function fetchRepoReleases(owner, repo) {
  const safeOwner = String(owner || '').trim();
  const safeRepo = String(repo || '').trim();
  if (!safeOwner || !safeRepo) throw new Error('Invalid repository');
  const releases = await httpsJson(
    `https://api.github.com/repos/${encodeURIComponent(safeOwner)}/${encodeURIComponent(safeRepo)}/releases?per_page=100`
  );
  if (!Array.isArray(releases)) return [];
  return releases.map((release) => ({
    tag_name: release && release.tag_name ? String(release.tag_name) : '',
    html_url:
      release && release.html_url
        ? String(release.html_url)
        : `https://github.com/${safeOwner}/${safeRepo}/releases`,
    prerelease: Boolean(release && release.prerelease),
    published_at: release && release.published_at ? String(release.published_at) : null,
    assets: Array.isArray(release && release.assets)
      ? release.assets
          .map((asset) => ({
            name: asset && asset.name ? String(asset.name) : '',
            browser_download_url:
              asset && asset.browser_download_url ? String(asset.browser_download_url) : '',
            size: Number(asset && asset.size ? asset.size : 0),
          }))
          .filter((asset) => asset.name && asset.browser_download_url)
      : [],
  }));
}

function downloadAsset(url, outputPath, opts) {
  if (undici && typeof undici.request === 'function') {
    return (async () => {
      const file = fs.createWriteStream(outputPath);
      const meta =
        opts && typeof opts === 'object' && !Array.isArray(opts)
          ? {
              runtime: opts.runtime,
              label: typeof opts.label === 'string' ? opts.label : '',
              source_id: typeof opts.source_id === 'string' ? opts.source_id : null,
            }
          : { runtime: null, label: '', source_id: null };
      const startedAt = Date.now();
      let received = 0;
      let total = 0;
      let lastAt = startedAt;
      let lastBytes = 0;
      let ema = 0;
      let lastEmitAt = 0;
      const updateRuntime = (done, error) => {
        if (!meta.runtime) return;
        const now = Date.now();
        if (!done && now - lastEmitAt < 250) return;
        lastEmitAt = now;
        meta.runtime.payloadDownloadProgress = {
          label: meta.label || null,
          source_id: meta.source_id,
          received_bytes: received,
          total_bytes: total || null,
          speed_bps: ema || 0,
          elapsed_ms: now - startedAt,
          done: !!done,
          error: error || null,
          updated_at_ms: now,
        };
      };
      const tick = () => {
        const now = Date.now();
        const dt = (now - lastAt) / 1000;
        if (dt <= 0) return;
        const delta = received - lastBytes;
        const inst = delta > 0 ? delta / dt : 0;
        const alpha = 1 - Math.exp(-dt / 3);
        ema = ema > 0 ? ema + (inst - ema) * alpha : inst;
        lastAt = now;
        lastBytes = received;
      };

      updateRuntime(false, null);
      const { statusCode, headers, body } = await undici.request(url, {
        method: 'GET',
        headers: { 'User-Agent': 'ps5upload-app' },
        headersTimeout: 30000,
        bodyTimeout: 0,
      });
      if (statusCode >= 400) {
        throw new Error(`HTTP ${statusCode}`);
      }
      const contentLength = Number(headers && headers['content-length'] ? headers['content-length'] : 0);
      total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;

      await new Promise((resolve, reject) => {
        const onErr = (err) => {
          try { file.destroy(); } catch {}
          reject(err);
        };
        file.on('error', onErr);
        body.on('data', (chunk) => {
          received += chunk.length;
          tick();
          updateRuntime(false, null);
        });
        body.on('error', onErr);
        body.pipe(file);
        file.on('finish', resolve);
      });
      tick();
      updateRuntime(true, null);
      return true;
    })();
  }
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    const meta =
      opts && typeof opts === 'object' && !Array.isArray(opts)
        ? {
            runtime: opts.runtime,
            label: typeof opts.label === 'string' ? opts.label : '',
            source_id: typeof opts.source_id === 'string' ? opts.source_id : null,
          }
        : { runtime: null, label: '', source_id: null };
    const startedAt = Date.now();
    let received = 0;
    let total = 0;
    let lastAt = startedAt;
    let lastBytes = 0;
    let ema = 0;
    let lastEmitAt = 0;

    const updateRuntime = (done, error) => {
      if (!meta.runtime) return;
      const now = Date.now();
      if (!done && now - lastEmitAt < 250) return;
      lastEmitAt = now;
      meta.runtime.payloadDownloadProgress = {
        label: meta.label || null,
        source_id: meta.source_id,
        received_bytes: received,
        total_bytes: total || null,
        speed_bps: ema || 0,
        elapsed_ms: now - startedAt,
        done: Boolean(done),
        error: error ? String(error) : null,
        updated_at_ms: now,
      };
    };

    if (meta.runtime) {
      meta.runtime.payloadDownloadProgress = {
        label: meta.label || null,
        source_id: meta.source_id,
        received_bytes: 0,
        total_bytes: null,
        speed_bps: 0,
        elapsed_ms: 0,
        done: false,
        error: null,
        updated_at_ms: Date.now(),
      };
    }

    const req = https.get(url, { headers: { 'User-Agent': 'ps5upload-app' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(outputPath);
        downloadAsset(res.headers.location, outputPath, opts).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        file.close();
        const err = new Error(`Download failed: HTTP ${res.statusCode}`);
        updateRuntime(true, err.message);
        fs.unlink(outputPath, () => reject(err));
        return;
      }
      total = Number.parseInt(String(res.headers['content-length'] || '0'), 10) || 0;
      updateRuntime(false, null);
      res.on('data', (chunk) => {
        if (!chunk) return;
        received += chunk.length || 0;
        const now = Date.now();
        const dt = now - lastAt;
        if (dt >= 250) {
          const delta = received - lastBytes;
          const inst = dt > 0 ? (delta * 1000) / dt : 0;
          ema = ema > 0 ? ema * 0.8 + inst * 0.2 : inst;
          lastAt = now;
          lastBytes = received;
          updateRuntime(false, null);
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        updateRuntime(true, null);
        file.close(() => resolve(outputPath));
      });
    });
    req.on('error', (err) => {
      file.close();
      updateRuntime(true, err && err.message ? err.message : String(err));
      fs.unlink(outputPath, () => reject(err));
    });
    req.setTimeout(30000, () => {
      req.destroy(new Error('Download timeout'));
    });
  });
}

function commandExists(command) {
  if (process.platform === 'win32') {
    const probe = spawnSync('where', [command], { stdio: 'ignore' });
    return probe.status === 0;
  }
  const probe = spawnSync('sh', ['-lc', `command -v ${command}`], { stdio: 'ignore' });
  return probe.status === 0;
}

function buildKeepAwakeCommand() {
  if (process.platform === 'darwin' && commandExists('caffeinate')) {
    return {
      method: 'caffeinate',
      command: 'caffeinate',
      args: ['-dimsu'],
    };
  }

  if (process.platform === 'linux' && commandExists('systemd-inhibit')) {
    return {
      method: 'systemd-inhibit',
      command: 'systemd-inhibit',
      args: [
        '--what=sleep',
        '--who=ps5upload-app',
        '--why=PS5Upload transfer in progress',
        '--mode=block',
        'bash',
        '-lc',
        'while true; do sleep 3600; done',
      ],
    };
  }

  if (process.platform === 'win32' && commandExists('powershell')) {
    return {
      method: 'powershell',
      command: 'powershell',
      args: [
        '-NoProfile',
        '-Command',
        "$sig='[DllImport(\"kernel32.dll\")]public static extern uint SetThreadExecutionState(uint esFlags);';" +
          "$type=Add-Type -MemberDefinition $sig -Name ES -Namespace Win32 -PassThru;" +
          'while($true){$type::SetThreadExecutionState(0x80000003) | Out-Null; Start-Sleep -Seconds 30}',
      ],
    };
  }

  return null;
}

function startKeepAwake(runtime) {
  if (runtime.keepAwake.enabled) {
    return { enabled: true, method: runtime.keepAwake.method };
  }

  const spec = buildKeepAwakeCommand();
  if (!spec) {
    runtime.keepAwake = { enabled: false, method: 'unsupported', child: null, reason: 'unsupported_platform_or_missing_tool' };
    return { enabled: false, method: runtime.keepAwake.method, reason: runtime.keepAwake.reason };
  }

  const child = spawn(spec.command, spec.args, { stdio: 'ignore' });
  child.on('error', () => {
    runtime.keepAwake.enabled = false;
    runtime.keepAwake.child = null;
    runtime.keepAwake.reason = 'spawn_failed';
  });
  child.on('exit', () => {
    runtime.keepAwake.enabled = false;
    runtime.keepAwake.child = null;
  });

  runtime.keepAwake = { enabled: true, method: spec.method, child, reason: null };
  return { enabled: true, method: spec.method };
}

function stopKeepAwake(runtime) {
  if (runtime.keepAwake.child) {
    try {
      runtime.keepAwake.child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  runtime.keepAwake = { enabled: false, method: runtime.keepAwake.method || 'none', child: null, reason: null };
  return { enabled: false, method: runtime.keepAwake.method };
}

async function handleInvoke(cmd, args, runtime) {
  switch (cmd) {
    case 'app_version':
      return runtime.version;
    case 'app_platform':
      return { platform: process.platform, arch: process.arch };
    case 'faq_load':
      return fs.existsSync(FAQ_FILE) ? fs.readFileSync(FAQ_FILE, 'utf8') : 'FAQ file not found.';
    case 'set_save_logs':
    case 'set_ui_log_enabled':
      return true;
    case 'dialog_open':
    case 'dialog_save':
      return null;

    case 'config_load':
      return loadConfig();
    case 'config_save':
    case 'config_update':
      saveConfig(args && args.config);
      return true;

    case 'profiles_load':
      return loadProfiles();
    case 'profiles_save':
    case 'profiles_update':
      saveProfiles(args && args.data);
      return true;

    case 'queue_load':
      return loadQueue();
    case 'queue_save':
    case 'queue_update':
      saveQueue(args && args.data);
      return true;

    case 'history_load':
      return loadHistory();
    case 'history_save':
      saveHistory(args && args.data);
      return true;
    case 'history_add':
      addHistoryRecord(args && args.record);
      return true;
    case 'history_clear':
      clearHistory();
      return true;

    case 'sleep_set':
      return Boolean(args && args.enabled) ? startKeepAwake(runtime) : stopKeepAwake(runtime);
    case 'sleep_status':
      return {
        enabled: Boolean(runtime.keepAwake.enabled),
        method: runtime.keepAwake.method || 'none',
        reason: runtime.keepAwake.reason || null,
      };

    case 'port_check': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      const port = Number.parseInt(String(args && args.port ? args.port : ''), 10);
      if (!ip || !Number.isFinite(port) || port <= 0 || port > 65535) {
        throw new Error('ip and valid port are required');
      }
      return isPortOpen(ip, port);
    }

    case 'storage_list': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return listStorage(ip, TRANSFER_PORT);
    }

    case 'connection_set_ip':
      runtime.connectionIp = (args && args.ip ? String(args.ip) : '').trim();
      return true;
    case 'connection_polling_set':
      runtime.connectionPollEnabled = Boolean(args && args.enabled);
      return true;
    case 'connection_auto_set':
      runtime.connectionAutoEnabled = Boolean(args && args.enabled);
      return true;
    case 'connection_snapshot':
      return runtime.connectionStatus;
    case 'connection_connect': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) {
        runtime.connectionStatus = { is_connected: false, status: 'Missing IP', storage_locations: [] };
        return runtime.connectionStatus;
      }
      try {
        const portOpen = await isPortOpen(ip, TRANSFER_PORT);
        if (!portOpen) {
          runtime.connectionStatus = { is_connected: false, status: `Port ${TRANSFER_PORT} closed`, storage_locations: [] };
          return runtime.connectionStatus;
        }
        const storage = await listStorage(ip, TRANSFER_PORT);
        const available = Array.isArray(storage) ? storage.filter((loc) => Number(loc.free_gb) > 0) : [];
        runtime.connectionStatus =
          available.length > 0
            ? { is_connected: true, status: 'Connected', storage_locations: available }
            : { is_connected: false, status: 'No storage', storage_locations: [] };
        return runtime.connectionStatus;
      } catch (err) {
        runtime.connectionStatus = { is_connected: false, status: `Error: ${err.message || err}`, storage_locations: [] };
        return runtime.connectionStatus;
      }
    }

    case 'payload_external_releases': {
      return fetchRepoReleases(args && args.owner, args && args.repo);
    }

    case 'payload_send': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      const filepath = (args && args.path ? String(args.path) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      if (!filepath) throw new Error('Select a payload (.elf/.bin) file first.');
      if (runtime.payloadSendInFlight) throw new Error('Payload send already in progress.');
      runtime.payloadSendInFlight = true;
      try {
        return await sendPayloadFile(ip, filepath);
      } finally {
        runtime.payloadSendInFlight = false;
      }
    }
    case 'payload_download_and_send': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      if (runtime.payloadSendInFlight) throw new Error('Payload send already in progress.');
      runtime.payloadSendInFlight = true;
      runtime.payloadDownloadProgress = null;
      try {
        const fetchValue = args ? args.fetch : 'latest';
        const isCustomFetch =
          fetchValue && typeof fetchValue === 'object' && !Array.isArray(fetchValue);
        const customUrl =
          isCustomFetch && typeof fetchValue.url === 'string' ? fetchValue.url.trim() : '';
        const customName =
          isCustomFetch && typeof fetchValue.temp_name === 'string'
            ? fetchValue.temp_name.trim()
            : '';
        const customLabel =
          isCustomFetch && typeof fetchValue.label === 'string' ? fetchValue.label.trim() : '';
        const customSourceId =
          isCustomFetch && typeof fetchValue.source_id === 'string'
            ? fetchValue.source_id.trim()
            : '';
        const customExpectedVersion =
          isCustomFetch && typeof fetchValue.expected_version === 'string'
            ? fetchValue.expected_version.trim()
            : '';

        if (customUrl) {
          let parsed;
          try {
            parsed = new URL(customUrl);
          } catch {
            throw new Error('Invalid payload URL');
          }
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new Error('Unsupported payload URL protocol');
          }
          const ext = path.extname(parsed.pathname || '').toLowerCase();
          const safeExt = ext === '.bin' ? '.bin' : '.elf';
          const safeStem = (customName || 'external_payload').replace(/[^a-zA-Z0-9._-]/g, '_');
          const tmpPath = path.join(os.tmpdir(), `${safeStem}${safeExt}`);
          await downloadAsset(customUrl, tmpPath, {
            runtime,
            label: customLabel || (customName ? `External payload (${customName})` : 'External payload'),
            source_id: customSourceId || customName || null,
          });
          return await sendPayloadFile(ip, tmpPath);
        }

        const fetchMode = (fetchValue ? String(fetchValue) : 'latest').trim();
        if (fetchMode === 'current') {
          const localPayload = findLocalPayloadElf();
          if (localPayload) {
            return await sendPayloadFile(ip, localPayload);
          }
        }
        let release;
        if (fetchMode === 'current') {
          try {
            release = await fetchReleaseByTag(`v${runtime.version}`);
          } catch {
            release = await fetchLatestRelease(false);
          }
        } else {
          release = await fetchLatestRelease(false);
        }
        const assets = Array.isArray(release && release.assets) ? release.assets : [];
        let asset = assets.find((a) => a && a.name === 'ps5upload.elf');
        if (!asset) asset = assets.find((a) => a && typeof a.name === 'string' && a.name.endsWith('.elf'));
        if (!asset || !asset.browser_download_url) throw new Error('Payload asset not found in release');
        const tmpPath = path.join(os.tmpdir(), `ps5upload_${fetchMode}.elf`);
        await downloadAsset(asset.browser_download_url, tmpPath, {
          runtime,
          label: fetchMode === 'current' ? `ps5upload v${runtime.version}` : 'ps5upload latest',
          source_id: 'ps5upload',
        });
        return await sendPayloadFile(ip, tmpPath);
      } finally {
        runtime.payloadSendInFlight = false;
      }
    }

    case 'payload_download_progress_snapshot': {
      return runtime.payloadDownloadProgress || null;
    }
    case 'payload_check': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return getPayloadVersion(ip, TRANSFER_PORT);
    }
    case 'payload_caps': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return getPayloadCaps(ip, TRANSFER_PORT);
    }
    case 'payload_probe': {
      const filepath = (args && args.path ? String(args.path) : '').trim();
      if (!filepath) throw new Error('Select a payload (.elf/.bin) file first.');
      return probePayloadFile(filepath);
    }
    case 'payload_status': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return getPayloadStatus(ip, TRANSFER_PORT);
    }
    case 'open_external':
      return true;

    case 'payload_status_snapshot':
      return runtime.payloadStatus || { status: null, error: null, updated_at_ms: 0 };
    case 'payload_status_refresh': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      try {
        const status = await getPayloadStatus(ip, TRANSFER_PORT);
        runtime.payloadStatus = { status, error: null, updated_at_ms: Date.now() };
      } catch (err) {
        runtime.payloadStatus = { status: null, error: err.message || String(err), updated_at_ms: Date.now() };
      }
      return runtime.payloadStatus;
    }
    case 'payload_set_ip':
      runtime.payloadIp = (args && args.ip ? String(args.ip) : '').trim();
      return true;
    case 'payload_polling_set':
      runtime.payloadPollEnabled = Boolean(args && args.enabled);
      return true;
    case 'payload_auto_reload_set':
      runtime.payloadAutoReloadEnabled = Boolean(args && args.enabled);
      runtime.payloadAutoReloadMode = args && args.mode ? String(args.mode) : 'current';
      runtime.payloadAutoReloadPath = args && args.local_path ? String(args.local_path) : '';
      return true;

    case 'manage_list': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      const dirPath = (args && args.path ? String(args.path) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      if (!dirPath) throw new Error('Enter a path.');
      return listDir(ip, TRANSFER_PORT, dirPath);
    }
    case 'manage_list_snapshot':
      return runtime.manageListCache || { path: runtime.managePath || '/data', entries: [], error: null, updated_at_ms: 0 };
    case 'manage_list_refresh': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      const dirPath = (args && args.path ? String(args.path) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      if (!dirPath) throw new Error('Enter a path.');
      try {
        const entries = await listDir(ip, TRANSFER_PORT, dirPath);
        runtime.manageListCache = { path: dirPath, entries, error: null, updated_at_ms: Date.now() };
      } catch (err) {
        runtime.manageListCache = { path: dirPath, entries: [], error: err.message || String(err), updated_at_ms: Date.now() };
      }
      return runtime.manageListCache;
    }
    case 'manage_set_ip':
      runtime.manageIp = (args && args.ip ? String(args.ip) : '').trim();
      return true;
    case 'manage_set_path':
      runtime.managePath = (args && args.path ? String(args.path) : '').trim();
      return true;
    case 'manage_polling_set':
      runtime.managePollEnabled = Boolean(args && args.enabled);
      return true;
    case 'manage_progress_status':
      return runtime.manageProgress || { op: '', processed: 0, total: 0, current_file: '', active: false, updated_at_ms: 0 };
    case 'manage_cancel':
      runtime.manageCancel = true;
      runtime.transferCancel = true;
      runtime.manageProgress = {
        ...(runtime.manageProgress || { op: 'Manage', processed: 0, total: 0, current_file: '', active: false }),
        active: false,
        updated_at_ms: Date.now(),
      };
      return true;
    case 'manage_delete': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      const filePath = (args && args.path ? String(args.path) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      if (!filePath) throw new Error('Select a path.');
      return deletePath(ip, TRANSFER_PORT, filePath);
    }
    case 'manage_rename':
    case 'manage_move': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      const src = (args && args.src_path ? String(args.src_path) : '').trim();
      const dst = (args && args.dst_path ? String(args.dst_path) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      if (!src || !dst) throw new Error('Source and destination are required.');
      return movePath(ip, TRANSFER_PORT, src, dst);
    }
    case 'manage_create_dir': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      const dirPath = (args && args.path ? String(args.path) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      if (!dirPath) throw new Error('Folder path is required.');
      return createPath(ip, TRANSFER_PORT, dirPath);
    }
    case 'manage_chmod': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      const filePath = (args && args.path ? String(args.path) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      if (!filePath) throw new Error('Select a path.');
      return chmod777(ip, TRANSFER_PORT, filePath);
    }

    case 'payload_queue_extract': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      const src = (args && args.src ? String(args.src) : '').trim();
      const dst = (args && args.dst ? String(args.dst) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      if (!src || !dst) throw new Error('Source and destination are required.');
      return queueExtract(ip, TRANSFER_PORT, src, dst);
    }
    case 'payload_queue_cancel': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return queueCancel(ip, TRANSFER_PORT, args && args.id);
    }
    case 'payload_queue_clear': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return queueClear(ip, TRANSFER_PORT);
    }
    case 'payload_queue_clear_all': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return queueClearAll(ip, TRANSFER_PORT);
    }
    case 'payload_queue_clear_failed': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return queueClearFailed(ip, TRANSFER_PORT);
    }
    case 'payload_reset': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return payloadReset(ip, TRANSFER_PORT);
    }
    case 'payload_clear_tmp': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return payloadClearTmp(ip, TRANSFER_PORT);
    }
    case 'payload_maintenance': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return payloadMaintenance(ip, TRANSFER_PORT);
    }
    case 'payload_queue_reorder': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return queueReorder(ip, TRANSFER_PORT, args && args.ids);
    }
    case 'payload_queue_process': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return queueProcess(ip, TRANSFER_PORT);
    }
    case 'payload_queue_pause': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return queuePause(ip, TRANSFER_PORT, args && args.id);
    }
    case 'payload_queue_retry': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return queueRetry(ip, TRANSFER_PORT, args && args.id);
    }
    case 'payload_queue_remove': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return queueRemove(ip, TRANSFER_PORT, args && args.id);
    }
    case 'payload_sync_info': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return syncInfo(ip, TRANSFER_PORT);
    }
    case 'payload_upload_queue_get': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return uploadQueueGet(ip, TRANSFER_PORT);
    }
    case 'payload_upload_queue_sync': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return uploadQueueSync(ip, TRANSFER_PORT, args && args.payload ? args.payload : '');
    }
    case 'payload_history_get': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return historyGet(ip, TRANSFER_PORT);
    }
    case 'payload_history_sync': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      return historySync(ip, TRANSFER_PORT, args && args.payload ? args.payload : '');
    }

    case 'transfer_check_dest': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      const destPath = (args && args.destPath ? String(args.destPath) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      if (!destPath) throw new Error('Destination path is required.');
      const response = await sendSimpleCommand(ip, TRANSFER_PORT, `CHECK_DIR ${destPath}\n`);
      return response === 'EXISTS';
    }
    case 'transfer_scan': {
      runtime.scanCancel = false;
      const sourcePath = typeof args === 'string' ? args : args && args.source_path;
      if (!sourcePath || !String(sourcePath).trim()) throw new Error('Source path is required.');
      const maxMs = typeof args.max_ms === 'number' ? args.max_ms : 8000;
      const maxFiles = typeof args.max_files === 'number' ? args.max_files : 50000;
      const quickCount = Boolean(args && args.quick_count);
      const sampleLimit = typeof args.sample_limit === 'number' ? args.sample_limit : 400;

      const stat = await fs.promises.stat(sourcePath);
      if (!stat.isDirectory()) throw new Error('Scan supports folders only.');

      const startedAt = Date.now();
      let files = 0;
      let total = 0;
      let partial = false;
      let reason = null;
      let estimated = false;
      let sampleCount = 0;
      let sampleSizeSum = 0;
      const stack = [sourcePath];
      let lastUpdate = 0;

      runtime.scanState = {
        active: true,
        files: 0,
        total: 0,
        partial: false,
        reason: null,
        estimated: false,
        elapsed_ms: 0,
        source_path: sourcePath,
        updated_at_ms: Date.now(),
      };

      try {
        while (stack.length > 0) {
          if (runtime.scanCancel) throw new Error('Scan cancelled');
          if (maxMs > 0 && Date.now() - startedAt >= maxMs) {
            partial = true;
            reason = 'time';
            break;
          }
          if (maxFiles > 0 && files >= maxFiles) {
            partial = true;
            reason = 'files';
            break;
          }
          const dir = stack.pop();
          if (!dir) continue;
          let entries;
          try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const entry of entries) {
            if (runtime.scanCancel) throw new Error('Scan cancelled');
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              stack.push(fullPath);
            } else if (entry.isFile()) {
              files += 1;
              if (quickCount) {
                if (sampleCount < sampleLimit) {
                  try {
                    const st = await fs.promises.stat(fullPath);
                    sampleCount += 1;
                    sampleSizeSum += st.size;
                    total += st.size;
                  } catch {
                    // ignore
                  }
                }
              } else {
                try {
                  const st = await fs.promises.stat(fullPath);
                  total += st.size;
                } catch {
                  // ignore
                }
              }
            }
            const now = Date.now();
            if (now - lastUpdate >= 200) {
              lastUpdate = now;
              runtime.scanState = {
                ...runtime.scanState,
                active: true,
                files,
                total,
                elapsed_ms: now - startedAt,
                updated_at_ms: now,
              };
            }
          }
        }
      } finally {
        runtime.scanState = {
          ...runtime.scanState,
          active: false,
          files,
          total,
          elapsed_ms: Date.now() - startedAt,
          updated_at_ms: Date.now(),
        };
      }

      if (quickCount) {
        estimated = true;
        total = sampleCount > 0 ? Math.round((sampleSizeSum / sampleCount) * files) : 0;
      }
      runtime.scanState = {
        ...runtime.scanState,
        active: false,
        files,
        total,
        partial,
        reason,
        estimated,
        elapsed_ms: Date.now() - startedAt,
        updated_at_ms: Date.now(),
      };
      return { files, total, partial, reason, elapsed_ms: Date.now() - startedAt, estimated };
    }
    case 'transfer_scan_status':
      return runtime.scanState || {
        active: false,
        files: 0,
        total: 0,
        partial: false,
        reason: null,
        estimated: false,
        elapsed_ms: 0,
        source_path: '',
        updated_at_ms: 0,
      };
    case 'transfer_scan_cancel':
      runtime.scanCancel = true;
      return true;
    case 'transfer_cancel':
      runtime.transferCancel = true;
      runtime.transferStatus = {
        ...(runtime.transferStatus || createTransferStatus()),
        status: 'Cancelling',
      };
      return true;
    case 'transfer_status':
      return { ...(runtime.transferStatus || createTransferStatus()), ...(runtime.transferMeta || {}) };
    case 'transfer_reset':
      runtime.transferCancel = false;
      runtime.transferActive = false;
      runtime.transferStatus = createTransferStatus();
      resetTransferSpeed(runtime);
      runtime.transferMeta = {
        requested_optimize: null,
        auto_tune_connections: null,
        requested_max_throughput: null,
        effective_optimize: null,
        effective_compression: null,
        requested_ftp_connections: null,
        effective_ftp_connections: null,
        preflight_bottleneck: null,
      };
      return true;
    case 'transfer_active':
      return Boolean(runtime.transferActive);
    case 'transfer_start':
    case 'manage_upload': {
      if (runtime.transferActive) {
        throw new Error('Transfer already running');
      }
      const req = cmd === 'transfer_start' ? (args && args.req ? args.req : args) : args;
      const ip = (req && req.ip ? String(req.ip) : '').trim();
      const destRoot = cmd === 'transfer_start'
        ? (req && req.dest_path ? String(req.dest_path) : '').trim()
        : (req && req.dest_root ? String(req.dest_root) : '').trim();
      const sourcePath = cmd === 'transfer_start'
        ? (req && req.source_path ? String(req.source_path) : '').trim()
        : '';
      const paths = cmd === 'transfer_start'
        ? [sourcePath]
        : (Array.isArray(req && req.paths) ? req.paths : []);
      if (!ip) throw new Error('Enter a PS5 address first.');
      if (!destRoot) throw new Error('Destination path is required.');
      if (!paths.length || !paths[0]) throw new Error('Select at least one file or folder.');

      const preferredFtpPort = req && req.ftp_port ? req.ftp_port : 'auto';

      const runId = Date.now();
      const requestedOptimize = Boolean(req && req.optimize_upload);
      const autoTuneConnections = req && typeof req.auto_tune_connections === 'boolean' ? req.auto_tune_connections : null;
      const requestedFtpConnections = 10;
      let effectiveFtpConnections = Math.max(
        1,
        Math.min(
          10,
          Number.isFinite(Number(requestedFtpConnections))
            ? Number(requestedFtpConnections)
            : 10
        )
      );
      // App mode shares the transfer engine with desktop. Keep this defined up-front because
      // archive flows can reference it before file scanning/tuning logic runs.
      let effectivePayloadConnections = 4;
      const compression = req && req.compression ? String(req.compression) : null;
      const uploadMode = req && req.upload_mode ? String(req.upload_mode) : null;

      runtime.transferActive = true;
      runtime.transferCancel = false;
      runtime.manageCancel = false;
      resetTransferSpeed(runtime);
      runtime.transferMeta = {
        requested_optimize: requestedOptimize,
        auto_tune_connections: autoTuneConnections,
        requested_max_throughput: Boolean(req && (req.max_throughput_experimental || req.mad_max)),
        effective_optimize: requestedOptimize,
        effective_compression: compression,
        requested_ftp_connections: requestedFtpConnections,
        effective_ftp_connections: effectiveFtpConnections,
        preflight_bottleneck: null,
      };
      runtime.transferStatus = createTransferStatus({
        run_id: runId,
        status: 'Scanning',
        sent: 0,
        total: 0,
        files: 0,
        elapsed_secs: 0,
        current_file: '',
        upload_mode: uploadMode,
      });

      const startedAt = Date.now();
      const executeTransfer = async () => {
        try {
          let totalBytes = 0;
          let totalFiles = 0;
          const uploadFiles = [];

          // Match desktop Transfer behavior: if the selected source is a single .rar file,
          // use the special upload+queue-extract path.
          if (cmd === 'transfer_start' && paths.length === 1) {
            const archiveStat = await fs.promises.stat(sourcePath);
            const isArchive = archiveStat.isFile() && path.extname(sourcePath).toLowerCase() === '.rar';
            if (isArchive) {
              const mode = uploadMode && uploadMode.toLowerCase() === 'ftp' ? 'ftp' : 'payload';
              const rarName = path.basename(sourcePath);

              runtime.transferStatus = createTransferStatus({
                run_id: runId,
                status: 'Uploading archive',
                sent: 0,
                total: archiveStat.size,
                files: 1,
                elapsed_secs: 0,
                current_file: rarName,
                upload_mode: mode,
              });

                  if (mode === 'ftp') {
                    const ftpPort = await findFtpPort(ip, preferredFtpPort);
                    if (!ftpPort) throw new Error('FTP not reachable on ports 1337/2121. Enable ftpsrv or etaHEN FTP service.');
                const tempRoot = req && typeof req.rar_temp_root === 'string'
                  ? req.rar_temp_root.trim()
                  : (req && typeof req.rar_temp === 'string' ? req.rar_temp.trim() : '');
                const tempRootPath = buildTempRootForArchive(destRoot, tempRoot);
                const tempDir = `${tempRootPath.replace(/\/+$/, '')}/rar_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
                const rarRemotePath = `${tempDir}/${rarName}`;

                await createPath(ip, TRANSFER_PORT, tempDir);
                await uploadFilesViaFtpSimple(ip, ftpPort, tempDir, [{
                  abs_path: sourcePath,
                  rel_path: rarName,
                  size: archiveStat.size,
                }], {
                  connections: effectiveFtpConnections,
                  shouldCancel: () => runtime.transferCancel,
                      onProgress: (sent) => {
                        runtime.transferStatus.sent = sent;
                        recordTransferSpeed(runtime, sent, 'ftp');
                        runtime.transferStatus.elapsed_secs = (Date.now() - startedAt) / 1000;
                        runtime.transferStatus.current_file = rarName;
                      },
                    });

                const queuedId = await queueExtract(ip, TRANSFER_PORT, rarRemotePath, destRoot, {
                  cleanupPath: tempDir,
                  deleteSource: true,
                  unrarMode: 'AUTO',
                });

                runtime.transferStatus = createTransferStatus({
                  run_id: runId,
                  status: 'Queued for extraction',
                  sent: archiveStat.size,
                  total: archiveStat.size,
                  files: 1,
                  elapsed_secs: (Date.now() - startedAt) / 1000,
                  current_file: '',
                  upload_mode: mode,
                });
                runtime.transferMeta = {
                  ...runtime.transferMeta,
                  queued_extract_id: queuedId,
                };
                return;
              }

              const overrideOnConflict = req && typeof req.override_on_conflict === 'boolean' ? req.override_on_conflict : true;
              const tempRoot = req && typeof req.rar_temp_root === 'string'
                ? req.rar_temp_root.trim()
                : (req && typeof req.rar_temp === 'string' ? req.rar_temp.trim() : '');

                    const result = await uploadRarForExtractionViaPayload(ip, sourcePath, destRoot, {
                      overrideOnConflict,
                      tempRoot,
                      shouldCancel: () => runtime.transferCancel,
                      onLog: (message) => { runtime.transferStatus.status = message; },
                      onProgress: (sent) => {
                        runtime.transferStatus.sent = sent;
                        recordTransferSpeed(runtime, sent, 'payload');
                        runtime.transferStatus.elapsed_secs = (Date.now() - startedAt) / 1000;
                        runtime.transferStatus.current_file = rarName;
                      },
                    });

              runtime.transferStatus = createTransferStatus({
                run_id: runId,
                status: 'Queued for extraction',
                sent: archiveStat.size,
                total: archiveStat.size,
                files: 1,
                elapsed_secs: (Date.now() - startedAt) / 1000,
                current_file: '',
                upload_mode: mode,
              });
              runtime.transferMeta = {
                ...runtime.transferMeta,
                queued_extract_id: result && result.queuedId ? result.queuedId : null,
              };
              return;
            }
          }

          for (const srcPath of paths) {
            if (runtime.transferCancel) throw new Error('Transfer cancelled');
            // Desktop parity:
            // - manage_upload: directory selections upload into destRoot/<folderName>/...
            // - transfer_start: folder selections upload contents into dest_path (no extra folder level)
            // eslint-disable-next-line no-await-in-loop
            const st = await fs.promises.stat(srcPath);
            const prefix = (cmd === 'manage_upload' && st.isDirectory()) ? path.basename(srcPath) : '';
            // eslint-disable-next-line no-await-in-loop
            await walkLocalFiles(srcPath, {
              shouldCancel: () => runtime.transferCancel,
              onFile: (file) => {
                if (prefix) {
                  file = { ...file, rel_path: `${prefix}/${String(file.rel_path || '').replace(/^\/+/, '')}` };
                }
                uploadFiles.push(file);
                totalFiles += 1;
                totalBytes += Number(file && file.size) || 0;
                runtime.transferStatus.files = totalFiles;
                runtime.transferStatus.total = totalBytes;
                runtime.transferStatus.elapsed_secs = (Date.now() - startedAt) / 1000;
                runtime.transferStatus.current_file = file && file.rel_path ? file.rel_path : runtime.transferStatus.current_file;
              },
            });
          }

          const mode = uploadMode && uploadMode.toLowerCase() === 'ftp' ? 'ftp' : 'payload';

          const normalizeResumeMode = (value) => {
            if (value === 'size_mtime') return 'size';
            const allowed = ['size', 'hash_large', 'hash_medium', 'sha256'];
            return allowed.includes(value) ? value : 'none';
          };
          const shouldHashResume = (value, size) => {
            if (value === 'sha256') return true;
            if (value === 'hash_large') return size >= RESUME_HASH_LARGE_BYTES;
            if (value === 'hash_medium') return size >= RESUME_HASH_MED_BYTES;
            return false;
          };
          const resumeMode = normalizeResumeMode(req && req.resume_mode ? String(req.resume_mode) : 'none');
          if (resumeMode !== 'none' && mode !== 'ftp' && uploadFiles.length > 0) {
            runtime.transferStatus.status = 'Resume scan';
            runtime.transferStatus.files = 0;
            runtime.transferStatus.total = uploadFiles.length;
            runtime.transferStatus.current_file = '';

            let payloadCapsForResume = createDefaultPayloadCaps(null);
            try {
              payloadCapsForResume = await getPayloadCaps(ip, TRANSFER_PORT);
            } catch {
              // Fall back to compatibility defaults.
            }
            const resumeHashAlgorithm = chooseResumeHashAlgorithm(
              payloadCapsForResume,
              resumeMode,
              isLocalHashAlgorithmSupported
            );
            if (resumeMode !== 'size') {
              runtime.transferStatus.status = `Resume scan (${String(resumeHashAlgorithm).toUpperCase()})`;
            }

            const remoteFiles = await listDirRecursiveCompat(ip, destRoot);
            const remoteIndex = new Map();
            for (const entry of remoteFiles) {
              if (!entry || typeof entry.relPath !== 'string') continue;
              remoteIndex.set(entry.relPath.replace(/\\/g, '/'), {
                size: Number(entry.size) || 0,
              });
            }
            const filteredResult = await sharedResumeScan.filterResumeFiles({
              files: uploadFiles,
              remoteIndex,
              resumeMode,
              shouldHashResume,
              mapWithConcurrency,
              hashLocal: (file) => hashFileLocal(file.abs_path, resumeHashAlgorithm),
              hashRemote: (remotePath) => hashFileRemote(ip, TRANSFER_PORT, remotePath, resumeHashAlgorithm),
              makeRemotePath: (rel) => joinRemotePath(destRoot, rel),
              concurrency: RESUME_HASH_REMOTE_PARALLELISM,
              onProgress: (done, total) => {
                runtime.transferStatus.files = done;
                runtime.transferStatus.total = total;
              },
              cancelCheck: () => runtime.transferCancel,
            });
            const filtered = filteredResult.filtered;

            uploadFiles.length = 0;
            uploadFiles.push(...filtered);
            totalFiles = uploadFiles.length;
            totalBytes = uploadFiles.reduce((sum, file) => sum + (Number(file && file.size) || 0), 0);
            runtime.transferStatus.status = 'Scanning';
            runtime.transferStatus.files = totalFiles;
            runtime.transferStatus.total = totalBytes;
          }

          const avgSize = totalFiles > 0 ? totalBytes / totalFiles : 0;
          if (autoTuneConnections && totalFiles > 0) {
            if (totalFiles === 1) {
              if (totalBytes >= 8 * 1024 * 1024 * 1024) {
                effectivePayloadConnections = Math.max(effectivePayloadConnections, 4);
              } else if (totalBytes >= 1024 * 1024 * 1024) {
                effectivePayloadConnections = Math.max(effectivePayloadConnections, 3);
              } else if (totalBytes <= 128 * 1024 * 1024) {
                effectivePayloadConnections = Math.min(effectivePayloadConnections, 4);
              }
            } else if (avgSize < 256 * 1024 || totalFiles >= 100000) {
              effectivePayloadConnections = Math.min(effectivePayloadConnections, 4);
            } else if (avgSize < 2 * 1024 * 1024 || totalFiles >= 20000) {
              effectivePayloadConnections = Math.min(effectivePayloadConnections, 6);
            } else if (avgSize > 256 * 1024 * 1024 && totalFiles < 1000) {
              effectivePayloadConnections = Math.max(effectivePayloadConnections, 3);
            }
          }
          if (autoTuneConnections && totalFiles > 0) {
            if (avgSize < 256 * 1024 || totalFiles >= 50000) {
              effectiveFtpConnections = Math.min(effectiveFtpConnections, 4);
            } else if (avgSize < 2 * 1024 * 1024 || totalFiles >= 20000) {
              effectiveFtpConnections = Math.min(effectiveFtpConnections, 6);
            } else if (avgSize > 256 * 1024 * 1024 && totalFiles < 1000) {
              effectiveFtpConnections = Math.max(effectiveFtpConnections, 4);
            }
          }

          // Stability first: cap payload concurrency at 4 to avoid overwhelming the PS5 side.
          effectivePayloadConnections = Math.max(1, Math.min(4, effectivePayloadConnections));

          // Match desktop Manage Upload defaults (ipcMain.handle('manage_upload')):
          // - For a big single file: use the lane path with 4 connections.
          // - Otherwise: use up to 4 workers for payload multi-file uploads.
          if (cmd === 'manage_upload' && mode === 'payload') {
            if (uploadFiles.length === 1 && Number(uploadFiles[0].size || 0) >= LANE_MIN_FILE_SIZE) {
              effectivePayloadConnections = 4;
            } else {
              effectivePayloadConnections = Math.max(1, Math.min(4, uploadFiles.length));
            }
          }

          if (mode === 'payload') {
            const waitForPayloadRecovery = async () => {
              const deadline = Date.now() + 180000;
              let statusErrors = 0;
              let resetIssued = false;
              while (Date.now() < deadline) {
                if (runtime.transferCancel) return false;
                try {
                  const status = await getPayloadStatus(ip, TRANSFER_PORT);
                  statusErrors = 0;
                  if (status && !status.is_busy) {
                    const transfer = status.transfer || {};
                    if (Number(transfer.active_sessions || 0) === 0 && !transfer.abort_requested) {
                      return true;
                    }
                    if (!resetIssued && transfer.abort_requested) {
                      resetIssued = true;
                      await payloadReset(ip, TRANSFER_PORT).catch(() => {});
                    }
                  }
                } catch {
                  statusErrors += 1;
                  if (!resetIssued && statusErrors >= 3) {
                    resetIssued = true;
                    await payloadReset(ip, TRANSFER_PORT).catch(() => {});
                  }
                  // Keep polling through transient status failures.
                }
                await sleepMs(2000);
              }
              return false;
            };
            const filterResumeBySize = async (files) => {
              if (!Array.isArray(files) || files.length === 0) return [];
              try {
                const remoteFiles = await listDirRecursiveCompat(ip, destRoot);
                const remoteIndex = new Map();
                for (const entry of remoteFiles) {
                  if (!entry || typeof entry.relPath !== 'string') continue;
                  remoteIndex.set(entry.relPath.replace(/\\/g, '/'), { size: Number(entry.size) || 0 });
                }
                const result = await sharedResumeScan.filterResumeFiles({
                  files,
                  remoteIndex,
                  resumeMode: 'size',
                  shouldHashResume: () => false,
                  mapWithConcurrency,
                  concurrency: RESUME_HASH_REMOTE_PARALLELISM,
                  onProgress: () => {},
                  cancelCheck: () => runtime.transferCancel,
                });
                return result.filtered;
              } catch {
                return files;
              }
            };

            let attemptFiles = uploadFiles;
            let recoveryAttempted = false;
            let precreatedDirs = false;
            while (true) {
              try {
                const maxThroughputRequested = Boolean(req && (req.max_throughput_experimental || req.mad_max));
                const madMaxRequested = Boolean(req && req.mad_max === true);
                runtime.transferStatus.status = 'Preparing upload';
                runtime.transferStatus.current_file = '';
                const largeSingleFile = attemptFiles.length === 1 && Number(attemptFiles[0].size || 0) >= LANE_MIN_FILE_SIZE;
                let singleStrategy = null;
                if (largeSingleFile) {
                  const fileSize = Number(attemptFiles[0].size || 0);
                  if (!maxThroughputRequested) {
                    singleStrategy = { mode: 'stable', reason: 'not_requested' };
                  } else {
                    let bottleneck = 'unknown';
                    try {
                      const status = await getPayloadStatus(ip, TRANSFER_PORT);
                      bottleneck = classifyPayloadUploadBottleneck(
                        status,
                        Number(runtime.transferStatus?.payload_speed_bps || runtime.transferStatus?.total_speed_bps || 0)
                      );
                    } catch {
                      // Keep unknown when preflight status is unavailable.
                    }
                    runtime.transferMeta = { ...runtime.transferMeta, preflight_bottleneck: bottleneck };
                    if (bottleneck === 'payload_disk' || bottleneck === 'payload_cpu' || bottleneck === 'client') {
                      singleStrategy = { mode: 'stable', reason: bottleneck };
                    } else if (madMaxRequested && fileSize >= MAD_MAX_MIN_FILE_SIZE) {
                      singleStrategy = {
                        mode: 'mad_max',
                        workers: Math.max(1, Math.min(4, MAD_MAX_WORKERS)),
                        chunkSize: getMadMaxChunkSize(fileSize),
                      };
                    } else {
                      singleStrategy = {
                        mode: 'lane',
                        workers: Math.max(1, Math.min(4, effectivePayloadConnections || LANE_CONNECTIONS)),
                        chunkSize: getLaneChunkSize(fileSize),
                      };
                    }
                  }
                }

                runtime.transferStatus.status = 'Uploading';
                runtime.transferStatus.current_file = '';

                if (singleStrategy && singleStrategy.mode === 'mad_max') {
                  runtime.transferStatus.payload_transfer_path = 'mad_max_single';
                  runtime.transferStatus.payload_workers = singleStrategy.workers;
                  await uploadLaneSingleFile(ip, destRoot, attemptFiles[0], {
                    connections: singleStrategy.workers,
                    chunkSize: singleStrategy.chunkSize,
                    shouldCancel: () => runtime.transferCancel,
                    onProgress: (sent) => {
                      runtime.transferStatus.sent = sent;
                      recordTransferSpeed(runtime, sent, 'payload');
                      runtime.transferStatus.elapsed_secs = (Date.now() - startedAt) / 1000;
                      runtime.transferStatus.current_file = attemptFiles[0].rel_path || '';
                    },
                  });
                } else if (singleStrategy && singleStrategy.mode === 'lane') {
                  runtime.transferStatus.payload_transfer_path = 'lane_fast_offset';
                  runtime.transferStatus.payload_workers = singleStrategy.workers;
                  await uploadLaneSingleFile(ip, destRoot, attemptFiles[0], {
                    connections: singleStrategy.workers,
                    chunkSize: singleStrategy.chunkSize,
                    shouldCancel: () => runtime.transferCancel,
                    onProgress: (sent) => {
                      runtime.transferStatus.sent = sent;
                      recordTransferSpeed(runtime, sent, 'payload');
                      runtime.transferStatus.elapsed_secs = (Date.now() - startedAt) / 1000;
                      runtime.transferStatus.current_file = attemptFiles[0].rel_path || '';
                    },
                  });
                } else if (singleStrategy && singleStrategy.mode === 'stable') {
                  runtime.transferStatus.payload_transfer_path = 'binary_single';
                  runtime.transferStatus.payload_workers = 1;
                  await uploadFastMultiFile(ip, destRoot, attemptFiles, {
                    connections: 1,
                    shouldCancel: () => runtime.transferCancel,
                    onFileStart: (file) => {
                      runtime.transferStatus.current_file = file.rel_path || '';
                    },
                    onProgress: (sent) => {
                      runtime.transferStatus.sent = sent;
                      recordTransferSpeed(runtime, sent, 'payload');
                      runtime.transferStatus.elapsed_secs = (Date.now() - startedAt) / 1000;
                    },
                  });
                } else {
                  if (!precreatedDirs) {
                    await precreateRemoteDirectories(ip, destRoot, attemptFiles, {
                      shouldCancel: () => runtime.transferCancel,
                      log: (message) => {
                        runtime.transferStatus.status = message;
                      },
                    });
                    precreatedDirs = true;
                  }
                  runtime.transferStatus.status = 'Uploading';
                  runtime.transferStatus.payload_transfer_path = effectivePayloadConnections > 1 ? 'binary_multi_file' : 'binary_single';
                  runtime.transferStatus.payload_workers = effectivePayloadConnections > 1 ? effectivePayloadConnections : 1;
                  await uploadFastMultiFile(ip, destRoot, attemptFiles, {
                    connections: effectivePayloadConnections,
                    shouldCancel: () => runtime.transferCancel,
                    onFileStart: (file) => {
                      runtime.transferStatus.current_file = file.rel_path || '';
                    },
                    onProgress: (sent) => {
                      runtime.transferStatus.sent = sent;
                      recordTransferSpeed(runtime, sent, 'payload');
                      runtime.transferStatus.elapsed_secs = (Date.now() - startedAt) / 1000;
                    },
                  });
                }
                break;
              } catch (err) {
                if (recoveryAttempted || runtime.transferCancel) throw err;
                recoveryAttempted = true;
                runtime.transferStatus.status = 'Recovering payload';
                const recovered = await waitForPayloadRecovery();
                if (!recovered) throw err;
                const retryFiles = await filterResumeBySize(attemptFiles);
                if (!Array.isArray(retryFiles) || retryFiles.length === 0) {
                  runtime.transferStatus = createTransferStatus({
                    run_id: runId,
                    status: 'Complete',
                    sent: totalBytes,
                    total: totalBytes,
                    files: totalFiles,
                    elapsed_secs: (Date.now() - startedAt) / 1000,
                    current_file: '',
                    upload_mode: 'payload',
                  });
                  return;
                }
                attemptFiles = retryFiles;
                precreatedDirs = false;
              }
            }

            runtime.transferStatus = createTransferStatus({
              run_id: runId,
              status: 'Complete',
              sent: totalBytes,
              total: totalBytes,
              files: totalFiles,
              elapsed_secs: (Date.now() - startedAt) / 1000,
              current_file: '',
              upload_mode: 'payload',
            });
            return;
          }

          const ftpPort = await findFtpPort(ip, preferredFtpPort);
          if (!ftpPort) throw new Error('FTP not reachable on ports 1337/2121. Enable ftpsrv or etaHEN FTP service.');
          runtime.transferStatus.status = 'Uploading (FTP)';
          runtime.transferStatus.current_file = '';
          await uploadFilesViaFtpSimple(ip, ftpPort, destRoot, uploadFiles, {
            connections: effectiveFtpConnections,
            shouldCancel: () => runtime.transferCancel,
            onFileStart: (file) => {
              runtime.transferStatus.current_file = file && file.rel_path ? file.rel_path : '';
            },
            onProgress: (sent, file) => {
              runtime.transferStatus.sent = sent;
              recordTransferSpeed(runtime, sent, 'ftp');
              runtime.transferStatus.elapsed_secs = (Date.now() - startedAt) / 1000;
              runtime.transferStatus.current_file = file && file.rel_path ? file.rel_path : runtime.transferStatus.current_file;
            },
          });
          runtime.transferStatus = createTransferStatus({
            run_id: runId,
            status: 'Complete',
            sent: totalBytes,
            total: totalBytes,
            files: totalFiles,
            elapsed_secs: (Date.now() - startedAt) / 1000,
            current_file: '',
            upload_mode: 'ftp',
          });
        } catch (err) {
          const msg = err && err.message ? String(err.message) : String(err);
          const isCancelled = /cancel/i.test(msg);
          runtime.transferStatus = createTransferStatus({
            run_id: runId,
            status: isCancelled ? 'Cancelled' : `Error: ${msg}`,
            sent: Number(runtime.transferStatus && runtime.transferStatus.sent) || 0,
            total: Number(runtime.transferStatus && runtime.transferStatus.total) || 0,
            files: Number(runtime.transferStatus && runtime.transferStatus.files) || 0,
            elapsed_secs: (Date.now() - startedAt) / 1000,
            current_file: runtime.transferStatus && runtime.transferStatus.current_file ? runtime.transferStatus.current_file : '',
            upload_mode: uploadMode,
          });
          if (cmd === 'manage_upload') throw err;
        } finally {
          runtime.transferActive = false;
        }
      };

      if (cmd === 'transfer_start') {
        executeTransfer().catch(() => {});
        return runId;
      }
      await executeTransfer();
      return true;
    }

    case 'manage_download_file': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      const remotePath = (args && args.path ? String(args.path) : '').trim();
      const destPath = (args && args.dest_path ? String(args.dest_path) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      if (!remotePath || !destPath) throw new Error('Source and destination are required.');
      runtime.manageCancel = false;
      runtime.manageProgress = { op: 'Download', processed: 0, total: 0, current_file: remotePath, active: true, updated_at_ms: Date.now() };
      try {
        const bytes = await downloadSingleFile(ip, remotePath, destPath, {
          shouldCancel: () => runtime.manageCancel,
          onProgress: (received, total) => {
            runtime.manageProgress = {
              op: 'Download',
              processed: received,
              total: total || received,
              current_file: remotePath,
              active: true,
              updated_at_ms: Date.now(),
            };
          },
        });
        runtime.manageProgress = { op: 'Download', processed: bytes, total: bytes, current_file: remotePath, active: false, updated_at_ms: Date.now() };
        return bytes;
      } catch (err) {
        runtime.manageProgress = { op: 'Download', processed: Number(runtime.manageProgress && runtime.manageProgress.processed) || 0, total: Number(runtime.manageProgress && runtime.manageProgress.total) || 0, current_file: remotePath, active: false, updated_at_ms: Date.now() };
        throw err;
      }
    }

    case 'manage_download_dir': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      const dirPath = (args && args.path ? String(args.path) : '').trim();
      const destPath = (args && args.dest_path ? String(args.dest_path) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      if (!dirPath || !destPath) throw new Error('Source and destination are required.');
      runtime.manageCancel = false;
      const files = await listDirRecursiveCompat(ip, dirPath);
      const totalExpected = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
      let totalBytes = 0;
      runtime.manageProgress = { op: 'Download', processed: 0, total: totalExpected, current_file: '', active: true, updated_at_ms: Date.now() };
      for (const file of files) {
        if (runtime.manageCancel) throw new Error('Download cancelled');
        const out = path.join(destPath, file.relPath);
        // eslint-disable-next-line no-await-in-loop
        totalBytes += await downloadSingleFile(ip, file.remotePath, out, {
          shouldCancel: () => runtime.manageCancel,
          onProgress: (received) => {
            runtime.manageProgress = {
              op: 'Download',
              processed: totalBytes + received,
              total: totalExpected || totalBytes + received,
              current_file: file.remotePath,
              active: true,
              updated_at_ms: Date.now(),
            };
          },
        });
        runtime.manageProgress = {
          op: 'Download',
          processed: totalBytes,
          total: totalExpected || totalBytes,
          current_file: file.remotePath,
          active: true,
          updated_at_ms: Date.now(),
        };
      }
      runtime.manageProgress = { op: 'Download', processed: totalBytes, total: totalExpected || totalBytes, current_file: '', active: false, updated_at_ms: Date.now() };
      return { bytes: totalBytes, files: files.length };
    }

    case 'manage_copy': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      const src = (args && args.src_path ? String(args.src_path) : '').trim();
      const dst = (args && args.dst_path ? String(args.dst_path) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      if (!src || !dst) throw new Error('Source and destination are required.');
      return runProgressCommand(ip, `COPY ${src}\t${dst}\n`);
    }

    case 'manage_extract': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      const src = (args && args.src_path ? String(args.src_path) : '').trim();
      const dst = (args && args.dst_path ? String(args.dst_path) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      if (!src || !dst) throw new Error('Source and destination are required.');
      return runProgressCommand(ip, `EXTRACT_ARCHIVE ${src}\t${dst}\n`);
    }

    case 'manage_upload_rar': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      const rarPath = (args && args.rar_path ? String(args.rar_path) : '').trim();
      const destPath = (args && args.dest_path ? String(args.dest_path) : '').trim();
      const tempRoot = (args && args.temp_root ? String(args.temp_root) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      if (!rarPath || !destPath) throw new Error('RAR source and destination are required.');
      if (tempRoot && (!isSafeRemotePath(tempRoot) || /\s/.test(tempRoot))) {
        throw new Error('Temp storage path must be under /data or /mnt/* and must not contain spaces.');
      }
      const stat = await fs.promises.stat(rarPath);
      if (!stat.isFile()) throw new Error('RAR source must be a file.');

      if (runtime.transferActive) {
        throw new Error('Transfer already running');
      }
      const uploadMode = args && args.upload_mode ? String(args.upload_mode).toLowerCase() : 'payload';
      const remoteDir = tempRoot || destPath;
      const remoteRarPath = `${remoteDir.replace(/\/+$/, '')}/${path.basename(rarPath)}`;
      const runId = Date.now();
      const startedAt = Date.now();
      runtime.transferActive = true;
      runtime.transferCancel = false;
      runtime.manageCancel = false;
      resetTransferSpeed(runtime);
      runtime.transferStatus = createTransferStatus({
        run_id: runId,
        status: 'Uploading archive',
        sent: 0,
        total: stat.size,
        files: 1,
        elapsed_secs: 0,
        current_file: path.basename(rarPath),
        upload_mode: uploadMode,
      });

      try {
        if (uploadMode === 'ftp') {
          const ftpPort = await findFtpPort(ip, 'auto');
          if (!ftpPort) throw new Error('FTP not reachable on ports 1337/2121. Enable ftpsrv or etaHEN FTP service.');
          await uploadFilesViaFtpSimple(ip, ftpPort, remoteDir, [{
            abs_path: rarPath,
            rel_path: path.basename(rarPath),
            size: stat.size,
          }], {
            connections: 4,
            shouldCancel: () => runtime.manageCancel,
            onProgress: (sent) => {
              runtime.transferStatus.sent = sent;
              recordTransferSpeed(runtime, sent, 'ftp');
              runtime.transferStatus.elapsed_secs = (Date.now() - startedAt) / 1000;
              runtime.transferStatus.current_file = path.basename(rarPath);
            },
          });
        } else {
          if (Number(stat.size) >= LANE_MIN_FILE_SIZE) {
            await uploadLaneSingleFile(ip, remoteDir, {
              rel_path: path.basename(rarPath),
              abs_path: rarPath,
              size: stat.size,
            }, {
              shouldCancel: () => runtime.manageCancel,
              onProgress: (sent) => {
                runtime.transferStatus.sent = sent;
                recordTransferSpeed(runtime, sent, 'payload');
                runtime.transferStatus.elapsed_secs = (Date.now() - startedAt) / 1000;
                runtime.transferStatus.current_file = path.basename(rarPath);
              },
            });
          } else {
            let sent = 0;
            await uploadFastOneFile(ip, remoteDir, {
              rel_path: path.basename(rarPath),
              abs_path: rarPath,
              size: stat.size,
            }, {
              shouldCancel: () => runtime.manageCancel,
              onProgress: (delta) => {
                sent += Number(delta) || 0;
                runtime.transferStatus.sent = sent;
                recordTransferSpeed(runtime, sent, 'payload');
                runtime.transferStatus.elapsed_secs = (Date.now() - startedAt) / 1000;
                runtime.transferStatus.current_file = path.basename(rarPath);
              },
            });
          }
        }

        const queuedId = await queueExtract(ip, TRANSFER_PORT, remoteRarPath, destPath, {
          deleteSource: true,
          unrarMode: 'AUTO',
        });
        const payloadSpeed = Number(runtime.transferStatus.payload_speed_bps) || 0;
        const ftpSpeed = Number(runtime.transferStatus.ftp_speed_bps) || 0;
        const totalSpeed = Number(runtime.transferStatus.total_speed_bps) || 0;
        runtime.transferStatus = createTransferStatus({
          run_id: runId,
          status: 'Queued for extraction',
          sent: stat.size,
          total: stat.size,
          files: 1,
          elapsed_secs: (Date.now() - startedAt) / 1000,
          current_file: '',
          upload_mode: uploadMode,
          payload_speed_bps: payloadSpeed,
          ftp_speed_bps: ftpSpeed,
          total_speed_bps: totalSpeed,
        });
        runtime.transferMeta = {
          ...(runtime.transferMeta || {}),
          queued_extract_id: queuedId,
        };
        return { fileSize: stat.size, bytes: stat.size, files: 1, queuedId };
      } catch (err) {
        const msg = err && err.message ? String(err.message) : String(err);
        runtime.transferStatus = {
          ...(runtime.transferStatus || createTransferStatus({ run_id: runId })),
          status: `Error: ${msg}`,
          elapsed_secs: (Date.now() - startedAt) / 1000,
        };
        throw err;
      } finally {
        runtime.transferActive = false;
      }
    }

    case 'games_scan': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      const requestedRoots = Array.isArray(args && args.storage_paths)
        ? args.storage_paths.filter((v) => typeof v === 'string' && v.trim())
        : [];
      const scanPathsRaw = Array.isArray(args && args.scan_paths) ? args.scan_paths : [];
      const absoluteScanPaths = scanPathsRaw
        .map((value) => (value == null ? '' : String(value)).trim().replace(/\\/g, '/'))
        .map((value) => (value.startsWith('/') ? `/${value.replace(/^\/+/, '').replace(/\/+$/, '')}` : ''))
        .filter((value, index, array) => value && array.indexOf(value) === index);
      const scanPaths = scanPathsRaw
        .map(normalizeRemoteScanSubpath)
        .filter((value, index, array) => value && array.indexOf(value) === index);
      const effectiveScanPaths = scanPaths.length > 0 ? scanPaths : ['etaHEN/games', 'etaHEN/homebrew', 'games', 'homebrew'];
      const roots = requestedRoots.length > 0
        ? requestedRoots
        : (await listStorage(ip, TRANSFER_PORT)).map((item) => item.path).filter(Boolean);

      const games = [];
      const scannedStorage = [];
      const skippedStorage = [];
      const scannedGamesDirs = [];
      const scannedGamesDirSet = new Set();

      const inferStorageRootForPath = (pathValue) => {
        const p = String(pathValue || '');
        for (const root of roots) {
          if (!root) continue;
          if (p === root) return root;
          if (p.startsWith(root + '/')) return root;
        }
        return null;
      };

      const scanGamesDir = async (storageRoot, gamesDir) => {
        let entries = [];
        try {
          // eslint-disable-next-line no-await-in-loop
          entries = await listDir(ip, TRANSFER_PORT, gamesDir);
          if (!scannedGamesDirSet.has(gamesDir)) {
            scannedGamesDirSet.add(gamesDir);
            scannedGamesDirs.push(gamesDir);
          }
        } catch {
          return;
        }
        const gameDirs = entries.filter((entry) => isRemoteDirEntry(entry) && entry.name);
        for (const entry of gameDirs) {
          const folderName = String(entry.name);
          const gamePath = joinRemoteScanPath(gamesDir, folderName);
          const candidates = [
            joinRemoteScanPath(gamePath, 'sce_sys', 'param.json'),
            joinRemoteScanPath(gamePath, 'param.json'),
          ];
          let marker = null;
          let meta = null;
          for (const candidate of candidates) {
            try {
              // eslint-disable-next-line no-await-in-loop
              const bytes = await downloadRemoteFileToBuffer(ip, candidate, 512 * 1024);
              const parsed = JSON.parse(bytes.toString('utf8'));
              meta = parseGameMetaFromParam(parsed);
              if (meta) {
                marker = candidate;
                break;
              }
            } catch {
              // ignore
            }
          }
          if (!meta) continue;

          let cover = null;
          const coverCandidates = [
            joinRemoteScanPath(gamePath, 'sce_sys', 'icon0.png'),
            joinRemoteScanPath(gamePath, 'sce_sys', 'icon0.jpg'),
            joinRemoteScanPath(gamePath, 'sce_sys', 'icon0.jpeg'),
          ];
          for (const coverPath of coverCandidates) {
            try {
              // eslint-disable-next-line no-await-in-loop
              const bytes = await downloadRemoteFileToBuffer(ip, coverPath, 2 * 1024 * 1024);
              const dataUrl = bufferToDataUrl(bytes, coverPath);
              if (dataUrl) {
                cover = { data_url: dataUrl };
                break;
              }
            } catch {
              // ignore
            }
          }

          games.push({
            storage_path: storageRoot,
            games_path: gamesDir,
            path: gamePath,
            folder_name: folderName,
            marker_file: marker,
            meta,
            cover,
          });
        }
      };

      for (const storagePath of roots) {
        let storageOk = true;
        try {
          // eslint-disable-next-line no-await-in-loop
          await listDir(ip, TRANSFER_PORT, storagePath);
        } catch {
          storageOk = false;
        }
        if (!storageOk) {
          skippedStorage.push(storagePath);
          continue;
        }
        scannedStorage.push(storagePath);

        for (const subpath of effectiveScanPaths) {
          const gamesDir = joinRemoteScanPath(storagePath, subpath);
          // eslint-disable-next-line no-await-in-loop
          await scanGamesDir(storagePath, gamesDir);
        }
      }

      for (const absDir of absoluteScanPaths) {
        const inferredRoot = inferStorageRootForPath(absDir);
        const storageRoot = inferredRoot || absDir;
        if (!scannedStorage.includes(storageRoot) && storageRoot) {
          scannedStorage.push(storageRoot);
        }
        // eslint-disable-next-line no-await-in-loop
        await scanGamesDir(storageRoot, absDir);
      }

      return {
        games,
        scanned_storage: scannedStorage,
        scanned_games_dirs: scannedGamesDirs,
        skipped_storage: skippedStorage,
        scan_paths: effectiveScanPaths,
      };
    }
    case 'games_scan_stats': {
      const ip = (args && args.ip ? String(args.ip) : '').trim();
      const gamePath = (args && args.path ? String(args.path) : '').trim();
      if (!ip) throw new Error('Enter a PS5 address first.');
      if (!gamePath) throw new Error('Invalid game path.');
      const files = await listDirRecursiveCompat(ip, gamePath);
      const totalSize = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
      return { path: gamePath, file_count: files.length, total_size: totalSize };
    }

    case 'update_check': {
      const includePrerelease = Boolean(args && args.includePrerelease);
      return fetchLatestRelease(includePrerelease);
    }
    case 'update_check_tag': {
      const tag = (args && args.tag ? String(args.tag) : '').trim();
      if (!tag) throw new Error('tag is required');
      return fetchReleaseByTag(tag);
    }
    case 'update_download_asset': {
      const url = (args && args.url ? String(args.url) : '').trim();
      const destPath = (args && args.dest_path ? String(args.dest_path) : '').trim();
      if (!url || !destPath) throw new Error('url and dest_path are required');
      await downloadAsset(url, destPath);
      return { path: destPath };
    }
    case 'update_current_asset_name': {
      const platform = process.platform;
      const arch = process.arch;
      if (platform === 'win32') return 'ps5upload-windows.zip';
      if (platform === 'darwin') return arch === 'arm64' ? 'ps5upload-macos-arm64.zip' : 'ps5upload-macos-x64.zip';
      return 'ps5upload-linux.zip';
    }
    case 'update_prepare_self':
    case 'update_apply_self':
      return true;
    case 'game_meta_load': {
      const sourcePath = (args && args.path ? String(args.path) : '').trim();
      if (!sourcePath) return { meta: null, cover: null };
      const paramCandidates = [
        path.join(sourcePath, 'sce_sys', 'param.json'),
        path.join(sourcePath, 'param.json'),
      ];
      let cover = null;
      const coverCandidates = [
        path.join(sourcePath, 'sce_sys', 'icon0.png'),
        path.join(sourcePath, 'sce_sys', 'icon0.jpg'),
        path.join(sourcePath, 'sce_sys', 'icon0.jpeg'),
      ];
      for (const coverPath of coverCandidates) {
        try {
          const bytes = fs.readFileSync(coverPath);
          const dataUrl = bufferToDataUrl(bytes, coverPath);
          if (dataUrl) {
            cover = { data_url: dataUrl };
            break;
          }
        } catch {
          // ignore
        }
      }
      for (const candidate of paramCandidates) {
        try {
          const raw = fs.readFileSync(candidate, 'utf8');
          const meta = parseGameMetaFromParam(JSON.parse(raw));
          if (meta) return { meta, cover };
        } catch {
          // ignore
        }
      }
      return { meta: null, cover };
    }
    case 'manage_rar_metadata':
      return { meta: null, cover: null };

    default:
      // Desktop parity work is in progress. Return null instead of throwing
      // so the shared desktop UI can render in browser mode.
      return null;
  }
}

function serveFrontend(req, res, frontendDir) {
  const reqUrl = new URL(req.url || '/', 'http://local');
  const pathname = reqUrl.pathname;

  if (pathname === '/web-bridge.js') {
    if (!fs.existsSync(BRIDGE_FILE)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const content = fs.readFileSync(BRIDGE_FILE, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(content);
    return;
  }

  const target = safeJoin(frontendDir, pathname);
  if (!target) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(target)) {
    // SPA index route handling
    const fallback = path.join(frontendDir, 'index.html');
    if (!fs.existsSync(fallback)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    return serveIndexHtml(res, fallback);
  }

  const stats = fs.statSync(target);
  if (stats.isDirectory()) {
    const indexPath = path.join(target, 'index.html');
    if (fs.existsSync(indexPath)) {
      return serveIndexHtml(res, indexPath);
    }
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  if (target.endsWith('.html')) {
    return serveIndexHtml(res, target);
  }

  res.writeHead(200, {
    'Content-Type': contentTypeFor(target),
    'Content-Length': stats.size,
    'Cache-Control': target.endsWith('.js') || target.endsWith('.css') ? 'public, max-age=3600' : 'public, max-age=300',
  });
  fs.createReadStream(target).pipe(res);
}

function serveIndexHtml(res, indexPath) {
  const raw = fs.readFileSync(indexPath, 'utf8');
  const injected = raw.includes('/web-bridge.js')
    ? raw
    : raw.replace('</head>', '  <script src="/web-bridge.js"></script>\n</head>');

  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(injected),
    'Cache-Control': 'no-cache',
  });
  res.end(injected);
}

function resolveFrontendDir() {
  if (fs.existsSync(path.join(DESKTOP_DIST_DIR, 'index.html'))) {
    return DESKTOP_DIST_DIR;
  }
  return FALLBACK_PUBLIC_DIR;
}

function buildServer(config) {
  const runtime = {
    version: readVersion(),
    startedAt: new Date().toISOString(),
    keepAwake: { enabled: false, method: 'none', child: null, reason: null },
    connectionIp: '',
    connectionPollEnabled: true,
    connectionAutoEnabled: false,
    connectionStatus: { is_connected: false, status: 'Disconnected', storage_locations: [] },
    payloadIp: '',
    payloadPollEnabled: true,
    payloadAutoReloadEnabled: false,
    payloadAutoReloadMode: 'current',
    payloadAutoReloadPath: '',
    payloadSendInFlight: false,
    payloadStatus: { status: null, error: null, updated_at_ms: 0 },
    manageIp: '',
    managePath: '/data',
    managePollEnabled: false,
    manageListCache: { path: '/data', entries: [], error: null, updated_at_ms: 0 },
    manageProgress: { op: '', processed: 0, total: 0, current_file: '', active: false, updated_at_ms: 0 },
    manageCancel: false,
    scanCancel: false,
    scanState: {
      active: false,
      files: 0,
      total: 0,
      partial: false,
      reason: null,
      estimated: false,
      elapsed_ms: 0,
      source_path: '',
      updated_at_ms: 0,
    },
    transferCancel: false,
    transferActive: false,
    transferStatus: createTransferStatus(),
    transferMeta: {
      requested_optimize: null,
      auto_tune_connections: null,
      requested_max_throughput: null,
      effective_optimize: null,
      effective_compression: null,
      requested_ftp_connections: null,
      effective_ftp_connections: null,
      preflight_bottleneck: null,
    },
  };
  const sseClients = new Set();
  const SSE_MAX_CLIENTS = 64;
  const sseWrite = (res, type, payload) => {
    try {
      if (res.writableEnded || res.destroyed) return false;
      const envelope = JSON.stringify({ type, payload, ts: Date.now() });
      res.write(`data: ${envelope}\n\n`);
      return true;
    } catch {
      return false;
    }
  };
  const sseBroadcast = (type, payload) => {
    for (const res of Array.from(sseClients)) {
      if (!sseWrite(res, type, payload)) {
        sseClients.delete(res);
        try { res.end(); } catch {}
      }
    }
  };
  const transferSnapshot = () => ({ ...runtime.transferStatus, ...runtime.transferMeta });
  let lastTransferSig = '';
  let lastPayloadSig = '';
  let lastConnSig = '';
  const sseTicker = setInterval(() => {
    const transfer = transferSnapshot();
    const payload = runtime.payloadStatus || { status: null, error: null, updated_at_ms: 0 };
    const conn = runtime.connectionStatus || { is_connected: false, status: 'Disconnected', storage_locations: [] };
    const transferSig = JSON.stringify({
      run_id: transfer.run_id,
      status: transfer.status,
      sent: transfer.sent,
      total: transfer.total,
      files: transfer.files,
      total_speed_bps: transfer.total_speed_bps,
      payload_speed_bps: transfer.payload_speed_bps,
      ftp_speed_bps: transfer.ftp_speed_bps,
      payload_transfer_path: transfer.payload_transfer_path,
      payload_workers: transfer.payload_workers,
      preflight_bottleneck: transfer.preflight_bottleneck || null,
    });
    if (transferSig !== lastTransferSig) {
      lastTransferSig = transferSig;
      sseBroadcast('transfer_status_update', transfer);
    }
    const payloadSig = JSON.stringify({
      status: payload.status || null,
      error: payload.error || null,
      updated_at_ms: payload.updated_at_ms || 0,
    });
    if (payloadSig !== lastPayloadSig) {
      lastPayloadSig = payloadSig;
      sseBroadcast('payload_status_update', payload);
    }
    const connSig = JSON.stringify({
      is_connected: !!conn.is_connected,
      status: conn.status || '',
      storage_count: Array.isArray(conn.storage_locations) ? conn.storage_locations.length : 0,
    });
    if (connSig !== lastConnSig) {
      lastConnSig = connSig;
      sseBroadcast('connection_status_update', conn);
    }
  }, 350);
  if (sseTicker && typeof sseTicker.unref === 'function') sseTicker.unref();
  const sseHeartbeat = setInterval(() => {
    for (const res of Array.from(sseClients)) {
      try {
        if (res.writableEnded || res.destroyed) {
          sseClients.delete(res);
          continue;
        }
        res.write(': ping\n\n');
      } catch {
        sseClients.delete(res);
        try { res.end(); } catch {}
      }
    }
  }, 15000);
  if (sseHeartbeat && typeof sseHeartbeat.unref === 'function') sseHeartbeat.unref();
  const frontendDir = resolveFrontendDir();

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url || '/', 'http://local');

    if (reqUrl.pathname === '/hostfs-browser' && req.method === 'GET') {
      const mode = reqUrl.searchParams.get('mode') === 'save' ? 'save' : 'open';
      const directory = reqUrl.searchParams.get('directory') === '1';
      const token = reqUrl.searchParams.get('token') || '';
      const defaultPath = reqUrl.searchParams.get('defaultPath') || '';
      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Host File Browser</title>
  <style>
    :root{
      --bg:#f4f6f8;--surface:#ffffff;--surface-2:#f8fafc;--surface-3:#ffffff;
      --line:rgba(16,24,40,.12);--text:#1b1f26;--muted:#546274;--accent:#2563eb;--accent-2:#0ea5e9;--ok:#22c55e;
      --btn-neutral-bg:#eef2f7;--btn-neutral-hover:#e2e8f0;--btn-neutral-text:#111827;--btn-neutral-border:rgba(16,24,40,.14);
      --btn-primary-bg:#2563eb;--btn-primary-hover:#1d4ed8;--btn-primary-text:#ffffff;
      --btn-danger-bg:#dc2626;--btn-danger-hover:#b91c1c;--btn-danger-text:#ffffff;
      --focus-ring:0 0 0 3px rgba(37,99,235,.28);
    }
    @media (prefers-color-scheme: dark){
      :root{
        --bg:#070d18;--surface:#0f1729;--surface-2:#101d33;--surface-3:#0d1628;
        --line:rgba(255,255,255,.14);--text:#e8f0ff;--muted:#90a8cf;--accent:#60a5fa;--accent-2:#22d3ee;--ok:#22c55e;
        --btn-neutral-bg:#1f2937;--btn-neutral-hover:#273447;--btn-neutral-text:#e2e8f0;--btn-neutral-border:rgba(255,255,255,.16);
        --btn-primary-bg:#3b82f6;--btn-primary-hover:#2563eb;--btn-primary-text:#f8fafc;
        --btn-danger-bg:#ef4444;--btn-danger-hover:#dc2626;--btn-danger-text:#ffffff;
        --focus-ring:0 0 0 3px rgba(96,165,250,.38);
      }
    }
    *{box-sizing:border-box}
    body{margin:0;font-family:"Noto Sans","Segoe UI",Arial,sans-serif;background:radial-gradient(1000px 560px at 12% -8%,color-mix(in srgb,var(--accent) 24%,transparent) 0%,var(--bg) 56%),var(--bg);color:var(--text)}
    .app{display:grid;grid-template-columns:260px 1fr;grid-template-rows:auto auto 1fr auto;height:100vh}
    .head{grid-column:1/-1;padding:14px 16px;border-bottom:1px solid var(--line);background:linear-gradient(90deg,color-mix(in srgb,var(--surface) 86%,var(--surface-2) 14%),var(--surface-2));font-weight:700}
    .sub{display:block;font-weight:400;color:var(--muted);font-size:12px;margin-top:3px}
    .roots{border-right:1px solid var(--line);overflow:auto;padding:10px 9px;background:linear-gradient(180deg,color-mix(in srgb,var(--surface-2) 92%,transparent),color-mix(in srgb,var(--surface) 88%,transparent))}
    .roots-title{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.12em;margin:4px 6px 10px}
    .rootbtn,.entry{width:100%;text-align:left;border:1px solid var(--line);background:var(--surface);border-radius:11px;padding:8px 10px;margin-bottom:7px;cursor:pointer;color:var(--text);transition:border-color .12s,transform .12s,background .12s}
    .rootbtn{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .rootbtn{background:transparent;border-style:dashed;color:var(--muted)}
    .rootbtn:hover,.entry:hover{border-color:var(--accent);transform:translateY(-1px);background:color-mix(in srgb,var(--surface-2) 88%,var(--accent) 12%)}
    .toolbar{grid-column:2/3;display:flex;gap:8px;padding:10px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--surface) 92%,var(--surface-2) 8%)}
    .toolbar input{flex:1;padding:9px 10px;border:1px solid var(--line);border-radius:9px;background:var(--surface-3);color:var(--text)}
    .toolbar input:focus-visible{outline:none;border-color:var(--accent);box-shadow:var(--focus-ring)}
    .toolbar .small{width:165px;max-width:22vw;min-width:120px}
    .toolbar .toggle{display:flex;align-items:center;gap:6px;padding:0 4px;color:var(--muted);font-size:12px;white-space:nowrap}
    .toolbar .toggle input{accent-color:var(--accent);width:15px;height:15px}
    .list{grid-column:2/3;overflow:auto;padding:10px;background:color-mix(in srgb,var(--surface) 92%,transparent)}
    .entry{display:flex;align-items:center;gap:9px}
    .entry .icon{width:18px;height:18px;min-width:18px;display:flex;align-items:center;justify-content:center;color:#8cb6ff}
    .entry .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
    .entry .meta{margin-left:auto;border:none;background:none;padding:0;color:#7e98c3}
    .entry.sel{border-color:var(--accent-2);background:color-mix(in srgb,var(--surface-2) 72%,var(--accent-2) 28%)}
    .empty{padding:18px 10px;color:var(--muted)}
    .foot{grid-column:1/-1;display:flex;justify-content:space-between;gap:8px;padding:10px;border-top:1px solid var(--line);background:color-mix(in srgb,var(--surface) 90%,var(--surface-2) 10%)}
    .hint{color:var(--muted);font-size:12px;align-self:center}
    button{padding:8px 12px;border:1px solid var(--btn-neutral-border);background:var(--btn-neutral-bg);color:var(--btn-neutral-text);border-radius:9px;cursor:pointer;font-weight:650;transition:background-color .15s,border-color .15s,transform .15s,box-shadow .15s}
    button:hover{background:var(--btn-neutral-hover);border-color:var(--accent);transform:translateY(-1px)}
    button:focus-visible{outline:none;box-shadow:var(--focus-ring)}
    button.primary{background:var(--btn-primary-bg);color:var(--btn-primary-text);border-color:transparent}
    button.primary:hover{background:var(--btn-primary-hover)}
    .group{display:flex;gap:8px}
    @media (max-width: 940px){
      .app{grid-template-columns:1fr;grid-template-rows:auto auto 1fr auto}
      .roots{grid-column:1/2;grid-row:2/3;border-right:none;border-bottom:1px solid var(--line);max-height:130px}
      .toolbar,.list{grid-column:1/2}
      .toolbar{flex-wrap:wrap}
      .toolbar .small{flex:1;min-width:140px;max-width:none}
    }
  </style>
</head>
<body>
  <div class="app">
    <div class="head">Host File Browser<span class="sub">Browse paths on the machine running PS5Upload</span></div>
    <div id="roots" class="roots"><div class="roots-title">Locations</div></div>
    <div class="toolbar">
      <button id="homeBtn" type="button">Home</button>
      <button id="upBtn" type="button">Up</button>
      <input id="pathInput" type="text" />
      <button id="goBtn" type="button">Go</button>
      ${mode === 'save' ? '<input id="nameInput" class="small" type="text" placeholder="File name" />' : ''}
      <input id="filterInput" class="small" type="text" placeholder="Filter name..." />
      <label class="toggle"><input id="showHiddenToggle" type="checkbox" /> Show hidden</label>
    </div>
    <div id="list" class="list"></div>
    <div class="foot">
      <div class="hint">Remembers last path on this host.</div>
      <div class="group">
        <button id="cancelBtn" type="button">Cancel</button>
        <button id="selectBtn" type="button" class="primary">${mode === 'save' ? 'Save' : 'Select'}</button>
      </div>
    </div>
  </div>
<script>
(() => {
  const MODE = ${JSON.stringify(mode)};
  const DIRECTORY = ${directory ? 'true' : 'false'};
  const TOKEN = ${JSON.stringify(token)};
  const DEFAULT_PATH = ${JSON.stringify(defaultPath)};
  const STORAGE_PATH_KEY = 'ps5upload.hostfs.lastPath.' + MODE + '.' + (DIRECTORY ? 'dir' : 'file');
  const STORAGE_SHOW_HIDDEN_KEY = 'ps5upload.hostfs.showHidden';
  const origin = window.location.origin;
  let currentPath = DEFAULT_PATH || localStorage.getItem(STORAGE_PATH_KEY) || '';
  let parentPath = null;
  let selected = null;
  let roots = [];
  let allEntries = [];
  let showHidden = localStorage.getItem(STORAGE_SHOW_HIDDEN_KEY) === '1';
  const rootsEl = document.getElementById('roots');
  const listEl = document.getElementById('list');
  const pathInput = document.getElementById('pathInput');
  const filterInput = document.getElementById('filterInput');
  const showHiddenToggle = document.getElementById('showHiddenToggle');
  const nameInput = document.getElementById('nameInput');
  if (showHiddenToggle) showHiddenToggle.checked = showHidden;
  if (nameInput && DEFAULT_PATH) {
    const parts = DEFAULT_PATH.split(/[\\\\/]/);
    nameInput.value = parts[parts.length - 1] || '';
  }
  async function j(url){
    const r = await fetch(url);
    const p = await r.json();
    if(!r.ok) throw new Error(p && p.error ? p.error : 'request failed');
    return p;
  }
  function done(value){
    if (window.opener) {
      window.opener.postMessage({ type:'ps5upload-hostfs-select', token:TOKEN, value:value }, origin);
    }
    window.close();
  }
  function iconSvg(type) {
    if (type === 'dir') {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 7.5a2.5 2.5 0 0 1 2.5-2.5h4.1l2.1 2.1h6.8A2.5 2.5 0 0 1 21 9.6v8.9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18.5z" stroke="currentColor" stroke-width="1.6"/></svg>';
    }
    if (type === 'file') {
      return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3.8h7.1l4.1 4.1V20.2a1.8 1.8 0 0 1-1.8 1.8H7a1.8 1.8 0 0 1-1.8-1.8V5.6A1.8 1.8 0 0 1 7 3.8z" stroke="currentColor" stroke-width="1.6"/><path d="M14 3.8v4.1h4.1" stroke="currentColor" stroke-width="1.6"/></svg>';
    }
    return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.6"/></svg>';
  }
  function formatBytes(v){
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return '';
    if (n < 1024) return n + ' B';
    const kb = n / 1024;
    if (kb < 1024) return kb.toFixed(1) + ' KB';
    const mb = kb / 1024;
    if (mb < 1024) return mb.toFixed(1) + ' MB';
    const gb = mb / 1024;
    return gb.toFixed(2) + ' GB';
  }
  function renderEntries(entries){
    listEl.innerHTML = '';
    const filter = filterInput && filterInput.value ? filterInput.value.trim().toLowerCase() : '';
    const visible = (entries || []).filter((e) => {
      if (!showHidden && e.name && e.name[0] === '.') return false;
      if (!filter) return true;
      return String(e.name || '').toLowerCase().includes(filter);
    });
    if(!visible || visible.length===0){ listEl.innerHTML = '<div class="empty">No items to show.</div>'; return; }
    visible.forEach((e) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'entry';
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.innerHTML = iconSvg(e.type);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = e.name || '';
      const meta = document.createElement('span');
      meta.className = 'meta';
      if (e.type === 'dir') {
        const c = Number(e.child_count);
        if (Number.isFinite(c) && c >= 0) {
          meta.textContent = c + (c === 1 ? ' item' : ' items');
        } else {
          meta.textContent = '';
        }
      } else if (e.type === 'file') {
        meta.textContent = formatBytes(e.size);
      } else {
        meta.textContent = '';
      }
      btn.appendChild(icon);
      btn.appendChild(name);
      if (meta.textContent) btn.appendChild(meta);
      btn.onclick = () => {
        selected = e.path;
        listEl.querySelectorAll('.entry.sel').forEach((el) => el.classList.remove('sel'));
        btn.classList.add('sel');
      };
      btn.ondblclick = () => { if(e.type==='dir'){ loadPath(e.path); } else if(!DIRECTORY){ done(e.path); } };
      listEl.appendChild(btn);
    });
  }
  async function loadRoots(){
    const p = await j('/api/hostfs/roots');
    roots = p.roots || [];
    rootsEl.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'roots-title';
    title.textContent = 'Locations';
    rootsEl.appendChild(title);
    roots.forEach((r) => {
      const b = document.createElement('button');
      b.type='button'; b.className='rootbtn'; b.textContent = r.label || r.path;
      b.onclick = () => loadPath(r.path);
      rootsEl.appendChild(b);
    });
    if (!currentPath && roots[0]) currentPath = roots[0].path;
  }
  async function loadPath(p){
    const payload = await j('/api/hostfs/list?path=' + encodeURIComponent(p || currentPath || ''));
    currentPath = payload.path;
    parentPath = payload.parent;
    localStorage.setItem(STORAGE_PATH_KEY, currentPath);
    pathInput.value = currentPath;
    selected = DIRECTORY ? currentPath : null;
    allEntries = payload.entries || [];
    renderEntries(allEntries);
  }
  if (filterInput) {
    filterInput.addEventListener('input', () => renderEntries(allEntries));
  }
  if (showHiddenToggle) {
    showHiddenToggle.addEventListener('change', () => {
      showHidden = !!showHiddenToggle.checked;
      localStorage.setItem(STORAGE_SHOW_HIDDEN_KEY, showHidden ? '1' : '0');
      renderEntries(allEntries);
    });
  }
  if (pathInput) {
    pathInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') loadPath(pathInput.value);
    });
  }
  document.getElementById('homeBtn').onclick = () => {
    if (roots[0] && roots[0].path) loadPath(roots[0].path);
  };
  document.getElementById('upBtn').onclick = () => { if(parentPath) loadPath(parentPath); };
  document.getElementById('goBtn').onclick = () => loadPath(pathInput.value);
  document.getElementById('cancelBtn').onclick = () => done(null);
  document.getElementById('selectBtn').onclick = () => {
    if (MODE === 'save') {
      const n = nameInput ? nameInput.value.trim() : '';
      const sep = currentPath.includes('\\\\') && !currentPath.includes('/') ? '\\\\' : '/';
      const out = n ? (currentPath.endsWith('/') || currentPath.endsWith('\\\\') ? currentPath + n : currentPath + sep + n) : currentPath;
      done(out);
      return;
    }
    if (!selected) { done(null); return; }
    done(selected);
  };
  loadRoots().then(() => loadPath(currentPath)).catch((e) => { listEl.innerHTML = '<div style="padding:8px;color:#fca5a5">Error: '+e.message+'</div>'; });
})();
</script>
</body>
</html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(html);
      return;
    }

    if (reqUrl.pathname === '/api/hostfs/roots' && req.method === 'GET') {
      sendJson(res, 200, { roots: listHostRoots() });
      return;
    }

    if (reqUrl.pathname === '/api/hostfs/list' && req.method === 'GET') {
      try {
        const payload = await listHostDirectory(reqUrl.searchParams.get('path'));
        sendJson(res, 200, payload);
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err && err.message ? err.message : 'Failed to list path' });
      }
      return;
    }

    if (reqUrl.pathname === '/api/health' && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        service: 'ps5upload-app',
        version: runtime.version,
        started_at: runtime.startedAt,
        frontend: path.relative(ROOT_DIR, frontendDir),
      });
      return;
    }

    if (reqUrl.pathname === '/api/config' && req.method === 'GET') {
      sendJson(res, 200, {
        host: config.host,
        port: config.port,
        version: runtime.version,
      });
      return;
    }

    if (reqUrl.pathname === '/api/network/interfaces' && req.method === 'GET') {
      sendJson(res, 200, {
        interfaces: listNetworkInterfaces(),
      });
      return;
    }

    if (reqUrl.pathname === '/api/invoke' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req);
        const cmd = body && body.cmd ? String(body.cmd) : '';
        const args = body && body.args ? body.args : {};
        if (!cmd) {
          sendJson(res, 400, { ok: false, error: 'cmd is required' });
          return;
        }
        const result = await handleInvoke(cmd, args, runtime);
        sendJson(res, 200, { ok: true, result });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err && err.message ? err.message : 'invoke failed' });
      }
      return;
    }

    if (reqUrl.pathname === '/api/events' && req.method === 'GET') {
      if (sseClients.size >= SSE_MAX_CLIENTS) {
        res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Too many event clients' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      // Send initial snapshots immediately so UI can paint without polling delay.
      sseWrite(res, 'transfer_status_update', transferSnapshot());
      sseWrite(res, 'payload_status_update', runtime.payloadStatus || { status: null, error: null, updated_at_ms: 0 });
      sseWrite(res, 'connection_status_update', runtime.connectionStatus || { is_connected: false, status: 'Disconnected', storage_locations: [] });
      req.on('close', () => {
        sseClients.delete(res);
        try { res.end(); } catch {}
      });
      res.on('error', () => {
        sseClients.delete(res);
        try { res.end(); } catch {}
      });
      return;
    }

    if (reqUrl.pathname === '/api/port-check' && req.method === 'GET') {
      const ip = (reqUrl.searchParams.get('ip') || '').trim();
      const portRaw = (reqUrl.searchParams.get('port') || '').trim();
      const port = Number.parseInt(portRaw, 10);

      if (!ip || !Number.isFinite(port) || port <= 0 || port > 65535) {
        sendJson(res, 400, { ok: false, error: 'ip and valid port are required' });
        return;
      }

      const result = await checkPort(ip, port);
      sendJson(res, 200, {
        ok: true,
        ip,
        port,
        reachable: result.reachable,
        error: result.error,
      });
      return;
    }

    if (reqUrl.pathname.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }

    serveFrontend(req, res, frontendDir);
  });
  server.on('close', () => {
    clearInterval(sseTicker);
    clearInterval(sseHeartbeat);
    for (const res of Array.from(sseClients)) {
      try { res.end(); } catch {}
    }
    sseClients.clear();
  });
  server.__runtime = runtime;
  return server;
}

function main() {
  const config = getRuntimeConfig();
  const server = buildServer(config);

  server.listen(config.port, config.host, () => {
    console.log(`[app] PS5Upload app server listening on ${config.host}:${config.port}`);
    if (config.host === '0.0.0.0') {
      console.log(`[app] Access URLs: http://127.0.0.1:${config.port} and http://<server-lan-ip>:${config.port}`);
    }
  });

  const shutdown = () => {
    if (server.__runtime && server.__runtime.keepAwake) {
      stopKeepAwake(server.__runtime);
    }
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
