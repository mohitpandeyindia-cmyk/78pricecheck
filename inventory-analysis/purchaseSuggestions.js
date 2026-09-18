// Z-scores for common service levels (probability of NOT stocking out during lead time).
const SERVICE_LEVEL_Z = {
  0.90: 1.28,
  0.95: 1.65,
  0.975: 1.96,
  0.99: 2.33,
};

function zFor(serviceLevel) {
  if (SERVICE_LEVEL_Z[serviceLevel]) return SERVICE_LEVEL_Z[serviceLevel];
  const keys = Object.keys(SERVICE_LEVEL_Z).map(Number).sort((a, b) => a - b);
  let nearest = keys[0];
  for (const k of keys) {
    if (Math.abs(k - serviceLevel) < Math.abs(nearest - serviceLevel)) nearest = k;
  }
  return SERVICE_LEVEL_Z[nearest];
}

/**
 * Validates configuration values according to V1 rules (Section 41).
 */
function validateConfig(config = {}) {
  const leadTimeDays = config.leadTimeDays ?? 3;
  const reviewFrequencyDays = config.reviewFrequencyDays ?? 7;
  const orderCoverageDays = config.orderCoverageDays ?? config.planningHorizonDays ?? 15;
  const serviceLevel = config.serviceLevel ?? 0.95;
  const useTrendAdjustedDemand = config.useTrendAdjustedDemand ?? true;
  const watchThresholdFactor = config.watchThresholdFactor ?? 1.25;

  if (typeof leadTimeDays !== 'number' || isNaN(leadTimeDays) || leadTimeDays <= 0) {
    throw new Error(`Invalid leadTimeDays: ${leadTimeDays}. Must be a positive number.`);
  }
  if (typeof reviewFrequencyDays !== 'number' || isNaN(reviewFrequencyDays) || reviewFrequencyDays <= 0) {
    throw new Error(`Invalid reviewFrequencyDays: ${reviewFrequencyDays}. Must be a positive number.`);
  }
  if (typeof orderCoverageDays !== 'number' || isNaN(orderCoverageDays) || orderCoverageDays <= 0) {
    throw new Error(`Invalid orderCoverageDays: ${orderCoverageDays}. Must be a positive number.`);
  }
  if (typeof serviceLevel !== 'number' || isNaN(serviceLevel) || serviceLevel <= 0 || serviceLevel >= 1) {
    throw new Error(`Invalid serviceLevel: ${serviceLevel}. Must be between 0 and 1 (e.g. 0.95).`);
  }
  if (typeof watchThresholdFactor !== 'number' || isNaN(watchThresholdFactor) || watchThresholdFactor < 1.0) {
    throw new Error(`Invalid watchThresholdFactor: ${watchThresholdFactor}. Must be at least 1.0.`);
  }

  return {
    leadTimeDays,
    reviewFrequencyDays,
    orderCoverageDays,
    serviceLevel,
    useTrendAdjustedDemand: Boolean(useTrendAdjustedDemand),
    watchThresholdFactor,
  };
}

/**
 * Generates deterministic operational explanation for an item (Section 18, 31).
 */
function generateReason({ classification, currentStock, daysOfCover, trend, reorderPoint, orderCoverageDays }) {
  if (classification === 'BUY_NOW') {
    if (currentStock <= 0) {
      return `Out of stock. Immediate replenishment needed to reach ${orderCoverageDays || 15}-day target stock.`;
    }
    const coverStr = daysOfCover !== null ? `${daysOfCover} days of cover` : 'minimal cover';
    if (trend === 'rising') {
      return `Current stock is below the reorder point. Demand is rising and current stock provides ${coverStr}.`;
    }
    if (trend === 'falling') {
      return `Current stock is below the reorder point. Recent demand is falling and the forecast uses the recent demand rate.`;
    }
    return `Current stock is below the reorder point. Demand is stable and current stock provides ${coverStr}.`;
  }

  if (classification === 'WATCH') {
    return `Current stock is within 25% above the reorder point. Monitor closely.`;
  }

  // OK
  return `Current stock is well above the reorder point.`;
}

/**
 * Builds purchase suggestions and inventory classifications according to V1 specs:
 * - Lead Time (default 3 days): delivery window
 * - Review Frequency (default 7 days): operating review cadence
 * - Order Coverage (default 15 days): purchasing interval / order-up-to target
 * - Safety Stock: Z * stdDev * sqrt(leadTimeDays)
 * - Reorder Point: effectiveDailyDemand * leadTimeDays + safetyStock
 * - Target Stock: effectiveDailyDemand * orderCoverageDays + safetyStock
 * - Suggested Order Qty: ceil(targetStock - currentStock) if BUY_NOW, else 0
 * - Classification: BUY_NOW, WATCH, OK
 * - Urgency: CRITICAL, HIGH, BUY, WATCH, null
 *
 * @param {Object} params
 * @param {Object} params.salesAnalysis - output of analyzeSalesPatterns().items
 * @param {Object} params.currentStockByItem - output of getCurrentStockByItem().currentStock
 * @param {Object} [params.config] - user configuration
 */
