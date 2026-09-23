import type { BoundingBox, DeviceDetection } from "./types";

/** COCO labels that are almost never the merchandise at a yard sale. */
const NON_MERCHANDISE_LABELS = new Set([
  "person", "car", "bus", "truck", "train", "airplane", "boat", "motorcycle",
  "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "dining table",
  "bird", "cat", "dog", "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe",
]);
export const MIN_DETECTION_SCORE = 0.4;
/** Two boxes with the same label and at least this overlap are treated as the same object. */
const SAME_OBJECT_IOU = 0.5;

export function sellableDetections(detections: DeviceDetection[]): DeviceDetection[] {
  return detections.filter(
    (detection) => detection.score >= MIN_DETECTION_SCORE && !NON_MERCHANDISE_LABELS.has(detection.label),
  );
}

export function iou(left: BoundingBox, right: BoundingBox): number {
  const width = Math.min(left.xMax, right.xMax) - Math.max(left.xMin, right.xMin);
  const height = Math.min(left.yMax, right.yMax) - Math.max(left.yMin, right.yMin);
  if (width <= 0 || height <= 0) return 0;
  const intersection = width * height;
  const area = (box: BoundingBox) => (box.xMax - box.xMin) * (box.yMax - box.yMin);
  return intersection / (area(left) + area(right) - intersection);
}

/**
 * True when the current frame shows an object that was not in the last frame sent for analysis,
 * so the camera can stay pointed at one table without paying to re-analyze it every interval.
 */
export function sceneChanged(previous: DeviceDetection[] | null, current: DeviceDetection[]): boolean {
  if (previous === null) return true;
  return current.some(
    (detection) =>
      !previous.some(
        (earlier) => earlier.label === detection.label && iou(earlier.box, detection.box) >= SAME_OBJECT_IOU,
      ),
  );
}

export type GateDecision = { send: true } | { send: false; reason: "empty" | "unchanged" };

export function gateFrame(options: {
  detections: DeviceDetection[];
  lastSent: DeviceDetection[] | null;
  msSinceLastSent: number;
  maxQuietMs: number;
}): GateDecision {
  // COCO has no class for clothing, records, tools, and many other sale items, so
  // always re-check the scene now and then, even when the detector sees nothing.
  if (options.msSinceLastSent >= options.maxQuietMs) return { send: true };
  const sellable = sellableDetections(options.detections);
  if (sellable.length === 0) return { send: false, reason: "empty" };
  return sceneChanged(options.lastSent, sellable) ? { send: true } : { send: false, reason: "unchanged" };
}
