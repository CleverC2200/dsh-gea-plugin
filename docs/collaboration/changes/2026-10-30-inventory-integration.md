# Inventory and APS integration, 2026-10-30

The candidate reconciles the independent inventory, branch and APS repairs against the current main branches. Raw snapshots and reconciliation evidence stay outside the public repositories. No authored Agent Skill or dashboard prompt asset is replaced.

## Business boundaries

- Pending branch supply orders use unreceived ASN documents. The receiving warehouse owns the order; execution lines supply base allocation. Shared base/SKU availability is allocated once, in creation-time order, before branch filtering and pagination.
- Monthly supply fulfilment remains an independent receiving-warehouse execution measure. Warehouse outbound uses WMS closing dates and delivered quantities in pieces. Customer deliveries do not replace branch supply orders or WMS movement.
- Missing or denied sources remain distinct from zero. Independent valid inventory, movement and fee fields stay visible.
- Imported plans replace their warehouse/month package. The same recalculated rows feed visible pages and CSV. Independent replenishment/business filters apply before counts and paging; positive manual quantities remain eligible.
- Normal successful reads retain the existing twenty-minute, identity-scoped cache. Failed or incomplete reads do not become successful cache entries. A replaced connection withdraws results owned by the old port.

## Regression review

The newest ASN definition intentionally supersedes the older execution-side current-order definition; monthly execution fulfilment is retained separately. The established DMS confirmation, persistence and receipt flow is preserved. Positive-only confirmation rows remain editable while their value is cleared. No business data tables or account permissions are modified.

Coverage includes actual configured SQL fixtures, FIFO/allocation and unit boundaries, outer gateway pagination, scoped browser filters, inline SKU resources, plan/CSV parity, cache recovery, target-version selection and APS perspective calculations. Installation and real model acceptance are separate release stages and are not claimed by source tests.

## Remaining external evidence

Source publication, source accuracy snapshots, ordinary-account permissions and model transport failures require their own verification. Those issues are not declared resolved merely because this code is included.
