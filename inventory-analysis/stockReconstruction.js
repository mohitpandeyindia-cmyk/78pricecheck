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
  let salesWhileAvailable = 0;
  let firstStockoutDate = null;
  let lastAvailableDate = null;
  let lastReplenishmentDate = null;
  let replenishedAfterStockout = false;

  const cursor = new Date(minDate);
  for (let i = 0; i < analysisPeriodDays; i++) {
    const dayKey = toDayKey(cursor);
    const moves = dailyMovements.get(dayKey) || {
      purchases: 0,
      debitNotes: 0,
      sales: 0,
      creditNotes: 0,
      adjustments: 0,
    };

    // Net movements on day d
    // Inbound: purchases + creditNotes (sales returns)
    // Outbound: sales + debitNotes (purchase returns)
    // Adjustments: added directly
    const dayIn = moves.purchases + moves.creditNotes;
    const dayOut = moves.sales + moves.debitNotes;
    const netDayMovements = dayIn - dayOut + moves.adjustments;

    // Beginning stock of the day is runningStock
    const dayStartStock = runningStock;

    // Track replenishments
    if (moves.purchases > 0) {
      lastReplenishmentDate = new Date(cursor);
      if (firstStockoutDate) {
        replenishedAfterStockout = true;
      }
    }

    // End-of-day stock
    runningStock = dayStartStock + netDayMovements;

    // Availability determination:
    // A SKU is considered AVAILABLE if it had stock to sell during that day (dayStartStock > 0 or runningStock > 0)
    // Stockout is when both start and end are <= 0, or end drops <= 0
    const wasAvailable = dayStartStock > 0 || (dayIn > 0 && dayIn >= dayOut);

    if (wasAvailable) {
      availableDays++;
      salesWhileAvailable += moves.sales;
      lastAvailableDate = new Date(cursor);
    } else {
      stockoutDays++;
      if (!firstStockoutDate) {
        firstStockoutDate = new Date(cursor);
      }
    }

    dailyStates.push({
      date: new Date(cursor),
      dayKey,
      dayStartStock: Math.round(dayStartStock * 100) / 100,
      purchases: moves.purchases,
      debitNotes: moves.debitNotes,
      sales: moves.sales,
      creditNotes: moves.creditNotes,
      adjustments: moves.adjustments,
      estimatedEndingStock: Math.round(runningStock * 100) / 100,
      isAvailable: wasAvailable,
      status: wasAvailable ? 'AVAILABLE' : 'STOCKOUT',
    });

    cursor.setDate(cursor.getDate() + 1);
  }

  const reconstructedClosingStock = Math.round(runningStock * 100) / 100;

  // Stockout metrics
  let stockoutDurationDays = stockoutDays;
  let daysSinceLastReplenishment = null;
  if (lastReplenishmentDate) {
    daysSinceLastReplenishment = Math.max(0, Math.round((maxDate - lastReplenishmentDate) / MS_PER_DAY));
  }

  const availabilityPercent = analysisPeriodDays > 0
    ? Math.round((availableDays / analysisPeriodDays) * 1000) / 10
    : 0;

  const averageDailyDemandWhileAvailable = availableDays > 0
    ? Math.round((salesWhileAvailable / availableDays) * 100) / 100
    : 0;

  const stockConstrained = stockoutDays > 0 && availableDays < analysisPeriodDays;

  // Mandatory Reconciliation against Stock Detail
  let reconciliationStatus = 'NOT_CHECKED';
  let reconciliationDifference = null;
  const reconciliationMismatchReasons = [];

  if (stockDetailClosing !== null && stockDetailClosing !== undefined) {
    const cleanStockDetailClosing = Number(stockDetailClosing);
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

  return {
    skuKey,
    itemName,
    itemCode,
    openingStock: cleanOpening,
    reconstructedClosingStock,
    stockDetailClosing: stockDetailClosing !== null ? Number(stockDetailClosing) : null,
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
      availabilityPercent,
      salesWhileAvailable,
      averageDailyDemandWhileAvailable,
      firstStockoutDate,
      lastAvailableDate,
      lastReplenishmentDate,
      daysSinceLastReplenishment,
      replenishedAfterStockout,
      stockConstrained,
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

  // 4. Run reconstruction for each SKU
  const results = new Map();
  for (const [key, data] of skuMap.entries()) {
    const recon = reconstructSkuStock(data);
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
