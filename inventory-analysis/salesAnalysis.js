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
    dayMap.set(key, (dayMap.get(key) || 0) + rec.quantity);
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
 * @param {Array<number>} dailyValues - complete daily series of sales
 * @param {number} trendWindowDays - half the observed period length
 */
function detectTrend(dailyValues, trendWindowDays) {
  if (!trendWindowDays || dailyValues.length < 14 || trendWindowDays < 7) {
    return { trend: 'insufficient-data', recentAvg: null, priorAvg: null, changePct: null };
  }

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
      changePct = null; // mathematical % change from 0 is undefined, but trend is genuine
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

  for (const [itemName, dayMap] of byItem.entries()) {
    const dailyValues = fillDailyValues(dayMap, minDate, maxDate);
    const totalSold = dailyValues.reduce((a, b) => a + b, 0);
    const avgDailyDemand = mean(dailyValues);
    const dailyStdDev = stdDev(dailyValues);
    const trendInfo = detectTrend(dailyValues, trendWindowDays);

    items[itemName] = {
      totalSold,
      periodDays,
      trendWindowDays,
      fullPeriodAvgDailyDemand: round2(avgDailyDemand),
      avgDailyDemand: round2(avgDailyDemand),
      dailyStdDev: round2(dailyStdDev),
      coefficientOfVariation: avgDailyDemand > 0 ? round2(dailyStdDev / avgDailyDemand) : null,
      trend: trendInfo.trend,
      recentAvgDailyDemand: trendInfo.recentAvg !== null ? round2(trendInfo.recentAvg) : null,
      priorAvgDailyDemand: trendInfo.priorAvg !== null ? round2(trendInfo.priorAvg) : null,
      demandChangePct: trendInfo.changePct !== null ? round2(trendInfo.changePct) : null,
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
