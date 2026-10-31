import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";

/**
 * Physical core count for onnxruntime's intra-op pool. Returns 0 where it
 * cannot be read cheaply (Windows), which tells onnxruntime to size the pool
 * itself; it counts physical cores there.
 */
export const physicalCores = (): number => {
  try {
    if (process.platform === "linux") {
      const seen = new Set<string>();
      for (const cpu of readdirSync("/sys/devices/system/cpu").filter((d) => /^cpu\d+$/.test(d))) {
        const base = `/sys/devices/system/cpu/${cpu}/topology`;
        seen.add(`${readFileSync(`${base}/physical_package_id`, "utf8").trim()}:${readFileSync(`${base}/core_id`, "utf8").trim()}`);
      }
      if (seen.size) return seen.size;
    } else if (process.platform === "darwin") {
      const value = Number(execFileSync("sysctl", ["-n", "hw.physicalcpu"], { encoding: "utf8", timeout: 2000 }).trim());
      if (value > 0) return value;
    } else if (process.platform === "win32") {
      return 0;
    }
  } catch {
    // fall through
  }
  return os.availableParallelism?.() ?? os.cpus().length;
};
