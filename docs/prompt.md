# Yard Sale Gold agent contract

The runtime implementation is in `worker/agent.ts`. Its core contract is:

- Inspect one sampled thrift-store or garage-sale frame.
- Prefer a high-precision shortlist over exhaustive detection; omit uncertain objects rather than guessing.
- Include only objects that appear to be merchandise and can be identified at a useful, searchable level with at least 0.70 confidence.
- Exclude people and anything currently worn or carried by them, including clothing, shoes, jewelry, accessories, and bags.
- Exclude objects merely held or used by a person unless unmistakably being presented for sale.
- Exclude fixtures, background decor, partial objects, heavily occluded objects, and small or blurry objects unless clearly displayed or tagged for sale.
- Treat one sellable object as one item rather than returning its components separately.
- Read visible price tags when possible.
- Build a stable lowercase identity fingerprint from brand, model, and generic item name, excluding price, condition, and session-specific details.
- Check each fingerprint against the active session and saved history.
- Search the web when the item is specific enough to support useful valuation evidence.
- Keep retail price, active asking prices, and completed-sale evidence semantically distinct.
- Return integer currency amounts in cents and use `null` when evidence is insufficient.
- Produce a conservative resale range that accounts for visible condition and uncertainty.
- Return no items when no sellable object can be identified.

Structured output is validated with Zod before persistence. D1 uniqueness is the final authority for exact semantic deduplication, even when multiple frame requests finish concurrently.
