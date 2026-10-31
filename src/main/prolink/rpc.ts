// ONC RPC v2 over UDP (RFC 1057). Clean-room implementation from the RFC
// message definitions: call/reply framing, AUTH_NULL / AUTH_UNIX credentials,
// and a small UDP client with xid matching, retransmission and timeouts.
import dgram from "node:dgram";
import { XdrReader, XdrWriter } from "./xdr.ts";

export const RPC_VERSION = 2;
export const MSG_CALL = 0;
export const MSG_REPLY = 1;
export const AUTH_NULL = 0;
export const AUTH_UNIX = 1;

export const ACCEPT_STAT = ["SUCCESS", "PROG_UNAVAIL", "PROG_MISMATCH", "PROC_UNAVAIL", "GARBAGE_ARGS", "SYSTEM_ERR"];

export interface RpcCredential {
  flavor: number;
  body: Uint8Array;
}

export const authNull = (): RpcCredential => ({ flavor: AUTH_NULL, body: new Uint8Array(0) });

export const authUnix = (opts: { stamp?: number; machine?: string; uid?: number; gid?: number; gids?: number[] } = {}): RpcCredential => {
  const w = new XdrWriter();
  w.uint(opts.stamp ?? 0);
  w.string(opts.machine ?? "");
  w.uint(opts.uid ?? 0);
  w.uint(opts.gid ?? 0);
  const gids = opts.gids ?? [];
  w.uint(gids.length);
  for (const g of gids) w.uint(g);
  return { flavor: AUTH_UNIX, body: w.bytes() };
};

export interface RpcCall {
  xid: number;
  prog: number;
  vers: number;
  proc: number;
  cred: RpcCredential;
  verf: RpcCredential;
  args: Buffer;
}

export function encodeCall(call: Omit<RpcCall, "verf"> & { verf?: RpcCredential }): Buffer {
  const w = new XdrWriter();
  w.uint(call.xid).uint(MSG_CALL).uint(RPC_VERSION).uint(call.prog).uint(call.vers).uint(call.proc);
  w.uint(call.cred.flavor).opaque(call.cred.body);
  const verf = call.verf ?? authNull();
  w.uint(verf.flavor).opaque(verf.body);
  return Buffer.concat([w.bytes(), call.args]);
}

export function decodeCall(buf: Uint8Array): RpcCall {
  const r = new XdrReader(buf);
  const xid = r.uint();
  if (r.uint() !== MSG_CALL) throw new RpcError("not an RPC call");
  const rpcvers = r.uint();
  if (rpcvers !== RPC_VERSION) throw new RpcError(`unsupported RPC version ${rpcvers}`);
  const prog = r.uint();
  const vers = r.uint();
  const proc = r.uint();
  const cred = { flavor: r.uint(), body: r.opaque(400) };
  const verf = { flavor: r.uint(), body: r.opaque(400) };
  return { xid, prog, vers, proc, cred, verf, args: r.buf.subarray(r.offset) };
}

export type RpcReply =
  | { xid: number; kind: "accepted"; acceptStat: number; results: Buffer; mismatch?: [number, number] }
  | { xid: number; kind: "denied"; rejectStat: number; authStat?: number; mismatch?: [number, number] };

export function encodeAcceptedReply(xid: number, results: Uint8Array, acceptStat = 0): Buffer {
  const w = new XdrWriter();
  w.uint(xid).uint(MSG_REPLY).uint(0); // MSG_ACCEPTED
  w.uint(AUTH_NULL).opaque(new Uint8Array(0));
  w.uint(acceptStat);
  return Buffer.concat([w.bytes(), Buffer.from(results)]);
}

export function encodeDeniedReply(xid: number, authStat: number): Buffer {
  const w = new XdrWriter();
  w.uint(xid).uint(MSG_REPLY).uint(1).uint(1).uint(authStat); // MSG_DENIED, AUTH_ERROR
  return w.bytes();
}

