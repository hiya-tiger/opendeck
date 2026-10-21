export interface QueueTrack {
  id: string;
  title: string;
  artist: string;
  durationSec: number;
  provider: string;
  url: string;
  thumbnail?: string;
}

export type RepeatMode = "off" | "all" | "one";

export class PlayQueue {
  items: QueueTrack[] = [];
  index = -1;
  repeat: RepeatMode = "off";
  shuffle = false;

  add(track: QueueTrack, at?: number): number {
    const position = at == null ? this.items.length : Math.max(0, Math.min(this.items.length, at));
    this.items.splice(position, 0, track);
    if (this.index === -1) this.index = position;
    else if (position <= this.index) this.index += 1;
    return position;
  }

  addMany(tracks: QueueTrack[]): void {
    for (const track of tracks) this.add(track);
  }

  remove(id: string): boolean {
    const at = this.items.findIndex((track) => track.id === id);
    if (at < 0) return false;
    this.items.splice(at, 1);
    if (this.index >= this.items.length) this.index = this.items.length - 1;
    return true;
  }

  move(from: number, to: number): void {
    if (from < 0 || from >= this.items.length) return;
    const target = Math.max(0, Math.min(this.items.length - 1, to));
    const [item] = this.items.splice(from, 1);
    this.items.splice(target, 0, item);
    if (this.index === from) this.index = target;
    else if (from < this.index && target >= this.index) this.index -= 1;
    else if (from > this.index && target <= this.index) this.index += 1;
  }

  clear(): void {
    this.items = [];
    this.index = -1;
  }

  get current(): QueueTrack | null {
    return this.items[this.index] ?? null;
  }

  nextIndex(step = 1): number {
    if (!this.items.length) return -1;
    if (this.shuffle) {
      if (this.items.length === 1) return 0;
      let next = this.index;
      while (next === this.index) next = Math.floor(Math.random() * this.items.length);
      return next;
    }
    let next = this.index + step;
    if (next >= this.items.length) {
      if (this.repeat === "all") next = 0;
      else return -1;
    }
    if (next < 0) {
      if (this.repeat === "all") next = this.items.length - 1;
      else return -1;
    }
    return next;
  }

  next(): QueueTrack | null {
    if (this.repeat === "one" && this.current) return this.current;
    const next = this.nextIndex(1);
    if (next < 0) return null;
    this.index = next;
    return this.current;
  }

  previous(): QueueTrack | null {
    const previous = this.nextIndex(-1);
    if (previous < 0) return null;
    this.index = previous;
    return this.current;
  }

  jump(index: number): QueueTrack | null {
    if (index < 0 || index >= this.items.length) return null;
    this.index = index;
    return this.current;
  }
}
