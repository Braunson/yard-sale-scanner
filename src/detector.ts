import type { ObjectDetector } from "@mediapipe/tasks-vision";
import type { DeviceDetection } from "./types";

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite";

let detectorPromise: Promise<ObjectDetector> | null = null;

/** Loads EfficientDet-Lite0 (COCO, ~4.5 MB) once. It runs on the GPU when available. */
export function loadDetector(): Promise<ObjectDetector> {
  detectorPromise ??= (async () => {
    const { FilesetResolver, ObjectDetector } = await import("@mediapipe/tasks-vision");
    const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
    const options = { scoreThreshold: 0.3, maxResults: 12, runningMode: "VIDEO" as const };
    try {
      return await ObjectDetector.createFromOptions(fileset, {
        ...options,
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      });
    } catch {
      return ObjectDetector.createFromOptions(fileset, {
        ...options,
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
      });
    }
  })();
  detectorPromise.catch(() => {
    detectorPromise = null;
  });
  return detectorPromise;
}

/** Detects objects in the current video frame, with boxes in the same 0-1000 space the server uses. */
export function detectVideoFrame(detector: ObjectDetector, video: HTMLVideoElement, timestampMs: number): DeviceDetection[] {
  if (!video.videoWidth || !video.videoHeight) return [];
  const result = detector.detectForVideo(video, timestampMs);
  return result.detections.flatMap((detection) => {
    const category = detection.categories[0];
    const box = detection.boundingBox;
    if (!category || !box) return [];
    const scale = (value: number, size: number) => Math.min(1000, Math.max(0, Math.round((value / size) * 1000)));
    return [{
      label: category.categoryName,
      score: category.score,
      box: {
        xMin: scale(box.originX, video.videoWidth),
        yMin: scale(box.originY, video.videoHeight),
        xMax: scale(box.originX + box.width, video.videoWidth),
        yMax: scale(box.originY + box.height, video.videoHeight),
      },
    }];
  });
}
