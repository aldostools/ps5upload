'use strict';

const fs = require('fs');
const path = require('path');

function payloadPathIsElf(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  return ext === '.elf' || ext === '.bin';
}

function findLocalPayloadElf(candidates) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    try {
      if (fs.existsSync(candidate) && payloadPathIsElf(candidate)) return candidate;
    } catch {
      // ignore invalid candidate path
    }
  }
  return null;
}

function createLocalPayloadElfFinder(options) {
  const pathModule = options && options.pathModule;
  const baseDir = options && options.baseDir;
  const includeParentPayload = Boolean(options && options.includeParentPayload);
  const payloadRelativePath = (options && options.payloadRelativePath) || '../payload/ps5upload.elf';
  const includeCwdPayload = options && options.includeCwdPayload !== false;
  const includeCwdRoot = options && options.includeCwdRoot !== false;
  return function findLocalPayloadElfFromDefaults() {
    const candidates = [];
    if (includeParentPayload && pathModule && baseDir) {
      candidates.push(pathModule.resolve(baseDir, payloadRelativePath));
    }
    if (includeCwdPayload && pathModule) {
      candidates.push(pathModule.resolve(process.cwd(), 'payload/ps5upload.elf'));
    }
    if (includeCwdRoot && pathModule) {
      candidates.push(pathModule.resolve(process.cwd(), 'ps5upload.elf'));
    }
    return findLocalPayloadElf(candidates);
  };
}

function probePayloadFile(filepath) {
  if (!payloadPathIsElf(filepath)) {
    return { is_ps5upload: false, code: 'payload_probe_invalid_ext' };
  }
  const nameMatch = String(filepath || '').toLowerCase().includes('ps5upload');
  const content = fs.readFileSync(filepath, { encoding: null }).slice(0, 512 * 1024);
  const signatureMatch = content.includes(Buffer.from('ps5upload')) || content.includes(Buffer.from('PS5UPLOAD'));
  if (nameMatch || signatureMatch) {
    return { is_ps5upload: true, code: 'payload_probe_detected' };
  }
  return { is_ps5upload: false, code: 'payload_probe_no_signature' };
}

module.exports = {
  payloadPathIsElf,
  findLocalPayloadElf,
  createLocalPayloadElfFinder,
  probePayloadFile,
};
