// Portmapper (RFC 1057 appendix A), MOUNT v1 and NFS v2 (RFC 1094) client
// procedures over the RPC client in rpc.ts. Clean-room from the RFCs.
//
// Pioneer players run a non-standard NFS server: file names on the wire are
// UTF-16LE rather than ASCII. The client therefore treats names as raw bytes
// and encodes them with a selectable NameEncoding. Mount tries UTF-16LE first
// and falls back to ASCII, and remembers whichever worked for that export.
import { RpcError, RpcUdpClient, type RpcCallOptions } from "./rpc.ts";
import { XdrReader, XdrWriter } from "./xdr.ts";

export const PMAP_PROG = 100000;
export const PMAP_VERS = 2;
export const PMAPPROC_GETPORT = 3;
export const MOUNT_PROG = 100005;
export const MOUNT_VERS = 1;
export const MOUNTPROC_MNT = 1;
export const MOUNTPROC_UMNT = 3;
export const NFS_PROG = 100003;
export const NFS_VERS = 2;
export const NFSPROC_GETATTR = 1;
export const NFSPROC_LOOKUP = 4;
export const NFSPROC_READ = 6;
export const NFSPROC_READDIR = 16;
export const IPPROTO_UDP = 17;
export const FHSIZE = 32;
export const NFS_MAXDATA = 8192;

export const NFSERR: Record<number, string> = {
  1: "PERM",
  2: "NOENT",
  5: "IO",
  6: "NXIO",
  13: "ACCES",
  17: "EXIST",
  19: "NODEV",
  20: "NOTDIR",
  21: "ISDIR",
  27: "FBIG",
  28: "NOSPC",
  30: "ROFS",
  63: "NAMETOOLONG",
  66: "NOTEMPTY",
  69: "DQUOT",
  70: "STALE",
};

export type NameEncoding = "utf16le" | "ascii";

export class NfsError extends Error {
  readonly status: number;
  constructor(op: string, status: number, detail = "") {
    super(`NFS ${op} failed: ${NFSERR[status] ?? status}${detail ? ` (${detail})` : ""}`);
    this.status = status;
  }
}

export const NF_REG = 1;
export const NF_DIR = 2;

export interface Fattr {
  type: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  size: number;
  blocksize: number;
  rdev: number;
  blocks: number;
  fsid: number;
  fileid: number;
  atime: number;
  mtime: number;
  ctime: number;
}

export function readFattr(r: XdrReader): Fattr {
  const type = r.uint();
  const mode = r.uint();
  const nlink = r.uint();
  const uid = r.uint();
  const gid = r.uint();
  const size = r.uint();
  const blocksize = r.uint();
  const rdev = r.uint();
  const blocks = r.uint();
  const fsid = r.uint();
  const fileid = r.uint();
  const atime = r.uint();
  r.uint();
  const mtime = r.uint();
  r.uint();
  const ctime = r.uint();
  r.uint();
  return { type, mode, nlink, uid, gid, size, blocksize, rdev, blocks, fsid, fileid, atime, mtime, ctime };
}

export function writeFattr(w: XdrWriter, a: Partial<Fattr> & { type: number; size: number }): void {
  w.uint(a.type).uint(a.mode ?? (a.type === NF_DIR ? 0o40755 : 0o100644)).uint(a.nlink ?? 1).uint(a.uid ?? 0).uint(a.gid ?? 0);
  w.uint(a.size).uint(a.blocksize ?? 4096).uint(a.rdev ?? 0).uint(a.blocks ?? Math.ceil(a.size / 512)).uint(a.fsid ?? 1).uint(a.fileid ?? 0);
  w.uint(a.atime ?? 0).uint(0).uint(a.mtime ?? 0).uint(0).uint(a.ctime ?? 0).uint(0);
}

export function encodeName(name: string, encoding: NameEncoding): Buffer {
  return Buffer.from(name, encoding === "utf16le" ? "utf16le" : "latin1");
}

/** Decode a name that might be UTF-16LE (Pioneer) or ASCII/UTF-8 (standard). */
export function decodeName(bytes: Buffer, hint?: NameEncoding): string {
  if (hint === "ascii") return bytes.toString("utf8");
  if (hint === "utf16le" || looksUtf16le(bytes)) {
    let s = bytes.toString("utf16le");
    while (s.endsWith("\u0000")) s = s.slice(0, -1);
    return s;
  }
  return bytes.toString("utf8");
}

export function looksUtf16le(bytes: Buffer): boolean {
  if (bytes.length < 2 || bytes.length % 2 !== 0) return false;
  let zeroHigh = 0;
  for (let i = 1; i < bytes.length; i += 2) if (bytes[i] === 0) zeroHigh++;
  return zeroHigh >= Math.ceil(bytes.length / 4);
}

export interface PortmapOptions extends RpcCallOptions {
  portmapPort?: number;
}

