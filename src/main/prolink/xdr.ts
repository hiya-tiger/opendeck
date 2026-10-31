// XDR (RFC 1014 / RFC 4506) encoding used by ONC RPC, MOUNT and NFSv2.
// Written from the RFC text; every item is padded to a multiple of 4 bytes and
// all integers are big-endian.

export class XdrWriter {
  private chunks: Buffer[] = [];
  private length = 0;

  uint(value: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(value >>> 0, 0);
    return this.push(b);
  }

  int(value: number): this {
    const b = Buffer.alloc(4);
    b.writeInt32BE(value | 0, 0);
    return this.push(b);
  }

  bool(value: boolean): this {
    return this.uint(value ? 1 : 0);
  }

  /** Fixed-length opaque: no length prefix, padded to 4. */
  fixedOpaque(bytes: Uint8Array): this {
    this.push(Buffer.from(bytes));
    return this.pad(bytes.length);
  }

  /** Variable-length opaque / string: uint length, bytes, pad. */
  opaque(bytes: Uint8Array): this {
    this.uint(bytes.length);
    return this.fixedOpaque(bytes);
  }

  string(value: string, encoding: BufferEncoding = "ascii"): this {
    return this.opaque(Buffer.from(value, encoding));
  }

  bytes(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }

  private pad(n: number): this {
    const extra = (4 - (n % 4)) % 4;
    if (extra) this.push(Buffer.alloc(extra));
    return this;
  }

  private push(b: Buffer): this {
    this.chunks.push(b);
    this.length += b.length;
    return this;
  }
}

export class XdrError extends Error {}

export class XdrReader {
  offset = 0;
  readonly buf: Buffer;

  constructor(buf: Uint8Array, offset = 0) {
    this.buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    this.offset = offset;
  }

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  private need(n: number): void {
    if (this.offset + n > this.buf.length) {
      throw new XdrError(`XDR underflow: need ${n} bytes at ${this.offset}, have ${this.remaining}`);
    }
  }

  uint(): number {
    this.need(4);
    const v = this.buf.readUInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  int(): number {
    this.need(4);
    const v = this.buf.readInt32BE(this.offset);
    this.offset += 4;
    return v;
  }

  bool(): boolean {
    return this.uint() !== 0;
  }

  fixedOpaque(n: number): Buffer {
    this.need(n);
    const out = Buffer.from(this.buf.subarray(this.offset, this.offset + n));
    this.offset += n;
    const extra = (4 - (n % 4)) % 4;
    this.need(extra);
    this.offset += extra;
    return out;
  }

  opaque(max = 1 << 24): Buffer {
    const n = this.uint();
    if (n > max) throw new XdrError(`XDR opaque length ${n} exceeds ${max}`);
    return this.fixedOpaque(n);
  }
}