function generatePurchaseSuggestions({ salesAnalysis, currentStockByItem, config = {} }) {
  const validatedConfig = validateConfig(config);
  const {
    leadTimeDays,
    reviewFrequencyDays,
    orderCoverageDays,
    serviceLevel,
    useTrendAdjustedDemand,
    watchThresholdFactor,
  } = validatedConfig;

  const z = zFor(serviceLevel);

  const allItemNames = new Set([
    ...Object.keys(salesAnalysis),
    ...Object.keys(currentStockByItem),
  ]);

  const suggestions = [];
  const dataQualityNotes = [];

  for (const itemName of allItemNames) {
    const sales = salesAnalysis[itemName];
    const stockEntry = currentStockByItem[itemName];

    if (!sales) continue; // No sales data — handled separately as dead stock or zero stock
    if (!stockEntry) {
      dataQualityNotes.push({
        itemName,
        issue: 'Sold historically but not found in Stock Detail Report — current stock cannot be determined.',
      });
      continue;
    }

    // Physical stock (negative stock was clamped to 0 during parsing)
    const currentStock = stockEntry.quantity;

    // Determine Effective Daily Demand (Section 7)
    let effectiveDailyDemand = sales.fullPeriodAvgDailyDemand;
    let demandBasis = 'full-period average';

    if (
      useTrendAdjustedDemand &&
      (sales.trend === 'rising' || sales.trend === 'falling') &&
      sales.recentAvgDailyDemand !== null
    ) {
      effectiveDailyDemand = sales.recentAvgDailyDemand;
      demandBasis = `recent-window average (trend: ${sales.trend})`;
    }

    // Mathematical calculations (keep full precision internally, round at output)
    const safetyStockRaw = z * (sales.dailyStdDev || 0) * Math.sqrt(leadTimeDays);
    const reorderPointRaw = effectiveDailyDemand * leadTimeDays + safetyStockRaw;
    const targetStockRaw = effectiveDailyDemand * orderCoverageDays + safetyStockRaw;

    // Classification (Section 14)
    let classification = 'OK';
    let needsReorder = false;
    let suggestedOrderQty = 0;

    if (currentStock < reorderPointRaw && effectiveDailyDemand > 0) {
      classification = 'BUY_NOW';
      needsReorder = true;
      const unroundedOrder = targetStockRaw - currentStock;
      suggestedOrderQty = unroundedOrder > 0 ? Math.ceil(unroundedOrder) : 0;
    } else if (currentStock <= reorderPointRaw * watchThresholdFactor && reorderPointRaw > 0) {
      classification = 'WATCH';
      needsReorder = false;
      suggestedOrderQty = 0;
    } else {
      classification = 'OK';
      needsReorder = false;
      suggestedOrderQty = 0;
    }

    // Days of Cover (Section 15)
    let daysOfCover = null;
    if (effectiveDailyDemand > 0) {
      daysOfCover = round2(currentStock / effectiveDailyDemand);
    }

    // Urgency (Section 16)
    let urgency = null;
    if (daysOfCover !== null) {
      if (daysOfCover < 1) urgency = 'CRITICAL';
      else if (daysOfCover < 3) urgency = 'HIGH';
      else if (daysOfCover < 7) urgency = 'BUY';
      else urgency = 'WATCH';
    }

    // Deterministic reason (Section 18, 31)
    const reason = generateReason({
      classification,
      currentStock,
      daysOfCover,
      trend: sales.trend,
      reorderPoint: round2(reorderPointRaw),
      orderCoverageDays,
    });

    suggestions.push({
      itemName,
      currentStock: round2(currentStock),
      daysOfCover,
      totalSoldInPeriod: sales.totalSold,
      periodDays: sales.periodDays,
      fullPeriodAvgDailyDemand: round2(sales.fullPeriodAvgDailyDemand),
      recentAvgDailyDemand: sales.recentAvgDailyDemand !== null ? round2(sales.recentAvgDailyDemand) : null,
      priorAvgDailyDemand: sales.priorAvgDailyDemand !== null ? round2(sales.priorAvgDailyDemand) : null,
      effectiveDailyDemand: round2(effectiveDailyDemand),
      demandBasis,
      trend: sales.trend,
      demandChangePct: sales.demandChangePct !== null ? round2(sales.demandChangePct) : null,
      trendWindowDays: sales.trendWindowDays,
      leadTimeDays,
      reviewFrequencyDays,
      orderCoverageDays,
      serviceLevel,
      safetyStock: round2(safetyStockRaw),
      reorderPoint: round2(reorderPointRaw),
      targetStock: round2(targetStockRaw),
      suggestedOrderQty,
      classification,
      urgency,
      needsReorder,
      reason,
      // Existing useful metadata retained:
      stockAsOfDate: stockEntry.asOfDate,
      demandVariability: round2(sales.dailyStdDev),
    });
  }

  // Sort order: BUY_NOW first (by daysOfCover asc, then ratio asc), then WATCH, then OK
  suggestions.sort((a, b) => {
    const classPriority = { BUY_NOW: 0, WATCH: 1, OK: 2 };
    const pA = classPriority[a.classification] ?? 3;
    const pB = classPriority[b.classification] ?? 3;
    if (pA !== pB) return pA - pB;

    if (a.classification === 'BUY_NOW') {
      const coverA = a.daysOfCover !== null ? a.daysOfCover : 999999;
      const coverB = b.daysOfCover !== null ? b.daysOfCover : 999999;
      if (coverA !== coverB) return coverA - coverB;
    }

    const ratioA = a.targetStock > 0 ? a.currentStock / a.targetStock : 1;
    const ratioB = b.targetStock > 0 ? b.currentStock / b.targetStock : 1;
    return ratioA - ratioB;
  });

  return {
    config: validatedConfig,
    suggestions,
    dataQualityNotes,
  };
}

function round2(n) {
  if (n === null || n === undefined || isNaN(n)) return null;
  return Math.round(n * 100) / 100;
}

module.exports = {
  generatePurchaseSuggestions,
  validateConfig,
  zFor,
  round2,
  generateReason,
};
