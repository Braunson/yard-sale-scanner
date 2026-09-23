import type { BoundingBox, DeviceBarcode } from "../../src/types";
import { PROVIDER_TIMEOUT_MS } from "./types";

export type BarcodeIdentity = {
  barcode: string;
  kind: "isbn" | "upc";
  title: string | null;
  brand: string | null;
  authors: string[];
  source: string | null;
};

/** GS1 check digit for UPC-A, EAN-13 (and so ISBN-13), and EAN-8. */
export function isValidBarcode(value: string): boolean {
  const digits = value.replace(/[\s-]/g, "");
  if (!/^\d+$/.test(digits) || ![8, 12, 13].includes(digits.length)) return false;
  let sum = 0;
  // Weights alternate 3, 1, … starting from the digit next to the check digit.
  for (let index = digits.length - 2, weight = 3; index >= 0; index -= 1, weight = 4 - weight) {
    sum += Number(digits[index]) * weight;
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/** The service answered and does not know the code. Unlike a failure, this is worth caching. */
class NotFoundError extends Error {}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  if (response.status === 404) throw new NotFoundError("Barcode not found");
  if (!response.ok) throw new Error(`Barcode lookup failed with status ${response.status}`);
  return (await response.json()) as T;
}

async function lookupIsbn(identity: BarcodeIdentity): Promise<BarcodeIdentity> {
  const book = await getJson<{ title?: string; publishers?: string[]; authors?: Array<{ key: string }> }>(
    `https://openlibrary.org/isbn/${identity.barcode}.json`,
  );
  const authors = await Promise.all(
    (book.authors ?? []).slice(0, 2).map(async ({ key }) => {
      try {
        return (await getJson<{ name?: string }>(`https://openlibrary.org${key}.json`)).name ?? null;
      } catch {
        return null;
      }
    }),
  );
  return {
    ...identity,
    title: book.title ?? null,
    brand: book.publishers?.[0] ?? null,
    authors: authors.filter((name): name is string => name !== null),
    source: "openlibrary",
  };
}

async function lookupUpc(identity: BarcodeIdentity): Promise<BarcodeIdentity> {
  // UPCitemdb's offer prices are unreliable, so only its identity fields are used.
  const data = await getJson<{ items?: Array<{ title?: string; brand?: string }> }>(
    `https://api.upcitemdb.com/prod/trial/lookup?upc=${identity.barcode}`,
  );
  const first = data.items?.[0];
  if (!first) return identity;
  return { ...identity, title: first.title || null, brand: first.brand || null, source: "upcitemdb" };
}

const IDENTITY_TTL_MS = 24 * 60 * 60 * 1000;
const identityCache = new Map<string, { at: number; identity: Promise<BarcodeIdentity> }>();

export function clearBarcodeCache(): void {
  identityCache.clear();
}

/**
 * Cached per isolate, because the same code is attached to many frames while it stays in view and
 * UPCitemdb's trial tier allows about 100 lookups a day.
 */
export function lookupBarcode(barcode: string): Promise<BarcodeIdentity> {
  const key = barcode.replace(/\D/g, "");
  const cached = identityCache.get(key);
  if (cached && Date.now() - cached.at < IDENTITY_TTL_MS) return cached.identity;
  const identity = fetchBarcodeIdentity(barcode).then(({ identity: result, failed }) => {
    // A failed lookup is not kept, so the next frame can try again. A code the service does not
    // know is kept, so it is not looked up again on every frame.
    if (failed) identityCache.delete(key);
    return result;
  });
  identityCache.set(key, { at: Date.now(), identity });
  return identity;
}

async function fetchBarcodeIdentity(barcode: string): Promise<{ identity: BarcodeIdentity; failed: boolean }> {
  const digits = barcode.replace(/\D/g, "");
  const kind = digits.length === 13 && /^97[89]/.test(digits) ? "isbn" : "upc";
  const identity: BarcodeIdentity = { barcode: digits, kind, title: null, brand: null, authors: [], source: null };
  if (!digits) return { identity, failed: false };
  try {
    return { identity: kind === "isbn" ? await lookupIsbn(identity) : await lookupUpc(identity), failed: false };
  } catch (error) {
    return { identity, failed: !(error instanceof NotFoundError) };
  }
}

/**
 * Luna links barcodes to items, but its answer is model output. Accept a code only when the device
 * read it in this frame, and, when the device reported where it was, only when its center is inside
 * the item's box. This stops an invented but valid code from pulling another product's prices.
 */
export function deviceBarcodeForItem(
  claimed: string | null,
  itemBox: BoundingBox,
  deviceBarcodes: DeviceBarcode[],
): string | null {
  const digits = claimed?.replace(/\D/g, "") ?? "";
  if (!digits) return null;
  const read = deviceBarcodes.find((barcode) => barcode.value === digits);
  if (!read) return null;
  if (!read.box) return digits;
  const centerX = (read.box.xMin + read.box.xMax) / 2;
  const centerY = (read.box.yMin + read.box.yMax) / 2;
  const inside = centerX >= itemBox.xMin && centerX <= itemBox.xMax && centerY >= itemBox.yMin && centerY <= itemBox.yMax;
  return inside ? digits : null;
}
