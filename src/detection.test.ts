import { describe, expect, it } from "vitest";
import { gateFrame, iou, sceneChanged, sellableDetections } from "./detection";
import type { DeviceDetection } from "./types";

const lamp: DeviceDetection = { label: "vase", score: 0.8, box: { xMin: 100, yMin: 100, xMax: 300, yMax: 400 } };
const person: DeviceDetection = { label: "person", score: 0.95, box: { xMin: 500, yMin: 0, xMax: 900, yMax: 1000 } };

describe("sellableDetections", () => {
  it("drops people, fixtures, and low-score detections", () => {
    const weak = { ...lamp, label: "cup", score: 0.2 };
    expect(sellableDetections([lamp, person, weak])).toEqual([lamp]);
  });
});

describe("iou", () => {
  it("is 1 for identical boxes and 0 for disjoint boxes", () => {
    expect(iou(lamp.box, lamp.box)).toBe(1);
    expect(iou(lamp.box, { xMin: 600, yMin: 600, xMax: 700, yMax: 700 })).toBe(0);
  });
});

describe("sceneChanged", () => {
  it("ignores small camera shake", () => {
    const shaken = { ...lamp, box: { xMin: 110, yMin: 105, xMax: 310, yMax: 405 } };
    expect(sceneChanged([lamp], [shaken])).toBe(false);
  });

  it("reports a new object or a changed label", () => {
    const cup = { ...lamp, label: "cup", box: { xMin: 600, yMin: 600, xMax: 700, yMax: 700 } };
    expect(sceneChanged([lamp], [lamp, cup])).toBe(true);
    expect(sceneChanged([lamp], [{ ...lamp, label: "bottle" }])).toBe(true);
    expect(sceneChanged(null, [lamp])).toBe(true);
  });
});

describe("gateFrame", () => {
  const options = { lastSent: [lamp], msSinceLastSent: 1_000, maxQuietMs: 20_000 };

  it("skips frames with nothing sellable in view until the quiet period ends", () => {
    expect(gateFrame({ ...options, detections: [person] })).toEqual({ send: false, reason: "empty" });
    expect(gateFrame({ ...options, detections: [], msSinceLastSent: 20_000 })).toEqual({ send: true });
  });

  it("skips unchanged scenes until the quiet period ends", () => {
    expect(gateFrame({ ...options, detections: [lamp] })).toEqual({ send: false, reason: "unchanged" });
    expect(gateFrame({ ...options, detections: [lamp], msSinceLastSent: 20_000 })).toEqual({ send: true });
  });
});
