import { describe, expect, it } from "vitest";
import { hasValidCheckDigit } from "./barcodes";

describe("hasValidCheckDigit", () => {
  it("accepts valid ISBN-13, UPC-A, and EAN-8 codes", () => {
    expect(hasValidCheckDigit("9780306406157")).toBe(true);
    expect(hasValidCheckDigit("036000291452")).toBe(true);
    expect(hasValidCheckDigit("96385074")).toBe(true);
  });

  it("rejects misreads and other lengths", () => {
    expect(hasValidCheckDigit("9780306406158")).toBe(false);
    expect(hasValidCheckDigit("12345")).toBe(false);
    expect(hasValidCheckDigit("03600029145a")).toBe(false);
  });
});
