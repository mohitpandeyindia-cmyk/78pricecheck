/**
 * Historical Stock Reconstruction Engine (Inventory Assistant V2 Foundation)
 *
 * Implements movement-type-aware stock trajectory reconstruction and reconciliation:
 * - Authoritative sources: Sale Report (sales & returns), Purchase Report (purchases & debit notes), Stock Detail Report (opening & closing anchor).
 * - Distinguishes:
 *     Purchase (+qty)
 *     Debit Note (-qty, purchase reversal)
 *     Sale (-qty, outbound)
 *     Credit Note (+qty, sales return)
 *     Adjustments (+/- qty)
 * - Compares reconstructed closing stock against Stock Detail closing quantity:
 *     Reconciled vs STOCK_RECONSTRUCTION_MISMATCH (does not silently alter either figure).
 * - Classifies daily stock states:
 *     AVAILABLE (stock > 0)
 *     STOCKOUT / DEMAND UNOBSERVABLE (stock <= 0)
 * - Identifies:
 *     firstStockoutDate
 *     lastAvailableDate
 *     stockoutDurationDays
 *     lastReplenishmentDate
 *     replenishedAfterStockout
 *     daysSinceLastReplenishment
 *     stockConstrained
 * - Generates availability-aware demand metrics:
 *     salesWhileAvailable
 *     availableDays
 *     averageDailyDemandWhileAvailable
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toDayKey(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d)) return null;
  const yr = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${yr}-${mo}-${day}`;
}

function parseDayKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function startOfDay(date) {
  const d = date instanceof Date ? date : new Date(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Reconstructs the movement-type-aware stock history and availability for a single SKU.
 *
 * @param {Object} params
 * @param {string} params.skuKey - primary SKU identity (canonicalName or itemCode)
 * @param {string} [params.itemName] - display name
 * @param {string} [params.itemCode] - primary item code (string)
 * @param {number} [params.openingStock=0] - opening/beginning stock from Stock Detail
 * @param {boolean} [params.hasExplicitOpeningEvidence=false] - whether opening stock is backed by explicit audit evidence
 * @param {number|null} [params.stockDetailClosing=null] - closing quantity from Stock Detail
 * @param {number|null} [params.stockDetailIn=null] - quantityIn from Stock Detail
 * @param {number|null} [params.stockDetailOut=null] - quantityOut from Stock Detail
 * @param {Array<Object>} [params.movements=[]] - list of dated movements
 * @param {Object} [params.periodBounds] - { from: Date, to: Date }
 */
