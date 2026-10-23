import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as ort from "onnxruntime-node";

export const MODEL = {
  id: "htdemucs-fp16weights",
  version: "1",
  filename: "htdemucs_fp16weights.onnx",
  url: "https://huggingface.co/StemSplitio/htdemucs-onnx/resolve/main/htdemucs_fp16weights.onnx",
  sha256: "d05c269d0178d2a72ad484b10b11dd370193fc923201c3b27a99f848745db70a",
  bytes: 165612636,
  sampleRate: 44100,
  frameCount: 343980,
} as const;

export const MODEL_OVERLAP = Math.floor(MODEL.frameCount / 4);
export const MODEL_STRIDE = MODEL.frameCount - MODEL_OVERLAP;
export const PART_IDS = ["drums", "bass", "other", "vocals"] as const;
export type PartId = (typeof PART_IDS)[number];

export interface ChunkPlan {
  index: number;
  start: number;
  length: number;
}

export const planChunks = (totalFrames: number): ChunkPlan[] => {
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) return [];
  const chunks: ChunkPlan[] = [];
  for (let start = 0, index = 0; start < totalFrames; start += MODEL_STRIDE, index += 1) {
    chunks.push({ index, start, length: Math.min(MODEL.frameCount, totalFrames - start) });
  }
  return chunks;
};

export const transitionWindow = (length: number, overlap: number): Float32Array => {
  const window = new Float32Array(length);
  const ramp = Math.max(1, Math.floor(overlap));
  for (let i = 0; i < length; i += 1) {
    if (i < ramp) window[i] = i / ramp;
    else if (i >= length - ramp) window[i] = Math.max(0, (length - i) / ramp);
    else window[i] = 1;
  }
  return window;
};

export const toInt16 = (data: Float32Array): Int16Array => {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    const value = Math.max(-1, Math.min(1, data[i]));
    out[i] = Math.round(value * 32767);
  }
  return out;
};

export const fromInt16 = (data: Int16Array): Float32Array => {
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = data[i] / 32768;
  return out;
};

const safe = (value: string): string => value.replace(/[^a-z0-9._-]+/gi, "_").replace(/^\.+/, "_").slice(0, 80) || "model";

export const cacheDirName = (hash: string, modelVersion: string): string => `${safe(hash)}-${safe(modelVersion)}`;

export const resampleLinear = (data: Float32Array, from: number, to: number): Float32Array => {
  if (!data.length) return new Float32Array(0);
  if (from === to) return data;
  const length = Math.max(1, Math.round((data.length * to) / from));
  const out = new Float32Array(length);
  const ratio = from / to;
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const index = Math.floor(position);
    const next = Math.min(data.length - 1, index + 1);
    const t = position - index;
    out[i] = data[index] * (1 - t) + data[next] * t;
  }
  return out;
};

export interface SeparationProgress {
  stage: "download" | "prepare" | "separate" | "write" | "done";
  percent: number;
  detail: string;
}

export interface SeparateRequest {
  hash: string;
  sampleRate: number;
  left: Float32Array;
  right: Float32Array;
  trackPath?: string | null;
  modelPath?: string | null;
}

export interface StemManifest {
  version: 1;
  model: string;
  modelVersion: string;
  hash: string;
  sampleRate: number;
  frames: number;
  createdAt: string;
  parts: Record<PartId, { file: string; bytes: number }>;
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;
let sessionPath = "";

const getSession = async (modelPath: string): Promise<ort.InferenceSession> => {
  if (!sessionPromise || sessionPath !== modelPath) {
    sessionPath = modelPath;
    sessionPromise = ort.InferenceSession.create(modelPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
      intraOpNumThreads: Math.max(1, Math.min(8, os.cpus().length - 1)),
    });
  }
  return sessionPromise;
};

export const modelInfo = async (modelPath: string): Promise<{ path: string; ready: boolean; bytes: number }> => {
  try {
    const stat = await fs.stat(modelPath);
    return { path: modelPath, ready: stat.size === MODEL.bytes, bytes: stat.size };
  } catch {
    return { path: modelPath, ready: false, bytes: 0 };
  }
};

