const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toDayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Groups raw sale records by item, then by calendar day, summing quantity.
 * Returns { itemName -> Map(dayKey -> qtySoldThatDay) } plus the overall
 * date range found in the data.
 */
function buildDailySeries(saleRecords) {
  if (!saleRecords || saleRecords.length === 0) {
    return { byItem: new Map(), minDate: null, maxDate: null };
  }

  const byItem = new Map();
  let minDate = saleRecords[0].date;
  let maxDate = saleRecords[0].date;

  for (const rec of saleRecords) {
    if (rec.date < minDate) minDate = rec.date;
    if (rec.date > maxDate) maxDate = rec.date;

    if (!byItem.has(rec.itemName)) byItem.set(rec.itemName, new Map());
    const dayMap = byItem.get(rec.itemName);
    const key = toDayKey(rec.date);

    // Enforce gross customer sales for customer demand velocity:
    // Sales returns (credit notes) do not reduce customer purchase velocity.
    const isReturn = rec.isCreditNote || String(rec.transactionType || '').toLowerCase().includes('credit');
    if (!isReturn) {
      const qty = typeof rec.quantity === 'number' && !isNaN(rec.quantity) ? Math.max(0, rec.quantity) : 0;
      dayMap.set(key, (dayMap.get(key) || 0) + qty);
    }
  }

  return { byItem, minDate: startOfDay(minDate), maxDate: startOfDay(maxDate) };
}