function reconstructSkuStock({
  skuKey,
  itemName = '',
  itemCode = null,
  openingStock = 0,
  hasExplicitOpeningEvidence = false,
  stockDetailClosing = null,
  stockDetailIn = null,
  stockDetailOut = null,
  movements = [],
  periodBounds = null,
}) {
  const cleanOpening = typeof openingStock === 'number' && !isNaN(openingStock) ? openingStock : 0;

  // Determine period boundaries
  let minDate = periodBounds?.from ? startOfDay(periodBounds.from) : null;
  let maxDate = periodBounds?.to ? startOfDay(periodBounds.to) : null;

  for (const m of movements) {
    if (m.date) {
      const d = startOfDay(m.date);
      if (!minDate || d < minDate) minDate = d;
      if (!maxDate || d > maxDate) maxDate = d;
    }
  }

  if (!minDate && !maxDate) {
    minDate = new Date();
    maxDate = new Date();
  } else if (!minDate) {
    minDate = new Date(maxDate);
  } else if (!maxDate) {
    maxDate = new Date(minDate);
  }

  const analysisPeriodDays = Math.max(1, Math.round((maxDate - minDate) / MS_PER_DAY) + 1);

  // Group movements by calendar day
  // Day entry: { purchases: 0, debitNotes: 0, sales: 0, creditNotes: 0, adjustments: 0 }
  const dailyMovements = new Map();
  let totalPurchases = 0;
  let totalDebitNotes = 0;
  let totalSales = 0;
  let totalCreditNotes = 0;
  let totalAdjustments = 0;

  for (const m of movements) {
    if (!m.date) continue;
    const dayKey = toDayKey(m.date);
    if (!dailyMovements.has(dayKey)) {
      dailyMovements.set(dayKey, {
        purchases: 0,
        debitNotes: 0,
        sales: 0,
        creditNotes: 0,
        adjustments: 0,
      });
    }

    const entry = dailyMovements.get(dayKey);
    const qty = typeof m.quantity === 'number' && !isNaN(m.quantity) ? m.quantity : 0;
    const type = String(m.transactionType || m.type || '').trim().toLowerCase();

    if (m.isDebitNote || type === 'debit note' || type === 'debit_note') {
      entry.debitNotes += qty;
      totalDebitNotes += qty;
    } else if (m.isCreditNote || type === 'credit note' || type === 'credit_note') {
      entry.creditNotes += qty;
      totalCreditNotes += qty;
    } else if (type === 'sale' || type === 'sales') {
      entry.sales += qty;
      totalSales += qty;
    } else if (type === 'purchase') {
      entry.purchases += qty;
      totalPurchases += qty;
    } else if (type === 'adjustment') {
      entry.adjustments += qty;
      totalAdjustments += qty;
    } else {
      // Default fallback by direction
      if (qty >= 0 && (type.includes('buy') || type.includes('in'))) {
        entry.purchases += qty;
        totalPurchases += qty;
      } else {
        entry.sales += Math.abs(qty);
        totalSales += Math.abs(qty);
      }
    }
  }

  // Iterate chronologically through each calendar day to reconstruct daily stock trajectory
  const dailyStates = [];
  let runningStock = cleanOpening;
  let availableDays = 0;
  let stockoutDays = 0;
  let unknownDays = 0;
  let salesWhileAvailable = 0;
  let firstStockoutDate = null;
  let earliestPlausibleStockoutDate = null;
  let latestPlausibleStockoutDate = null;
  let lastAvailableDate = null;
  let lastReplenishmentDate = null;
  let replenishedAfterStockout = false;
  let hasNegativeRunningDip = false;

  // Determine whether this SKU has undated inward and opening trust
  const totalBilledPurchasesNet = totalPurchases - totalDebitNotes;
  const cleanStockDetailIn = stockDetailIn !== null && stockDetailIn !== undefined ? Number(stockDetailIn) : null;
  const cleanStockDetailClosing = stockDetailClosing !== null && stockDetailClosing !== undefined ? Number(stockDetailClosing) : null;
  const undatedInward = cleanStockDetailIn !== null ? Math.max(0, cleanStockDetailIn - totalBilledPurchasesNet) : 0;
  const hasUndatedInward = cleanStockDetailIn !== null && (cleanStockDetailIn - totalBilledPurchasesNet) > 0.001;
  const hasMissingOpeningEvidence = cleanOpening === 0 && cleanStockDetailIn !== null && cleanStockDetailIn > 0 && totalPurchases === 0;
  const isOpeningTrustworthy = hasExplicitOpeningEvidence || (cleanOpening > 0 && typeof openingStock === 'number');

  // Pre-collect daily records chronologically
  const dayRecords = [];
  const cursorPre = new Date(minDate);
  for (let i = 0; i < analysisPeriodDays; i++) {
    const k = toDayKey(cursorPre);
    const m = dailyMovements.get(k) || {
      purchases: 0,
      debitNotes: 0,
      sales: 0,
      creditNotes: 0,
      adjustments: 0,
    };
    dayRecords.push({
      date: new Date(cursorPre),
      dayKey: k,
      moves: m,
    });
    cursorPre.setDate(cursorPre.getDate() + 1);
  }

  // Precompute cumulative net purchases and sales
  const cumPurchasesArr = new Array(analysisPeriodDays);
  const cumSalesArr = new Array(analysisPeriodDays);
  let accPurchases = 0;
  let accSales = 0;
  for (let i = 0; i < analysisPeriodDays; i++) {
    const m = dayRecords[i].moves;
    accPurchases += (m.purchases - m.debitNotes);
    accSales += (m.sales - m.creditNotes);
    cumPurchasesArr[i] = accPurchases;
    cumSalesArr[i] = accSales;
  }
  const totalPeriodSales = accSales;
  const totalPeriodPurchases = accPurchases;

  for (let i = 0; i < analysisPeriodDays; i++) {
    const { date, dayKey, moves } = dayRecords[i];
    const cumPurchases = cumPurchasesArr[i];
    const cumSales = cumSalesArr[i];
    const futureSales = totalPeriodSales - cumSales;
    const futurePurchases = totalPeriodPurchases - cumPurchases;

    // Net movements on day d
    const dayIn = moves.purchases + moves.creditNotes;
    const dayOut = moves.sales + moves.debitNotes;
    const netDayMovements = dayIn - dayOut + moves.adjustments;

    // Beginning stock of the day is runningStock
    const dayStartStock = runningStock;

    // Track replenishments
    if (moves.purchases > 0) {
      lastReplenishmentDate = new Date(date);
      if (firstStockoutDate) {
        replenishedAfterStockout = true;
      }
    }

    // End-of-day stock under dated movements
    runningStock = dayStartStock + netDayMovements;
    if (runningStock < 0 || dayStartStock < 0) {
      hasNegativeRunningDip = true;
    }

    // Feasible stock balance bounds under all admissible histories
    // Raw past constraint: maximum physical stock that could have existed by day i
    // S_i <= S_0_max + cumPurchases + undatedInward - cumSales
    // When opening is untrusted:
    // - If Stock Detail closing stock is known, opening is bounded by: S_0 <= cleanStockDetailClosing + totalPeriodSales - totalPeriodPurchases
    //   Substituting this S_0_max into S_i gives exactly rawFutureMax.
    // - If no defensible opening-stock upper bound exists (closing stock is null/unknown), do not manufacture one by assuming zero!
    let rawPastMax = Infinity;
    if (isOpeningTrustworthy) {
      rawPastMax = cleanOpening + cumPurchases + undatedInward - cumSales;
    } else if (cleanStockDetailClosing !== null) {
      // Defensible upper bound from complete Stock Detail accounting identity:
      // S_0 <= cleanStockDetailClosing + totalPeriodSales - totalPeriodPurchases
      // Thus: rawPastMax = (cleanStockDetailClosing + totalPeriodSales - totalPeriodPurchases) + cumPurchases + undatedInward - cumSales;
      // In conservative admissible histories with undated inward:
      rawPastMax = (cleanStockDetailClosing + totalPeriodSales - totalPeriodPurchases) + cumPurchases + undatedInward - cumSales;
    } else {
      // No defensible opening-stock upper bound exists; do NOT manufacture zero!
      rawPastMax = Infinity;
    }

    // Raw future constraint: maximum physical stock at day i compatible with cleanStockDetailClosing and future sales
    // S_i <= cleanStockDetailClosing + futureSales - futurePurchases
    let rawFutureMax = Infinity;
    if (cleanStockDetailClosing !== null) {
      rawFutureMax = cleanStockDetailClosing + futureSales - futurePurchases;
    }

    // Mathematical upper bound candidate before clamping
    const rawMaxFeasibleStock = Math.min(rawPastMax, rawFutureMax);

    // Minimum feasible stock candidate:
    // Only dated movements with trustworthy opening balance can prove positive lower bound S_i >= min
    let rawMinFeasibleStock = -Infinity;
    if (isOpeningTrustworthy && !hasUndatedInward) {
      rawMinFeasibleStock = cleanOpening + cumPurchases - cumSales;
    } else if (isOpeningTrustworthy && hasUndatedInward) {
      // Even if undated inward exists, dated purchases alone establish lower bound if they exceed sales
      rawMinFeasibleStock = cleanOpening + cumPurchases - cumSales;
    } else {
      // Unanchored opening balance cannot guarantee positive lower bound
      rawMinFeasibleStock = 0;
    }

    // Evidence Consistency and Feasibility Validation (Defect 1)
    // Check if the ledger constraints are jointly feasible:
    // 1. rawMaxFeasibleStock < 0 means physical stock constraints are contradictory under assumed opening / movements
    // 2. rawMinFeasibleStock > rawMaxFeasibleStock means inverted feasible interval
    // 3. rawPastMax < 0 means cumulative sales exceeded all known inward to date
    const isInfeasible = rawMaxFeasibleStock < -0.001 || (rawMinFeasibleStock > rawMaxFeasibleStock + 0.001);

    // Clamped operational stock values for ordering (never negative)
    const maxFeasibleStock = Math.max(0, rawMaxFeasibleStock);
    const minFeasibleStock = Math.max(0, rawMinFeasibleStock);

    let dayStatus = 'UNKNOWN';
    let rationale = '';

    if (isInfeasible) {
      // Contradictory ledger constraints: DO NOT clamp to zero to claim stockout!
      dayStatus = 'INDETERMINATE';
      unknownDays++;
      rationale = `Infeasible stock constraints: raw upper bound (${Math.round(rawMaxFeasibleStock * 100) / 100}) is negative or inverted relative to lower bound (${Math.round(rawMinFeasibleStock * 100) / 100}). Ledger is contradictory on this date.`;
    } else if (hasUndatedInward || hasMissingOpeningEvidence) {
      // Under undated inward or unanchored opening balance:
      // Rule 4: Classify STOCKOUT only when maximum feasible stock is zero AND underlying constraints are feasible AND no customer sales occurred.
      // Proven terminal stockout occurs when future sales = 0 and cleanStockDetailClosing = 0 and past inward is exhausted.
      if (rawMaxFeasibleStock <= 0.001 && moves.sales === 0) {
        dayStatus = 'STOCKOUT';
        stockoutDays++;
        if (!firstStockoutDate) firstStockoutDate = new Date(date);
        rationale = 'Stockout verified: max feasible stock is zero under all admissible histories (future sales = 0, closing stock = 0).';
      } else {
        dayStatus = 'UNKNOWN';
        unknownDays++;
        if (moves.sales > 0) {
          rationale = `Sales occurred (${moves.sales} units), but arrival chronology of undated inward (${undatedInward} units) prevents exact stock reconstruction.`;
        } else {
          rationale = `Potential stock present: feasible interval is [${Math.round(minFeasibleStock * 100) / 100}, ${Math.round(maxFeasibleStock * 100) / 100}]. Future sales or undated inward (${undatedInward} units) allow non-zero stock.`;
        }
      }
    } else {
      // All inward movements are dated and opening evidence is validated
      if (dayStartStock > 0 || (dayIn > 0 && dayIn >= dayOut)) {
        dayStatus = 'AVAILABLE';
        availableDays++;
        salesWhileAvailable += moves.sales;
        lastAvailableDate = new Date(date);
        rationale = 'Verified available: dated stock balance strictly positive.';
      } else if (dayStartStock <= 0 && runningStock <= 0 && maxFeasibleStock <= 0.001) {
        dayStatus = 'STOCKOUT';
        stockoutDays++;
        if (!firstStockoutDate) {
          firstStockoutDate = new Date(date);
        }
        rationale = 'Stockout verified: dated inventory balance is zero and no inward replenishment present.';
      } else {
        dayStatus = 'UNKNOWN';
        unknownDays++;
        rationale = 'Stock status unknown under dated movements.';
      }
    }

    dailyStates.push({
      date: new Date(date),
      dayKey,
      dayStartStock: Math.round(dayStartStock * 100) / 100,
      purchases: moves.purchases,
      debitNotes: moves.debitNotes,
      sales: moves.sales,
      creditNotes: moves.creditNotes,
      adjustments: moves.adjustments,
      estimatedEndingStock: Math.round(runningStock * 100) / 100,
      rawMinFeasibleStock: Math.round(rawMinFeasibleStock * 100) / 100,
      rawMaxFeasibleStock: Math.round(rawMaxFeasibleStock * 100) / 100,
      minFeasibleStock: Math.round(minFeasibleStock * 100) / 100,
      maxFeasibleStock: Math.round(maxFeasibleStock * 100) / 100,
      undatedInwardConstraint: Math.round(undatedInward * 100) / 100,
      isAvailable: dayStatus === 'AVAILABLE',
      status: dayStatus,
      rationale,
    });
  }

  const reconstructedClosingStock = Math.round(runningStock * 100) / 100;

  // Stockout metrics & interval bounding
  let daysSinceLastReplenishment = null;
  if (lastReplenishmentDate) {
    daysSinceLastReplenishment = Math.max(0, Math.round((maxDate - lastReplenishmentDate) / MS_PER_DAY));
  }

  // Stock Detail Reconciliation
  let reconciliationStatus = 'NOT_CHECKED';
  let reconciliationDifference = null;
  const reconciliationMismatchReasons = [];

  if (cleanStockDetailClosing !== null) {
    reconciliationDifference = Math.round((reconstructedClosingStock - cleanStockDetailClosing) * 100) / 100;

    const EPSILON = 0.001;
    if (Math.abs(reconciliationDifference) <= EPSILON) {
      reconciliationStatus = 'RECONCILED';
    } else {
      reconciliationStatus = 'STOCK_RECONSTRUCTION_MISMATCH';
      reconciliationMismatchReasons.push(
        `Closing stock mismatch: Reconstructed closing = ${reconstructedClosingStock}, but Stock Detail closing = ${cleanStockDetailClosing} (diff: ${reconciliationDifference}).`
      );
    }

    if (stockDetailIn !== null && stockDetailIn !== undefined) {
      const reconIn = totalPurchases + totalCreditNotes;
      const cleanIn = Number(stockDetailIn);
      if (Math.abs(reconIn - cleanIn) > EPSILON) {
        reconciliationMismatchReasons.push(
          `Inward quantity mismatch: Reconstructed In = ${reconIn}, Stock Detail In = ${cleanIn}.`
        );
      }
    }

    if (stockDetailOut !== null && stockDetailOut !== undefined) {
      const reconOut = totalSales + totalDebitNotes;
      const cleanOut = Number(stockDetailOut);
      if (Math.abs(reconOut - cleanOut) > EPSILON) {
        reconciliationMismatchReasons.push(
          `Outward quantity mismatch: Reconstructed Out = ${reconOut}, Stock Detail Out = ${cleanOut}.`
        );
      }
    }
  }

  // Determine availabilityConfidence: VERIFIED | BOUNDED | INDETERMINATE
  let availabilityConfidence = 'INDETERMINATE';
  let stockoutWindow = null;

  const inwardMatchesBilled = cleanStockDetailIn !== null && Math.abs(cleanStockDetailIn - totalBilledPurchasesNet) <= 0.001;
  const isClosingReconciled = reconciliationStatus === 'RECONCILED';

  // Opening balance evidence rule (evaluated earlier):
  // isOpeningTrustworthy was determined above for daily feasible stock bounds.

  if (inwardMatchesBilled && isClosingReconciled && !hasNegativeRunningDip && isOpeningTrustworthy && cleanStockDetailClosing !== null) {
    // Only VERIFIED when dated chronology is validated, balances non-negative, and opening is explicitly trustworthy
    availabilityConfidence = 'VERIFIED';
    stockoutWindow = firstStockoutDate ? { exact: firstStockoutDate, type: 'EXACT' } : null;
  } else if (cleanStockDetailClosing !== null && !hasNegativeRunningDip && inwardMatchesBilled && isClosingReconciled && !isOpeningTrustworthy) {
    // Dated purchases reconcile with Stock Detail, but opening balance is unanchored (assumed 0 Beginning Quantity)
    availabilityConfidence = 'BOUNDED';
    stockoutWindow = firstStockoutDate
      ? { earliestPlausibleDate: firstStockoutDate, latestPlausibleDate: maxDate, type: 'INTERVAL', description: 'Assumed zero opening stock; stockout bounded by dated replenishment.' }
      : { type: 'UNKNOWN', description: 'Continuously active under assumed zero opening balance.' };
  } else if (cleanStockDetailClosing !== null && (hasUndatedInward || hasMissingOpeningEvidence || hasNegativeRunningDip)) {
    // BOUNDED when terminal stockout or bounded coverage can be determined, but exact chronology is incomplete
    if (cleanStockDetailClosing === 0 && totalSales > 0) {
      availabilityConfidence = 'BOUNDED';
      stockoutWindow = {
        earliestPlausibleDate: minDate,
        latestPlausibleDate: maxDate,
        type: 'INTERVAL',
        description: 'Stockout occurred within period; arrival chronology of inward inventory is undated.'
      };
    } else {
      availabilityConfidence = 'INDETERMINATE';
      stockoutWindow = { type: 'UNKNOWN', description: 'Availability indeterminate due to unsupported inward movement chronology.' };
    }
  } else {
    availabilityConfidence = 'INDETERMINATE';
    stockoutWindow = { type: 'UNKNOWN', description: 'Insufficient movement or stock anchor evidence.' };
  }

  // Calculate demand rate while available (only across verified available days)
  const averageDailyDemandWhileAvailable = availableDays > 0
    ? Math.round((salesWhileAvailable / availableDays) * 100) / 100
    : 0;

  const availabilityPercent = analysisPeriodDays > 0
    ? Math.round((availableDays / analysisPeriodDays) * 1000) / 10
    : 0;

  const stockConstrained = stockoutDays > 0 && availableDays < analysisPeriodDays;
  const isProvisional = availabilityConfidence !== 'VERIFIED' || availableDays < 14;

  return {
    skuKey,
    itemName,
    itemCode,
    openingStock: cleanOpening,
    reconstructedClosingStock,
    operationalStock: Math.max(0, cleanStockDetailClosing !== null ? cleanStockDetailClosing : reconstructedClosingStock),
    stockDetailClosing: cleanStockDetailClosing,
    reconciliationStatus,
    reconciliationDifference,
    reconciliationMismatchReasons,
    totals: {
      purchases: totalPurchases,
      debitNotes: totalDebitNotes,
      sales: totalSales,
      creditNotes: totalCreditNotes,
      adjustments: totalAdjustments,
    },
    metrics: {
      analysisPeriodDays,
      availableDays,
      stockoutDays,
      unknownDays,
      availabilityPercent,
      salesWhileAvailable,
      averageDailyDemandWhileAvailable,
      availabilityConfidence,
      stockoutWindow,
      firstStockoutDate: availabilityConfidence === 'VERIFIED' ? firstStockoutDate : null,
      lastAvailableDate,
      lastReplenishmentDate,
      daysSinceLastReplenishment,
      replenishedAfterStockout,
      stockConstrained,
      isProvisional,
    },
    dailyStates,
  };
}

