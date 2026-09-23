import type { DeviceBarcode } from "./types";

// UPC-E is left out: its check digit needs expansion to UPC-A first, and short codes misread easily.
const FORMATS = ["ean_13", "ean_8", "upc_a"] as const;

type Reader = { detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string; format: string; boundingBox: DOMRectReadOnly }>> };

let readerPromise: Promise<Reader> | null = null;
let decodeCanvas: HTMLCanvasElement | null = null;
const MAX_DECODE_EDGE = 1280;

/**
 * Uses the browser's BarcodeDetector (Chrome, Android) when it reads retail codes, and the ZXing
 * WebAssembly ponyfill everywhere else (Safari, iOS, Firefox). The ponyfill loads only when needed.
 */
export function loadBarcodeReader(): Promise<Reader> {
  readerPromise ??= (async () => {
    const native = (globalThis as { BarcodeDetector?: { new (options: { formats: string[] }): Reader; getSupportedFormats(): Promise<string[]> } }).BarcodeDetector;
    if (native) {
      const supported = await native.getSupportedFormats().catch(() => [] as string[]);
      if (FORMATS.every((format) => supported.includes(format))) return new native({ formats: [...FORMATS] });
    }
    const { BarcodeDetector } = await import("barcode-detector/ponyfill");
    return new BarcodeDetector({ formats: [...FORMATS] }) as unknown as Reader;
  })();
  readerPromise.catch(() => {
    readerPromise = null;
  });
  return readerPromise;
}

/** GS1 check digit, which UPC-A, UPC-E (expanded), EAN-8, EAN-13, and ISBN-13 all use. */
export function hasValidCheckDigit(value: string): boolean {
  if (!/^\d{8}$|^\d{12,13}$/.test(value)) return false;
  const digits = [...value].map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** Reads retail barcodes from a video frame or canvas, with boxes in the 0-1000 frame space. */
export async function readBarcodes(
  reader: Reader,
  source: HTMLVideoElement | HTMLCanvasElement,
): Promise<DeviceBarcode[]> {
  const width = source instanceof HTMLVideoElement ? source.videoWidth : source.width;
  const height = source instanceof HTMLVideoElement ? source.videoHeight : source.height;
  if (!width || !height) return [];
  // The WebAssembly reader runs on the main thread, so large frames are scaled down first.
  // Box coordinates are relative, so they are the same at either size.
  const scale = Math.min(1, MAX_DECODE_EDGE / Math.max(width, height));
  let input: HTMLVideoElement | HTMLCanvasElement = source;
  if (scale < 1) {
    decodeCanvas ??= document.createElement("canvas");
    decodeCanvas.width = Math.round(width * scale);
    decodeCanvas.height = Math.round(height * scale);
    decodeCanvas.getContext("2d")?.drawImage(source, 0, 0, decodeCanvas.width, decodeCanvas.height);
    input = decodeCanvas;
  }
  const results = await reader.detect(input);
  const inputWidth = input === source ? width : input.width;
  const inputHeight = input === source ? height : input.height;
  const toFrame = (value: number, size: number) => Math.min(1000, Math.max(0, Math.round((value / size) * 1000)));
  const seen = new Set<string>();
  return results.flatMap((result) => {
    const value = result.rawValue.replace(/\D/g, "");
    if (!hasValidCheckDigit(value) || seen.has(value)) return [];
    seen.add(value);
    const box = result.boundingBox;
    return [{
      value,
      format: result.format,
      box: box
        ? {
            xMin: toFrame(box.x, inputWidth),
            yMin: toFrame(box.y, inputHeight),
            xMax: toFrame(box.x + box.width, inputWidth),
            yMax: toFrame(box.y + box.height, inputHeight),
          }
        : null,
    }];
  });
}
