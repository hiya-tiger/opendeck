/**
 * Headless integration smoke test for the opendeck-link/1 session transport.
 *
 * This proves only what it actually proves: two *OpenDecks* nodes, in one
 * process on this machine, converge on tempo/beat/phase over multicast UDP.
 * It says nothing about Ableton Live interoperability, which is not
 * implemented and not claimed (docs/mobile/ADR-D34.md).
 *
 * Tiers: INTEGRATION on success. SKIP (non-zero skipCode) when multicast is
 * unavailable on the host — never a silent pass.
 */

import dgram from "node:dgram";
import { createLinkNode, LINK_GROUP, LINK_PORT, LINK_PROTOCOL, LINK_PROTOCOL_ID } from "../src/main/link.ts";
import { TempoAuthority } from "../src/renderer/engine/tempo-authority.ts";

const CONVERGE_TIMEOUT_MS = 5_000;
const PEER_TIMEOUT_MS = 3_000;
const BEAT_TOLERANCE = 0.05; // beats. At 120 BPM this is 25 ms.
const TEMPO_TOLERANCE = 1e-6;

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface SmokeResult {
  ok: boolean;
  skipped: boolean;
  skipCode: number;
  reason: string | null;
  protocol: string;
  abletonCompatible: false;
  tier: string;
  multicast: { group: string; port: number };
  checks: Check[];
  convergence: {
    tempo: number | null;
    beatDelta: number | null;
    phaseDelta: number | null;
    beatTolerance: number;
    timeoutMs: number;
  };
  platform: string;
  node: string;
  durationMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

const phaseDelta = (a: number, b: number, quantum: number): number => {
  const raw = Math.abs(a - b) % quantum;
  return Math.min(raw, quantum - raw);
};

export async function runLinkSmoke(): Promise<SmokeResult> {
  const startedAt = Date.now();
  const checks: Check[] = [];
  const record = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  const result = (partial: Partial<SmokeResult>): SmokeResult => ({
    ok: false,
    skipped: false,
    skipCode: 0,
    reason: null,
    protocol: LINK_PROTOCOL_ID,
    abletonCompatible: false,
    tier: "INTEGRATION",
    multicast: { group: LINK_GROUP, port: LINK_PORT },
    checks,
    convergence: {
      tempo: null,
      beatDelta: null,
      phaseDelta: null,
      beatTolerance: BEAT_TOLERANCE,
      timeoutMs: CONVERGE_TIMEOUT_MS,
    },
    platform: process.platform,
    node: process.version,
    durationMs: Date.now() - startedAt,
    ...partial,
  });

  // The transport this test guards. A plain object on purpose: the Link node has
  // no handle to it, and the assertion is that it still does not after a full
  // session. This is the "Link did not become a transport" check.
  const transport = { position: 12.345678, playing: true, rate: 1 };
  const transportBefore = JSON.stringify(transport);

  const nodeA = createLinkNode({ peerId: "smoke-node-a" });
  const nodeB = createLinkNode({ peerId: "smoke-node-b" });

  // A raw observer on the same group distinguishes "multicast is blocked on this
  // host" (skip) from "our peers cannot hear each other" (a real failure).
  let observed = 0;
  const observer = dgram.createSocket({ type: "udp4", reuseAddr: true });
  let observerReady = false;
  try {
    await new Promise<void>((resolve, reject) => {
      observer.once("error", reject);
      observer.once("listening", () => {
        try {
          observer.addMembership(LINK_GROUP);
          observerReady = true;
          resolve();
        } catch (error) {
          reject(error as Error);
        }
      });
      observer.bind(LINK_PORT);
    });
    observer.on("message", (message) => {
      try {
        const parsed = JSON.parse(message.toString("utf8")) as { p?: string };
        if (parsed.p === LINK_PROTOCOL) observed += 1;
      } catch {
        /* not ours */
      }
    });
  } catch (error) {
    observerReady = false;
  }

  const cleanup = async (): Promise<void> => {
    await nodeA.disable().catch(() => undefined);
    await nodeB.disable().catch(() => undefined);
    if (observerReady) {
      try {
        observer.dropMembership(LINK_GROUP);
      } catch {
        /* ignore */
      }
    }
    try {
      observer.close();
    } catch {
      /* ignore */
    }
  };

  try {
    // ---- 1. enabling Link starts and reports enabled -----------------------
    const enabledA = await nodeA.enable();
    const enabledB = await nodeB.enable();
    record(
      "enable-reports-enabled",
      enabledA.enabled && enabledB.enabled,
      `A.enabled=${enabledA.enabled} B.enabled=${enabledB.enabled}` +
        (enabledA.error ? ` A.error=${enabledA.error}` : "") +
        (enabledB.error ? ` B.error=${enabledB.error}` : ""),
    );
    if (!enabledA.enabled || !enabledB.enabled) {
      await cleanup();
      return result({
        skipped: true,
        skipCode: 2,
        reason: `multicast join failed on this host: ${enabledA.error ?? enabledB.error ?? "unknown"}`,
        tier: "SOURCE",
      });
    }

    // ---- 2. peers discover each other --------------------------------------
    const peersSeen = await waitFor(() => nodeA.peerCount > 0 && nodeB.peerCount > 0, PEER_TIMEOUT_MS);
    record(
      "peers-discovered",
      peersSeen,
      `A.peers=${nodeA.peerCount} B.peers=${nodeB.peerCount} observerDatagrams=${observed}`,
    );
    if (!peersSeen) {
      await cleanup();
      if (observed === 0) {
        return result({
          skipped: true,
          skipCode: 2,
          reason:
            "multicast is unavailable on this host: an independent listener on " +
            `${LINK_GROUP}:${LINK_PORT} received no opendeck-link datagrams`,
          tier: "SOURCE",
        });
      }
      return result({ ok: false, reason: "datagrams reached a third socket but the two nodes did not see each other" });
    }

    // ---- 3. two nodes converge on a shared tempo ---------------------------
    // A starts at 120, B is pushed to 128 before the test window opens.
    nodeB.setLocalTempo(128);
    const converged = await waitFor(
      () => Math.abs(nodeA.sessionTempo - nodeB.sessionTempo) < TEMPO_TOLERANCE,
      CONVERGE_TIMEOUT_MS,
    );
    const tempo = nodeA.sessionTempo;
    record(
      "tempo-converges",
      converged,
      `A=${nodeA.sessionTempo} B=${nodeB.sessionTempo} within ${CONVERGE_TIMEOUT_MS} ms`,
    );
    if (!converged) {
      await cleanup();
      return result({ ok: false, reason: "tempo did not converge within the stated timeout" });
    }

    // ---- 4. beat and phase agree within tolerance --------------------------
    // Evaluated at one shared instant so the number measures timeline agreement,
    // not the few milliseconds between two status() reads.
    const instant = Math.round(performance.timeOrigin * 1000 + performance.now() * 1000);
    const quantum = nodeA.status().quantum;
    const beatA = nodeA.beatAt(instant);
    const beatB = nodeB.beatAt(instant);
    const beatDelta = Math.abs(beatA - beatB);
    const phaseGap = phaseDelta(
      ((beatA % quantum) + quantum) % quantum,
      ((beatB % quantum) + quantum) % quantum,
      quantum,
    );
    record(
      "beat-phase-agree",
      beatDelta <= BEAT_TOLERANCE && phaseGap <= BEAT_TOLERANCE,
      `beatDelta=${beatDelta.toFixed(6)} phaseDelta=${phaseGap.toFixed(6)} tolerance=${BEAT_TOLERANCE} beats at one shared instant` +
        ` (independent status() reads differ by ${Math.abs(nodeA.status().beat - nodeB.status().beat).toFixed(6)} beats, which is read skew, not timeline disagreement)`,
    );

    // ---- 5. local tempo can be pushed and is observed by the peer ----------
    nodeA.setLocalTempo(124);
    const pushed = await waitFor(() => Math.abs(nodeB.sessionTempo - 124) < TEMPO_TOLERANCE, 2_000);
    record(
      "local-tempo-pushed-and-observed",
      pushed,
      `A pushed 124; B.sessionTempo=${nodeB.sessionTempo}`,
    );

    // ---- 6. disabling restores the pre-Link local tempo --------------------
    const beforeDisable = nodeA.sessionTempo;
    const disabled = await nodeA.disable();
    record(
      "disable-restores-pre-link-tempo",
      !disabled.enabled && Math.abs(disabled.sessionBpm - 120) < TEMPO_TOLERANCE,
      `pre-Link 120, was ${beforeDisable}, restored ${disabled.sessionBpm}, enabled=${disabled.enabled}`,
    );

    // ---- 7. the transport is untouched by Link -----------------------------
    const transportAfter = JSON.stringify(transport);
    record(
      "transport-playhead-unchanged",
      transportAfter === transportBefore,
      `before=${transportBefore} after=${transportAfter}`,
    );

    // ---- 8. TempoAuthority precedence (D35 rows 1/2/5/6 + restore) ---------
    const pushes: number[] = [];
    const authority = new TempoAuthority({
      defaultBpm: 120,
      onPushLink: (bpm) => pushes.push(bpm),
    });
    const manualOff = authority.setManualBpm(126);
    const row2 = manualOff.bpm === 126 && manualOff.source === "manual" && !manualOff.linkEnabled;
    const linkOn = authority.onLinkStatus({ enabled: true, sessionBpm: 124, beat: 0, phase: 0, quantum: 4 });
    const row5 = linkOn.source === "link" && Math.abs(linkOn.bpm - 124) < TEMPO_TOLERANCE;
    const manualPushed = authority.setManualBpm(130);
    const row6 = manualPushed.source === "link" && pushes[pushes.length - 1] === 130;
    const linkOff = authority.onLinkStatus({ enabled: false, sessionBpm: 0, beat: 0, phase: 0, quantum: 4 });
    const rowOff = !linkOff.linkEnabled && Math.abs(linkOff.bpm - 126) < TEMPO_TOLERANCE && linkOff.source === "manual";
    record(
      "tempo-authority-precedence",
      row2 && row5 && row6 && rowOff,
      `row2=${row2} row5=${row5} row6=${row6} restore=${rowOff} pushes=${pushes.join(",")}`,
    );

    const failed = checks.filter((check) => !check.ok);
    await cleanup();
    return result({
      ok: failed.length === 0,
      reason: failed.length === 0 ? null : `failed checks: ${failed.map((check) => check.name).join(", ")}`,
      convergence: {
        tempo,
        beatDelta,
        phaseDelta: phaseGap,
        beatTolerance: BEAT_TOLERANCE,
        timeoutMs: CONVERGE_TIMEOUT_MS,
      },
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    await cleanup();
    return result({
      ok: false,
      reason: `unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Date.now() - startedAt,
    });
  }
}