export async function getPort(client: RpcUdpClient, prog: number, vers: number, opts: PortmapOptions = {}): Promise<number> {
  const args = new XdrWriter().uint(prog).uint(vers).uint(IPPROTO_UDP).uint(0).bytes();
  const res = await client.call(opts.portmapPort ?? 111, PMAP_PROG, PMAP_VERS, PMAPPROC_GETPORT, args, opts);
  const port = new XdrReader(res).uint();
  if (!port) throw new RpcError(`program ${prog} v${vers} is not registered with the portmapper on ${client.host}`, "NOT_REGISTERED");
  return port;
}

export interface DirEntry {
  name: string;
  fileid: number;
  cookie: Buffer;
}

export interface NfsClientOptions extends PortmapOptions {
  /** Encoding order to try for the mount path and names. */
  encodings?: NameEncoding[];
  readSize?: number;
  concurrency?: number;
  bindAddress?: string;
}

export interface ReadProgress {
  done: number;
  total: number;
}

/**
 * A mounted export on one player. Create with NfsClient.mount(host, "/C/").
 */
export class NfsClient {
  readonly rpc: RpcUdpClient;
  readonly root: Buffer;
  readonly nfsPort: number;
  readonly encoding: NameEncoding;
  readonly exportPath: string;
  private opts: NfsClientOptions;
  private handles = new Map<string, { fh: Buffer; attr: Fattr | null }>();

  private constructor(rpc: RpcUdpClient, root: Buffer, nfsPort: number, encoding: NameEncoding, exportPath: string, opts: NfsClientOptions) {
    this.rpc = rpc;
    this.root = root;
    this.nfsPort = nfsPort;
    this.encoding = encoding;
    this.exportPath = exportPath;
    this.opts = opts;
    this.handles.set("", { fh: root, attr: null });
  }

  static async mount(host: string, exportPath: string, opts: NfsClientOptions = {}): Promise<NfsClient> {
    const rpc = new RpcUdpClient(host, { bindAddress: opts.bindAddress });
    try {
      const mountPort = await getPort(rpc, MOUNT_PROG, MOUNT_VERS, opts);
      const nfsPort = await getPort(rpc, NFS_PROG, NFS_VERS, opts);
      const encodings = opts.encodings ?? ["utf16le", "ascii"];
      let lastError: Error | null = null;
      for (const encoding of encodings) {
        try {
          const args = new XdrWriter().opaque(encodeName(exportPath, encoding)).bytes();
          const res = await rpc.call(mountPort, MOUNT_PROG, MOUNT_VERS, MOUNTPROC_MNT, args, opts);
          const r = new XdrReader(res);
          const status = r.uint();
          if (status !== 0) throw new NfsError("MNT", status, exportPath);
          const fh = r.fixedOpaque(FHSIZE);
          return new NfsClient(rpc, fh, nfsPort, encoding, exportPath, opts);
        } catch (error) {
          lastError = error as Error;
          if (!(error instanceof NfsError)) break; // transport trouble: do not try other encodings
        }
      }
      throw lastError ?? new Error("mount failed");
    } catch (error) {
      rpc.close();
      throw error;
    }
  }

  close(): void {
    this.rpc.close();
  }

  private nfs(proc: number, args: Buffer): Promise<Buffer> {
    return this.rpc.call(this.nfsPort, NFS_PROG, NFS_VERS, proc, args, this.opts);
  }

  async getattr(fh: Buffer): Promise<Fattr> {
    const res = await this.nfs(NFSPROC_GETATTR, new XdrWriter().fixedOpaque(fh).bytes());
    const r = new XdrReader(res);
    const status = r.uint();
    if (status !== 0) throw new NfsError("GETATTR", status);
    return readFattr(r);
  }

  async lookup(dir: Buffer, name: string): Promise<{ fh: Buffer; attr: Fattr }> {
    const args = new XdrWriter().fixedOpaque(dir).opaque(encodeName(name, this.encoding)).bytes();
    const res = await this.nfs(NFSPROC_LOOKUP, args);
    const r = new XdrReader(res);
    const status = r.uint();
    if (status !== 0) throw new NfsError("LOOKUP", status, name);
    const fh = r.fixedOpaque(FHSIZE);
    return { fh, attr: readFattr(r) };
  }

  /** Resolve a slash-separated path relative to the export root. */
  async lookupPath(path: string): Promise<{ fh: Buffer; attr: Fattr | null }> {
    const parts = path.split("/").filter((p) => p && p !== ".");
    let key = "";
    let current = this.handles.get("")!;
    for (const part of parts) {
      if (part === "..") throw new NfsError("LOOKUP", 2, "parent traversal refused");
      const nextKey = key ? `${key}/${part}` : part;
      const cached = this.handles.get(nextKey);
      if (cached) {
        current = cached;
      } else {
        const found = await this.lookup(current.fh, part);
        current = { fh: found.fh, attr: found.attr };
        this.handles.set(nextKey, current);
      }
      key = nextKey;
    }
    return current;
  }

