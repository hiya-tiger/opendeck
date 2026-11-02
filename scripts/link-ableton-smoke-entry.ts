/**
 * Ableton Link interop smoke (D43). Bundled and run by scripts/smoke-link.mjs.
 *
 * Part A, always: two AbletonLinkNode instances in this process discover each
 * other over 224.76.78.75:20808, measure ghost time, merge into one session and
 * agree on tempo, beat and phase. This proves self-consistency only.
 *
 * Part B, only when LINKHUT_BIN points at a built reference LinkHutSilent (a
 * real, non-OpenDecks Link peer): the peer is driven as a black box through a
 * pty (scripts/link-peer-pty.py) and we check, in both join orders,
 *   - the two sides end up in one session (a raw observer decodes both peers'
 *     alive packets and requires the same session id and the same timeline),
 *   - tempo changes made on either side reach the other,
 *   - phase agrees at the same monotonic instant, per row the peer draws,
 *   - start/stop intent propagates both ways with start/stop sync on.
 * Without LINKHUT_BIN, part B reports "not run" and never counts as verified.
 */

import dgram from "node:dgram";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { AbletonLinkNode } from "../src/main/ableton-link/node.ts";
import { LINK_MULTICAST_GROUP, LINK_MULTICAST_PORT, decodeDiscovery, phaseOf, beatAtGhost, type WireTimeline } from "../src/main/ableton-link/wire.ts";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AbletonSmokeResult {
  ok: boolean;
  skipped: boolean;
  reason: string | null;
  protocol: "ableton-link";
  interop: { peer: string | null; ran: boolean; verified: boolean };
  checks: Check[];
  phase: { samples: number; maxError: number | null; meanError: number | null; tolerance: number };
  durationMs: number;
}

const PHASE_TOLERANCE = 0.03; // beats: 15 ms at 120 BPM; the peer prints beats to 0.01
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const hostMicros = (): number => Number(process.hrtime.bigint() / 1000n);

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(20);
  }
  return pred();
}

const phaseGap = (a: number, b: number, q: number): number => {
  const d = Math.abs(phaseOf(a, q) - phaseOf(b, q));
  return Math.min(d, q - d);
};

interface PeerRow {
  t: number;
  enabled: boolean;
  peers: number;
  quantum: number;
  sync: boolean;
  playing: boolean;
  tempo: number;
  beats: number;
}

class ExternalPeer {
  private child: ChildProcessWithoutNullStreams;
  rows: PeerRow[] = [];
  constructor(bin: string, helper: string) {
    this.child = spawn("python3", [helper, bin], { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    this.child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const p = line.trim().split(/\s+/);
        if (p[0] !== "ROW" || p.length < 9) continue;
        this.rows.push({
          t: Number(p[1]),
          enabled: p[2] === "yes",
          peers: Number(p[3]),
          quantum: Number(p[4]),
          sync: p[5] === "yes",
          playing: p[6] === "playing",
          tempo: Number(p[7]),
          beats: Number(p[8]),
        });
        if (this.rows.length > 4000) this.rows.splice(0, 2000);
      }
    });
  }
  get last(): PeerRow | undefined {
    return this.rows[this.rows.length - 1];
  }
  key(c: string): void {
    this.child.stdin.write(`key ${c}\n`);
  }
  async stop(): Promise<void> {
    try {
      this.child.stdin.write("quit\n");
    } catch {
      /* gone */
    }
    await sleep(400);
    this.child.kill("SIGKILL");
  }
}

/** Raw observer: the latest alive per peer id, decoded with our codec. */
async function observer(): Promise<{ peers: Map<string, { session: string; timeline: WireTimeline }>; close: () => void }> {
  const peers = new Map<string, { session: string; timeline: WireTimeline }>();
  const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
  await new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.bind(LINK_MULTICAST_PORT, () => resolve());
  });
  s.addMembership(LINK_MULTICAST_GROUP, "127.0.0.1");
  s.on("message", (buf) => {
    const m = decodeDiscovery(buf);
    if (m && m.type === 1 && m.sessionId && m.timeline) peers.set(m.peerId, { session: m.sessionId, timeline: m.timeline });
  });
  return { peers, close: () => s.close() };
}

