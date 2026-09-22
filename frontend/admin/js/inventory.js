// SeventyEightOS - V1.1 Inventory Assistant Frontend Logic
(function() {
  'use strict';

  // Authentication & Logout
  const token = localStorage.getItem('admin_token');
  if (!token) {
    window.location.href = '/admin';
    return;
  }

  const logoutBtn = document.getElementById('logout-btn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('admin_token');
      localStorage.removeItem('admin_username');
      window.location.href = '/admin';
    });
  }

  // Authoritative State
  let analysisData = null;
  let activeTab = 'BUY_NOW'; // 'BUY_NOW' | 'WATCH' | 'OK' | 'REVIEW' | 'RESOLUTION'
  let activeUrgency = 'ALL'; // 'ALL' | 'CRITICAL' | 'HIGH' | 'BUY' | 'WATCH'
  let productSearchTerm = '';
  let productSort = { column: 'default', direction: 'asc' };

  let activeReviewCategory = 'matchRequired'; // 'matchRequired' | 'negativeStock' | 'deadStock' | 'zeroStock' | 'nameVariants' | 'dataQuality'
  let reviewSearchTerm = '';
  let validationSearchTerm = '';

  // DOM Elements
  const form = document.getElementById('analyze-form');
  const saleInput = document.getElementById('sale-report-input');
  const stockInput = document.getElementById('stock-detail-input');
  const saleBrowseBtn = document.getElementById('sale-browse-btn');
  const stockBrowseBtn = document.getElementById('stock-browse-btn');
  const saleBox = document.getElementById('sale-box');
  const stockBox = document.getElementById('stock-box');
  const saleFileName = document.getElementById('sale-file-name');
  const stockFileName = document.getElementById('stock-file-name');
  const analyzeBtn = document.getElementById('analyze-btn');
  const loadingIndicator = document.getElementById('loading-indicator');
  const errorAlert = document.getElementById('error-alert');
  const errorMsg = document.getElementById('error-message');

  const advancedToggleBtn = document.getElementById('advanced-toggle-btn');
  const advancedPanel = document.getElementById('advanced-settings-panel');
  const advancedArrow = document.getElementById('advanced-arrow');

  const resultsContainer = document.getElementById('results-container');
  const ctxSalesPeriod = document.getElementById('ctx-sales-period');
  const ctxSnapshotDate = document.getElementById('ctx-snapshot-date');
  const ctxGeneratedAt = document.getElementById('ctx-generated-at');

  const assumpLeadTime = document.getElementById('assump-lead-time');
  const assumpReviewFreq = document.getElementById('assump-review-freq');
  const assumpOrderCoverage = document.getElementById('assump-order-coverage');
  const assumpServiceLevel = document.getElementById('assump-service-level');
  const assumpWatchBuffer = document.getElementById('assump-watch-buffer');
  const assumpTrendWindow = document.getElementById('assump-trend-window');

  // Tab Elements
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabCountBuyNow = document.getElementById('tab-count-buy-now');
  const tabCountWatch = document.getElementById('tab-count-watch');
  const tabCountOk = document.getElementById('tab-count-ok');
  const tabCountReview = document.getElementById('tab-count-review');
  const tabCountResolution = document.getElementById('tab-count-resolution');

  const productTabContent = document.getElementById('product-tab-content');
  const reviewTabContent = document.getElementById('review-tab-content');
  const resolutionTabContent = document.getElementById('resolution-tab-content');

  const tabSearchInput = document.getElementById('tab-search-input');
  const urgencyFilterGroup = document.getElementById('urgency-filter-group');
  const urgencyFilterBtns = document.querySelectorAll('.urgency-filter-btn');
  const exportTabCsvBtn = document.getElementById('export-tab-csv-btn');
  const mainProductTable = document.getElementById('main-product-table');
  const mainProductTbody = document.getElementById('main-product-tbody');
  const noItemsMsg = document.getElementById('no-items-msg');
  const thOrderQty = document.getElementById('th-order-qty');

  // Review Tab Elements
  const revCountMatchRequired = document.getElementById('rev-count-match-required');
  const revCountNegative = document.getElementById('rev-count-negative');
  const revCountDead = document.getElementById('rev-count-dead');
  const revCountZero = document.getElementById('rev-count-zero');
  const revCountVariants = document.getElementById('rev-count-variants');
  const revCountQuality = document.getElementById('rev-count-quality');
  const reviewSelectors = document.querySelectorAll('.review-card-selector');
  const reviewPanelTitle = document.getElementById('review-panel-title');
  const reviewPanelDesc = document.getElementById('review-panel-desc');
  const reviewSearchInput = document.getElementById('review-search-input');
  const exportReviewCsvBtn = document.getElementById('export-review-csv-btn');
  const reviewThead = document.getElementById('review-thead');
  const reviewTbody = document.getElementById('review-tbody');
  const noReviewItemsMsg = document.getElementById('no-review-items-msg');

  // Resolution Tab Elements
  const resTotalRaw = document.getElementById('res-total-raw');
  const resMatchedCount = document.getElementById('res-matched-count');
  const resAutoMergedCount = document.getElementById('res-automerged-count');
  const resManualCount = document.getElementById('res-manual-count');
  const resPendingCount = document.getElementById('res-pending-count');
  const candidateCardsContainer = document.getElementById('candidate-cards-container');
  const noCandidatesMsg = document.getElementById('no-candidates-msg');
  const validationSearchInput = document.getElementById('validation-search-input');
  const exportValidationCsvBtn = document.getElementById('export-validation-csv-btn');
  const validationTbody = document.getElementById('validation-tbody');
  const ledgerEntriesContainer = document.getElementById('ledger-entries-container');

  // Production Observability Status Elements
  const statusLedgerState = document.getElementById('status-ledger-state');
  const statusLastAnalysis = document.getElementById('status-last-analysis');
  const statusLastUpload = document.getElementById('status-last-upload');

  async function refreshLedgerStatus() {
    try {
      const token = localStorage.getItem('admin_token') || '';
      const res = await (typeof authenticatedFetch === 'function'
        ? authenticatedFetch('/api/admin/inventory/mappings')
        : fetch('/api/admin/inventory/mappings', { headers: { 'Authorization': `Bearer ${token}` } }));
      if (res && res.ok) {
        const data = await res.json();
        const mergesCount = data.merges?.length || 0;
        const separatesCount = data.separates?.length || 0;
        if (statusLedgerState) {
          statusLedgerState.innerHTML = `<span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--color-resolution);"></span> OK (${mergesCount} merges, ${separatesCount} separated)`;
        }
      }
    } catch (e) {
      // Non-blocking
    }
  }
  refreshLedgerStatus();

  // Drawer Elements
  const drawerBackdrop = document.getElementById('drawer-backdrop');
  const drawerPanel = document.getElementById('drawer-panel');
  const drawerCloseBtn = document.getElementById('drawer-close-btn');
  const drawerItemName = document.getElementById('drawer-item-name');
  const drawerClassBadge = document.getElementById('drawer-class-badge');
  const drawerUrgencyBadge = document.getElementById('drawer-urgency-badge');
  const drawerWhyBox = document.getElementById('drawer-why-box');
  const drawerReason = document.getElementById('drawer-reason');
  const drawerMetricStock = document.getElementById('drawer-metric-stock');
  const drawerMetricCover = document.getElementById('drawer-metric-cover');
  const drawerMetricDemand = document.getElementById('drawer-metric-demand');

  const auditDemandBox = document.getElementById('audit-demand-box');
  const auditSafetyStockBox = document.getElementById('audit-safety-stock-box');
  const auditRopBox = document.getElementById('audit-rop-box');
  const auditTargetStockBox = document.getElementById('audit-target-stock-box');
  const auditOrderQtyBox = document.getElementById('audit-order-qty-box');
  const drawerActionBanner = document.getElementById('drawer-action-banner');
  const drawerActionValue = document.getElementById('drawer-action-value');

  // 1. File Picker Wiring
  saleBrowseBtn.addEventListener('click', () => saleInput.click());
  stockBrowseBtn.addEventListener('click', () => stockInput.click());

  saleInput.addEventListener('change', () => {
    if (saleInput.files && saleInput.files[0]) {
      saleFileName.textContent = saleInput.files[0].name;
      saleFileName.style.color = 'var(--primary-color)';
      saleBox.classList.add('has-file');
    } else {
      saleFileName.textContent = 'No file selected';
      saleFileName.style.color = 'inherit';
      saleBox.classList.remove('has-file');
    }
    updateSubmitButtonState();
  });

  stockInput.addEventListener('change', () => {
    if (stockInput.files && stockInput.files[0]) {
      stockFileName.textContent = stockInput.files[0].name;
      stockFileName.style.color = 'var(--primary-color)';
      stockBox.classList.add('has-file');
    } else {
      stockFileName.textContent = 'No file selected';
      stockFileName.style.color = 'inherit';
      stockBox.classList.remove('has-file');
    }
    updateSubmitButtonState();
  });

  function updateSubmitButtonState() {
    const hasSale = saleInput.files && saleInput.files[0];
    const hasStock = stockInput.files && stockInput.files[0];
    analyzeBtn.disabled = !(hasSale && hasStock);
  }

  // 2. Advanced Parameters Collapsible
  advancedToggleBtn.addEventListener('click', () => {
    const isOpen = advancedPanel.classList.toggle('open');
    advancedArrow.classList.toggle('open', isOpen);
  });

  // 3. Form Submission
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!saleInput.files[0] || !stockInput.files[0]) return;

    errorAlert.style.display = 'none';
    loadingIndicator.style.display = 'inline-flex';
    analyzeBtn.disabled = true;

    const formData = new FormData();
    formData.append('saleReport', saleInput.files[0]);
    formData.append('stockDetail', stockInput.files[0]);

    // Optional overrides
    const leadTimeVal = document.getElementById('lead-time-input').value;
    if (leadTimeVal) formData.append('leadTimeDays', leadTimeVal);

    const reviewFreqVal = document.getElementById('review-frequency-input').value;
    if (reviewFreqVal) formData.append('reviewFrequencyDays', reviewFreqVal);

    const orderCoverageVal = document.getElementById('order-coverage-input').value;
    if (orderCoverageVal) formData.append('orderCoverageDays', orderCoverageVal);

    const serviceLevelVal = document.getElementById('service-level-select').value;
    if (serviceLevelVal) formData.append('serviceLevel', serviceLevelVal);

    const watchBufferVal = document.getElementById('watch-threshold-input').value;
    if (watchBufferVal) formData.append('watchThresholdFactor', watchBufferVal);

    const trendCheckbox = document.getElementById('trend-adjusted-checkbox');
    formData.append('useTrendAdjustedDemand', trendCheckbox.checked ? 'true' : 'false');

    try {
      const response = await fetch('/api/admin/inventory/analyze', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        body: formData
      });

      let data;
      try {
        data = await response.json();
      } catch (jsonErr) {
        throw new Error(`Server returned HTTP ${response.status} (${response.statusText || 'Non-JSON response'}). The upload or analysis may have timed out on the proxy.`);
      }

      if (!response.ok) {
        throw new Error(data.error || data.message || 'Analysis failed on server.');
      }

      analysisData = data;
      renderAnalysisView();
      resultsContainer.style.display = 'block';
      resultsContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });

      // Update Observability Status
      if (statusLastAnalysis) {
        statusLastAnalysis.textContent = formatDateTime(new Date().toISOString());
      }
      if (statusLastUpload && saleInput.files && saleInput.files[0] && stockInput.files && stockInput.files[0]) {
        statusLastUpload.textContent = `${saleInput.files[0].name} + ${stockInput.files[0].name}`;
      }
      refreshLedgerStatus();
    } catch (err) {
      if (err.name === 'TypeError' && String(err.message).toLowerCase().includes('fetch')) {
        errorMsg.textContent = 'Connection failed ("Failed to fetch"). Please verify you are using HTTPS (https://pricecheck.78supermaart.in/admin/inventory) and that your internet connection supports transferring 16.8 MB without interruption.';
      } else {
        errorMsg.textContent = err.message || 'An unexpected error occurred during inventory analysis.';
      }
      errorAlert.style.display = 'block';
    } finally {
      loadingIndicator.style.display = 'none';
      analyzeBtn.disabled = false;
    }
  });

  // 4. Render Analysis View
  function renderAnalysisView() {
    if (!analysisData) return;

    const { config, summary, suggestions, review, meta, nameResolution, analysisGeneratedAt } = analysisData;

    // Time Concept Context
    if (meta?.salesPeriod?.from && meta?.salesPeriod?.to) {
      const fromStr = formatDate(meta.salesPeriod.from);
      const toStr = formatDate(meta.salesPeriod.to);
      ctxSalesPeriod.textContent = `${fromStr} → ${toStr} · ${meta.salesPeriod.days} days`;
    } else {
      ctxSalesPeriod.textContent = 'Full period provided';
    }

    if (meta?.stockSnapshotDate) {
      ctxSnapshotDate.textContent = formatDate(meta.stockSnapshotDate);
    } else {
      ctxSnapshotDate.textContent = 'Not provided by export (Desktop Vyapar Stock Detail)';
    }

    if (analysisGeneratedAt) {
      ctxGeneratedAt.textContent = formatDateTime(analysisGeneratedAt);
    } else {
      ctxGeneratedAt.textContent = formatDateTime(new Date().toISOString());
    }

    // Authoritative Effective Assumptions
    assumpLeadTime.textContent = `${config.leadTimeDays} days`;
    assumpReviewFreq.textContent = `${config.reviewFrequencyDays} days`;
    assumpOrderCoverage.textContent = `${config.orderCoverageDays} days`;

    const zScore = getZScoreFor(config.serviceLevel);
    assumpServiceLevel.textContent = `${Math.round(config.serviceLevel * 100)}% (Z = ${zScore})`;

    const watchPct = Math.round((config.watchThresholdFactor - 1) * 100);
    assumpWatchBuffer.textContent = `+${watchPct}%`;

    const trendWindowDays = meta?.trendWindowDays || (suggestions[0]?.trendWindowDays) || 0;
    if (trendWindowDays > 0) {
      assumpTrendWindow.textContent = `Auto · ${trendWindowDays}-day recent vs ${trendWindowDays}-day prior`;
    } else {
      assumpTrendWindow.textContent = `Auto · Insufficient history (<14 days)`;
    }

    // Counts on Main Tabs
    const buyNowCount = suggestions.filter(s => s.classification === 'BUY_NOW').length;
    const watchCount = suggestions.filter(s => s.classification === 'WATCH').length;
    const okCount = suggestions.filter(s => s.classification === 'OK').length;
    
    const matchReqCount = review?.matchRequiredItems?.length || 0;
    const reviewTotal = (review?.negativeStockItems?.length || 0) +
      (review?.deadStockCandidates?.length || 0) +
      (review?.zeroStockNeverSold?.length || 0) +
      (review?.suggestedMerges?.length || 0) +
      (review?.dataQualityNotes?.length || 0) +
      matchReqCount;

    tabCountBuyNow.textContent = buyNowCount;
    tabCountWatch.textContent = watchCount;
    tabCountOk.textContent = okCount;
    tabCountReview.textContent = reviewTotal;
    tabCountResolution.textContent = nameResolution?.summary?.pendingCandidatesCount || 0;

    // Review exception category counts
    revCountMatchRequired.textContent = matchReqCount;
    revCountNegative.textContent = review?.negativeStockItems?.length || 0;
    revCountDead.textContent = review?.deadStockCandidates?.length || 0;
    revCountZero.textContent = review?.zeroStockNeverSold?.length || 0;
    revCountVariants.textContent = (review?.suggestedMerges?.length || 0);
    revCountQuality.textContent = review?.dataQualityNotes?.length || 0;

    // Resolution Metrics
    if (nameResolution?.summary) {
      resTotalRaw.textContent = nameResolution.summary.totalRawNames;
      resMatchedCount.textContent = nameResolution.summary.matchedCount;
      resAutoMergedCount.textContent = nameResolution.summary.autoMergedCount;
      resManualCount.textContent = nameResolution.summary.manualMergedCount;
      resPendingCount.textContent = nameResolution.summary.pendingCandidatesCount;
    }

    // Render active tab
    renderActiveTab();
  }

  function getZScoreFor(serviceLevel) {
    if (serviceLevel >= 0.99) return '2.33';
    if (serviceLevel >= 0.975) return '1.96';
    if (serviceLevel >= 0.95) return '1.65';
    if (serviceLevel >= 0.90) return '1.28';
    return '1.65';
  }

  // 5. Main Tab Switching
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.getAttribute('data-tab');

      // Reset search & urgency filter
      tabSearchInput.value = '';
      productSearchTerm = '';
      activeUrgency = 'ALL';
      urgencyFilterBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-urgency') === 'ALL'));

      renderActiveTab();
    });
  });

  function renderActiveTab() {
    tabBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === activeTab));

    if (activeTab === 'REVIEW') {
      productTabContent.style.display = 'none';
      reviewTabContent.style.display = 'block';
      resolutionTabContent.style.display = 'none';
      renderReviewCategory();
    } else if (activeTab === 'RESOLUTION') {
      productTabContent.style.display = 'none';
      reviewTabContent.style.display = 'none';
      resolutionTabContent.style.display = 'block';
      renderResolutionTab();
    } else {
      productTabContent.style.display = 'block';
      reviewTabContent.style.display = 'none';
      resolutionTabContent.style.display = 'none';

      // Urgency filter group only visible on BUY NOW tab
      urgencyFilterGroup.style.display = (activeTab === 'BUY_NOW') ? 'flex' : 'none';

      renderProductTable();
    }
  }

  // Urgency Filters (BUY NOW tab)
  urgencyFilterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      urgencyFilterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeUrgency = btn.getAttribute('data-urgency');
      renderProductTable();
    });
  });

  // Search in Product Table
  tabSearchInput.addEventListener('input', (e) => {
    productSearchTerm = e.target.value.trim().toLowerCase();
    renderProductTable();
  });

  // Sorting in Product Table
  mainProductTable.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.getAttribute('data-col');
      if (productSort.column === col) {
        productSort.direction = productSort.direction === 'asc' ? 'desc' : 'asc';
      } else {
        productSort.column = col;
        productSort.direction = (col === 'itemName') ? 'asc' : 'desc';
      }

      mainProductTable.querySelectorAll('th').forEach(t => t.classList.remove('sort-active'));
      th.classList.add('sort-active');
      renderProductTable();
    });
  });

  // 6. Render Homogeneous Product Table (BUY NOW, WATCH, OK)
  function renderProductTable() {
    if (!analysisData?.suggestions) return;

    let items = analysisData.suggestions.filter(s => s.classification === activeTab);

    // Filter by urgency if on BUY NOW
    if (activeTab === 'BUY_NOW' && activeUrgency !== 'ALL') {
      items = items.filter(s => s.urgency === activeUrgency);
    }

    // Filter by search
    if (productSearchTerm) {
      items = items.filter(s => s.itemName.toLowerCase().includes(productSearchTerm));
    }

    // Sort items
    if (productSort.column !== 'default') {
      const { column, direction } = productSort;
      const factor = direction === 'asc' ? 1 : -1;
      items.sort((a, b) => {
        let valA = a[column];
        let valB = b[column];

        if (valA === null || valA === undefined) valA = direction === 'asc' ? 9999999 : -9999999;
        if (valB === null || valB === undefined) valB = direction === 'asc' ? 9999999 : -9999999;

        if (typeof valA === 'string') {
          return valA.localeCompare(valB) * factor;
        }
        return (valA - valB) * factor;
      });
    }

    mainProductTbody.innerHTML = '';

    if (items.length === 0) {
      noItemsMsg.style.display = 'block';
      return;
    }
    noItemsMsg.style.display = 'none';

    items.forEach(item => {
      const tr = document.createElement('tr');
      tr.className = 'clickable-row';
      tr.setAttribute('title', 'Click to open calculation audit trail');

      const daysCoverDisplay = item.daysOfCover !== null ? `${item.daysOfCover}d` : '—';
      const trendTag = getTrendBadge(item.trend);
      const orderQtyDisplay = item.classification === 'BUY_NOW' && item.suggestedOrderQty > 0
        ? `<span class="order-qty-pill">${item.suggestedOrderQty}</span>`
        : '0';

      tr.innerHTML = `
        <td>
          <div style="font-weight: 600; color: var(--text-color);">${escapeHtml(item.itemName)}</div>
          ${getUrgencyTag(item.urgency)}
        </td>
        <td class="text-right" style="font-weight: 600;">${item.currentStock}</td>
        <td class="text-right" style="font-weight: 600; color: ${getCoverColor(item.daysOfCover)};">${daysCoverDisplay}</td>
        <td class="text-right">${item.effectiveDailyDemand}</td>
        <td class="text-center">${trendTag}</td>
        <td class="text-right">${item.reorderPoint}</td>
        <td class="text-right">${item.targetStock}</td>
        <td class="text-right">${orderQtyDisplay}</td>
      `;

      tr.addEventListener('click', () => openProductDrawer(item));
      mainProductTbody.appendChild(tr);
    });
  }

  function getTrendBadge(trend) {
    if (trend === 'rising') return '<span class="trend-tag trend-rising">▲ Rising</span>';
    if (trend === 'falling') return '<span class="trend-tag trend-falling">▼ Falling</span>';
    if (trend === 'stable') return '<span class="trend-tag trend-stable">● Stable</span>';
    return '<span class="trend-tag trend-insufficient">No Trend</span>';
  }

  function getUrgencyTag(urgency) {
    if (!urgency) return '';
    const u = urgency.toLowerCase();
    return `<span class="urgency-pill urgency-${u}">${urgency}</span>`;
  }

  function getCoverColor(days) {
    if (days === null) return 'inherit';
    if (days < 1) return 'var(--admin-danger)';
    if (days < 3) return 'var(--admin-orange)';
    if (days < 7) return 'var(--admin-warning)';
    return 'var(--admin-success)';
  }

  // 7. REVIEW Tab Exception Dashboard
  reviewSelectors.forEach(card => {
    card.addEventListener('click', () => {
      reviewSelectors.forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      activeReviewCategory = card.getAttribute('data-category');
      reviewSearchInput.value = '';
      reviewSearchTerm = '';
      renderReviewCategory();
    });
  });

  reviewSearchInput.addEventListener('input', (e) => {
    reviewSearchTerm = e.target.value.trim().toLowerCase();
    renderReviewCategory();
  });

  function renderReviewCategory() {
    if (!analysisData?.review) return;

    const { review } = analysisData;
    reviewThead.innerHTML = '';
    reviewTbody.innerHTML = '';
    noReviewItemsMsg.style.display = 'none';

    if (activeReviewCategory === 'matchRequired') {
      reviewPanelTitle.textContent = 'Match Required Items (Unresolved Identity)';
      reviewPanelDesc.textContent = 'These items have pending candidate matches across reports. Reorder calculations are withheld to prevent false purchase orders.';

      reviewThead.innerHTML = `
        <tr>
          <th>Candidate SKU</th>
          <th class="text-right">Sales Qty</th>
          <th class="text-right">Stock Qty</th>
          <th>Resolution Status</th>
          <th>Action</th>
        </tr>
      `;

      let items = review.matchRequiredItems || [];
      if (reviewSearchTerm) {
        items = items.filter(i => (i.canonicalName || '').toLowerCase().includes(reviewSearchTerm));
      }

      if (items.length === 0) {
        noReviewItemsMsg.style.display = 'block';
        return;
      }

      items.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${escapeHtml(item.canonicalName)}</strong></td>
          <td class="text-right">${item.totalSalesQuantity}</td>
          <td class="text-right">${item.totalStockQuantity}</td>
          <td><span class="urgency-pill urgency-critical">MATCH REQUIRED</span></td>
          <td>
            <button type="button" class="btn btn-outline btn-sm btn-goto-resolution" data-name="${escapeHtml(item.canonicalName)}">
              Resolve in Catalog
            </button>
          </td>
        `;
        reviewTbody.appendChild(tr);
      });

      // Wire Go to Resolution buttons
      reviewTbody.querySelectorAll('.btn-goto-resolution').forEach(btn => {
        btn.addEventListener('click', () => {
          document.getElementById('tab-btn-resolution').click();
        });
      });
    } else if (activeReviewCategory === 'negativeStock') {
      reviewPanelTitle.textContent = 'Negative Stock Items';
      reviewPanelDesc.textContent = 'Recorded stock in system is less than zero (unlogged purchase or barcode mix-up). Physical stock is clamped to 0 for calculations.';

      reviewThead.innerHTML = `
        <tr>
          <th>Item Name</th>
          <th class="text-right">Recorded Closing Qty</th>
          <th>Action Needed</th>
        </tr>
      `;

      let items = review.negativeStockItems || [];
      if (reviewSearchTerm) {
        items = items.filter(i => (i.itemName || '').toLowerCase().includes(reviewSearchTerm));
      }

      if (items.length === 0) {
        noReviewItemsMsg.style.display = 'block';
        return;
      }

        items.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-weight: 600;">${escapeHtml(item.itemName)}</td>
          <td class="text-right" style="color: var(--admin-danger); font-weight: 700;">${item.recordedClosingQty}</td>
          <td><span class="urgency-pill urgency-critical">Perform Physical Audit</span></td>
        `;
        reviewTbody.appendChild(tr);
      });
    } else if (activeReviewCategory === 'deadStock') {
      reviewPanelTitle.textContent = 'Dead Stock Candidates';
      reviewPanelDesc.textContent = 'Physical stock is on hand (> 0) but recorded zero sales across the entire observation period. Candidates for catalog deactivation or markdown.';

      reviewThead.innerHTML = `
        <tr>
          <th>Item Name</th>
          <th class="text-right">Current Stock On Hand</th>
          <th class="text-right">Sales in Period</th>
          <th>Recommendation</th>
        </tr>
      `;

      let items = review.deadStockCandidates || [];
      if (reviewSearchTerm) {
        items = items.filter(i => (i.itemName || '').toLowerCase().includes(reviewSearchTerm));
      }

      if (items.length === 0) {
        noReviewItemsMsg.style.display = 'block';
        return;
      }

      items.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-weight: 600;">${escapeHtml(item.itemName)}</td>
          <td class="text-right" style="font-weight: 700; color: var(--admin-warning);">${item.currentStock}</td>
          <td class="text-right">0</td>
          <td><span class="urgency-pill urgency-watch">Review for Deactivation</span></td>
        `;
        reviewTbody.appendChild(tr);
      });
    } else if (activeReviewCategory === 'zeroStock') {
      reviewPanelTitle.textContent = 'Zero Stock, Never Sold';
      reviewPanelDesc.textContent = 'Zero recorded stock and zero sales. May indicate an obsolete product or an item stocked out for the entire observation period.';

      reviewThead.innerHTML = `
        <tr>
          <th>Item Name</th>
          <th class="text-right">Current Stock</th>
          <th class="text-right">Sales in Period</th>
          <th>Operational Note</th>
        </tr>
      `;

      let items = review.zeroStockNeverSold || [];
      if (reviewSearchTerm) {
        items = items.filter(i => (i.itemName || '').toLowerCase().includes(reviewSearchTerm));
      }

      if (items.length === 0) {
        noReviewItemsMsg.style.display = 'block';
        return;
      }

      items.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-weight: 600;">${escapeHtml(item.itemName)}</td>
          <td class="text-right">0</td>
          <td class="text-right">0</td>
          <td style="color: var(--text-muted); font-size: 0.82rem;">Check supplier purchase history to distinguish obsolete vs out-of-stock.</td>
        `;
        reviewTbody.appendChild(tr);
      });
    } else if (activeReviewCategory === 'nameVariants') {
      reviewPanelTitle.textContent = 'Suggested Merge Candidates';
      reviewPanelDesc.textContent = 'Candidate pairs identified by the semantic matching engine pending human review in the Name Resolution tab.';

      reviewThead.innerHTML = `
        <tr>
          <th style="width: 40%;">Item A</th>
          <th style="width: 10%; text-align: center;">Match</th>
          <th style="width: 40%;">Item B</th>
          <th style="width: 10%;">Action</th>
        </tr>
      `;

      let items = review.suggestedMerges || [];
      if (reviewSearchTerm) {
        items = items.filter(i => (i.itemA || '').toLowerCase().includes(reviewSearchTerm) || (i.itemB || '').toLowerCase().includes(reviewSearchTerm));
      }

      if (items.length === 0) {
        noReviewItemsMsg.style.display = 'block';
        return;
      }

      items.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${escapeHtml(item.itemA)}</strong></td>
          <td style="text-align: center; color: var(--color-review); font-weight: 700;">⇄</td>
          <td><strong>${escapeHtml(item.itemB)}</strong></td>
          <td>
            <button type="button" class="btn btn-outline btn-sm btn-goto-resolution">Review</button>
          </td>
        `;
        reviewTbody.appendChild(tr);
      });

      reviewTbody.querySelectorAll('.btn-goto-resolution').forEach(btn => {
        btn.addEventListener('click', () => {
          document.getElementById('tab-btn-resolution').click();
        });
      });
    } else if (activeReviewCategory === 'dataQuality') {
      reviewPanelTitle.textContent = 'Data Quality Notes';
      reviewPanelDesc.textContent = 'Items found in the Sale Report that do not exist in the Stock Detail snapshot.';

      reviewThead.innerHTML = `
        <tr>
          <th>Item Name</th>
          <th>Issue Description</th>
        </tr>
      `;

      let items = review.dataQualityNotes || [];
      if (reviewSearchTerm) {
        items = items.filter(i => (i.itemName || '').toLowerCase().includes(reviewSearchTerm));
      }

      if (items.length === 0) {
        noReviewItemsMsg.style.display = 'block';
        return;
      }

      items.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td style="font-weight: 600;">${escapeHtml(item.itemName)}</td>
          <td style="color: var(--admin-danger);">${escapeHtml(item.issue)}</td>
        `;
        reviewTbody.appendChild(tr);
      });
    }
  }

  // 8. V1.1 CATALOG / NAME RESOLUTION TAB
  validationSearchInput.addEventListener('input', (e) => {
    validationSearchTerm = e.target.value.trim().toLowerCase();
    renderValidationReport();
  });

  function renderResolutionTab() {
    if (!analysisData?.nameResolution) return;

    renderCandidateQueue();
    renderValidationReport();
    renderDecisionLedger();
  }

  function renderCandidateQueue() {
    const candidates = analysisData?.nameResolution?.pendingCandidates || [];
    candidateCardsContainer.innerHTML = '';

    if (candidates.length === 0) {
      noCandidatesMsg.style.display = 'block';
      return;
    }
    noCandidatesMsg.style.display = 'none';

    candidates.forEach(cand => {
      const card = document.createElement('div');
      card.className = `candidate-card ${cand.hasWarning ? 'candidate-card-warning' : ''}`;

      const varA = cand.variantA || {
        name: cand.itemA,
        mrp: cand.avgMrpA ?? cand.mrpA ?? cand.avgPriceA ?? null,
        mrpSource: cand.mrpSourceA || (cand.avgMrpA != null || cand.avgPriceA != null ? 'Sale Report / UnitPrice' : 'Not available'),
        salesQty: 0,
        stockQty: 0,
      };
      const varB = cand.variantB || {
        name: cand.itemB,
        mrp: cand.avgMrpB ?? cand.mrpB ?? cand.avgPriceB ?? null,
        mrpSource: cand.mrpSourceB || (cand.avgMrpB != null || cand.avgPriceB != null ? 'Sale Report / UnitPrice' : 'Not available'),
        salesQty: 0,
        stockQty: 0,
      };

      const mrpADisplay = varA.mrp != null ? `₹${varA.mrp}` : '—';
      const mrpBDisplay = varB.mrp != null ? `₹${varB.mrp}` : '—';

      const avgPriceADisplay = varA.avgPrice != null ? `₹${varA.avgPrice}` : '—';
      const avgPriceBDisplay = varB.avgPrice != null ? `₹${varB.avgPrice}` : '—';

      const idCheck = cand.identityCheck || {
        brand: { valA: '—', valB: '—', match: true },
        product: { valA: '—', valB: '—', match: true },
        packCount: { valA: '—', valB: '—', warning: false, label: 'Agreed' },
        mrp: { valA: mrpADisplay, valB: mrpBDisplay, label: '—' },
      };

      const packCheck = idCheck.packCount || { warning: false, label: 'Agreed' };

      const badgeHtml = cand.hasWarning
        ? `<span class="candidate-status-badge badge-warning">⚠ HUMAN REVIEW REQUIRED</span>`
        : `<span class="candidate-status-badge badge-supported">✔ IDENTITY SUPPORTED</span>`;

      const actionsHtml = cand.hasWarning ? `
        <button type="button" class="btn btn-primary btn-sm btn-separate-candidate"
          data-action="keep-separate"
          data-canonical="${escapeHtml(cand.suggestedCanonical)}"
          data-a="${escapeHtml(cand.itemA)}"
          data-b="${escapeHtml(cand.itemB)}">
          Keep Separate (Recommended)
        </button>
        <button type="button" class="btn btn-outline btn-sm btn-merge-candidate btn-cautious"
          data-action="merge"
          data-canonical="${escapeHtml(cand.suggestedCanonical)}"
          data-a="${escapeHtml(cand.itemA)}"
          data-b="${escapeHtml(cand.itemB)}">
          Review / Merge into ${escapeHtml(cand.suggestedCanonical)}
        </button>
      ` : `
        <button type="button" class="btn btn-primary btn-sm btn-merge-candidate"
          data-action="merge"
          data-canonical="${escapeHtml(cand.suggestedCanonical)}"
          data-a="${escapeHtml(cand.itemA)}"
          data-b="${escapeHtml(cand.itemB)}">
          Merge into ${escapeHtml(cand.suggestedCanonical)}
        </button>
        <button type="button" class="btn btn-outline btn-sm btn-separate-candidate"
          data-action="keep-separate"
          data-canonical="${escapeHtml(cand.suggestedCanonical)}"
          data-a="${escapeHtml(cand.itemA)}"
          data-b="${escapeHtml(cand.itemB)}">
          Keep Separate
        </button>
      `;

      card.innerHTML = `
        <div class="candidate-header">
          <div class="candidate-title-group">
            <span class="candidate-label">Suggested Canonical</span>
            <span class="candidate-canonical-name">${escapeHtml(cand.suggestedCanonical)}</span>
          </div>
          <div class="candidate-badge-group">
            ${badgeHtml}
          </div>
        </div>

        <div class="candidate-variants-grid">
          <!-- Variant A -->
          <div class="variant-panel">
            <div class="variant-panel-header">
              <span class="variant-panel-tag">Variant A</span>
            </div>
            <div class="variant-name">${escapeHtml(varA.name || cand.itemA)}</div>
            <div class="variant-detail-list">
              <div class="variant-detail-row">
                <span class="detail-label">MRP:</span>
                <span class="detail-val">${mrpADisplay}</span>
              </div>
              <div class="variant-detail-row">
                <span class="detail-label">Source:</span>
                <span class="detail-val detail-source">${escapeHtml(varA.mrpSource || 'Not available')}</span>
              </div>
              <div class="variant-detail-row">
                <span class="detail-label">Sales Units:</span>
                <span class="detail-val">${varA.salesQty ?? 0}</span>
              </div>
              <div class="variant-detail-row">
                <span class="detail-label">Stock Units:</span>
                <span class="detail-val">${varA.stockQty ?? 0}</span>
              </div>
            </div>
          </div>

          <!-- Variant B -->
          <div class="variant-panel">
            <div class="variant-panel-header">
              <span class="variant-panel-tag">Variant B</span>
            </div>
            <div class="variant-name">${escapeHtml(varB.name || cand.itemB)}</div>
            <div class="variant-detail-list">
              <div class="variant-detail-row">
                <span class="detail-label">MRP:</span>
                <span class="detail-val">${mrpBDisplay}</span>
              </div>
              <div class="variant-detail-row">
                <span class="detail-label">Source:</span>
                <span class="detail-val detail-source">${escapeHtml(varB.mrpSource || 'Not available')}</span>
              </div>
              <div class="variant-detail-row">
                <span class="detail-label">Sales Units:</span>
                <span class="detail-val">${varB.salesQty ?? 0}</span>
              </div>
              <div class="variant-detail-row">
                <span class="detail-label">Stock Units:</span>
                <span class="detail-val">${varB.stockQty ?? 0}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Identity Verification Matrix -->
        <div class="candidate-identity-box">
          <div class="identity-header">
            <span>Identity Verification Matrix</span>
            <span class="identity-note">MRP is supporting evidence only</span>
          </div>
          <table class="identity-table">
            <thead>
              <tr>
                <th style="width: 25%;">Attribute</th>
                <th style="width: 25%;">Variant A</th>
                <th style="width: 25%;">Variant B</th>
                <th style="width: 25%;">Verification</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Brand</strong></td>
                <td>${escapeHtml(idCheck.brand?.valA || '—')}</td>
                <td>${escapeHtml(idCheck.brand?.valB || '—')}</td>
                <td><span class="id-check-pass">✔ Match</span></td>
              </tr>
              <tr>
                <td><strong>Product</strong></td>
                <td>${escapeHtml(idCheck.product?.valA || '—')}</td>
                <td>${escapeHtml(idCheck.product?.valB || '—')}</td>
                <td><span class="id-check-pass">✔ Match</span></td>
              </tr>
              <tr>
                <td><strong>Pack / Count</strong></td>
                <td>${escapeHtml(packCheck.valA || idCheck.packCount?.valA || '—')}</td>
                <td>${escapeHtml(packCheck.valB || idCheck.packCount?.valB || '—')}</td>
                <td>
                  ${packCheck.warning
                    ? `<span class="id-check-warn">⚠ ${escapeHtml(packCheck.label)}</span>`
                    : `<span class="id-check-pass">✔ Match</span>`
                  }
                </td>
              </tr>
              <tr>
                <td><strong>MRP Evidence</strong></td>
                <td>${escapeHtml(idCheck.mrp?.valA || mrpADisplay)}</td>
                <td>${escapeHtml(idCheck.mrp?.valB || mrpBDisplay)}</td>
                <td><span class="id-check-info">${escapeHtml(idCheck.mrp?.label || '—')}</span></td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Card Footer -->
        <div class="candidate-footer">
          <div class="candidate-reason-text">
            <strong>Matcher Reason:</strong> ${escapeHtml(cand.reason)}
          </div>
          <div class="candidate-actions">
            ${actionsHtml}
          </div>
          <div class="card-action-status" style="display: none; font-size: 0.8rem; margin-top: 6px; font-weight: 600; width: 100%;"></div>
        </div>
      `;

      candidateCardsContainer.appendChild(card);
    });
  }

  // Event delegation on candidate cards container (attached once)
  candidateCardsContainer.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;

    const card = btn.closest('.candidate-card');
    if (!card) return;

    const action = btn.getAttribute('data-action');
    const canonicalName = btn.getAttribute('data-canonical');
    const itemA = btn.getAttribute('data-a');
    const itemB = btn.getAttribute('data-b');

    // 1. Immediately disable both buttons to prevent double-clicks
    const allBtns = card.querySelectorAll('button');
    allBtns.forEach(b => { b.disabled = true; });

    const originalText = btn.textContent;
    btn.textContent = 'Saving...';

    const statusEl = card.querySelector('.card-action-status');
    if (statusEl) {
      statusEl.style.display = 'none';
      statusEl.textContent = '';
      statusEl.style.color = '';
    }

    try {
      if (action === 'merge') {
        // Find variants not matching canonicalName
        const variantsToMerge = [itemA, itemB].filter(v => v && v !== canonicalName);
        if (variantsToMerge.length === 0 && itemA) {
          variantsToMerge.push(itemA);
        }

        for (const rawName of variantsToMerge) {
          await apiDecision({ action: 'MERGE', rawName, canonicalName });
        }

        btn.textContent = '✔ Merged';
        btn.style.backgroundColor = 'var(--admin-success)';
        btn.style.borderColor = 'var(--admin-success)';
        btn.style.color = '#0b1e10';
        card.style.borderColor = 'var(--admin-success)';

        // In-memory state update
        updateStateAfterDecision(itemA, itemB, canonicalName, 'MERGE', variantsToMerge);
      } else if (action === 'keep-separate') {
        await apiDecision({ action: 'KEEP_SEPARATE', itemA, itemB });

        btn.textContent = '✔ Kept Separate';
        btn.style.backgroundColor = 'var(--admin-warning)';
        btn.style.borderColor = 'var(--admin-warning)';
        btn.style.color = '#1f1300';
        card.style.borderColor = 'var(--admin-warning)';

        // In-memory state update
        updateStateAfterDecision(itemA, itemB, canonicalName, 'KEEP_SEPARATE');
      }

      // 2. Animate and remove card from DOM
      setTimeout(() => {
        card.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
        card.style.opacity = '0';
        card.style.transform = 'translateY(-6px)';
        setTimeout(() => {
          card.remove();
          if (candidateCardsContainer.querySelectorAll('.candidate-card').length === 0) {
            noCandidatesMsg.style.display = 'block';
          }
        }, 250);
      }, 350);

      // 3. Immediately refresh Decision Ledger & Status
      renderDecisionLedger();
      refreshLedgerStatus();

      // 4. Background re-analysis to update reorder models without interrupting user
      triggerBackgroundAnalysis();

    } catch (err) {
      btn.textContent = originalText;
      allBtns.forEach(b => { b.disabled = false; });
      if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.style.color = 'var(--admin-danger)';
        statusEl.textContent = `Error: ${err.message || 'Failed to record decision.'}`;
      } else {
        alert(`Error: ${err.message || 'Failed to record decision.'}`);
      }
    }
  });

  function updateStateAfterDecision(itemA, itemB, canonicalName, action, variantsMerged = []) {
    if (!analysisData?.nameResolution) return;
    const nr = analysisData.nameResolution;

    // Filter out resolved candidate from pendingCandidates
    if (Array.isArray(nr.pendingCandidates)) {
      nr.pendingCandidates = nr.pendingCandidates.filter(c => {
        const matches = (c.itemA === itemA && c.itemB === itemB) || (c.itemA === itemB && c.itemB === itemA);
        return !matches;
      });
      nr.summary = nr.summary || {};
      nr.summary.pendingCandidatesCount = nr.pendingCandidates.length;
    }

    // Update counters in UI
    if (tabCountResolution) tabCountResolution.textContent = nr.summary.pendingCandidatesCount || 0;
    if (resPendingCount) resPendingCount.textContent = nr.summary.pendingCandidatesCount || 0;

    const todayStr = new Date().toISOString().slice(0, 10);

    if (action === 'MERGE') {
      nr.summary.manualMergedCount = (nr.summary.manualMergedCount || 0) + variantsMerged.length;
      if (resManualCount) resManualCount.textContent = nr.summary.manualMergedCount;

      nr.persistentMappings = nr.persistentMappings || [];
      for (const rawName of variantsMerged) {
        if (!nr.persistentMappings.some(m => m.rawName === rawName)) {
          nr.persistentMappings.unshift({ rawName, canonicalName, date: todayStr });
        }
      }
    } else if (action === 'KEEP_SEPARATE') {
      nr.persistentSeparates = nr.persistentSeparates || [];
      if (!nr.persistentSeparates.some(s => (s.itemA === itemA && s.itemB === itemB) || (s.itemA === itemB && s.itemB === itemA))) {
        nr.persistentSeparates.unshift({ itemA, itemB, date: todayStr });
      }
    }
  }

  function renderValidationReport() {
    let reports = analysisData?.nameResolution?.validationReport || [];
    validationTbody.innerHTML = '';

    if (validationSearchTerm) {
      reports = reports.filter(r => {
        if (r.canonicalName.toLowerCase().includes(validationSearchTerm)) return true;
        if (r.salesVariants.some(v => v.rawName.toLowerCase().includes(validationSearchTerm))) return true;
        if (r.stockVariants.some(v => v.rawName.toLowerCase().includes(validationSearchTerm))) return true;
        return false;
      });
    }

    if (reports.length === 0) {
      validationTbody.innerHTML = '<tr><td colspan="6" style="text-align: center; padding: 25px; color: var(--text-muted);">No records found.</td></tr>';
      return;
    }

    reports.forEach(rep => {
      const tr = document.createElement('tr');

      // Sales variants chips
      const salesChips = rep.salesVariants.map(v => {
        const chipClass = v.status === 'AUTO' ? 'variant-chip-auto' : (v.status === 'MANUAL' ? 'variant-chip-manual' : 'variant-chip-exact');
        const srcTag = v.resolutionSource ? ` <span style="opacity: 0.7; font-size: 0.7rem;">[${escapeHtml(v.resolutionSource)}]</span>` : '';
        return `<div><span class="variant-chip ${chipClass}">${v.status}</span> <strong>${escapeHtml(v.rawName)}</strong> (${v.quantitySold} units)${srcTag}</div>`;
      }).join('') || '<span style="color: var(--text-muted); font-size: 0.8rem;">No sales recorded</span>';

      // Stock variants chips
      const stockChips = rep.stockVariants.map(v => {
        const chipClass = v.status === 'AUTO' ? 'variant-chip-auto' : (v.status === 'MANUAL' ? 'variant-chip-manual' : 'variant-chip-exact');
        const srcTag = v.resolutionSource ? ` <span style="opacity: 0.7; font-size: 0.7rem;">[${escapeHtml(v.resolutionSource)}]</span>` : '';
        return `<div><span class="variant-chip ${chipClass}">${v.status}</span> <strong>${escapeHtml(v.rawName)}</strong> (${v.currentStock} units)${srcTag}</div>`;
      }).join('') || '<span style="color: var(--text-muted); font-size: 0.8rem;">No stock record</span>';

      // Status pill & resolution source
      let statusPill = `<span class="tab-badge badge-ok">${rep.resolutionStatus}</span>`;
      if (rep.resolutionStatus === 'UNRESOLVED') {
        statusPill = `<span class="tab-badge badge-buy-now">MATCH REQUIRED</span>`;
      } else if (rep.resolutionStatus === 'MANUAL_MERGED') {
        statusPill = `<span class="tab-badge badge-review">MANUAL MERGED</span>`;
      } else if (rep.resolutionStatus === 'AUTO_MERGED') {
        statusPill = `<span class="tab-badge badge-resolution">AUTO MERGED</span>`;
      }
      const sourceBadge = rep.resolutionSource ? `<div style="font-size: 0.68rem; color: var(--admin-text-muted); margin-top: 4px; font-family: monospace;">[${escapeHtml(rep.resolutionSource)}]</div>` : '';

      tr.innerHTML = `
        <td>
          <div style="font-weight: 700; color: var(--admin-text);">${escapeHtml(rep.canonicalName)}</div>
          <div style="font-size: 0.74rem; color: var(--admin-text-secondary);">${escapeHtml(rep.resolutionDetail)}</div>
        </td>
        <td style="font-size: 0.82rem;">${salesChips}</td>
        <td class="text-right" style="font-weight: 700; color: var(--admin-text);">${rep.totalSalesQuantity}</td>
        <td style="font-size: 0.82rem;">${stockChips}</td>
        <td class="text-right" style="font-weight: 700; color: var(--admin-text);">${rep.totalStockQuantity}</td>
        <td style="text-align: center;">
          ${statusPill}
          ${sourceBadge}
        </td>
      `;

      validationTbody.appendChild(tr);
    });
  }

  function renderDecisionLedger() {
    const merges = analysisData?.nameResolution?.persistentMappings || [];
    const separates = analysisData?.nameResolution?.persistentSeparates || [];

    if (merges.length === 0 && separates.length === 0) {
      ledgerEntriesContainer.innerHTML = '<p style="color: var(--admin-text-muted); font-size: 0.85rem;">No persistent decisions recorded yet.</p>';
      return;
    }

    let html = '<div style="display: flex; flex-direction: column; gap: 8px;">';

    merges.forEach(m => {
      html += `
        <div class="ledger-row" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: var(--admin-surface-3); border: 1px solid var(--admin-border); border-radius: 4px; font-size: 0.85rem;">
          <div>
            <span class="tab-badge badge-review" style="font-size: 0.7rem; margin-right: 6px;">MERGE</span>
            <strong>${escapeHtml(m.rawName)}</strong> &rarr; <strong>${escapeHtml(m.canonicalName)}</strong>
            <span style="color: var(--admin-text-muted); font-size: 0.75rem; margin-left: 6px;">(${formatDate(m.date)})</span>
          </div>
          <button type="button" class="btn btn-outline btn-sm btn-revoke" data-action="revoke-merge" data-raw="${escapeHtml(m.rawName)}" style="color: var(--admin-danger); border-color: var(--admin-danger-border);">Revoke</button>
        </div>
      `;
    });

    separates.forEach(s => {
      html += `
        <div class="ledger-row" style="display: flex; justify-content: space-between; align-items: center; padding: 10px 14px; background: var(--admin-surface-3); border: 1px solid var(--admin-border); border-radius: 4px; font-size: 0.85rem;">
          <div>
            <span class="tab-badge badge-watch" style="font-size: 0.7rem; margin-right: 6px;">KEEP SEPARATE</span>
            <strong>${escapeHtml(s.itemA)}</strong> &ne; <strong>${escapeHtml(s.itemB)}</strong>
          </div>
          <button type="button" class="btn btn-outline btn-sm btn-revoke" data-action="revoke-separate" data-a="${escapeHtml(s.itemA)}" data-b="${escapeHtml(s.itemB)}" style="color: var(--admin-danger); border-color: var(--admin-danger-border);">Revoke</button>
        </div>
      `;
    });

    html += '</div>';
    ledgerEntriesContainer.innerHTML = html;
  }

  // Event delegation on ledger entries container (attached once)
  ledgerEntriesContainer.addEventListener('click', async (e) => {
    const btn = e.target.closest('button.btn-revoke');
    if (!btn || btn.disabled) return;

    const row = btn.closest('.ledger-row');
    const action = btn.getAttribute('data-action');
    const rawName = btn.getAttribute('data-raw');
    const itemA = btn.getAttribute('data-a');
    const itemB = btn.getAttribute('data-b');

    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Revoking...';

    try {
      if (action === 'revoke-merge') {
        await apiDeleteDecision({ rawName });
        if (analysisData?.nameResolution) {
          const nr = analysisData.nameResolution;
          nr.persistentMappings = (nr.persistentMappings || []).filter(m => m.rawName !== rawName);
          nr.summary = nr.summary || {};
          nr.summary.manualMergedCount = Math.max(0, (nr.summary.manualMergedCount || 1) - 1);
          if (resManualCount) resManualCount.textContent = nr.summary.manualMergedCount;
        }
      } else if (action === 'revoke-separate') {
        await apiDeleteDecision({ itemA, itemB });
        if (analysisData?.nameResolution) {
          const nr = analysisData.nameResolution;
          nr.persistentSeparates = (nr.persistentSeparates || []).filter(s =>
            !((s.itemA === itemA && s.itemB === itemB) || (s.itemA === itemB && s.itemB === itemA))
          );
        }
      }

      btn.textContent = '✔ Revoked';
      setTimeout(() => {
        if (row) row.remove();
        renderDecisionLedger();
        refreshLedgerStatus();
        triggerBackgroundAnalysis();
      }, 300);

    } catch (err) {
      btn.disabled = false;
      btn.textContent = originalText;
      alert(`Error revoking decision: ${err.message || 'Server error'}`);
    }
  });

  async function apiDecision(payload) {
    const token = localStorage.getItem('admin_token') || '';
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    };

    const res = await (typeof authenticatedFetch === 'function'
      ? authenticatedFetch('/api/admin/inventory/mappings/decision', options)
      : fetch('/api/admin/inventory/mappings/decision', options));

    if (!res) throw new Error('Session expired. Please log in again.');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save decision.');
    return data;
  }

  async function apiDeleteDecision(payload) {
    const token = localStorage.getItem('admin_token') || '';
    const options = {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    };

    const res = await (typeof authenticatedFetch === 'function'
      ? authenticatedFetch('/api/admin/inventory/mappings/decision', options)
      : fetch('/api/admin/inventory/mappings/decision', options));

    if (!res) throw new Error('Session expired. Please log in again.');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to revoke decision.');
    return data;
  }

  async function triggerBackgroundAnalysis() {
    if (!saleInput.files || !saleInput.files[0] || !stockInput.files || !stockInput.files[0]) {
      return;
    }

    const currentTab = activeTab;

    try {
      const formData = new FormData();
      formData.append('saleReport', saleInput.files[0]);
      formData.append('stockDetail', stockInput.files[0]);

      const leadTimeVal = document.getElementById('lead-time-input')?.value;
      if (leadTimeVal) formData.append('leadTimeDays', leadTimeVal);

      const reviewFreqVal = document.getElementById('review-frequency-input')?.value;
      if (reviewFreqVal) formData.append('reviewFrequencyDays', reviewFreqVal);

      const orderCoverageVal = document.getElementById('order-coverage-input')?.value;
      if (orderCoverageVal) formData.append('orderCoverageDays', orderCoverageVal);

      const serviceLevelVal = document.getElementById('service-level-select')?.value;
      if (serviceLevelVal) formData.append('serviceLevel', serviceLevelVal);

      const watchBufferVal = document.getElementById('watch-threshold-input')?.value;
      if (watchBufferVal) formData.append('watchThresholdFactor', watchBufferVal);

      const trendCheckbox = document.getElementById('trend-adjusted-checkbox');
      if (trendCheckbox) formData.append('useTrendAdjustedDemand', trendCheckbox.checked ? 'true' : 'false');

      const token = localStorage.getItem('admin_token') || '';
      const response = await (typeof authenticatedFetch === 'function'
        ? authenticatedFetch('/api/admin/inventory/analyze', {
            method: 'POST',
            body: formData
          })
        : fetch('/api/admin/inventory/analyze', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
          }));

      if (!response || !response.ok) return;
      const data = await response.json();
      analysisData = data;

      // Preserve the active tab so user stays exactly where they were
      activeTab = currentTab;
      renderAnalysisView();
    } catch (e) {
      console.warn('Background re-analysis after decision failed:', e);
    }
  }

  // 9. Slide-Over Product Detail Drawer (Mathematical Audit Trail)
  function openProductDrawer(item) {
    drawerItemName.textContent = item.itemName;

    // Badges
    drawerClassBadge.textContent = item.classification.replace('_', ' ');
    drawerClassBadge.className = `tab-badge badge-${item.classification.toLowerCase().replace('_', '-')}`;

    if (item.urgency) {
      drawerUrgencyBadge.style.display = 'inline-block';
      drawerUrgencyBadge.textContent = item.urgency;
      drawerUrgencyBadge.className = `urgency-pill urgency-${item.urgency.toLowerCase()}`;
    } else {
      drawerUrgencyBadge.style.display = 'none';
    }

    // Why? Box
    drawerWhyBox.className = 'why-box';
    if (item.classification === 'BUY_NOW') {
      drawerWhyBox.classList.add('urgent');
    } else if (item.classification === 'WATCH') {
      drawerWhyBox.classList.add('watch');
    }

    drawerReason.textContent = item.reason;
    drawerMetricStock.textContent = `${item.currentStock} units`;
    drawerMetricCover.textContent = item.daysOfCover !== null ? `${item.daysOfCover} days` : 'None';
    drawerMetricDemand.textContent = `${item.effectiveDailyDemand} /day`;

    // 1. Demand Step
    const trendText = item.trend ? item.trend.toUpperCase() : 'STABLE';
    const changeText = item.demandChangePct !== null
      ? (item.demandChangePct > 0 ? `+${item.demandChangePct}%` : `${item.demandChangePct}%`)
      : 'N/A';
    const recentVal = item.recentAvgDailyDemand !== null ? `${item.recentAvgDailyDemand} /day` : 'N/A';
    const priorVal = item.priorAvgDailyDemand !== null ? `${item.priorAvgDailyDemand} /day` : 'N/A';

    auditDemandBox.innerHTML = `
      <div>Period: ${item.periodDays} days · Total Sold: ${item.totalSoldInPeriod} units</div>
      <div>Full Period Avg: ${item.fullPeriodAvgDailyDemand} units/day</div>
      <div>Trend Window: ${item.trendWindowDays} days (${recentVal} recent vs ${priorVal} prior)</div>
      <div>Trend Signal: ${trendText} (${changeText} change)</div>
      <div>Demand Variability (σ): ${item.demandVariability ?? '0.00'} units/day</div>
      <div class="result-line">Effective Daily Demand = ${item.effectiveDailyDemand} units/day</div>
      <div style="font-size: 0.76rem; color: var(--admin-text-secondary); margin-top: 2px;">Basis: ${item.demandBasis}</div>
    `;

    // 2. Safety Stock Step (Real Numbers)
    const zVal = getZScoreFor(item.serviceLevel);
    const sigmaVal = item.demandVariability ?? 0;
    const sqrtL = Math.sqrt(item.leadTimeDays).toFixed(2);
    auditSafetyStockBox.innerHTML = `
      <div>Formula: Z × σ × √LeadTime</div>
      <div>Values: ${zVal} × ${sigmaVal} × √${item.leadTimeDays} (${sqrtL})</div>
      <div class="result-line">= ${item.safetyStock} units</div>
      <div style="font-size: 0.76rem; color: var(--admin-text-secondary); margin-top: 2px;">Protects against stockouts during ${item.leadTimeDays}-day delivery window (SL: ${Math.round(item.serviceLevel * 100)}%)</div>
    `;

    // 3. Reorder Point Step (Real Numbers)
    const demandLeadRaw = (item.effectiveDailyDemand * item.leadTimeDays).toFixed(2);
    auditRopBox.innerHTML = `
      <div>Formula: EffectiveDailyDemand × LeadTime + SafetyStock</div>
      <div>Values: ${item.effectiveDailyDemand} × ${item.leadTimeDays} (${demandLeadRaw}) + ${item.safetyStock}</div>
      <div class="result-line">= ${item.reorderPoint} units</div>
      <div style="font-size: 0.76rem; color: var(--admin-text-secondary); margin-top: 2px;">Stock below this point triggers an immediate purchase recommendation</div>
    `;

    // 4. Target Stock Step (Real Numbers)
    const demandCoverageRaw = (item.effectiveDailyDemand * item.orderCoverageDays).toFixed(2);
    auditTargetStockBox.innerHTML = `
      <div>Formula: EffectiveDailyDemand × OrderCoverage + SafetyStock</div>
      <div>Values: ${item.effectiveDailyDemand} × ${item.orderCoverageDays} (${demandCoverageRaw}) + ${item.safetyStock}</div>
      <div class="result-line">= ${item.targetStock} units</div>
      <div style="font-size: 0.76rem; color: var(--admin-text-secondary); margin-top: 2px;">Order-up-to ceiling covering ${item.orderCoverageDays} days of forecast demand plus buffer</div>
    `;

    // 5. Order Recommendation Step (Real Numbers)
    const currentStockClamped = Math.max(0, item.currentStock);
    const diffRaw = (item.targetStock - currentStockClamped).toFixed(2);
    auditOrderQtyBox.innerHTML = `
      <div>Formula: ⌈TargetStock − CurrentStock⌉</div>
      <div>Values: ⌈${item.targetStock} − ${currentStockClamped}⌉ (${diffRaw})</div>
      <div class="result-line">= ${item.suggestedOrderQty} units</div>
      ${item.currentStock < 0 ? `<div style="font-size: 0.76rem; color: var(--admin-danger); margin-top: 2px;">(Physical stock clamped to 0 from recorded ${item.currentStock})</div>` : ''}
    `;

    // Action Banner
    if (item.classification === 'BUY_NOW' && item.suggestedOrderQty > 0) {
      drawerActionBanner.className = 'recommendation-action-banner buy';
      drawerActionValue.textContent = `BUY ${item.suggestedOrderQty} UNITS`;
    } else {
      drawerActionBanner.className = 'recommendation-action-banner';
      drawerActionValue.textContent = 'NO ORDER REQUIRED';
    }

    // Open drawer
    drawerBackdrop.classList.add('open');
    drawerPanel.classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function closeProductDrawer() {
    drawerBackdrop.classList.remove('open');
    drawerPanel.classList.remove('open');
    document.body.style.overflow = '';
  }

  drawerCloseBtn.addEventListener('click', closeProductDrawer);
  drawerBackdrop.addEventListener('click', closeProductDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeProductDrawer();
  });

  // 10. CSV Exports
  exportTabCsvBtn.addEventListener('click', () => {
    if (!analysisData?.suggestions) return;
    let items = analysisData.suggestions.filter(s => s.classification === activeTab);
    if (activeTab === 'BUY_NOW' && activeUrgency !== 'ALL') {
      items = items.filter(s => s.urgency === activeUrgency);
    }
    if (productSearchTerm) {
      items = items.filter(s => s.itemName.toLowerCase().includes(productSearchTerm));
    }

    let csv = 'Item Name,Classification,Urgency,Current Stock,Days of Cover,Daily Demand,Trend,Reorder Point,Target Stock,Suggested Order Qty,Reason\n';
    items.forEach(i => {
      const name = `"${String(i.itemName).replace(/"/g, '""')}"`;
      const reason = `"${String(i.reason).replace(/"/g, '""')}"`;
      csv += `${name},${i.classification},${i.urgency || ''},${i.currentStock},${i.daysOfCover || ''},${i.effectiveDailyDemand},${i.trend},${i.reorderPoint},${i.targetStock},${i.suggestedOrderQty},${reason}\n`;
    });

    downloadCsv(csv, `78inventory_${activeTab.toLowerCase()}_${Date.now()}.csv`);
  });

  exportReviewCsvBtn.addEventListener('click', () => {
    if (!analysisData?.review) return;
    const { review } = analysisData;
    let csv = '';

    if (activeReviewCategory === 'matchRequired') {
      csv = 'Canonical SKU,Sales Qty,Stock Qty,Status\n';
      (review.matchRequiredItems || []).forEach(i => {
        csv += `"${String(i.canonicalName).replace(/"/g, '""')}",${i.totalSalesQuantity},${i.totalStockQuantity},MATCH REQUIRED\n`;
      });
    } else if (activeReviewCategory === 'negativeStock') {
      csv = 'Item Name,Recorded Closing Qty\n';
      (review.negativeStockItems || []).forEach(i => {
        csv += `"${String(i.itemName).replace(/"/g, '""')}",${i.recordedClosingQty}\n`;
      });
    } else if (activeReviewCategory === 'deadStock') {
      csv = 'Item Name,Current Stock On Hand,Sales in Period\n';
      (review.deadStockCandidates || []).forEach(i => {
        csv += `"${String(i.itemName).replace(/"/g, '""')}",${i.currentStock},0\n`;
      });
    } else if (activeReviewCategory === 'zeroStock') {
      csv = 'Item Name,Current Stock,Sales in Period\n';
      (review.zeroStockNeverSold || []).forEach(i => {
        csv += `"${String(i.itemName).replace(/"/g, '""')}",0,0\n`;
      });
    } else if (activeReviewCategory === 'nameVariants') {
      csv = 'Item A,Item B,Reason\n';
      (review.suggestedMerges || []).forEach(i => {
        csv += `"${String(i.itemA).replace(/"/g, '""')}","${String(i.itemB).replace(/"/g, '""')}","${String(i.reason || '').replace(/"/g, '""')}"\n`;
      });
    } else if (activeReviewCategory === 'dataQuality') {
      csv = 'Item Name,Issue Description\n';
      (review.dataQualityNotes || []).forEach(i => {
        csv += `"${String(i.itemName).replace(/"/g, '""')}","${String(i.issue).replace(/"/g, '""')}"\n`;
      });
    }

    downloadCsv(csv, `78inventory_review_${activeReviewCategory}_${Date.now()}.csv`);
  });

  exportValidationCsvBtn.addEventListener('click', () => {
    const reports = analysisData?.nameResolution?.validationReport || [];
    let csv = 'Canonical Product SKU,Sales Variants,Merged Sales Qty,Stock Variants,Merged Stock Qty,Resolution Status,Resolution Source,Detail\n';
    reports.forEach(r => {
      const sales = `"${r.salesVariants.map(v => `${v.rawName} (${v.quantitySold})`).join('; ').replace(/"/g, '""')}"`;
      const stock = `"${r.stockVariants.map(v => `${v.rawName} (${v.currentStock})`).join('; ').replace(/"/g, '""')}"`;
      csv += `"${String(r.canonicalName).replace(/"/g, '""')}",${sales},${r.totalSalesQuantity},${stock},${r.totalStockQuantity},${r.resolutionStatus},${r.resolutionSource || ''},"${String(r.resolutionDetail).replace(/"/g, '""')}"\n`;
    });
    downloadCsv(csv, `78inventory_validation_report_${Date.now()}.csv`);
  });

  function downloadCsv(content, filename) {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // Helpers
  function formatDate(d) {
    if (!d) return '-';
    const date = new Date(d);
    if (isNaN(date.getTime())) return String(d);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = date.getDate();
    const month = months[date.getMonth()];
    const year = date.getFullYear();
    return `${day} ${month} ${year}`;
  }

  function formatDateTime(d) {
    if (!d) return '-';
    const date = new Date(d);
    if (isNaN(date.getTime())) return String(d);
    const datePart = formatDate(d);
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${datePart}, ${String(hours).padStart(2, '0')}:${minutes} ${ampm}`;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

})();