  async readdir(dir: Buffer, count = 4096): Promise<DirEntry[]> {
    const out: DirEntry[] = [];
    let cookie: Buffer = Buffer.alloc(4);
    for (let guard = 0; guard < 10000; guard++) {
      const args = new XdrWriter().fixedOpaque(dir).fixedOpaque(cookie).uint(count).bytes();
      const res = await this.nfs(NFSPROC_READDIR, args);
      const r = new XdrReader(res);
      const status = r.uint();
      if (status !== 0) throw new NfsError("READDIR", status);
      let any = false;
      while (r.bool()) {
        const fileid = r.uint();
        const nameBytes = r.opaque(1024);
        cookie = r.fixedOpaque(4);
        const hint: NameEncoding | undefined =
          this.encoding === "ascii" ? "ascii" : nameBytes.length % 2 === 0 ? "utf16le" : undefined;
        out.push({ name: decodeName(nameBytes, hint), fileid, cookie });
        any = true;
      }
      const eof = r.bool();
      if (eof || !any) break;
    }
    return out;
  }

  async read(fh: Buffer, offset: number, count: number): Promise<{ attr: Fattr; data: Buffer }> {
    const args = new XdrWriter().fixedOpaque(fh).uint(offset).uint(count).uint(count).bytes();
    const res = await this.nfs(NFSPROC_READ, args);
    const r = new XdrReader(res);
    const status = r.uint();
    if (status !== 0) throw new NfsError("READ", status);
    const attr = readFattr(r);
    const data = r.opaque(1 << 20);
    return { attr, data };
  }

  /**
   * Read a whole file in readSize chunks with a small in-flight window. Short
   * reads are normal: the remainder is simply requested again.
   */
  async readFile(
    path: string,
    opts: { onChunk?: (offset: number, data: Buffer) => void | Promise<void>; onProgress?: (p: ReadProgress) => void; maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<{ size: number; data: Buffer | null }> {
    const { fh, attr: cachedAttr } = await this.lookupPath(path);
    const attr = cachedAttr ?? (await this.getattr(fh));
    if (attr.type === NF_DIR) throw new NfsError("READ", 21, path);
    const size = attr.size;
    if (opts.maxBytes !== undefined && size > opts.maxBytes) throw new Error(`file larger than ${opts.maxBytes} bytes`);
    const chunk = Math.min(this.opts.readSize ?? NFS_MAXDATA, NFS_MAXDATA);
    const keep = !opts.onChunk;
    const out = keep ? Buffer.alloc(size) : null;
    const ranges: [number, number][] = [];
    for (let off = 0; off < size; off += chunk) ranges.push([off, Math.min(chunk, size - off)]);
    let done = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (opts.signal?.aborted) throw new Error("aborted");
        const range = ranges.shift();
        if (!range) return;
        const [off, len] = range;
        const { data } = await this.read(fh, off, len);
        if (data.length === 0) throw new NfsError("READ", 5, `unexpected EOF at ${off} of ${size}`);
        const got = Math.min(data.length, len);
        if (out) data.copy(out, off, 0, got);
        else await opts.onChunk!(off, data.subarray(0, got));
        if (got < len) ranges.unshift([off + got, len - got]);
        done += got;
        opts.onProgress?.({ done, total: size });
      }
    };
    const workers = Array.from({ length: Math.max(1, this.opts.concurrency ?? 4) }, () => worker());
    await Promise.all(workers);
    return { size, data: out };
  }

  /** Depth-first walk returning file paths (relative, no leading slash). */
  async walk(
    start: string,
    accept: (name: string) => boolean,
    opts: { maxDepth?: number; maxFiles?: number; skip?: (name: string) => boolean } = {},
  ): Promise<{ path: string; size: number }[]> {
    const maxDepth = opts.maxDepth ?? 12;
    const maxFiles = opts.maxFiles ?? 20000;
    const found: { path: string; size: number }[] = [];
    const visit = async (dirPath: string, depth: number): Promise<void> => {
      if (depth > maxDepth || found.length >= maxFiles) return;
      const { fh } = await this.lookupPath(dirPath);
      const entries = await this.readdir(fh);
      for (const entry of entries) {
        if (found.length >= maxFiles) return;
        if (entry.name === "." || entry.name === ".." || !entry.name) continue;
        if (opts.skip?.(entry.name)) continue;
        const childPath = dirPath ? `${dirPath}/${entry.name}` : entry.name;
        let info: { fh: Buffer; attr: Fattr | null };
        try {
          info = await this.lookupPath(childPath);
        } catch {
          continue;
        }
        const type = info.attr?.type ?? (await this.getattr(info.fh)).type;
        if (type === NF_DIR) await visit(childPath, depth + 1);
        else if (type === NF_REG && accept(entry.name)) found.push({ path: childPath, size: info.attr?.size ?? 0 });
      }
    };
    await visit(start.replace(/^\/+|\/+$/g, ""), 0);
    return found;
  }
}