/**
 * Reconstructs stock history for an entire collection of SKUs across four authoritative files.
 *
 * @param {Object} params
 * @param {Array<Object>} params.saleRecords - from parseSaleReport
 * @param {Array<Object>} [params.purchaseRecords=[]] - from parsePurchaseReport
 * @param {Array<Object>} params.stockRecords - from parseStockDetailReport
 * @param {Object} [params.mrpMaster=null] - loaded MRP master
 * @param {Function} [params.resolveToCanonical=null] - name resolution function
 */
function reconstructAllStockHistory({
  saleRecords = [],
  purchaseRecords = [],
  stockRecords = [],
  mrpMaster = null,
  resolveToCanonical = null,
  periodBounds = null,
}) {
  const skuMap = new Map(); // key -> { skuKey, itemName, itemCode, openingStock, stockDetailClosing, stockDetailIn, stockDetailOut, movements: [] }

  const resolve = typeof resolveToCanonical === 'function' ? resolveToCanonical : (name) => name;

  // 1. Anchor from Stock Detail Report
  for (const s of stockRecords) {
    const rawName = s.rawItemName || s.itemName || '';
    const canonical = resolve(rawName);
    const itemCode = s.itemCode ? String(s.itemCode).trim() : null;
    const key = itemCode || canonical;

    if (!skuMap.has(key)) {
      skuMap.set(key, {
        skuKey: key,
        itemName: canonical,
        itemCode,
        openingStock: s.openingQty ?? 0,
        stockDetailClosing: s.closingQty ?? null,
        stockDetailIn: s.quantityIn ?? null,
        stockDetailOut: s.quantityOut ?? null,
        movements: [],
      });
    } else {
      const entry = skuMap.get(key);
      if (typeof s.openingQty === 'number') entry.openingStock += s.openingQty;
      if (typeof s.closingQty === 'number') {
        entry.stockDetailClosing = (entry.stockDetailClosing || 0) + s.closingQty;
      }
      if (typeof s.quantityIn === 'number') {
        entry.stockDetailIn = (entry.stockDetailIn || 0) + s.quantityIn;
      }
      if (typeof s.quantityOut === 'number') {
        entry.stockDetailOut = (entry.stockDetailOut || 0) + s.quantityOut;
      }
      if (!entry.itemCode && itemCode) entry.itemCode = itemCode;
    }
  }

  // 2. Incorporate Purchases & Debit Notes
  for (const p of purchaseRecords) {
    const rawName = p.rawItemName || p.itemName || '';
    const canonical = resolve(rawName);
    const itemCode = p.itemCode ? String(p.itemCode).trim() : null;
    const key = itemCode || canonical;

    if (!skuMap.has(key)) {
      skuMap.set(key, {
        skuKey: key,
        itemName: canonical,
        itemCode,
        openingStock: 0,
        stockDetailClosing: null,
        stockDetailIn: null,
        stockDetailOut: null,
        movements: [],
      });
    }

    const entry = skuMap.get(key);
    entry.movements.push({
      date: p.date,
      quantity: p.quantity,
      transactionType: p.transactionType || (p.isDebitNote ? 'Debit Note' : 'Purchase'),
      isDebitNote: p.isDebitNote,
    });
    if (!entry.itemCode && itemCode) entry.itemCode = itemCode;
  }

  // 3. Incorporate Sales & Credit Notes
  for (const s of saleRecords) {
    const rawName = s.rawItemName || s.itemName || '';
    const canonical = resolve(rawName);
    const itemCode = s.itemCode ? String(s.itemCode).trim() : null;
    const key = itemCode || canonical;

    if (!skuMap.has(key)) {
      skuMap.set(key, {
        skuKey: key,
        itemName: canonical,
        itemCode,
        openingStock: 0,
        stockDetailClosing: null,
        stockDetailIn: null,
        stockDetailOut: null,
        movements: [],
      });
    }

    const entry = skuMap.get(key);
    entry.movements.push({
      date: s.date,
      quantity: s.quantity,
      transactionType: s.transactionType || (s.isCreditNote ? 'Credit Note' : 'Sale'),
      isCreditNote: s.isCreditNote,
    });
    if (!entry.itemCode && itemCode) entry.itemCode = itemCode;
  }

  // 4. Compute global analysis date range across all records
  let globalMinDate = null;
  let globalMaxDate = null;
  for (const s of saleRecords) {
    if (s.date) {
      if (!globalMinDate || s.date < globalMinDate) globalMinDate = s.date;
      if (!globalMaxDate || s.date > globalMaxDate) globalMaxDate = s.date;
    }
  }
  for (const p of purchaseRecords) {
    if (p.date) {
      if (!globalMinDate || p.date < globalMinDate) globalMinDate = p.date;
      if (!globalMaxDate || p.date > globalMaxDate) globalMaxDate = p.date;
    }
  }
  const globalPeriodBounds = periodBounds || (globalMinDate && globalMaxDate ? { from: globalMinDate, to: globalMaxDate } : null);

  // 5. Run reconstruction for each SKU across the full store observation period
  const results = new Map();
  for (const [key, data] of skuMap.entries()) {
    const recon = reconstructSkuStock({
      ...data,
      periodBounds: globalPeriodBounds,
    });
    results.set(key, recon);
    // Also index by canonical itemName if different from key
    if (data.itemName && data.itemName !== key) {
      results.set(data.itemName, recon);
    }
  }

  return results;
}

module.exports = {
  reconstructSkuStock,
  reconstructAllStockHistory,
  toDayKey,
};
