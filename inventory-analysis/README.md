# 78 Supermaart — Inventory Assistant V1.1

The **78 Supermaart Inventory Assistant** turns Vyapar spreadsheet exports (`Sale Report` and `Stock Detail Report`) into prioritized, mathematically sound purchase recommendations, catalog health diagnostics, and automated stock name resolution.

Instead of simplistic "sold X, buy X" heuristics, the engine combines **product identity normalization & candidate matching**, **daily sales time-series modeling**, **statistical safety stock**, **automatic trend detection**, and **order-up-to replenishment targets**.

---

## 1. Operational Parameters & Defaults

The V1 engine separates inventory planning into distinct operational parameters:

| Parameter | Default | Operational Definition |
|---|---|---|
| **Lead Time (`leadTimeDays`)** | `3` days | Time elapsed between placing a purchase order and receiving physical stock at the store. |
| **Review Frequency (`reviewFrequencyDays`)** | `7` days | How often inventory is evaluated for replenishment. |
| **Order Coverage (`orderCoverageDays`)** | `15` days | How much forecast demand a replenishment is intended to cover. |
| **Service Level (`serviceLevel`)** | `0.95` (95%) | Target non-stockout probability during the supplier lead time ($Z = 1.65$). |
| **Watch Threshold Factor (`watchThresholdFactor`)** | `1.25` (125%) | Upper boundary for items nearing reorder threshold ($1.0 \times ROP$ to $1.25 \times ROP$). |
| **Use Trend Adjusted Demand (`useTrendAdjustedDemand`)** | `true` | When true, rising/falling demand trends use recent window rate for forecasting. |

---

## 2. Mathematical Model & Formulas

### A. Demand Modeling & Automatic Trend Window
1. **Full Period Daily Demand**:
   $$\mu_{\text{daily}} = \frac{\text{Total Units Sold in Observed Period}}{\text{Total Calendar Days in Period}}$$
   *Zero-sales days are fully filled so slow movers are not overstated.*

2. **Demand Variability**:
   $$\sigma_{\text{daily}} = \sqrt{\frac{1}{N - 1} \sum_{i=1}^N (x_i - \mu)^2}$$

3. **Automatic Trend Window**:
   $$\text{trendWindowDays} = \left\lfloor \frac{\text{periodDays}}{2} \right\rfloor$$
   - **$\text{periodDays} < 14$**: Returns `trend: 'insufficient-data'`. The engine falls back to full-period average demand.
   - **$\text{periodDays} \ge 14$**: Slices equal-length `recent` ($\text{last } W \text{ days}$) and `prior` ($W \text{ days prior}$) windows.

4. **Zero-Baseline Safe Classification**:
   - If $\text{priorAvg} = 0$ and $\text{recentAvg} = 0$: `trend = 'stable'`, $\text{changePct} = 0$.
   - If $\text{priorAvg} = 0$ and $\text{recentAvg} > 0$:
     - If $\text{recentAvg} < 0.5$ units/day: treated conservatively as `'stable'`, $\text{changePct} = 0$ to prevent small blips from triggering massive order spikes.
     - If $\text{recentAvg} \ge 0.5$ units/day: treated as `'rising'`, $\text{changePct} = \text{null}$.
   - If $\text{priorAvg} > 0$:
     $$\text{changePct} = \frac{\text{recentAvg} - \text{priorAvg}}{\text{priorAvg}} \times 100$$
     - $\text{changePct} > +15\% \implies \text{'rising'}$
     - $\text{changePct} < -15\% \implies \text{'falling'}$
     - Otherwise $\implies \text{'stable'}$

5. **Effective Daily Demand (EDD)**:
   - If $\text{useTrendAdjustedDemand} = \text{true}$ and $\text{trend} \in \{\text{'rising'}, \text{'falling'}\}$: $\text{EDD} = \text{recentAvgDailyDemand}$.
   - Otherwise: $\text{EDD} = \text{fullPeriodAvgDailyDemand}$.

---

### B. Buffer, Reorder Point & Replenishment
1. **Safety Stock ($SS$)**:
   Protects strictly against demand volatility during supplier replenishment lead time:
   $$SS = Z \times \sigma_{\text{daily}} \times \sqrt{\text{leadTimeDays}}$$

2. **Reorder Point ($ROP$)**:
   Threshold triggering an immediate purchase order:
   $$ROP = (\text{EDD} \times \text{leadTimeDays}) + SS$$

3. **Target Stock ($TS$)**:
   Order-up-to ceiling covering operating order coverage plus buffer:
   $$TS = (\text{EDD} \times \text{orderCoverageDays}) + SS$$

