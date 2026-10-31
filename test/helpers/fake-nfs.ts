// In-process fake of a Pioneer player's file service: portmapper, MOUNT v1
// and NFS v2 on one UDP socket, serving an in-memory tree with UTF-16LE names.
import { createHash } from "node:crypto";
import dgram from "node:dgram";
import { decodeCall, encodeAcceptedReply, encodeDeniedReply } from "../../src/main/prolink/rpc.ts";
import { XdrReader, XdrWriter } from "../../src/main/prolink/xdr.ts";
import {
  MOUNT_PROG,
  NF_DIR,
  NF_REG,
  NFS_PROG,
  NFSPROC_GETATTR,
  NFSPROC_LOOKUP,
  NFSPROC_READ,
  NFSPROC_READDIR,
  PMAP_PROG,
  writeFattr,
} from "../../src/main/prolink/nfs.ts";

export interface FakeNfsOptions {
  exports: Record<string, Record<string, Buffer>>; // export path -> { "dir/file": bytes }
  nameEncoding?: "utf16le" | "ascii";
  /** Drop this fraction of requests to exercise retransmission. */
  dropEvery?: number;
  /** Cap READ replies to this many bytes (exercises short reads). */
  maxRead?: number;
  requireAuthUnix?: boolean;
}

interface Node {
  path: string;
  exportPath: string;
  dir: boolean;
  data?: Buffer;
  children: Map<string, Node>;
  fileid: number;
}

export class FakeNfsServer {
  socket = dgram.createSocket("udp4");
  port = 0;
  calls: { prog: number; proc: number }[] = [];
  private handles = new Map<string, Node>();
  private roots = new Map<string, Node>();
  private opts: FakeNfsOptions;
  private counter = 0;
  private nextId = 1;

  constructor(opts: FakeNfsOptions) {
    this.opts = opts;
    for (const [exportPath, files] of Object.entries(opts.exports)) {
      const root = this.node("", exportPath, true);
      this.roots.set(exportPath, root);
      for (const [p, data] of Object.entries(files)) {
        let cur = root;
        const parts = p.split("/").filter(Boolean);
        parts.forEach((part, i) => {
          const last = i === parts.length - 1;
          let child = cur.children.get(part);
          if (!child) {
            child = this.node(cur.path ? `${cur.path}/${part}` : part, exportPath, !last);
            cur.children.set(part, child);
          }
          if (last) child.data = data;
          cur = child;
        });
      }
    }
  }

  private node(path: string, exportPath: string, dir: boolean): Node {
    const n: Node = { path, exportPath, dir, children: new Map(), fileid: this.nextId++ };
    this.handles.set(this.fh(n).toString("hex"), n);
    return n;
  }

  private fh(n: Node): Buffer {
    const out = Buffer.alloc(32);
    createHash("sha256").update(`${n.exportPath}|${n.path}`).digest().copy(out);
    return out;
  }

  private enc(): BufferEncoding {
    return this.opts.nameEncoding === "ascii" ? "latin1" : "utf16le";
  }

  async start(): Promise<number> {
    this.socket.on("message", (msg, rinfo) => this.onMessage(msg, rinfo));
    await new Promise<void>((resolve) => this.socket.bind(0, "127.0.0.1", () => resolve()));
    this.port = this.socket.address().port;
    return this.port;
  }

  close(): void {
    this.socket.close();
  }

  private attr(w: XdrWriter, n: Node): void {
    writeFattr(w, { type: n.dir ? NF_DIR : NF_REG, size: n.dir ? 4096 : n.data!.length, fileid: n.fileid });
  }

  private onMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    this.counter++;
    if (this.opts.dropEvery && this.counter % this.opts.dropEvery === 0) return;
    const call = decodeCall(msg);
    this.calls.push({ prog: call.prog, proc: call.proc });
    if (this.opts.requireAuthUnix && call.cred.flavor !== 1) {
      this.socket.send(encodeDeniedReply(call.xid, 1), rinfo.port, rinfo.address);
      return;
    }
    const r = new XdrReader(call.args);
    const w = new XdrWriter();
    if (call.prog === PMAP_PROG && call.proc === 3) {
      w.uint(this.port);
    } else if (call.prog === MOUNT_PROG && call.proc === 1) {
      const raw = r.opaque();
      const path = raw.toString(this.enc());
      const root = this.roots.get(path);
      if (!root) w.uint(2);
      else w.uint(0).fixedOpaque(this.fh(root));
    } else if (call.prog === NFS_PROG) {
      const handle = this.handles.get(r.fixedOpaque(32).toString("hex"));
      if (!handle) {
        w.uint(70); // STALE
      } else if (call.proc === NFSPROC_GETATTR) {
        w.uint(0);
        this.attr(w, handle);
      } else if (call.proc === NFSPROC_LOOKUP) {
        const name = r.opaque().toString(this.enc());
        const child = handle.children.get(name);
        if (!child) w.uint(2);
        else {
          w.uint(0).fixedOpaque(this.fh(child));
          this.attr(w, child);
        }
      } else if (call.proc === NFSPROC_READ) {
        const offset = r.uint();
        let count = r.uint();
        if (this.opts.maxRead) count = Math.min(count, this.opts.maxRead);
        const data = handle.data!.subarray(offset, offset + count);
        w.uint(0);
        this.attr(w, handle);
        w.opaque(data);
      } else if (call.proc === NFSPROC_READDIR) {
        const cookie = r.fixedOpaque(4).readUInt32BE(0);
        const names = [".", "..", ...handle.children.keys()];
        w.uint(0);
        // two entries per reply to exercise cookie paging
        const slice = names.slice(cookie, cookie + 2);
        slice.forEach((name, i) => {
          const c = Buffer.alloc(4);
          c.writeUInt32BE(cookie + i + 1, 0);
          w.bool(true).uint(handle.children.get(name)?.fileid ?? 1).opaque(Buffer.from(name, this.enc())).fixedOpaque(c);
        });
        w.bool(false).bool(cookie + 2 >= names.length);
      } else {
        this.socket.send(encodeAcceptedReply(call.xid, Buffer.alloc(0), 3), rinfo.port, rinfo.address);
        return;
      }
    } else {
      this.socket.send(encodeAcceptedReply(call.xid, Buffer.alloc(0), 1), rinfo.port, rinfo.address);
      return;
    }
    this.socket.send(encodeAcceptedReply(call.xid, w.bytes()), rinfo.port, rinfo.address);
  }
}
