import { describe, expect, it } from "vitest";
import { matchBoxes, mergeTracks, seedTracks, TRACK_MAX_AGE_MS, updateTracks } from "./tracking";
import type { DeviceDetection } from "./types";

const box = (xMin: number, yMin: number, xMax: number, yMax: number) => ({ xMin, yMin, xMax, yMax });
const detection = (label: string, b: ReturnType<typeof box>): DeviceDetection => ({ label, score: 0.8, box: b });

describe("matchBoxes", () => {
  it("pairs the best overlaps one to one and respects labels", () => {
    const left = [{ label: "cup", box: box(0, 0, 100, 100) }, { label: null, box: box(500, 500, 600, 600) }];
    const right = [detection("vase", box(0, 0, 100, 100)), detection("cup", box(10, 10, 110, 110)), detection("book", box(505, 505, 605, 605))];
    const matches = matchBoxes(left, right);
    expect(matches.map(([l, r]) => [l.label, r.label])).toEqual([[null, "book"], ["cup", "cup"]]);
  });
});

describe("seedTracks", () => {
  it("takes the detector label and box from the hint that overlaps each find", () => {
    const tracks = seedTracks(
      [{ id: "lamp", boundingBox: box(100, 100, 300, 500) }, { id: "no-box", boundingBox: null }],
      [detection("vase", box(110, 90, 310, 480))],
      1_000,
    );
    expect(tracks).toEqual([{ itemId: "lamp", box: box(110, 90, 310, 480), label: "vase", lastMatchedAt: 1_000, confirmed: false }]);
  });

  it("keeps Luna's box when no hint overlaps", () => {
    const [track] = seedTracks([{ id: "tee", boundingBox: box(0, 0, 200, 200) }], [], 0);
    expect(track).toMatchObject({ box: box(0, 0, 200, 200), label: null });
  });
});

describe("updateTracks", () => {
  const track = { itemId: "lamp", box: box(100, 100, 300, 500), label: "vase", lastMatchedAt: 0, confirmed: true };

  it("follows the object as the camera moves", () => {
    const [moved] = updateTracks([track], [detection("vase", box(140, 110, 340, 510))], 200);
    expect(moved).toEqual({ ...track, box: box(140, 110, 340, 510), lastMatchedAt: 200 });
  });

  it("needs a close overlap before a new track follows a detection", () => {
    const fresh = { ...track, confirmed: false };
    // IoU about 0.33: enough for a confirmed track, not for a new one.
    expect(updateTracks([fresh], [detection("vase", box(200, 100, 400, 500))], 200)).toEqual([fresh]);
    expect(updateTracks([fresh], [detection("vase", box(110, 100, 310, 500))], 200)[0]).toMatchObject({ confirmed: true, lastMatchedAt: 200 });
  });

  it("keeps a lost track briefly, then drops it", () => {
    expect(updateTracks([track], [], TRACK_MAX_AGE_MS)).toEqual([track]);
    expect(updateTracks([track], [], TRACK_MAX_AGE_MS + 1)).toEqual([]);
  });
});

describe("mergeTracks", () => {
  it("replaces an older track for the same find", () => {
    const old = { itemId: "a", box: box(0, 0, 1, 1), label: null, lastMatchedAt: 0, confirmed: false };
    const fresh = { ...old, lastMatchedAt: 5 };
    expect(mergeTracks([old, { ...old, itemId: "b" }], [fresh])).toEqual([{ ...old, itemId: "b" }, fresh]);
  });
});