4. **Inventory Position ($IP$)**:
   $$\text{Inventory Position} = \max(\text{currentStock}, 0)$$
   *(Negative closing stock is clamped to 0 for calculation safety and surfaced in review diagnostics).*

5. **Suggested Order Quantity ($Q$)**:
   $$Q = \begin{cases} \lceil TS - \text{Inventory Position} \rceil & \text{if } \text{classification} = \text{BUY\_NOW} \text{ and } TS > \text{Inventory Position} \\ 0 & \text{otherwise} \end{cases}$$

---

## 3. Classification & Urgency

### Classifications
- **`BUY_NOW`**: Current stock is strictly below the reorder point ($\text{currentStock} < ROP$ and $\text{EDD} > 0$). Replenishment is required.
- **`WATCH`**: Current stock is within 25% above the reorder point ($ROP \le \text{currentStock} \le ROP \times 1.25$). Monitor closely on next review.
- **`OK`**: Current stock is well above the watch threshold ($\text{currentStock} > ROP \times 1.25$). No purchase required.
- **`REVIEW`**: Surfaced in the top-level `review` object for catalog hygiene and data quality exceptions:
  - `negativeStockItems`: Items recorded with negative stock (unlogged purchases or barcode mixups).
  - `deadStockCandidates`: Stock on hand ($> 0$) with 0 sales over the observed period (stale/discontinued).
  - `zeroStockNeverSold`: 0 stock and 0 sales over the observed period.
  - `unresolvedNameVariants`: Items with naming ambiguities.
  - `suggestedMerges`: Potential duplicates identified with contextual average selling price.
  - `dataQualityNotes`: Items sold historically but missing from stock snapshots.

### Days of Cover & Urgency
$$\text{daysOfCover} = \frac{\text{currentStock}}{\text{EDD}}$$

| Days of Cover | Urgency Level | Meaning |
|---|---|---|
| $< 1$ day | `CRITICAL` | Imminent stockout within 24 hours. |
| $1 \le \text{days} < 3$ | `HIGH` | Stockout risk within supplier delivery window. |
| $3 \le \text{days} < 7$ | `BUY` | Below weekly review cycle. |
| $\ge 7$ days | `WATCH` | Sufficient stock for current review cycle. |
| $EDD \le 0$ | `null` | No active demand. |

### Deterministic Reason Generator
Every suggestion includes an auditable explanation string:
- **BUY NOW (rising)**: `"Current stock is below the reorder point. Demand is rising and current stock provides X days of cover."`
- **BUY NOW (stable)**: `"Current stock is below the reorder point. Demand is stable and current stock provides X days of cover."`
- **BUY NOW (falling)**: `"Current stock is below the reorder point. Recent demand is falling and the forecast uses the recent demand rate."`
- **Out of stock**: `"Out of stock. Immediate replenishment needed to reach 15-day target stock."`
- **WATCH**: `"Current stock is within 25% above the reorder point. Monitor closely."`
- **OK**: `"Current stock is well above the reorder point."`

---

## 4. Operating Workflow

```
1. Validate Report Files
   ├── saleReport (.xls/.xlsx)
   └── stockDetail (.xls/.xlsx)
        │
2. Parse & Sanitize
   ├── dd/mm/yyyy date parsing (guards against US format date flips)
   ├── Stock snapshot date extraction from title ("Generated on...")
   └── Negative stock clamping (clamped to 0, logged to negativeStockItems)
        │
3. Catalog / Stock Name Resolution (V1.1 Engine)
   ├── Level 1: Deterministic normalization (strip trailing N/NN/NNN, normalize unit spacing)
   ├── Ledger Check: Apply persistent manual MERGE and KEEP_SEPARATE mappings
   ├── Level 2: Candidate matching (abbreviations e.g. BTTR ↔ BUTTER, consonantal skeletons)
   │    ├── Strict Product Identity Guard: Requires exact Brand, Product, Pack Size, and Unit
   │    └── Size/Product Disqualifiers: Rejects 500 GM vs 100 GM, Butter vs Cheese immediately
   ├── Resolution Hierarchy:
   │    1. Manual Ledger Mapping
   │    2. Exact Match (Clean Stock Name)
   │    3. Level 1 Auto-Normalized
   │    4. Level 2 Pending Candidate (Requires Human Confirmation)
   ├── Consolidation: Merge sales history and stock balance across approved variants
   └── Critical Safeguard: Unresolved candidate items are isolated into `review.matchRequiredItems`
        and EXCLUDED from downstream reorders (zero false purchase orders)
        │
4. Time-Series Analysis (Consolidated Canonical SKUs)
   ├── Generate continuous daily sales series (zero-filling inactive days)
   ├── Automatic trend window derivation: trendWindowDays = floor(periodDays / 2)
   ├── Compute mean, stdDev, recentAvg, priorAvg, demandChangePct
   └── Classify trend (rising / falling / stable / insufficient-data)
        │
5. Replenishment Calculation (Frozen V1 Formulas)
   ├── Determine effectiveDailyDemand
   ├── Compute Safety Stock: SS = Z * sigma * sqrt(leadTimeDays)
   ├── Calculate Reorder Point: ROP = EDD * leadTimeDays + SS
   ├── Calculate Target Stock: TS = EDD * orderCoverageDays + SS
   └── Suggested Order Qty: ceil(TS - currentStock) for BUY_NOW
        │
6. Categorization & Structured Output
   ├── Categorize into BUY_NOW, WATCH, OK
   ├── Isolate Dead Stock, Negative Stock, Zero Stock Never Sold, Match Required
   ├── Construct Name Resolution Summary & Validation Report
   └── Construct JSON API response (summary, suggestions, review, meta, nameResolution)
```

