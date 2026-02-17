'use strict';

function commandForRemoteHashAlgorithm(algorithm) {
  switch (String(algorithm || 'sha256').toLowerCase()) {
    case 'blake3':
      return 'HASH_FILE_B3';
    case 'xxh64':
      return 'HASH_FILE_FAST';
    default:
      return 'HASH_FILE';
  }
}

function chooseResumeHashAlgorithm(payloadCaps, resumeMode, supportsAlgorithm) {
  if (resumeMode === 'sha256') {
    return 'sha256';
  }
  const features = payloadCaps && payloadCaps.features && typeof payloadCaps.features === 'object'
    ? payloadCaps.features
    : {};
  const supports = typeof supportsAlgorithm === 'function'
    ? supportsAlgorithm
    : () => false;
  if (features.hash_blake3 === true && supports('blake3')) {
    return 'blake3';
  }
  if (features.hash_fast === true && supports('xxh64')) {
    return 'xxh64';
  }
  return 'sha256';
}

module.exports = {
  commandForRemoteHashAlgorithm,
  chooseResumeHashAlgorithm,
};