/** Same line? Compare beats at a shared ghost instant (re-anchored copies of one line are equal). */
const sameLine = (a: WireTimeline, b: WireTimeline): boolean => {
  const g = Number(a.timeOrigin) + 10_000_000;
  return a.microsPerBeat === b.microsPerBeat && Math.abs(beatAtGhost(a, g) - beatAtGhost(b, g)) < 1e-4;
};

export async function runAbletonSmoke(root: string): Promise<AbletonSmokeResult> {
  const started = Date.now();
  const checks: Check[] = [];
  const rec = (name: string, ok: boolean, detail: string): void => void checks.push({ name, ok, detail });
  const phaseErrors: number[] = [];
  const bin = process.env.LINKHUT_BIN && existsSync(process.env.LINKHUT_BIN) ? process.env.LINKHUT_BIN : null;
  const finish = (reason: string | null, skipped = false): AbletonSmokeResult => {
    const failed = checks.filter((c) => !c.ok);
    const interopChecks = checks.filter((c) => c.name.startsWith("interop-"));
    return {
      ok: !skipped && failed.length === 0,
      skipped,
      reason: reason ?? (failed.length ? `failed: ${failed.map((c) => c.name).join(", ")}` : null),
      protocol: "ableton-link",
      interop: { peer: bin ? path.basename(bin) : null, ran: interopChecks.length > 0, verified: interopChecks.length > 0 && interopChecks.every((c) => c.ok) },
      checks,
      phase: {
        samples: phaseErrors.length,
        maxError: phaseErrors.length ? Math.max(...phaseErrors) : null,
        meanError: phaseErrors.length ? phaseErrors.reduce((a, b) => a + b, 0) / phaseErrors.length : null,
        tolerance: PHASE_TOLERANCE,
      },
      durationMs: Date.now() - started,
    };
  };

  // ---------------------------------------------------------------- part A
  const a = new AbletonLinkNode({ interfaces: ["127.0.0.1"] });
  const b = new AbletonLinkNode({ interfaces: ["127.0.0.1"] });
  const sa = await a.enable();
  await sleep(300);
  const sb = await b.enable();
  if (!sa.enabled || !sb.enabled) {
    await a.disable();
    await b.disable();
    return finish(`multicast unavailable: ${sa.error ?? sb.error}`, true);
  }
  const joined = await waitFor(() => a.session === b.session && a.peerCount > 0 && b.peerCount > 0, 4000);
  rec("self-join-older-session", joined && b.session === a.peerId, `a.session=${a.session} b.session=${b.session} (a founded first)`);
  b.setLocalTempo(133);
  const tempoOk = await waitFor(() => Math.abs(a.sessionTempo - 133) < 0.01 && Math.abs(b.sessionTempo - 133) < 0.01, 3000);
  await sleep(1000); // must stay converged (no ping-pong)
  const stable = Math.abs(a.sessionTempo - 133) < 0.01 && Math.abs(b.sessionTempo - 133) < 0.01;
  const t = hostMicros();
  rec("self-tempo-beat-phase", tempoOk && stable && Math.abs(a.beatAt(t) - b.beatAt(t)) < 0.01, `tempo a=${a.sessionTempo.toFixed(3)} b=${b.sessionTempo.toFixed(3)} beatDelta=${Math.abs(a.beatAt(t) - b.beatAt(t)).toFixed(5)}`);
  await a.disable();
  await b.disable();

  if (!bin) return finish("part B not run: set LINKHUT_BIN to a built reference LinkHutSilent to verify interop");

  // ---------------------------------------------------------------- part B
  const helper = path.join(root, "scripts", "link-peer-pty.py");
  const obs = await observer();
  const samplePhase = async (od: AbletonLinkNode, peer: ExternalPeer, ms: number, label: string): Promise<void> => {
    const from = peer.rows.length;
    await sleep(ms);
    const rows = peer.rows.slice(from).filter((r) => r.enabled);
    const errs = rows.map((r) => phaseGap(od.beatAt(r.t), r.beats, r.quantum));
    phaseErrors.push(...errs);
    const max = errs.length ? Math.max(...errs) : Infinity;
    rec(`interop-phase-${label}`, errs.length > 10 && max <= PHASE_TOLERANCE, `${errs.length} rows, max phase error ${max.toFixed(4)} beats (tolerance ${PHASE_TOLERANCE})`);
  };
  const oneSession = (od: AbletonLinkNode): boolean => {
    const mine = obs.peers.get(od.peerId);
    const others = [...obs.peers.entries()].filter(([id]) => id !== od.peerId);
    return !!mine && others.length > 0 && others.every(([, v]) => v.session === mine.session && sameLine(v.timeline, mine.timeline));
  };

  try {
    // B1: the reference peer founds the session; OpenDecks joins it.
    {
      obs.peers.clear();
      const peer = new ExternalPeer(bin, helper);
      await waitFor(() => peer.rows.length > 0, 3000);
      peer.key("a");
      await sleep(1200);
      const od = new AbletonLinkNode({ interfaces: ["127.0.0.1"] });
      await od.enable();
      const inSession = await waitFor(() => od.peerCount > 0 && (peer.last?.peers ?? 0) > 0 && oneSession(od), 5000);
      rec("interop-B1-opendecks-joins-peer-session", inSession && od.session !== od.peerId, `od.session=${od.session} (own id ${od.peerId}); peer shows ${peer.last?.peers} peer(s)`);
      peer.key("e"); // peer: +1 BPM
      const followed = await waitFor(() => Math.abs(od.sessionTempo - 121) < 0.01, 3000);
      rec("interop-B1-peer-tempo-reaches-opendecks", followed, `peer pressed +1 → od ${od.sessionTempo.toFixed(3)} BPM`);
      od.setLocalTempo(128);
      const pushed = await waitFor(() => Math.abs((peer.last?.tempo ?? 0) - 128) < 0.01, 3000);
      rec("interop-B1-opendecks-tempo-reaches-peer", pushed, `od set 128 → peer shows ${peer.last?.tempo}`);
      await samplePhase(od, peer, 2500, "B1");
      await od.disable();
      await peer.stop();
    }
    await sleep(500);
    // B2: OpenDecks founds the session; the reference peer joins it.
    {
      obs.peers.clear();
      const od = new AbletonLinkNode({ interfaces: ["127.0.0.1"] });
      await od.enable();
      od.setLocalTempo(124);
      od.setStartStopSync(true);
      await sleep(1200);
      const peer = new ExternalPeer(bin, helper);
      await waitFor(() => peer.rows.length > 0, 3000);
      peer.key("a");
      const joined2 = await waitFor(() => od.peerCount > 0 && Math.abs((peer.last?.tempo ?? 0) - 124) < 0.01 && oneSession(od), 5000);
      const peerSession = [...obs.peers.entries()].find(([id]) => id !== od.peerId)?.[1].session;
      rec("interop-B2-peer-joins-opendecks-session", joined2 && peerSession === od.peerId, `peer advertises session ${peerSession}, OpenDecks id ${od.peerId}; peer tempo ${peer.last?.tempo}`);
      await samplePhase(od, peer, 2500, "B2");
      peer.key("s"); // peer: start/stop sync on
      await waitFor(() => peer.last?.sync === true, 2000);
      od.setPlaying(true);
      const started2 = await waitFor(() => peer.last?.playing === true, 3000);
      rec("interop-B2-opendecks-start-reaches-peer", started2, `od start → peer state ${peer.last?.playing ? "playing" : "stopped"}`);
      peer.key(" "); // peer stops
      const stopped = await waitFor(() => od.status().playing === false, 3000);
      rec("interop-B2-peer-stop-reaches-opendecks", stopped, `peer stop → od playing=${od.status().playing}`);
      await od.disable();
      await peer.stop();
    }
  } finally {
    obs.close();
  }
  return finish(null);
}