export function decodeReply(buf: Uint8Array): RpcReply {
  const r = new XdrReader(buf);
  const xid = r.uint();
  if (r.uint() !== MSG_REPLY) throw new RpcError("not an RPC reply");
  const replyStat = r.uint();
  if (replyStat === 0) {
    r.uint(); // verifier flavor
    r.opaque(400);
    const acceptStat = r.uint();
    if (acceptStat === 2) {
      return { xid, kind: "accepted", acceptStat, results: Buffer.alloc(0), mismatch: [r.uint(), r.uint()] };
    }
    return { xid, kind: "accepted", acceptStat, results: r.buf.subarray(r.offset) };
  }
  const rejectStat = r.uint();
  if (rejectStat === 0) return { xid, kind: "denied", rejectStat, mismatch: [r.uint(), r.uint()] };
  return { xid, kind: "denied", rejectStat, authStat: r.uint() };
}

export class RpcError extends Error {
  readonly code: string;
  constructor(message: string, code = "RPC") {
    super(message);
    this.code = code;
  }
}

export interface RpcCallOptions {
  timeoutMs?: number;
  retries?: number;
}

interface Pending {
  resolve: (buf: Buffer) => void;
  reject: (error: Error) => void;
}

/** One UDP socket, many outstanding calls matched by xid. */
export class RpcUdpClient {
  private socket: dgram.Socket | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextXid = (Math.random() * 0x7fffffff) >>> 0;
  readonly host: string;
  cred: RpcCredential;
  private bindAddress: string | undefined;

  constructor(host: string, opts: { cred?: RpcCredential; bindAddress?: string } = {}) {
    this.host = host;
    this.cred = opts.cred ?? authUnix();
    this.bindAddress = opts.bindAddress;
  }

  private open(): Promise<void> {
    if (this.ready) return this.ready;
    const socket = dgram.createSocket({ type: "udp4" });
    this.socket = socket;
    socket.on("message", (msg) => {
      if (msg.length < 8) return;
      const xid = msg.readUInt32BE(0);
      const waiter = this.pending.get(xid);
      if (!waiter) return; // late duplicate of a retransmitted call
      this.pending.delete(xid);
      waiter.resolve(msg);
    });
    socket.on("error", (error) => {
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    });
    this.ready = new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind({ port: 0, address: this.bindAddress }, () => {
        socket.off("error", reject);
        resolve();
      });
    });
    return this.ready;
  }

  async call(port: number, prog: number, vers: number, proc: number, args: Uint8Array, opts: RpcCallOptions = {}): Promise<Buffer> {
    await this.open();
    const socket = this.socket!;
    const timeoutMs = opts.timeoutMs ?? 1000;
    const retries = opts.retries ?? 4;
    this.nextXid = (this.nextXid + 1) >>> 0;
    const xid = this.nextXid;
    const packet = encodeCall({ xid, prog, vers, proc, cred: this.cred, args: Buffer.from(args) });
    const raw = await new Promise<Buffer>((resolve, reject) => {
      let attempt = 0;
      let timer: NodeJS.Timeout | null = null;
      const finish = (fn: () => void): void => {
        if (timer) clearTimeout(timer);
        this.pending.delete(xid);
        fn();
      };
      this.pending.set(xid, {
        resolve: (buf) => finish(() => resolve(buf)),
        reject: (error) => finish(() => reject(error)),
      });
      const send = (): void => {
        if (!this.pending.has(xid)) return;
        if (attempt > retries) {
          finish(() => reject(new RpcError(`RPC timeout: prog ${prog} proc ${proc} on ${this.host}:${port}`, "TIMEOUT")));
          return;
        }
        attempt++;
        socket.send(packet, port, this.host, (error) => {
          if (error) finish(() => reject(error));
        });
        // Back off a little on each retransmission.
        timer = setTimeout(send, timeoutMs * Math.min(attempt, 3));
      };
      send();
    });
    const reply = decodeReply(raw);
    if (reply.kind === "denied") {
      throw new RpcError(
        reply.rejectStat === 1 ? `RPC auth error ${reply.authStat}` : "RPC version mismatch",
        reply.rejectStat === 1 ? "AUTH" : "RPC_MISMATCH",
      );
    }
    if (reply.acceptStat !== 0) {
      throw new RpcError(`RPC ${ACCEPT_STAT[reply.acceptStat] ?? reply.acceptStat}`, ACCEPT_STAT[reply.acceptStat] ?? "RPC");
    }
    return reply.results;
  }

  close(): void {
    for (const waiter of this.pending.values()) waiter.reject(new RpcError("client closed", "CLOSED"));
    this.pending.clear();
    try {
      this.socket?.close();
    } catch {
      // already closed
    }
    this.socket = null;
    this.ready = null;
  }
}
