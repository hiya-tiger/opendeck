import os from "node:os";

export interface NetInterface {
  name: string;
  address: string;
  netmask: string;
  mac: string;
}

export function listInterfaces(): NetInterface[] {
  const out: NetInterface[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      out.push({ name, address: a.address, netmask: a.netmask, mac: a.mac });
    }
  }
  return out;
}

const toInt = (ip: string): number => ip.split(".").reduce((acc, p) => ((acc << 8) | (Number(p) & 255)) >>> 0, 0);
const toIp = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

export function sameSubnet(a: string, b: string, netmask: string): boolean {
  const m = toInt(netmask);
  return ((toInt(a) & m) >>> 0) === ((toInt(b) & m) >>> 0);
}

export function broadcastAddress(address: string, netmask: string): string {
  return toIp((toInt(address) | (~toInt(netmask) >>> 0)) >>> 0);
}

/** The interface whose subnet contains peerIp, if any. */
export function interfaceForPeer(ifaces: NetInterface[], peerIp: string): NetInterface | null {
  return ifaces.find((i) => sameSubnet(i.address, peerIp, i.netmask)) ?? null;
}
