import { iou } from "./detection";
import type { BoundingBox, DeviceDetection } from "./types";

/** Minimum overlap to treat a live detection as the same object as a tracked find. */
export const TRACK_MIN_IOU = 0.3;
/**
 * A new track comes from boxes that are seconds old by the time the find arrives, so it must
 * overlap a live detection more closely before it can follow one. This stops a label from
 * jumping to a similar object that is now where the find was.
 */
export const TRACK_CONFIRM_IOU = 0.5;
/** A label with no matching detection for this long is removed. */
export const TRACK_MAX_AGE_MS = 1_500;
/** Finds that arrive later than this after capture get no label; the camera has likely moved. */
export const TRACK_MAX_SEED_DELAY_MS = 10_000;

export type Track = {
  itemId: string;
  box: BoundingBox;
  /** COCO label of the detection that carries this find, or null if no detection matched yet. */
  label: string | null;
  lastMatchedAt: number;
  /** True after the track has matched a live detection at least once. */
  confirmed: boolean;
};

type Boxed = { box: BoundingBox; label: string | null };

/**
 * Greedy one-to-one matching by IoU, best pairs first. When both sides have a label,
 * the labels must agree, so a cup cannot take over a lamp's label.
 */
export function matchBoxes<Left extends Boxed, Right extends Boxed>(
  left: Left[],
  right: Right[],
  minIou = TRACK_MIN_IOU,
): Array<[Left, Right]> {
  const pairs: Array<{ left: Left; right: Right; score: number }> = [];
  for (const leftEntry of left) {
    for (const rightEntry of right) {
      if (leftEntry.label && rightEntry.label && leftEntry.label !== rightEntry.label) continue;
      const score = iou(leftEntry.box, rightEntry.box);
      if (score >= minIou) pairs.push({ left: leftEntry, right: rightEntry, score });
    }
  }
  pairs.sort((first, second) => second.score - first.score);
  const usedLeft = new Set<Left>();
  const usedRight = new Set<Right>();
  const matches: Array<[Left, Right]> = [];
  for (const pair of pairs) {
    if (usedLeft.has(pair.left) || usedRight.has(pair.right)) continue;
    usedLeft.add(pair.left);
    usedRight.add(pair.right);
    matches.push([pair.left, pair.right]);
  }
  return matches;
}

/**
 * Starts tracks for finds from one analyzed frame. Luna's item boxes and the detector hints sent
 * with that frame use the same coordinates, so each find takes the label of the hint it overlaps.
 */
export function seedTracks(
  items: Array<{ id: string; boundingBox: BoundingBox | null }>,
  hints: DeviceDetection[],
  now: number,
): Track[] {
  const boxed = items.flatMap((item) => (item.boundingBox ? [{ itemId: item.id, box: item.boundingBox, label: null }] : []));
  const matches = new Map(matchBoxes(boxed, hints).map(([item, hint]) => [item.itemId, hint]));
  return boxed.map((item) => {
    const hint = matches.get(item.itemId);
    return { itemId: item.itemId, box: hint?.box ?? item.box, label: hint?.label ?? null, lastMatchedAt: now, confirmed: false };
  });
}

/** Moves each track to its matching live detection and drops tracks that have been lost too long. */
export function updateTracks(tracks: Track[], detections: DeviceDetection[], now: number): Track[] {
  const confirmedMatches = matchBoxes(tracks.filter((track) => track.confirmed), detections);
  const taken = new Set(confirmedMatches.map(([, detection]) => detection));
  const newMatches = matchBoxes(
    tracks.filter((track) => !track.confirmed),
    detections.filter((detection) => !taken.has(detection)),
    TRACK_CONFIRM_IOU,
  );
  const matches = new Map([...confirmedMatches, ...newMatches]);
  return tracks.flatMap((track) => {
    const detection = matches.get(track);
    if (detection) return [{ ...track, box: detection.box, label: detection.label, lastMatchedAt: now, confirmed: true }];
    return now - track.lastMatchedAt > TRACK_MAX_AGE_MS ? [] : [track];
  });
}

/** Adds new tracks; a newer track for the same find replaces the older one. */
export function mergeTracks(existing: Track[], incoming: Track[]): Track[] {
  const incomingIds = new Set(incoming.map((track) => track.itemId));
  return [...existing.filter((track) => !incomingIds.has(track.itemId)), ...incoming];
}