function mean(values) {
  if (!values || values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values) {
  if (!values || values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Fills in zero-sale days across the full observed date range for an item,
 * so zero-sales days count toward the average and variability.
 */
function fillDailyValues(dayMap, minDate, maxDate) {
  const totalDays = Math.round((maxDate - minDate) / MS_PER_DAY) + 1;
  const values = [];
  const cursor = new Date(minDate);
  for (let i = 0; i < totalDays; i++) {
    values.push(dayMap.get(toDayKey(cursor)) || 0);
    cursor.setDate(cursor.getDate() + 1);
  }
  return values;
}

/**
 * Minimum recent average daily demand required to classify a 0-baseline item
 * as 'rising'. If prior average was 0 and recent average is below 0.5 units/day,
 * it is conservatively treated as 'stable' rather than an aggressive 100% surge.
 */
const MIN_MEANINGFUL_RECENT_DAILY_DEMAND = 0.5;

/**
 * Compares average daily demand in the recent half vs prior half of the available history.
 * Both windows are strictly equal in length.
 *
 * When dailyStates is available:
 * - Compares equivalent available days.
 * - If recent window is dominated by stockout, avoids falsely classifying demand as 'falling'.
 * - If available observations are sparse (< 7 available days in either window), reports 'insufficient-data'.
 *
 * @param {Array<number>} dailyValues - complete daily series of sales
 * @param {number} trendWindowDays - half the observed period length
 * @param {Array<Object>|null} [dailyStates=null] - daily availability state trajectory from stock reconstruction
 */
function detectTrend(dailyValues, trendWindowDays, dailyStates = null) {
  if (!trendWindowDays || dailyValues.length < 14 || trendWindowDays < 7) {
    return { trend: 'insufficient-data', recentAvg: null, priorAvg: null, changePct: null, reason: 'Observation period < 14 days' };
  }

  // If dailyStates is provided with availability status, use availability-adjusted windows
  if (dailyStates && dailyStates.length >= 14 && dailyStates.length === dailyValues.length) {
    const recentStates = dailyStates.slice(-trendWindowDays);
    const priorStates = dailyStates.slice(-trendWindowDays * 2, -trendWindowDays);

    const recentAvail = recentStates.filter((s) => s.status === 'AVAILABLE');
    const priorAvail = priorStates.filter((s) => s.status === 'AVAILABLE');

    // Sparse check for trend: if fewer than 7 available days in either window, insufficient data
    if (recentAvail.length < 7 || priorAvail.length < 7) {
      const recentStockoutDays = recentStates.filter((s) => s.status === 'STOCKOUT').length;
      return {
        trend: 'insufficient-data',
        recentAvg: recentAvail.length > 0 ? mean(recentAvail.map((s) => s.sales)) : null,
        priorAvg: priorAvail.length > 0 ? mean(priorAvail.map((s) => s.sales)) : null,
        changePct: null,
        reason: recentStockoutDays > (trendWindowDays / 2)
          ? 'Stockout in recent window prevented observable demand'
          : 'Fewer than 7 available days in trend observation window',
      };
    }

    const recentAvg = mean(recentAvail.map((s) => s.sales));
    const priorAvg = mean(priorAvail.map((s) => s.sales));

    let changePct = null;
    let trend;

    if (priorAvg === 0 && recentAvg === 0) {
      trend = 'stable';
      changePct = 0;
    } else if (priorAvg === 0) {
      if (recentAvg >= MIN_MEANINGFUL_RECENT_DAILY_DEMAND) {
        trend = 'rising';
        changePct = null;
      } else {
        trend = 'stable';
        changePct = 0;
      }
    } else {
      changePct = ((recentAvg - priorAvg) / priorAvg) * 100;
      if (changePct > 15) trend = 'rising';
      else if (changePct < -15) trend = 'falling';
      else trend = 'stable';
    }

    return { trend, recentAvg, priorAvg, changePct };
  }

  // Standard calendar-day trend detection
  const recent = dailyValues.slice(-trendWindowDays);
  const prior = dailyValues.slice(-trendWindowDays * 2, -trendWindowDays);

  const recentAvg = mean(recent);
  const priorAvg = mean(prior);

  let changePct = null;
  let trend;

  if (priorAvg === 0 && recentAvg === 0) {
    trend = 'stable';
    changePct = 0;
  } else if (priorAvg === 0) {
    // Zero prior-period baseline: conservative handling to avoid false spikes
    if (recentAvg >= MIN_MEANINGFUL_RECENT_DAILY_DEMAND) {
      trend = 'rising';
      changePct = null;
    } else {
      trend = 'stable';
      changePct = 0;
    }
  } else {
    changePct = ((recentAvg - priorAvg) / priorAvg) * 100;
    if (changePct > 15) trend = 'rising';
    else if (changePct < -15) trend = 'falling';
    else trend = 'stable';
  }

  return { trend, recentAvg, priorAvg, changePct };
}

/**
 * Main entry point: takes parsed sale records, returns per-item demand
 * statistics used by the reorder-point calculation.
 *
 * Automatic Trend Window (V1 Section 5):
 * - Derives window automatically from full period: trendWindowDays = floor(periodDays / 2).
 * - For periodDays < 14: trend = 'insufficient-data'.
 * - For periodDays >= 14: equal-length recent and prior windows.
 *
 * @param {Array} saleRecords - from parseSaleReport().records
 * @param {Object} opts
 * @param {number} [opts.trendWindowDays] - optional override; defaults to automatic floor(periodDays / 2)
 * @param {Map} [opts.reconstructedMap] - optional map of reconstructed stock history
 */
function analyzeSalesPatterns(saleRecords, opts = {}) {
  const { byItem, minDate, maxDate } = buildDailySeries(saleRecords);

  if (!minDate) {
    return { items: {}, periodDays: 0, trendWindowDays: 0, warning: 'No sale records to analyze.' };
  }

  const periodDays = Math.round((maxDate - minDate) / MS_PER_DAY) + 1;

  // Derive trend window automatically: floor(periodDays / 2)
  const autoTrendWindowDays = Math.floor(periodDays / 2);
  const trendWindowDays = opts.trendWindowDays !== undefined && opts.trendWindowDays !== null && opts.trendWindowDays > 0
    ? opts.trendWindowDays
    : autoTrendWindowDays;

  const items = {};
  const reconstructedMap = opts.reconstructedMap || null;

  for (const [itemName, dayMap] of byItem.entries()) {
    const dailyValues = fillDailyValues(dayMap, minDate, maxDate);
    const totalSold = dailyValues.reduce((a, b) => a + b, 0);
    const avgDailyDemand = mean(dailyValues);
    const dailyStdDev = stdDev(dailyValues);

    const recon = reconstructedMap ? (reconstructedMap.get(itemName) || null) : null;

    // Align dailyStates to the exact sales analysis date range by dayKey
    let alignedDailyStates = null;
    if (recon && recon.dailyStates) {
      const stateMap = new Map(recon.dailyStates.map((s) => [s.dayKey, s]));
      const cursor = new Date(minDate);
      alignedDailyStates = [];
      for (let i = 0; i < periodDays; i++) {
        const k = toDayKey(cursor);
        alignedDailyStates.push(stateMap.get(k) || { status: 'UNKNOWN', sales: 0, dayKey: k });
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    const trendInfo = detectTrend(dailyValues, trendWindowDays, alignedDailyStates);

    let effectiveAvgDailyDemand = avgDailyDemand;
    let availabilityMetrics = null;
    let isProvisional = false;
    let provisionalReason = null;

    if (recon && recon.metrics) {
      availabilityMetrics = recon.metrics;
      isProvisional = recon.metrics.isProvisional || false;

      if (recon.metrics.availabilityConfidence === 'VERIFIED') {
        if (recon.metrics.availableDays >= 14) {
          effectiveAvgDailyDemand = recon.metrics.averageDailyDemandWhileAvailable;
          isProvisional = false;
        } else {
          // Sparse observations (< 14 days)
          effectiveAvgDailyDemand = recon.metrics.averageDailyDemandWhileAvailable;
          isProvisional = true;
          provisionalReason = `Sparse observations: only ${recon.metrics.availableDays} verified available days (< 14 days).`;
        }
      } else if (recon.metrics.availabilityConfidence === 'BOUNDED') {
        // Bounded: arrival dates unverified or opening balance assumed; retain calendar baseline with explicit provisional warning
        effectiveAvgDailyDemand = avgDailyDemand;
        isProvisional = true;
        provisionalReason = 'Bounded availability: inward arrival dates are unverified; calendar baseline retained with provisional warning.';
      } else {
        // INDETERMINATE: do NOT claim availability-adjusted
        effectiveAvgDailyDemand = avgDailyDemand;
        isProvisional = true;
        provisionalReason = 'Indeterminate availability: insufficient movement evidence; using calendar demand baseline.';
      }
    }

    items[itemName] = {
      totalSold,
      periodDays,
      trendWindowDays,
      fullPeriodAvgDailyDemand: round2(effectiveAvgDailyDemand),
      calendarAvgDailyDemand: round2(avgDailyDemand),
      avgDailyDemand: round2(effectiveAvgDailyDemand),
      dailyStdDev: dailyStdDev,
      dailyStdDevRaw: dailyStdDev,
      dailyStdDevRounded: round2(dailyStdDev),
      coefficientOfVariation: effectiveAvgDailyDemand > 0 ? round2(dailyStdDev / effectiveAvgDailyDemand) : null,
      trend: trendInfo.trend,
      recentAvgDailyDemand: trendInfo.recentAvg !== null ? round2(trendInfo.recentAvg) : null,
      priorAvgDailyDemand: trendInfo.priorAvg !== null ? round2(trendInfo.priorAvg) : null,
      demandChangePct: trendInfo.changePct !== null ? round2(trendInfo.changePct) : null,
      trendReason: trendInfo.reason || null,
      availability: availabilityMetrics,
      availabilityConfidence: recon?.metrics?.availabilityConfidence || 'INDETERMINATE',
      isProvisional,
      provisionalReason,
      reconciliationStatus: recon ? recon.reconciliationStatus : 'NOT_CHECKED',
      reconciliationDifference: recon ? recon.reconciliationDifference : null,
      reconciliationMismatchReasons: recon ? recon.reconciliationMismatchReasons : [],
    };
  }

  return {
    items,
    periodDays,
    trendWindowDays,
    dateRange: {
      from: minDate,
      to: maxDate,
      days: periodDays,
    },
  };
}

function round2(n) {
  if (n === null || n === undefined || isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

module.exports = {
  analyzeSalesPatterns,
  detectTrend,
  buildDailySeries,
  fillDailyValues,
  mean,
  stdDev,
  MIN_MEANINGFUL_RECENT_DAILY_DEMAND,
};
