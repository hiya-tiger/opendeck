export interface WhipAnswer {
  sdp: string;
  type: "answer";
  location: string | null;
}

export function whipHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/sdp",
    Accept: "application/sdp",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function validateOffer(sdp: string): boolean {
  return /^v=0/m.test(sdp) && /\r?\nm=audio\s/m.test(sdp);
}

export function parseWhipAnswer(sdp: string, location?: string | null): WhipAnswer {
  const text = sdp.trim();
  if (!text.startsWith("v=0")) throw new Error("WHIP answer is not SDP");
  if (!/\r?\nm=audio\s/.test(text)) throw new Error("WHIP answer has no audio section");
  return { sdp: text, type: "answer", location: location ?? null };
}

export function resolveWhipLocation(endpoint: string, header: string | null): string {
  if (!header) return endpoint;
  try {
    return new URL(header, endpoint).toString();
  } catch {
    return endpoint;
  }
}

export type BroadcastState = "idle" | "connecting" | "live" | "error";

export interface BroadcastStatus {
  state: BroadcastState;
  detail: string;
  startedAt: number | null;
  bytesHint?: number;
}

export class WhipBroadcaster {
  private pc: RTCPeerConnection | null = null;
  private endpoint = "";
  private resource: string | null = null;
  onStatus: ((status: BroadcastStatus) => void) | null = null;

  private report(status: BroadcastStatus): void {
    this.onStatus?.(status);
  }

  async start(stream: MediaStream, endpoint: string, token?: string): Promise<void> {
    await this.stop();
    this.endpoint = endpoint;
    this.report({ state: "connecting", detail: "creating offer", startedAt: null });

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    this.pc = pc;

    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
    pc.addEventListener("connectionstatechange", () => {
      const state = pc.connectionState;
      if (state === "connected") {
        this.report({ state: "live", detail: "WHIP connected", startedAt: Date.now() });
      } else if (state === "failed" || state === "disconnected") {
        this.report({ state: "error", detail: `connection ${state}`, startedAt: null });
      }
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      const timer = window.setTimeout(resolve, 4000);
      pc.addEventListener("icegatheringstatechange", () => {
        if (pc.iceGatheringState === "complete") {
          window.clearTimeout(timer);
          resolve();
        }
      });
    });

    const local = pc.localDescription?.sdp ?? "";
    if (!validateOffer(local)) throw new Error("could not build a WHIP offer");

    const response = await fetch(endpoint, {
      method: "POST",
      headers: whipHeaders(token),
      body: local,
    });
    if (!response.ok) {
      this.report({ state: "error", detail: `WHIP ${response.status}`, startedAt: null });
      throw new Error(`WHIP endpoint returned ${response.status}`);
    }
    const answer = parseWhipAnswer(
      await response.text(),
      response.headers.get("Location"),
    );
    this.resource = resolveWhipLocation(endpoint, answer.location);
    await pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
    this.report({ state: "live", detail: "WHIP streaming", startedAt: Date.now() });
  }

  async stop(): Promise<void> {
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (this.resource) {
      try {
        await fetch(this.resource, { method: "DELETE" });
      } catch {
        // Resource cleanup is best effort.
      }
      this.resource = null;
    }
    this.report({ state: "idle", detail: "stopped", startedAt: null });
  }
}
