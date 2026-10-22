export interface PlatterOptions {
  inertia?: number;
  friction?: number;
  secondsPerTurn?: number;
  maxRate?: number;
}

const TWO_PI = Math.PI * 2;

export class Platter {
  readonly inertia: number;
  readonly friction: number;
  readonly secondsPerTurn: number;
  readonly maxRate: number;
  angle = 0;
  velocity = 0;

  constructor(options: PlatterOptions = {}) {
    this.inertia = options.inertia ?? 0.012;
    this.friction = options.friction ?? 1.8;
    this.secondsPerTurn = options.secondsPerTurn ?? 1.8;
    this.maxRate = options.maxRate ?? 6;
  }

  get rate(): number {
    const rate = (this.velocity / TWO_PI) * this.secondsPerTurn;
    return Math.max(-this.maxRate, Math.min(this.maxRate, rate));
  }

  reset(): void {
    this.angle = 0;
    this.velocity = 0;
  }

  applyTorque(torque: number, dt: number): void {
    if (!Number.isFinite(torque) || !Number.isFinite(dt) || dt <= 0) return;
    this.velocity += (torque / this.inertia) * dt;
    this.angle += this.velocity * dt;
  }

  drive(radians: number, dt: number): void {
    if (!Number.isFinite(radians) || !Number.isFinite(dt) || dt <= 0) return;
    const target = radians / dt;
    const torque = (target - this.velocity) * this.inertia * 22;
    this.applyTorque(torque, dt);
  }

  coast(dt: number): void {
    if (!Number.isFinite(dt) || dt <= 0) return;
    this.velocity *= Math.exp(-this.friction * dt);
    if (Math.abs(this.velocity) < 1e-4) this.velocity = 0;
    this.angle += this.velocity * dt;
  }
}
