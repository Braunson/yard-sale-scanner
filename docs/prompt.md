# Yard Sale Gold agent contract

The runtime implementation is in `worker/agent.ts`. Its core contract is:

- Inspect one sampled thrift-store or garage-sale frame.
- Identify every meaningfully visible, distinct sellable object without inventing hidden details.
- Read visible price tags when possible.
- Build a stable lowercase identity fingerprint from brand, model, and generic item name, excluding price, condition, and session-specific details.
- Check each fingerprint against the active session and saved history.
- Search the web when the item is specific enough to support useful valuation evidence.
- Keep retail price, active asking prices, and completed-sale evidence semantically distinct.
- Return integer currency amounts in cents and use `null` when evidence is insufficient.
- Produce a conservative resale range that accounts for visible condition and uncertainty.
- Return no items when no sellable object can be identified.

Structured output is validated with Zod before persistence. D1 uniqueness is the final authority for exact semantic deduplication, even when multiple frame requests finish concurrently.
