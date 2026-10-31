import assert from "node:assert/strict";
import test from "node:test";
import { decodeName, encodeName, NfsClient, NfsError } from "../src/main/prolink/nfs.ts";
import { FakeNfsServer } from "./helpers/fake-nfs.ts";

const big = Buffer.alloc(50_000);
for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xff;

const tree = {
  "/C/": {
    "PIONEER/rekordbox/export.pdb": Buffer.from("pdb-bytes"),
    "Contents/Ünïcödé Artist/Track ☂.mp3": big,
    "Contents/plain.wav": Buffer.from("RIFF"),
  },
  "/B/": { "card.txt": Buffer.from("sd") },
};

test("UTF-16LE name encoding helpers", () => {
  const enc = encodeName("Ünï ☂", "utf16le");
  assert.equal(enc.length, 10);
  assert.equal(decodeName(enc, "utf16le"), "Ünï ☂");
  assert.equal(decodeName(Buffer.from("plain"), "ascii"), "plain");
});

test("NFS client mounts, looks up UTF-16 paths, reads and lists over UDP", async () => {
  const server = new FakeNfsServer({ exports: tree, maxRead: 3000 });
  const port = await server.start();
  const client = await NfsClient.mount("127.0.0.1", "/C/", { portmapPort: port, timeoutMs: 200 });
  try {
    assert.equal(client.encoding, "utf16le");
    const pdb = await client.readFile("PIONEER/rekordbox/export.pdb");
    assert.equal(pdb.data!.toString(), "pdb-bytes");
    const progress: number[] = [];
    const file = await client.readFile("/Contents/Ünïcödé Artist/Track ☂.mp3", { onProgress: (p) => progress.push(p.done) });
    assert.equal(file.size, big.length);
    assert.ok(file.data!.equals(big), "short reads are stitched back together");
    assert.equal(progress.at(-1), big.length);
    const { fh } = await client.lookupPath("Contents");
    const names = (await client.readdir(fh)).map((e) => e.name).filter((n) => n !== "." && n !== "..");
    assert.deepEqual(names.sort(), ["plain.wav", "Ünïcödé Artist"].sort());
    const walked = await client.walk("", (n) => /\.(mp3|wav)$/.test(n));
    assert.deepEqual(walked.map((w) => w.path).sort(), ["Contents/plain.wav", "Contents/Ünïcödé Artist/Track ☂.mp3"]);
    await assert.rejects(client.readFile("Contents/missing.mp3"), (e: unknown) => e instanceof NfsError && e.status === 2);
    await assert.rejects(client.lookupPath("../etc"), /parent traversal/);
  } finally {
    client.close();
    server.close();
  }
});

test("NFS client retransmits lost datagrams and falls back to ASCII names", async () => {
  const server = new FakeNfsServer({ exports: tree, nameEncoding: "ascii", dropEvery: 3 });
  const port = await server.start();
  const client = await NfsClient.mount("127.0.0.1", "/B/", { portmapPort: port, timeoutMs: 80, retries: 5 });
  try {
    assert.equal(client.encoding, "ascii");
    assert.equal((await client.readFile("card.txt")).data!.toString(), "sd");
  } finally {
    client.close();
    server.close();
  }
});

test("mount of a missing export fails cleanly; unreachable host times out", async () => {
  const server = new FakeNfsServer({ exports: tree });
  const port = await server.start();
  await assert.rejects(NfsClient.mount("127.0.0.1", "/Z/", { portmapPort: port, timeoutMs: 100 }), NfsError);
  server.close();
  await assert.rejects(NfsClient.mount("127.0.0.1", "/C/", { portmapPort: port, timeoutMs: 40, retries: 1 }), /timeout|ECONNREFUSED/i);
});
