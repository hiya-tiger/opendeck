import assert from "node:assert/strict";
import test from "node:test";
import { Platter } from "../src/renderer/engine/platter.ts";

test("platter torque accelerates toward the hand velocity", () => {
  const platter = new Platter();
  for (let i = 0; i < 60; i += 1) platter.drive(Math.PI, 1 / 60);
  assert.ok(platter.rate > 0.4, `rate was ${platter.rate}`);
  assert.ok(platter.rate <= 6);
});

test("platter direction follows the hand", () => {
  const platter = new Platter();
  for (let i = 0; i < 30; i += 1) platter.drive(-Math.PI / 2, 1 / 60);
  assert.ok(platter.rate < -0.2, `rate was ${platter.rate}`);
});

test("platter coasts down under friction", () => {
  const platter = new Platter();
  platter.velocity = 5;
  platter.coast(0.25);
  assert.ok(platter.velocity < 5);
  assert.ok(platter.velocity > 0);
  platter.coast(10);
  assert.equal(platter.velocity, 0);
});

test("platter clamps extreme rates", () => {
  const platter = new Platter({ maxRate: 2 });
  for (let i = 0; i < 200; i += 1) platter.drive(Math.PI * 10, 1 / 60);
  assert.equal(platter.rate, 2);
});