const sha256File = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
};

export const installModel = async (
  modelPath: string,
  onProgress: (progress: SeparationProgress) => void,
  expectedSha = MODEL.sha256,
): Promise<string> => {
  if (existsSync(modelPath)) {
    const stat = await fs.stat(modelPath);
    if (stat.size === MODEL.bytes) {
      const digest = await sha256File(modelPath);
      if (digest === expectedSha) return modelPath;
    }
    await fs.rm(modelPath, { force: true });
  }
  await fs.mkdir(path.dirname(modelPath), { recursive: true });
  const temp = `${modelPath}.download`;
  await fs.rm(temp, { force: true });
  onProgress({ stage: "download", percent: 0, detail: "Starting model download" });
  const response = await fetch(MODEL.url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length") || MODEL.bytes);
  let received = 0;
  const meter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      onProgress({
        stage: "download",
        percent: Math.min(99, Math.round((received / total) * 100)),
        detail: `${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`,
      });
      controller.enqueue(chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body.pipeThrough(meter) as never), createWriteStream(temp));
  const digest = await sha256File(temp);
  if (digest !== expectedSha) {
    await fs.rm(temp, { force: true });
    throw new Error(`Model checksum mismatch: ${digest}`);
  }
  await fs.rename(temp, modelPath);
  onProgress({ stage: "download", percent: 100, detail: "Model installed" });
  return modelPath;
};

export const cacheCandidates = (trackPath: string | null | undefined, hash: string, appData: string): string[] => {
  const name = cacheDirName(hash, MODEL.version);
  const roots: string[] = [];
  if (trackPath && path.isAbsolute(trackPath)) roots.push(path.dirname(trackPath));
  roots.push(path.join(appData, "stems"));
  return roots.map((root) => path.join(root, ".opendeck-stems", name));
};

const readManifest = async (dir: string): Promise<StemManifest | null> => {
  try {
    const data = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as StemManifest;
    if (data.version !== 1 || data.modelVersion !== MODEL.version) return null;
    for (const id of PART_IDS) {
      const part = data.parts?.[id];
      if (!part?.file) return null;
      const stat = await fs.stat(path.join(dir, part.file));
      if (stat.size !== part.bytes) return null;
    }
    return data;
  } catch {
    return null;
  }
};

export const findCache = async (trackPath: string | null | undefined, hash: string, appData: string): Promise<StemManifest | null> => {
  for (const dir of cacheCandidates(trackPath, hash, appData)) {
    const manifest = await readManifest(dir);
    if (manifest) return { ...manifest, dir } as StemManifest & { dir: string };
  }
  return null;
};

const pickCacheDir = async (trackPath: string | null | undefined, hash: string, appData: string): Promise<string> => {
  const candidates = cacheCandidates(trackPath, hash, appData);
  for (const dir of candidates) {
    try {
      await fs.mkdir(path.dirname(dir), { recursive: true });
      const probe = path.join(path.dirname(dir), `.probe-${process.pid}`);
      await fs.writeFile(probe, "ok");
      await fs.rm(probe, { force: true });
      return dir;
    } catch {
      // try the next location
    }
  }
  return candidates[candidates.length - 1];
};

export const readCache = async (manifest: StemManifest): Promise<Record<PartId, { left: Float32Array; right: Float32Array }>> => {
  const dir = (manifest as StemManifest & { dir?: string }).dir ?? "";
  if (!dir) throw new Error("Stem cache location missing");
  const out = {} as Record<PartId, { left: Float32Array; right: Float32Array }>;
  for (const id of PART_IDS) {
    const file = path.join(dir, manifest.parts[id].file);
    const raw = await fs.readFile(file);
    const buffer = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    const interleaved = fromInt16(buffer);
    const left = new Float32Array(manifest.frames);
    const right = new Float32Array(manifest.frames);
    for (let i = 0; i < manifest.frames; i += 1) {
      left[i] = interleaved[i * 2];
      right[i] = interleaved[i * 2 + 1];
    }
    out[id] = { left, right };
  }
  return out;
};

