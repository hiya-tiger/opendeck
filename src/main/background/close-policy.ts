/**
 * What closing the app does while stems are still being separated (D45), kept
 * free of Electron so the choices are unit-tested. main.ts wires it to the
 * window's `close`, `before-quit`, a message box, the tray and notifications.
 */

export type CloseChoice = "tray" | "quit";
/** Stored preference: ask every time, or the remembered answer. */
export type ClosePreference = "ask" | CloseChoice;

export const CLOSE_DIALOG = {
  title: "OpenDecks",
  message: "Keep separating stems in the background?",
  buttons: ["Keep going in tray", "Quit now"] as const,
  checkboxLabel: "Remember my choice",
  /** Index of the button Escape / closing the dialog picks. */
  cancelId: 0,
  defaultId: 0,
};

export interface DialogAnswer {
  /** Index into CLOSE_DIALOG.buttons. */
  response: number;
  checkboxChecked: boolean;
}

export type CloseAction =
  /** Nothing is separating (or the quit is already confirmed): close normally. */
  | { action: "close" }
  /** Hide to the tray and keep separating at low priority. */
  | { action: "tray"; remember: boolean }
  /** Quit now; unfinished chunks stay in the cache's partial/ and resume next launch. */
  | { action: "quit"; remember: boolean };

export interface CloseContext {
  /** Separation queued or running. */
  busy: boolean;
  preference: ClosePreference;
  /** The user already confirmed quitting (tray Quit, dialog Quit, Cmd+Q after answering). */
  quitConfirmed: boolean;
}

/** Without asking: what to do, or `null` when the dialog must be shown. */
export const decideClose = (context: CloseContext): CloseAction | null => {
  if (context.quitConfirmed || !context.busy) return { action: "close" };
  if (context.preference === "tray") return { action: "tray", remember: true };
  if (context.preference === "quit") return { action: "quit", remember: true };
  return null;
};

export const actionFromAnswer = (answer: DialogAnswer): CloseAction => {
  const remember = Boolean(answer.checkboxChecked);
  return answer.response === 1 ? { action: "quit", remember } : { action: "tray", remember };
};

/**
 * Full flow: decide, ask if needed, and report the preference to store when
 * "Remember my choice" was ticked.
 */
export const resolveClose = async (
  context: CloseContext,
  ask: () => Promise<DialogAnswer>,
): Promise<{ result: CloseAction; savePreference: ClosePreference | null }> => {
  const decided = decideClose(context);
  if (decided) return { result: decided, savePreference: null };
  const result = actionFromAnswer(await ask());
  const savePreference = result.action !== "close" && result.remember ? result.action : null;
  return { result, savePreference };
};

/** Inference threads in the background: half the cores, at least one. */
export const backgroundThreads = (cores: number): number => Math.max(1, Math.floor((Number(cores) || 1) / 2));

export interface TrayActivity {
  jobs: Array<{ title: string; percent: number; running: boolean }>;
  paused: boolean;
}

export type TrayItemId = "status" | "job" | "open" | "pause" | "quit" | "separator";

export interface TrayItem {
  id: TrayItemId;
  label: string;
  enabled: boolean;
}

const short = (text: string, max = 42): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Overall progress across the queue (each job weighs the same). */
export const overallPercent = (activity: TrayActivity): number => {
  if (!activity.jobs.length) return 100;
  const sum = activity.jobs.reduce((total, job) => total + Math.max(0, Math.min(100, job.percent)), 0);
  return Math.round(sum / activity.jobs.length);
};

/** Tray tooltip / first menu line. */
export const trayStatus = (activity: TrayActivity): string => {
  if (!activity.jobs.length) return "Stems: all done";
  const verb = activity.paused ? "paused" : "separating";
  const count = activity.jobs.length === 1 ? "1 track" : `${activity.jobs.length} tracks`;
  return `Stems ${verb}: ${count}, ${overallPercent(activity)}%`;
};

/** The tray menu as data: Electron's Menu is built from this in main.ts. */
export const trayMenuModel = (activity: TrayActivity): TrayItem[] => {
  const items: TrayItem[] = [{ id: "status", label: trayStatus(activity), enabled: false }];
  for (const job of activity.jobs.slice(0, 6)) {
    items.push({ id: "job", label: `${job.running ? "▸" : "·"} ${short(job.title)}  ${job.percent}%`, enabled: false });
  }
  if (activity.jobs.length > 6) items.push({ id: "job", label: `+ ${activity.jobs.length - 6} more`, enabled: false });
  items.push({ id: "separator", label: "", enabled: false });
  items.push({ id: "open", label: "Open OpenDecks", enabled: true });
  items.push({ id: "pause", label: activity.paused ? "Resume separating" : "Pause separating", enabled: activity.jobs.length > 0 });
  items.push({ id: "quit", label: "Quit", enabled: true });
  return items;
};

/** Notification text when the background queue empties. */
export const doneNotice = (finished: Array<{ title: string; ok: boolean }>): { title: string; body: string } => {
  const ok = finished.filter((job) => job.ok);
  const failed = finished.length - ok.length;
  const title = ok.length ? "Stems ready" : "Stem separation stopped";
  const parts: string[] = [];
  if (ok.length === 1) parts.push(`${short(ok[0].title, 60)} is separated.`);
  else if (ok.length > 1) parts.push(`${ok.length} tracks are separated.`);
  if (failed) parts.push(`${failed} could not be finished.`);
  parts.push("They load instantly next time.");
  return { title, body: parts.join(" ") };
};
