#!/usr/bin/env node
'use strict';

function parseArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx < 0 || idx + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[idx + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const totalMb = parseArg('--mb', 256);
const minChunk = parseArg('--min-chunk', 1024);
const maxChunk = parseArg('--max-chunk', 64 * 1024);
const frameSize = parseArg('--frame', 4096);
const iterations = parseArg('--iterations', 7);
const warmup = parseArg('--warmup', 2);
const seedInput = parseArg('--seed', Date.now() & 0xffffffff);
const emitJson = process.argv.includes('--json');
let seed = 0;

function rnd() {
  seed = (1664525 * seed + 1013904223) >>> 0;
  return seed / 0x100000000;
}

function buildChunks(totalBytes) {
  const chunks = [];
  let remaining = totalBytes;
  while (remaining > 0) {
    const want = Math.min(
      remaining,
      Math.floor(minChunk + rnd() * (maxChunk - minChunk + 1))
    );
    const buf = Buffer.allocUnsafe(want);
    buf.fill(0xaa);
    chunks.push(buf);
    remaining -= want;
  }
  return chunks;
}

class ConcatReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }
  available() {
    return this.buffer.length;
  }
  readExact(len) {
    const out = this.buffer.subarray(0, len);
    this.buffer = this.buffer.subarray(len);
    return out;
  }
}

class QueueReader {
  constructor() {
    this.chunks = [];
    this.total = 0;
  }
  push(chunk) {
    this.chunks.push(chunk);
    this.total += chunk.length;
  }
  available() {
    return this.total;
  }
  readExact(len) {
    const out = Buffer.allocUnsafe(len);
    let copied = 0;
    while (copied < len && this.chunks.length > 0) {
      const head = this.chunks[0];
      const take = Math.min(head.length, len - copied);
      head.copy(out, copied, 0, take);
      copied += take;
      this.total -= take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    return out;
  }
}

function runBench(name, ReaderCtor, chunks, frameLen) {
  const reader = new ReaderCtor();
  const start = process.hrtime.bigint();
  let consumed = 0;
  for (const chunk of chunks) {
    reader.push(chunk);
    while (reader.available() >= frameLen) {
      reader.readExact(frameLen);
      consumed += frameLen;
    }
  }
  if (reader.available() > 0) {
    const tail = reader.available();
    reader.readExact(tail);
    consumed += tail;
  }
  const end = process.hrtime.bigint();
  const sec = Number(end - start) / 1e9;
  const mbps = consumed / (1024 * 1024) / sec;
  return { name, sec, mbps, consumed };
}

const totalBytes = totalMb * 1024 * 1024;
const allConcat = [];
const allQueue = [];

for (let i = 0; i < warmup + iterations; i += 1) {
  seed = (seedInput + i) >>> 0;
  const chunks = buildChunks(totalBytes);
  const concatResult = runBench('concat', ConcatReader, chunks, frameSize);
  const queueResult = runBench('queue', QueueReader, chunks, frameSize);
  if (i < warmup) continue;
  allConcat.push(concatResult.mbps);
  allQueue.push(queueResult.mbps);
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function mean(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

const concatMean = mean(allConcat);
const queueMean = mean(allQueue);
const concatMedian = percentile(allConcat, 50);
const queueMedian = percentile(allQueue, 50);
const concatP95 = percentile(allConcat, 95);
const queueP95 = percentile(allQueue, 95);
const speedupMean = queueMean / concatMean;
const speedupMedian = queueMedian / concatMedian;

console.log(`seed=${seedInput} total=${totalMb}MB frame=${frameSize}B warmup=${warmup} iterations=${iterations}`);
console.log(`concat mean  : ${concatMean.toFixed(2)} MB/s`);
console.log(`concat median: ${concatMedian.toFixed(2)} MB/s`);
console.log(`concat p95   : ${concatP95.toFixed(2)} MB/s`);
console.log(`queue  mean  : ${queueMean.toFixed(2)} MB/s`);
console.log(`queue  median: ${queueMedian.toFixed(2)} MB/s`);
console.log(`queue  p95   : ${queueP95.toFixed(2)} MB/s`);
console.log(`speedup mean(queue/concat)  : ${speedupMean.toFixed(2)}x`);
console.log(`speedup median(queue/concat): ${speedupMedian.toFixed(2)}x`);
if (emitJson) {
  console.log(JSON.stringify({
    seed: seedInput,
    total_mb: totalMb,
    frame_size: frameSize,
    warmup,
    iterations,
    concat: {
      mean_mbps: concatMean,
      median_mbps: concatMedian,
      p95_mbps: concatP95,
    },
    queue: {
      mean_mbps: queueMean,
      median_mbps: queueMedian,
      p95_mbps: queueP95,
    },
    speedup: {
      mean: speedupMean,
      median: speedupMedian,
    },
  }));
}
