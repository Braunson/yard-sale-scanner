import { EMPTY_LEDGER, defaultFeesCents, expectedSaleCents } from "../src/ledger";
import { marketForCurrency, PLATFORMS } from "../src/markets";
import type { DetectedItem, Ledger } from "../src/types";

export class LedgerInputError extends Error {}

const MAX_CENTS = 100_000_000;

function cents(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_CENTS) {
    throw new LedgerInputError(`${field} must be a whole number of cents from 0 to ${MAX_CENTS}.`);
  }
  return value;
}

function date(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new LedgerInputError(`${field} must be a date.`);
  return new Date(value).toISOString();
}

/**
 * Validates a ledger update for one item. Missing dates default to now, the sale fee defaults to the
 * platform's standard fee, and the app's estimate for that platform is stored with the sale so later
 * re-pricing cannot change the accuracy figures.
 */
export function buildLedger(body: unknown, item: DetectedItem, now = new Date().toISOString()): Ledger {
  if (typeof body !== "object" || body === null) throw new LedgerInputError("A ledger object is required.");
  const input = body as Record<string, unknown>;
  const purchaseCents = cents(input.purchaseCents, "purchaseCents");
  const saleCents = cents(input.saleCents, "saleCents");
  const platforms = PLATFORMS[marketForCurrency(item.currency)].map((platform) => platform.id);
  const platformId = input.platformId === null || input.platformId === undefined || input.platformId === "" ? null : input.platformId;
  if (platformId !== null && (typeof platformId !== "string" || !platforms.includes(platformId))) {
    throw new LedgerInputError(`platformId must be one of: ${platforms.join(", ")}.`);
  }
  if (saleCents !== null && platformId === null) throw new LedgerInputError("A sale needs a platform.");

  if (purchaseCents === null && saleCents === null) return EMPTY_LEDGER;
  const previous = item.ledger ?? EMPTY_LEDGER;
  const sameSale = saleCents !== null && saleCents === previous.saleCents && platformId === previous.platformId;
  return {
    purchaseCents,
    purchasedAt: purchaseCents === null ? null : date(input.purchasedAt, "purchasedAt") ?? previous.purchasedAt ?? now,
    saleCents,
    soldAt: saleCents === null ? null : date(input.soldAt, "soldAt") ?? previous.soldAt ?? now,
    platformId: saleCents === null ? null : platformId,
    feesCents:
      saleCents === null
        ? null
        : cents(input.feesCents, "feesCents") ?? defaultFeesCents(item.currency, platformId!, saleCents),
    shippingCents: saleCents === null ? null : cents(input.shippingCents, "shippingCents"),
    // Keep the estimate from when the sale was first recorded; edits to the fee or date do not move it.
    estimateCents:
      saleCents === null ? null : sameSale && previous.estimateCents !== null ? previous.estimateCents : expectedSaleCents(item, platformId!),
  };
}