export const separateToCache = async (
  request: SeparateRequest,
  modelPath: string,
  appData: string,
  onProgress: (progress: SeparationProgress) => void,
): Promise<StemManifest> => {
  const left = resampleLinear(request.left, request.sampleRate, MODEL.sampleRate);
  const right = resampleLinear(request.right, request.sampleRate, MODEL.sampleRate);
  const frames = Math.min(left.length, right.length);
  const chunks = planChunks(frames);
  if (!chunks.length) throw new Error("No audio to separate");
  const session = await getSession(modelPath);
  const inputs = session.inputNames;
  const outputs = session.outputNames;
  const inputName = inputs.includes("mix") ? "mix" : inputs[0];
  const outputName = outputs.includes("stems") ? "stems" : outputs[0];
  onProgress({ stage: "prepare", percent: 0, detail: `Preparing ${chunks.length} chunks` });
  const parts = {} as Record<PartId, [Float32Array, Float32Array]>;
  for (const id of PART_IDS) parts[id] = [new Float32Array(frames), new Float32Array(frames)];
  const weight = new Float32Array(frames);
  const window = transitionWindow(MODEL.frameCount, MODEL_OVERLAP);
  const chunk = new Float32Array(2 * MODEL.frameCount);
  const shape = [1, 2, MODEL.frameCount];

  for (const plan of chunks) {
    chunk.fill(0);
    for (let i = 0; i < plan.length; i += 1) {
      chunk[i] = left[plan.start + i];
      chunk[MODEL.frameCount + i] = right[plan.start + i];
    }
    const tensor = new ort.Tensor("float32", chunk, shape);
    const result = await session.run({ [inputName]: tensor });
    const data = result[outputName].data as Float32Array;
    const stride = 2 * MODEL.frameCount;
    for (let part = 0; part < PART_IDS.length; part += 1) {
      const output = parts[PART_IDS[part]];
      const base = part * stride;
      for (let i = 0; i < plan.length; i += 1) {
        const gain = window[i];
        output[0][plan.start + i] += data[base + i] * gain;
        output[1][plan.start + i] += data[base + MODEL.frameCount + i] * gain;
      }
    }
    for (let i = 0; i < plan.length; i += 1) weight[plan.start + i] += window[i];
    onProgress({
      stage: "separate",
      percent: Math.round(((plan.index + 1) / chunks.length) * 100),
      detail: `Chunk ${plan.index + 1} of ${chunks.length}`,
    });
  }

  const dir = await pickCacheDir(request.trackPath, request.hash, appData);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const manifest: StemManifest = {
    version: 1,
    model: MODEL.id,
    modelVersion: MODEL.version,
    hash: request.hash,
    sampleRate: MODEL.sampleRate,
    frames,
    createdAt: new Date().toISOString(),
    parts: {} as StemManifest["parts"],
  };
  for (const id of PART_IDS) {
    const [l, r] = parts[id];
    const interleaved = new Float32Array(frames * 2);
    for (let i = 0; i < frames; i += 1) {
      const normal = weight[i] > 0 ? 1 / weight[i] : 0;
      interleaved[i * 2] = l[i] * normal;
      interleaved[i * 2 + 1] = r[i] * normal;
    }
    const file = `${id}.i16`;
    const bytes = toInt16(interleaved);
    await fs.writeFile(path.join(dir, file), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    manifest.parts[id] = { file, bytes: bytes.byteLength };
  }
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  onProgress({ stage: "done", percent: 100, detail: "Stems ready" });
  return { ...manifest, dir } as StemManifest & { dir: string };
};

export const loadManifestAt = async (dir: string): Promise<StemManifest | null> => {
  const manifest = await readManifest(dir);
  if (!manifest) return null;
  return { ...manifest, dir } as StemManifest & { dir: string };
};