---

## 4.1. Catalog Name Resolution & Decision Ledger (V1.1)

### The Problem
Vyapar generates messy, un-synchronized stock names across `Sale Report` and `Stock Detail`:
- Operational trailing markers (`AMUL BTTR 500 GM N`, `AMUL BTTR 500 GM NN`).
- Abbreviations vs full names (`AMUL BTTR 500 GM` vs `AMUL BUTTER 500 GM`).
- Uncontrolled string similarity matching often dangerously pairs `500 GM` with `100 GM` or `BUTTER` with `CHEESE`.

### Two-Level Matching Architecture
1. **Level 1 — Deterministic Normalization**:
   - Strips trailing operational markers: `/\s+N+$/i`.
   - Normalizes metric units: `500GM` &rarr; `500 GM`, `1LTR` &rarr; `1 L`.
   - **Safe & Automatic**: Runs without requiring human intervention.
2. **Level 2 — Candidate Matching**:
   - Handles abbreviations (`BTTR` &harr; `BUTTER`, `CHOC` &harr; `CHOCOLATE`, `PWDR` &harr; `POWDER`).
   - Computes consonantal skeletons (e.g. `BSTRD` &harr; `BASTARD`).
   - **Identity Guards**: Requires brand match, product category match, and exact numeric size and unit agreement. Pack size mismatches (e.g., `500 GM` vs `100 GM`) and product mismatches (e.g., `BUTTER` vs `CHEESE`) are rejected immediately.
   - **Review Queue**: Generates pending candidate pairs for store manager approval.

### Canonical Name Selection Priority
1. Manual override from the persistent ledger.
2. Stock-master item name without trailing `N` marker.
3. Sales-report item name without trailing `N` marker.
4. Level 1 normalized item name.

### Persistent Ledger (`catalog_ledger.json`)
- **`MERGE`**: Explicitly maps a raw variant to a canonical SKU.
- **`KEEP_SEPARATE`**: Records user rejection of a candidate pair so it is permanently excluded from future candidate review queues.

### Success Criterion: Zero Downstream Duplicate Products
Given:
- `AMUL BUTTER 500 GM`
- `AMUL BTTR 500 GM`
- `AMUL BTTR 500 GM N`

The pipeline resolves:
- **Canonical SKU**: `AMUL BTTR 500 GM`
- **Sales Variants**: `AMUL BUTTER 500 GM` + `AMUL BTTR 500 GM N`
- **Stock Variants**: `AMUL BTTR 500 GM` + `AMUL BTTR 500 GM N`
- **Downstream Result**: Exactly **ONE** product entry with consolidated sales history and stock balance. Zero duplicate rows in `BUY_NOW`, `WATCH`, or `OK`.


---

## 5. Output JSON Schema

```json
{
  "analysisGeneratedAt": "2026-09-16T02:15:00.000Z",
  "config": {
    "leadTimeDays": 3,
    "reviewFrequencyDays": 7,
    "orderCoverageDays": 15,
    "serviceLevel": 0.95,
    "useTrendAdjustedDemand": true,
    "watchThresholdFactor": 1.25
  },
  "summary": {
    "totalItems": 4350,
    "buyNowCount": 182,
    "watchCount": 94,
    "okCount": 1520,
    "reviewCount": 115,
    "deadStockCount": 850,
    "negativeStockCount": 42,
    "zeroStockCount": 1600
  },
  "suggestions": [
    {
      "itemName": "AMUL BUTTER 500G",
      "currentStock": 8,
      "daysOfCover": 1.6,
      "totalSoldInPeriod": 450,
      "periodDays": 90,
      "fullPeriodAvgDailyDemand": 5.0,
      "recentAvgDailyDemand": 5.2,
      "priorAvgDailyDemand": 4.8,
      "effectiveDailyDemand": 5.0,
      "demandBasis": "full-period average",
      "trend": "stable",
      "demandChangePct": 8.33,
      "trendWindowDays": 45,
      "leadTimeDays": 3,
      "reviewFrequencyDays": 7,
      "orderCoverageDays": 15,
      "serviceLevel": 0.95,
      "safetyStock": 5.72,
      "reorderPoint": 20.72,
      "targetStock": 80.72,
      "suggestedOrderQty": 73,
      "classification": "BUY_NOW",
      "urgency": "HIGH",
      "needsReorder": true,
      "reason": "Current stock is below the reorder point. Demand is stable and current stock provides 1.6 days of cover.",
      "stockAsOfDate": "2026-09-13T00:00:00.000Z"
    }
  ],
  "review": {
    "negativeStockItems": [
      { "itemName": "FORTUNE OIL 1L", "recordedClosingQty": -14 }
    ],
    "deadStockCandidates": [
      { "itemName": "SPECIAL RICE 25KG", "currentStock": 35 }
    ],
    "zeroStockNeverSold": [
      { "itemName": "OLD DISCONTINUED BRAND" }
    ],
    "unresolvedNameVariants": [],
    "suggestedMerges": [],
    "dataQualityNotes": []
  },
  "meta": {
    "salesPeriod": { "from": "2026-06-15", "to": "2026-09-13", "days": 90 },
    "stockSnapshotDate": "2026-09-13T00:00:00.000Z",
    "trendWindowDays": 45
  }
}
```

---

## 6. Verification & Test Suite

The module is verified against two automated test suites covering all operational scenarios, edge cases, and safety bounds:

### A. V1 Core Engine Test Suite (21 Categories)
```bash
cd inventory-analysis
node test/v1-tests.js
```
- **Parser & Date**: Header detection, `dd/mm/yyyy` vs `mm/dd/yyyy`, snapshot date extraction.
- **Data Sanitization**: Clamping negative stock to 0, stripping `N/NN/NNN`.
- **Trend Detection**: 60-day (30/30), 90-day (45/45), 120-day (60/60), short-history fallback, zero-baseline safety.
- **Replenishment Formulas**: Safety Stock, Reorder Point, Target Stock, Suggested Qty.
- **Classification**: `BUY_NOW`, `WATCH`, `OK`, `deadStockCandidates`, and `dataQualityNotes`.

### B. V1.1 Catalog Name Resolution Test Suite (10 Categories)
```bash
cd inventory-analysis
node test/v1-1-name-resolution-tests.js
```
1. **Level 1 Deterministic Normalization**: Stripping `N/NN/NNN` and metric unit spacing normalization.
2. **Product Identity Parser**: Extracting brand, product, pack size, unit, and meaningful tokens.
3. **Abbreviation & Candidate Matching**: `BTTR` ↔ `BUTTER`, consonantal skeletons, with confidence scoring.
4. **Strict Pack Size Protection**: `500 GM` vs `100 GM` rejected with 0% match confidence.
5. **Strict Product Category Protection**: `AMUL BUTTER 500 GM` vs `AMUL CHEESE 500 GM` rejected with 0% match confidence.
6. **Persistent Decision Ledger**: `MERGE` and `KEEP_SEPARATE` persistence across engine runs.
7. **Deterministic Canonical Name Priority**: Ledger &rarr; Clean Stock Name &rarr; Clean Sales Name &rarr; Normalized.
8. **Critical Safeguard - Isolation of Unresolved Items**: Items with unresolved candidates are routed to `review.matchRequiredItems` and excluded from downstream purchase suggestions.
9. **Validation Report**: Accurate pre- and post-resolution sales and stock sums.
10. **The Strong Success Criterion**:
    - Input: `AMUL BUTTER 500 GM` (Sales), `AMUL BTTR 500 GM` (Stock), `AMUL BTTR 500 GM N` (Sales & Stock).
    - Result: Canonical `AMUL BTTR 500 GM`, exactly **ONE** consolidated downstream item, zero duplicate butter records in suggestions.

