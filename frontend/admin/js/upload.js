// 78 PriceCheck - Product Catalogue & Wholesale Review Controller

// DOM Elements - Navigation & Session
const logoutBtn = document.getElementById('logout-btn');

// DOM Elements - Status Panel
const statusProducts = document.getElementById('status-products');
const statusVersion = document.getElementById('status-version');
const statusUpdated = document.getElementById('status-updated');
const statusWholesaleRepo = document.getElementById('status-wholesale-repo');

// DOM Elements - Inline Upload History
const historyRows = document.getElementById('history-rows');
const refreshHistoryBtn = document.getElementById('refresh-history-btn');

// DOM Elements - Upload Inspection Modal
const inspectModal = document.getElementById('inspect-modal');
const inspectCloseBtn = document.getElementById('inspect-close-btn');
const inspectDismissBtn = document.getElementById('inspect-dismiss-btn');
const inspectFilename = document.getElementById('inspect-filename');
const inspectStockFilename = document.getElementById('inspect-stock-filename');
const inspectStatus = document.getElementById('inspect-status');
const inspectDate = document.getElementById('inspect-date');
const inspectUser = document.getElementById('inspect-user');
const inspectTotalRows = document.getElementById('inspect-total-rows');
const inspectStockRows = document.getElementById('inspect-stock-rows');
const inspectStockUnique = document.getElementById('inspect-stock-unique');
const inspectValidRows = document.getElementById('inspect-valid-rows');
const inspectInactiveRows = document.getElementById('inspect-inactive-rows');
const inspectBlankBarcodes = document.getElementById('inspect-blank-barcodes');
const inspectDuplicateBarcodes = document.getElementById('inspect-duplicate-barcodes');
const inspectWholesaleProducts = document.getElementById('inspect-wholesale-products');
const inspectWholesaleMatched = document.getElementById('inspect-wholesale-matched');
const inspectWholesaleManual = document.getElementById('inspect-wholesale-manual');
const inspectWholesaleSaved = document.getElementById('inspect-wholesale-saved');
const inspectDuration = document.getElementById('inspect-duration');
const inspectErrorsContainer = document.getElementById('inspect-errors-container');
const inspectErrorsContent = document.getElementById('inspect-errors-content');
const inspectDlErrorBtn = document.getElementById('inspect-dl-error-btn');

// DOM Elements - Dual Upload Controls
const browseExportBtn = document.getElementById('browse-export-btn');
const exportFileInput = document.getElementById('export-file-input');
const exportFileNameLabel = document.getElementById('export-file-name');
const browseStockBtn = document.getElementById('browse-stock-btn');
const stockFileInput = document.getElementById('stock-file-input');
const stockFileNameLabel = document.getElementById('stock-file-name');
const uploadBtn = document.getElementById('upload-btn');
const uploadForm = document.getElementById('upload-form');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');

// DOM Elements - Alerts
const resultContainer = document.getElementById('result-container');
const successAlert = document.getElementById('success-alert');
const failureAlert = document.getElementById('failure-alert');
const failureMsg = document.getElementById('failure-msg');
const errorsReportLink = document.getElementById('errors-report-link');
const downloadErrorsBtn = document.getElementById('download-errors-btn');

// DOM Elements - Review Section
const reviewSection = document.getElementById('review-section');
const duplicateConflictsCard = document.getElementById('duplicate-conflicts-card');
const duplicateConflictsContainer = document.getElementById('duplicate-conflicts-container');
const duplicateConflictBadge = document.getElementById('duplicate-conflict-badge');
const wholesaleTbody = document.getElementById('wholesale-tbody');
const reviewSearch = document.getElementById('review-search');
const missingAlertBox = document.getElementById('missing-alert-box');
const missingAlertText = document.getElementById('missing-alert-text');
const publishBtn = document.getElementById('publish-btn');
const downloadPreviewBtn = document.getElementById('download-preview-btn');
const cancelReviewBtn = document.getElementById('cancel-review-btn');

// DOM Elements - Inactive Products Excluded Section
const inactiveProductsCard = document.getElementById('inactive-products-card');
const inactiveCountBadge = document.getElementById('inactive-count-badge');
const toggleInactiveBtn = document.getElementById('toggle-inactive-btn');
const downloadInactiveBtn = document.getElementById('download-inactive-btn');
const inactiveTableWrapper = document.getElementById('inactive-table-wrapper');
const inactiveTbody = document.getElementById('inactive-tbody');

// DOM Elements - KPI Summary
const kpiSourceRows = document.getElementById('kpi-source-rows');
const kpiBlankBarcodes = document.getElementById('kpi-blank-barcodes');
const kpiDuplicateBarcodes = document.getElementById('kpi-duplicate-barcodes');
const kpiValidCandidates = document.getElementById('kpi-valid-candidates');
const kpiStockRows = document.getElementById('kpi-stock-rows');
const kpiStockUnique = document.getElementById('kpi-stock-unique');
const kpiActiveProducts = document.getElementById('kpi-active-products');
const kpiInactiveProducts = document.getElementById('kpi-inactive-products');
const kpiTotalWholesale = document.getElementById('kpi-total-wholesale');
const kpiMatchedWq = document.getElementById('kpi-matched-wq');
const kpiEditedWq = document.getElementById('kpi-edited-wq');
const kpiMissingWq = document.getElementById('kpi-missing-wq');

// DOM Elements - Modal
const publishModal = document.getElementById('publish-modal');
const modalCancelBtn = document.getElementById('modal-cancel-btn');
const modalConfirmBtn = document.getElementById('modal-confirm-btn');
const modalProductsCount = document.getElementById('modal-products-count');
const modalWholesaleCount = document.getElementById('modal-wholesale-count');
const modalUpdatesCount = document.getElementById('modal-updates-count');

// Local Staging State
let activeSessionId = null;
let stagedWholesaleItems = [];
let stagedDuplicateConflicts = [];
let stagedInactiveProducts = [];
let duplicateResolutions = new Map(); // barcode -> { action: 'SELECT' | 'EXCLUDE', candidateId?: string }
let wholesaleUpdates = new Map(); // normalizedName -> { originalName, normalizedName, wholesaleQty }
let cachedHistoryRecords = [];

// Authenticated fetch wrapper
async function authFetch(url, options = {}) {
  const token = localStorage.getItem('admin_token');
  if (!token) {
    window.location.href = '/admin';
    return null;
  }
  const headers = options.headers || {};
  headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(url, { ...options, headers });
  if (res.status === 401 || res.status === 403) {
    localStorage.removeItem('admin_token');
    window.location.href = '/admin';
    return null;
  }
  return res;
}

// 1. Fetch & update catalog status panel
async function updateStatusPanel() {
  try {
    const res = await fetch('/api/version');
    if (res.status === 200) {
      const data = await res.json();
      if (statusProducts) statusProducts.textContent = Number(data.productsCount || 0).toLocaleString();
      if (statusVersion) statusVersion.textContent = data.catalogVersion || 'N/A';
      if (statusWholesaleRepo) statusWholesaleRepo.textContent = Number(data.wholesaleRepoCount || 0).toLocaleString() + ' saved';
      
      if (statusUpdated) {
        if (data.lastCatalogUpload) {
          const d = new Date(data.lastCatalogUpload);
          const options = { day: 'numeric', month: 'long', year: 'numeric' };
          const dateStr = d.toLocaleDateString('en-GB', options);
          const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
          statusUpdated.innerHTML = `${dateStr}<br>${timeStr}`;
        } else {
          statusUpdated.textContent = 'Never';
        }
      }
    }
  } catch (err) {
    console.error('Failed to load version info', err);
  }
}

// 2. Fetch & update inline upload history
async function loadHistory() {
  if (!historyRows) return;
  try {
    const res = await authFetch('/api/admin/upload-history');
    if (!res) return;
    
    if (res.status === 200) {
      const data = await res.json();
      cachedHistoryRecords = Array.isArray(data) ? data : [];
      historyRows.innerHTML = '';
      
      if (cachedHistoryRecords.length === 0) {
        historyRows.innerHTML = '<tr><td colspan="10" class="text-center text-muted" style="padding: 16px;">No upload history records found.</td></tr>';
        return;
      }
      
      cachedHistoryRecords.forEach((run, index) => {
        const tr = document.createElement('tr');
        
        const d = new Date(run.uploadedAt);
        const dateStr = d.toLocaleString('en-GB');
        
        const statusBadge = run.status === 'Success'
          ? '<span class="badge badge-success">Success</span>'
          : '<span class="badge badge-danger">Failed</span>';
          
        let actionCell = `<div style="display: flex; gap: 6px; align-items: center;">
          <button class="btn btn-outline btn-sm inspect-history-btn" data-idx="${index}" style="padding: 2px 8px; font-size: 0.75rem;">Inspect</button>`;
        if (run.status === 'Failed' && run.failedRows > 0) {
          actionCell += `<button class="btn btn-outline btn-sm download-err-btn" data-id="${run.id}" style="padding: 2px 8px; font-size: 0.75rem;">Errors</button>`;
        }
        actionCell += `</div>`;
        
        const matched = run.wholesaleMatched || 0;
        const manual = run.wholesaleManual || 0;
        const wholesaleRatio = (run.wholesaleProducts > 0) ? `${matched} / ${manual}` : '-';

        const exportFile = run.exportFilename || run.filename;
        const stockFile = run.stockDetailFilename || '-';
        const fileDisplay = `
          <div style="font-weight: 600; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="Export: ${exportFile}">📄 ${exportFile}</div>
          <div style="font-size: 0.75rem; color: #38bdf8; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="Stock Detail: ${stockFile}">📊 ${stockFile}</div>
        `;

        tr.innerHTML = `
          <td style="font-size: 0.82rem; white-space: nowrap;">${dateStr}</td>
          <td class="text-semibold" style="font-size: 0.85rem;">${fileDisplay}</td>
          <td>${statusBadge}</td>
          <td style="font-size: 0.85rem;">${Number(run.totalRows || 0).toLocaleString()}</td>
          <td style="font-size: 0.85rem; font-weight: 600; color: var(--admin-brand);">${Number(run.activeProducts || run.successfulRows || 0).toLocaleString()}</td>
          <td style="font-size: 0.85rem; color: #fb923c;">${Number(run.inactiveProducts || 0).toLocaleString()}</td>
          <td style="font-size: 0.82rem; color: var(--admin-text-secondary);">${Number(run.blankBarcodes || 0).toLocaleString()} / ${Number(run.duplicateBarcodes || 0).toLocaleString()}</td>
          <td style="font-size: 0.82rem;">${wholesaleRatio}</td>
          <td style="font-size: 0.82rem; color: var(--admin-text-muted);">${run.processingTimeMs || 0} ms</td>
          <td>${actionCell}</td>
        `;
        
        historyRows.appendChild(tr);
      });
      
      // Wire up inspection buttons
      document.querySelectorAll('.inspect-history-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const idx = parseInt(e.target.getAttribute('data-idx'), 10);
          showInspectModal(cachedHistoryRecords[idx]);
        });
      });

      // Wire up download error buttons
      document.querySelectorAll('.download-err-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const runId = e.target.getAttribute('data-id');
          downloadErrorCsv(runId);
        });
      });
    }
  } catch (err) {
    console.error('Failed to load history', err);
  }
}

// Helper to download error CSV
async function downloadErrorCsv(runId) {
  try {
    const dlRes = await authFetch(`/api/admin/upload-errors/${runId}`);
    if (dlRes && dlRes.status === 200) {
      const blob = await dlRes.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `upload_errors_${runId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  } catch (err) {
    console.error('Failed to download error CSV', err);
  }
}

// 2b. Display Upload Inspection Modal
function showInspectModal(run) {
  if (!run || !inspectModal) return;

  const d = new Date(run.uploadedAt);
  const dateStr = d.toLocaleString('en-GB');

  inspectFilename.textContent = run.exportFilename || run.filename || '-';
  if (inspectStockFilename) inspectStockFilename.textContent = run.stockDetailFilename || '-';
  inspectStatus.innerHTML = run.status === 'Success'
    ? '<span class="badge badge-success">Success</span>'
    : '<span class="badge badge-danger">Failed</span>';
  inspectDate.textContent = dateStr;
  inspectUser.textContent = run.uploadedBy || 'admin';

  inspectTotalRows.textContent = Number(run.totalRows || 0).toLocaleString();
  if (inspectStockRows) inspectStockRows.textContent = run.stockDetailRows ? Number(run.stockDetailRows).toLocaleString() : '-';
  if (inspectStockUnique) inspectStockUnique.textContent = run.stockDetailUniqueNames ? Number(run.stockDetailUniqueNames).toLocaleString() : '-';
  inspectValidRows.textContent = Number(run.activeProducts || run.successfulRows || 0).toLocaleString();
  if (inspectInactiveRows) inspectInactiveRows.textContent = Number(run.inactiveProducts || 0).toLocaleString();
  inspectBlankBarcodes.textContent = Number(run.blankBarcodes || 0).toLocaleString();
  inspectDuplicateBarcodes.textContent = Number(run.duplicateBarcodes || 0).toLocaleString();
  inspectWholesaleProducts.textContent = Number(run.wholesaleProducts || 0).toLocaleString();
  inspectWholesaleMatched.textContent = Number(run.wholesaleMatched || 0).toLocaleString();
  inspectWholesaleManual.textContent = Number(run.wholesaleManual || 0).toLocaleString();
  inspectWholesaleSaved.textContent = Number(run.wholesaleSaved || 0).toLocaleString();
  inspectDuration.textContent = `${run.processingTimeMs || 0} ms`;

  // Parse and display errors or duplicate resolution decisions if present
  if (run.errorDetails) {
    inspectErrorsContainer.style.display = 'block';
    try {
      const parsed = typeof run.errorDetails === 'string' ? JSON.parse(run.errorDetails) : run.errorDetails;
      if (Array.isArray(parsed)) {
        inspectErrorsContent.textContent = parsed.map((c, i) => {
          if (c.resolution) {
            return `${i + 1}. [${c.barcode}] Resolution: ${c.resolution} ${c.selectedRow ? `(Selected Row ${c.selectedRow}: ${c.productName || ''})` : ''} ${c.reason || ''}`;
          }
          return `${i + 1}. [${c.barcode || 'N/A'}] ${c.error || JSON.stringify(c)}`;
        }).join('\n');
      } else {
        inspectErrorsContent.textContent = JSON.stringify(parsed, null, 2);
      }
    } catch (e) {
      inspectErrorsContent.textContent = String(run.errorDetails);
    }
  } else {
    inspectErrorsContainer.style.display = 'none';
    inspectErrorsContent.textContent = '';
  }

  if (run.failedRows > 0) {
    inspectDlErrorBtn.style.display = 'inline-block';
    inspectDlErrorBtn.onclick = () => downloadErrorCsv(run.id);
  } else {
    inspectDlErrorBtn.style.display = 'none';
  }

  inspectModal.style.display = 'flex';
}

function hideInspectModal() {
  if (inspectModal) inspectModal.style.display = 'none';
}

if (inspectCloseBtn) inspectCloseBtn.addEventListener('click', hideInspectModal);
if (inspectDismissBtn) inspectDismissBtn.addEventListener('click', hideInspectModal);
if (inspectModal) {
  inspectModal.addEventListener('click', (e) => {
    if (e.target === inspectModal) hideInspectModal();
  });
}

if (refreshHistoryBtn) {
  refreshHistoryBtn.addEventListener('click', (e) => {
    e.preventDefault();
    loadHistory();
  });
}

// 3. Dual File Selection Handlers
if (browseExportBtn && exportFileInput) {
  browseExportBtn.addEventListener('click', () => exportFileInput.click());
}
if (browseStockBtn && stockFileInput) {
  browseStockBtn.addEventListener('click', () => stockFileInput.click());
}

function checkFilesSelected() {
  const hasExport = exportFileInput && exportFileInput.files.length > 0;
  const hasStock = stockFileInput && stockFileInput.files.length > 0;

  if (exportFileNameLabel) {
    exportFileNameLabel.textContent = hasExport ? exportFileInput.files[0].name : 'No file selected';
  }
  if (stockFileNameLabel) {
    stockFileNameLabel.textContent = hasStock ? stockFileInput.files[0].name : 'No file selected';
  }

  if (uploadBtn) {
    uploadBtn.disabled = !(hasExport && hasStock);
  }
}

if (exportFileInput) exportFileInput.addEventListener('change', checkFilesSelected);
if (stockFileInput) stockFileInput.addEventListener('change', checkFilesSelected);

// 4. Handle Upload Form Submission (Export Items & Stock Detail Dual-File Processing)
uploadForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!exportFileInput || exportFileInput.files.length === 0 || !stockFileInput || stockFileInput.files.length === 0) {
    return;
  }
  
  uploadBtn.disabled = true;
  progressContainer.style.display = 'block';
  progressBar.style.width = '0%';
  progressText.textContent = 'Uploading & parsing workbooks: 0%';
  
  resultContainer.style.display = 'none';
  successAlert.style.display = 'none';
  failureAlert.style.display = 'none';
  reviewSection.style.display = 'none';
  
  const formData = new FormData();
  formData.append('exportItems', exportFileInput.files[0]);
  formData.append('stockDetail', stockFileInput.files[0]);
  
  try {
    const xhr = new XMLHttpRequest();
    
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        const percent = Math.round((event.loaded / event.total) * 90);
        progressBar.style.width = percent + '%';
        progressText.textContent = `Processing workbooks: ${percent}%`;
      }
    });
    
    xhr.addEventListener('load', async () => {
      progressBar.style.width = '100%';
      progressText.textContent = 'Finalizing reconciliation...';
      
      setTimeout(() => {
        progressContainer.style.display = 'none';
        uploadBtn.disabled = false;
      }, 400);
      
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch (pErr) {
        data = { success: false, message: 'Invalid server response.' };
      }
      
      if (xhr.status === 200 && data.success) {
        activeSessionId = data.sessionId;
        stagedWholesaleItems = data.wholesaleItems || [];
        stagedDuplicateConflicts = data.duplicateConflicts || [];
        stagedInactiveProducts = data.inactiveProducts || [];
        duplicateResolutions.clear();
        wholesaleUpdates.clear();
        
        // Populate KPIs
        const s = data.summary || {};
        if (kpiSourceRows) kpiSourceRows.textContent = Number(s.totalSourceRows || 0).toLocaleString();
        if (kpiBlankBarcodes) kpiBlankBarcodes.textContent = Number(s.blankBarcodesExcluded || 0).toLocaleString();
        if (kpiDuplicateBarcodes) kpiDuplicateBarcodes.textContent = Number(s.duplicateBarcodesCount || 0).toLocaleString();
        if (kpiValidCandidates) kpiValidCandidates.textContent = Number(s.validUniqueCandidates || 0).toLocaleString();
        if (kpiStockRows) kpiStockRows.textContent = Number(s.stockDetailNamedRows || 0).toLocaleString();
        if (kpiStockUnique) kpiStockUnique.textContent = Number(s.stockDetailUniqueNames || 0).toLocaleString();
        if (kpiActiveProducts) kpiActiveProducts.textContent = Number(s.activeProductCount || 0).toLocaleString();
        if (kpiInactiveProducts) kpiInactiveProducts.textContent = Number(s.inactiveProductCount || 0).toLocaleString();
        if (kpiTotalWholesale) kpiTotalWholesale.textContent = Number(s.totalWholesaleProducts || 0).toLocaleString();
        if (kpiMatchedWq) kpiMatchedWq.textContent = Number(s.matchedCount || 0).toLocaleString();
        if (kpiEditedWq) kpiEditedWq.textContent = '0';
        if (kpiMissingWq) kpiMissingWq.textContent = Number((s.missingCount || 0) + (s.ambiguousCount || 0)).toLocaleString();
        
        renderInactiveProductsSection();
        renderDuplicateConflicts();
        renderWholesaleReviewTable();
        validateWholesaleState();
        
        reviewSection.style.display = 'block';
        reviewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (xhr.status === 401 || xhr.status === 403) {
        localStorage.removeItem('admin_token');
        window.location.href = '/admin';
      } else {
        resultContainer.style.display = 'block';
        failureAlert.style.display = 'block';
        failureMsg.textContent = data.message || 'File processing rejected.';
      }
    });
    
    xhr.addEventListener('error', () => {
      progressContainer.style.display = 'none';
      uploadBtn.disabled = false;
      resultContainer.style.display = 'block';
      failureAlert.style.display = 'block';
      failureMsg.textContent = 'A network error occurred while uploading the files.';
    });
    
    xhr.open('POST', '/api/admin/upload-export-items');
    xhr.setRequestHeader('Authorization', 'Bearer ' + localStorage.getItem('admin_token'));
    xhr.send(formData);
    
  } catch (err) {
    progressContainer.style.display = 'none';
    uploadBtn.disabled = false;
    resultContainer.style.display = 'block';
    failureAlert.style.display = 'block';
    failureMsg.textContent = 'Upload submission failed.';
  }
});

// 4b. Render Excluded Inactive Products Section
function renderInactiveProductsSection() {
  if (!inactiveProductsCard || !inactiveTbody) return;
  if (!Array.isArray(stagedInactiveProducts) || stagedInactiveProducts.length === 0) {
    inactiveProductsCard.style.display = 'none';
    return;
  }

  inactiveProductsCard.style.display = 'block';
  if (inactiveCountBadge) inactiveCountBadge.textContent = stagedInactiveProducts.length.toLocaleString();

  inactiveTbody.innerHTML = '';
  stagedInactiveProducts.forEach(item => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--admin-border-soft)';
    const wpDisplay = (item.wholesalePrice !== null && item.wholesalePrice !== undefined && item.wholesalePrice > 0)
      ? `₹${Number(item.wholesalePrice).toFixed(2)}`
      : '-';

    tr.innerHTML = `
      <td style="padding: 6px 8px; font-family: monospace; font-size: 0.82rem;">${item.barcode}</td>
      <td style="padding: 6px 8px; font-weight: 500;">${item.name}</td>
      <td style="padding: 6px 8px; text-align: right; color: var(--admin-text-secondary);">₹${Number(item.mrp || 0).toFixed(2)}</td>
      <td style="padding: 6px 8px; text-align: right; font-weight: 600;">₹${Number(item.salePrice || 0).toFixed(2)}</td>
      <td style="padding: 6px 8px; text-align: right; color: var(--admin-brand);">${wpDisplay}</td>
      <td style="padding: 6px 8px; color: #fb923c; font-size: 0.78rem;">${item.reason || 'NOT FOUND IN STOCK DETAIL REPORT'}</td>
    `;
    inactiveTbody.appendChild(tr);
  });
}

if (toggleInactiveBtn && inactiveTableWrapper) {
  toggleInactiveBtn.addEventListener('click', () => {
    const isHidden = inactiveTableWrapper.style.display === 'none';
    inactiveTableWrapper.style.display = isHidden ? 'block' : 'none';
    toggleInactiveBtn.textContent = isHidden ? 'Hide List' : 'View Inactive Products';
  });
}

if (downloadInactiveBtn) {
  downloadInactiveBtn.addEventListener('click', async () => {
    if (!activeSessionId) return;
    try {
      const res = await authFetch(`/api/admin/export-inactive-products/${activeSessionId}`);
      if (res && res.status === 200) {
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `INACTIVE_PRODUCTS_${Date.now()}.xlsx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } catch (err) {
      console.error('Failed to download inactive products', err);
    }
  });
}

// 5. Render Conflicting Duplicate Barcodes Section
function renderDuplicateConflicts() {
  if (!duplicateConflictsCard || !duplicateConflictsContainer) return;
  duplicateConflictsContainer.innerHTML = '';

  if (!Array.isArray(stagedDuplicateConflicts) || stagedDuplicateConflicts.length === 0) {
    duplicateConflictsCard.style.display = 'none';
    return;
  }

  duplicateConflictsCard.style.display = 'block';

  let unresolvedCount = 0;
  stagedDuplicateConflicts.forEach(conflict => {
    if (!duplicateResolutions.has(conflict.barcode)) {
      unresolvedCount++;
    }
  });

  if (duplicateConflictBadge) {
    if (unresolvedCount > 0) {
      duplicateConflictBadge.className = 'badge badge-required';
      duplicateConflictBadge.textContent = `${unresolvedCount} Barcode(s) Unresolved`;
    } else {
      duplicateConflictBadge.className = 'badge badge-matched';
      duplicateConflictBadge.textContent = 'All Conflicts Resolved';
    }
  }

  stagedDuplicateConflicts.forEach((conflict, cIdx) => {
    const card = document.createElement('div');
    card.style.background = 'var(--admin-surface-2)';
    card.style.border = '1px solid var(--admin-border)';
    card.style.borderRadius = '6px';
    card.style.padding = '12px 14px';

    const resolution = duplicateResolutions.get(conflict.barcode);
    let statusText = '';
    if (!resolution) {
      statusText = '<span class="badge badge-required">Action Required: Select Row or Exclude</span>';
    } else if (resolution.action === 'SELECT') {
      const chosen = conflict.candidates.find(c => c.candidateId === resolution.candidateId);
      statusText = `<span class="badge badge-matched">✔ Row ${chosen ? chosen.rowNumber : ''} Selected</span>`;
    } else if (resolution.action === 'EXCLUDE') {
      statusText = '<span class="badge" style="background: rgba(168,176,188,0.15); color: var(--admin-text-secondary); border: 1px solid var(--admin-border);">✖ Barcode Excluded</span>';
    }

    let candidatesRowsHtml = '';
    conflict.candidates.forEach(cand => {
      const isSelected = resolution && resolution.action === 'SELECT' && resolution.candidateId === cand.candidateId;
      const wpDisplay = cand.wholesalePrice !== null && cand.wholesalePrice > 0 ? `₹${Number(cand.wholesalePrice).toFixed(2)}` : '-';

      candidatesRowsHtml += `
        <tr style="${isSelected ? 'background: rgba(34,197,94,0.12);' : ''}">
          <td style="text-align: center; width: 40px;">
            <input type="radio" name="dup_select_${conflict.barcode}" 
                   class="dup-candidate-radio" 
                   data-barcode="${conflict.barcode}" 
                   data-cand-id="${cand.candidateId}" 
                   ${isSelected ? 'checked' : ''}>
          </td>
          <td style="font-size: 0.82rem; color: var(--admin-text-secondary); width: 60px;">Row ${cand.rowNumber}</td>
          <td style="font-weight: 500;">${cand.name}</td>
          <td style="text-align: right; color: var(--admin-text-secondary); width: 80px;">₹${Number(cand.mrp).toFixed(2)}</td>
          <td style="text-align: right; font-weight: 600; width: 90px;">₹${Number(cand.salePrice).toFixed(2)}</td>
          <td style="text-align: right; color: var(--admin-brand); font-weight: 600; width: 110px;">${wpDisplay}</td>
        </tr>
      `;
    });

    const isExcluded = resolution && resolution.action === 'EXCLUDE';

    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 6px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-weight: 700; color: var(--admin-text); font-size: 0.95rem;">Barcode: <code style="color: var(--admin-info);">${conflict.barcode}</code></span>
          <span style="font-size: 0.8rem; color: var(--admin-text-muted);">(${conflict.candidates.length} conflicting occurrences in file)</span>
        </div>
        <div style="display: flex; align-items: center; gap: 10px;">
          ${statusText}
          <button type="button" class="btn btn-outline btn-sm dup-exclude-btn ${isExcluded ? 'active' : ''}" 
                  data-barcode="${conflict.barcode}" 
                  style="font-size: 0.75rem; padding: 2px 8px; ${isExcluded ? 'border-color: var(--admin-danger); color: var(--admin-danger);' : ''}">
            ${isExcluded ? 'Excluded' : 'Exclude Barcode'}
          </button>
        </div>
      </div>
      <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
        <thead>
          <tr style="border-bottom: 1px solid var(--admin-border-soft); color: var(--admin-text-muted); font-size: 0.75rem; text-transform: uppercase;">
            <th style="text-align: center; padding: 4px;">Pick</th>
            <th style="padding: 4px;">Source</th>
            <th style="padding: 4px;">Conflicting Product Name</th>
            <th style="text-align: right; padding: 4px;">MRP</th>
            <th style="text-align: right; padding: 4px;">Sale Price</th>
            <th style="text-align: right; padding: 4px;">Wholesale Price</th>
          </tr>
        </thead>
        <tbody>
          ${candidatesRowsHtml}
        </tbody>
      </table>
    `;

    duplicateConflictsContainer.appendChild(card);
  });

  // Attach radio listeners
  document.querySelectorAll('.dup-candidate-radio').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const barcode = e.target.getAttribute('data-barcode');
      const candidateId = e.target.getAttribute('data-cand-id');
      duplicateResolutions.set(barcode, { action: 'SELECT', candidateId });
      renderDuplicateConflicts();
      validateWholesaleState();
    });
  });

  // Attach exclude button listeners
  document.querySelectorAll('.dup-exclude-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const barcode = e.target.getAttribute('data-barcode');
      duplicateResolutions.set(barcode, { action: 'EXCLUDE' });
      renderDuplicateConflicts();
      validateWholesaleState();
    });
  });
}

// 6. Render Wholesale Review Table
function renderWholesaleReviewTable(filterQuery = '') {
  wholesaleTbody.innerHTML = '';
  const query = filterQuery.toLowerCase().trim();
  
  const filtered = stagedWholesaleItems.filter(item => {
    if (!query) return true;
    return item.name.toLowerCase().includes(query) || item.barcode.toLowerCase().includes(query);
  });
  
  if (filtered.length === 0) {
    wholesaleTbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted" style="padding: 24px;">No matching wholesale items found.</td></tr>';
    return;
  }
  
  filtered.forEach(item => {
    const tr = document.createElement('tr');
    
    // Determine current effective quantity
    let currentQty = item.wholesaleQty;
    const hasUpdate = wholesaleUpdates.has(item.normalizedName);
    if (hasUpdate) {
      currentQty = wholesaleUpdates.get(item.normalizedName).wholesaleQty;
    }
    
    const isRequired = item.status === 'REQUIRED';
    const isAmbiguous = item.status === 'AMBIGUOUS';
    const isUnresolved = (isRequired || isAmbiguous) && (!currentQty || currentQty < 1 || (!hasUpdate && isAmbiguous));
    
    if (isUnresolved) {
      tr.className = 'row-required';
    }
    
    let badgeHtml = '';
    if (isRequired) {
      badgeHtml = '<span class="badge-required">NEW — QUANTITY REQUIRED</span>';
    } else if (isAmbiguous) {
      badgeHtml = '<span class="badge-ambiguous">REVIEW — AMBIGUOUS MATCH</span>';
    } else {
      badgeHtml = '<span class="badge-matched">MATCHED — RETRIEVED</span>';
    }
    
    tr.innerHTML = `
      <td>${badgeHtml}</td>
      <td class="monospace" style="font-size: 0.85rem;">${item.barcode}</td>
      <td style="font-weight: 500;">${item.name}</td>
      <td style="text-align: right; color: var(--admin-text-secondary);">₹${Number(item.mrp).toFixed(2)}</td>
      <td style="text-align: right; font-weight: 600;">₹${Number(item.salePrice).toFixed(2)}</td>
      <td style="text-align: right; color: var(--admin-brand); font-weight: 700;">₹${Number(item.wholesalePrice).toFixed(2)}</td>
      <td style="text-align: center;">
        <input type="number" min="1" step="1" 
               class="wq-input ${isUnresolved ? 'invalid' : ''}" 
               data-norm="${item.normalizedName}" 
               data-name="${item.name}"
               value="${currentQty !== null && currentQty !== undefined ? currentQty : ''}" 
               placeholder="Min 1">
      </td>
    `;
    
    wholesaleTbody.appendChild(tr);
  });
  
  // Attach input listeners
  document.querySelectorAll('.wq-input').forEach(input => {
    input.addEventListener('input', (e) => {
      const norm = e.target.getAttribute('data-norm');
      const originalName = e.target.getAttribute('data-name');
      const valStr = e.target.value.trim();
      const valNum = parseInt(valStr, 10);
      
      if (!isNaN(valNum) && valNum >= 1) {
        wholesaleUpdates.set(norm, { originalName, normalizedName: norm, wholesaleQty: valNum });
        e.target.classList.remove('invalid');
        const parentTr = e.target.closest('tr');
        if (parentTr) parentTr.classList.remove('row-required');
      } else {
        wholesaleUpdates.delete(norm);
        e.target.classList.add('invalid');
        const parentTr = e.target.closest('tr');
        if (parentTr) parentTr.classList.add('row-required');
      }
      
      validateWholesaleState();
    });
  });
}

// 7. Validate Staging State & Toggle Publish Button
function validateWholesaleState() {
  let missingCount = 0;
  let ambiguousUnresolved = 0;
  let editedCount = 0;
  
  stagedWholesaleItems.forEach(item => {
    let effectiveQty = item.wholesaleQty;
    const hasUpdate = wholesaleUpdates.has(item.normalizedName);
    if (hasUpdate) {
      effectiveQty = wholesaleUpdates.get(item.normalizedName).wholesaleQty;
      editedCount++;
    }
    
    if (item.status === 'AMBIGUOUS' && !hasUpdate) {
      ambiguousUnresolved++;
      missingCount++;
    } else if (effectiveQty === null || effectiveQty === undefined || isNaN(effectiveQty) || effectiveQty < 1) {
      missingCount++;
    }
  });

  // Check unresolved duplicate conflicts
  let unresolvedDuplicates = 0;
  stagedDuplicateConflicts.forEach(c => {
    if (!duplicateResolutions.has(c.barcode)) {
      unresolvedDuplicates++;
    }
  });
  
  if (kpiEditedWq) kpiEditedWq.textContent = editedCount;
  if (kpiMissingWq) kpiMissingWq.textContent = missingCount;
  
  if (unresolvedDuplicates > 0) {
    missingAlertBox.style.display = 'block';
    missingAlertText.textContent = `Action Required: ${unresolvedDuplicates} conflicting duplicate barcode(s) must be selected or excluded before publication.`;
    publishBtn.disabled = true;
    publishBtn.textContent = `Resolve Duplicate Conflicts (${unresolvedDuplicates})`;
  } else if (missingCount > 0) {
    missingAlertBox.style.display = 'block';
    if (ambiguousUnresolved > 0) {
      missingAlertText.textContent = `Action Required: ${missingCount} wholesale item(s) require action (${ambiguousUnresolved} ambiguous match(es) and missing quantities) before publication.`;
    } else {
      missingAlertText.textContent = `Action Required: ${missingCount} wholesale product(s) require a valid quantity (min 1) before publication.`;
    }
    publishBtn.disabled = true;
    publishBtn.textContent = `Resolve Required Quantities (${missingCount})`;
  } else {
    missingAlertBox.style.display = 'none';
    publishBtn.disabled = false;
    publishBtn.textContent = 'Publish to PriceCheck';
  }
}

// Search filter in review table
if (reviewSearch) {
  reviewSearch.addEventListener('input', (e) => {
    renderWholesaleReviewTable(e.target.value);
  });
}

// 8. Download Compiled Excel Preview
downloadPreviewBtn.addEventListener('click', async () => {
  if (!activeSessionId) return;
  try {
    const res = await authFetch(`/api/admin/export-compiled-catalogue/${activeSessionId}`);
    if (res && res.status === 200) {
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `COMPILED_CATALOGUE_${Date.now()}.xlsx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  } catch (err) {
    console.error('Failed to download compiled Excel', err);
  }
});

// Cancel Review
cancelReviewBtn.addEventListener('click', () => {
  reviewSection.style.display = 'none';
  activeSessionId = null;
  stagedWholesaleItems = [];
  stagedDuplicateConflicts = [];
  stagedInactiveProducts = [];
  duplicateResolutions.clear();
  wholesaleUpdates.clear();
  if (exportFileInput) exportFileInput.value = '';
  if (exportFileNameLabel) exportFileNameLabel.textContent = 'No file selected';
  if (stockFileInput) stockFileInput.value = '';
  if (stockFileNameLabel) stockFileNameLabel.textContent = 'No file selected';
  if (uploadBtn) uploadBtn.disabled = true;
  if (inactiveProductsCard) inactiveProductsCard.style.display = 'none';
});

// 9. Publish Modal Controls
publishBtn.addEventListener('click', () => {
  if (publishBtn.disabled || !activeSessionId) return;
  
  modalProductsCount.textContent = kpiActiveProducts ? kpiActiveProducts.textContent : (kpiValidProducts ? kpiValidProducts.textContent : '0');
  modalWholesaleCount.textContent = kpiTotalWholesale ? kpiTotalWholesale.textContent : '0';
  modalUpdatesCount.textContent = wholesaleUpdates.size;
  
  publishModal.style.display = 'flex';
});

modalCancelBtn.addEventListener('click', () => {
  publishModal.style.display = 'none';
});

// 10. Confirm Publication Execution
modalConfirmBtn.addEventListener('click', async () => {
  if (!activeSessionId) return;
  
  modalConfirmBtn.disabled = true;
  modalConfirmBtn.textContent = 'Publishing...';
  
  const updatesArray = Array.from(wholesaleUpdates.values());
  const resolutionsArray = [];
  duplicateResolutions.forEach((res, barcode) => {
    resolutionsArray.push({ barcode, ...res });
  });
  
  try {
    const res = await authFetch('/api/admin/publish-catalogue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: activeSessionId,
        wholesaleUpdates: updatesArray,
        duplicateResolutions: resolutionsArray
      })
    });
    
    publishModal.style.display = 'none';
    modalConfirmBtn.disabled = false;
    modalConfirmBtn.textContent = 'Confirm & Publish';
    
    if (res && res.status === 200) {
      const data = await res.json();
      reviewSection.style.display = 'none';
      
      resultContainer.style.display = 'block';
      successAlert.style.display = 'block';
      document.getElementById('res-total').textContent = Number(data.activeProducts || data.totalProducts || 0).toLocaleString();
      if (document.getElementById('res-inactive')) {
        document.getElementById('res-inactive').textContent = Number(data.inactiveProducts || 0).toLocaleString();
      }
      document.getElementById('res-wholesale').textContent = Number(data.totalWholesaleProducts || 0).toLocaleString();
      document.getElementById('res-wq-saved').textContent = Number(data.wholesaleSaved || 0).toLocaleString();
      document.getElementById('res-time').textContent = data.processingTimeMs || 0;
      document.getElementById('res-version').textContent = data.catalogVersion || 'N/A';
      
      // Reset upload form
      if (exportFileInput) exportFileInput.value = '';
      if (exportFileNameLabel) exportFileNameLabel.textContent = 'No file selected';
      if (stockFileInput) stockFileInput.value = '';
      if (stockFileNameLabel) stockFileNameLabel.textContent = 'No file selected';
      if (uploadBtn) uploadBtn.disabled = true;
      activeSessionId = null;
      stagedWholesaleItems = [];
      stagedDuplicateConflicts = [];
      stagedInactiveProducts = [];
      duplicateResolutions.clear();
      wholesaleUpdates.clear();
      if (inactiveProductsCard) inactiveProductsCard.style.display = 'none';
      
      // Refresh status panel & inline history
      updateStatusPanel();
      loadHistory();
      
      resultContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      const errData = await res.json();
      resultContainer.style.display = 'block';
      failureAlert.style.display = 'block';
      failureMsg.textContent = errData.message || 'Catalogue publication failed.';
    }
  } catch (err) {
    publishModal.style.display = 'none';
    modalConfirmBtn.disabled = false;
    modalConfirmBtn.textContent = 'Confirm & Publish';
    resultContainer.style.display = 'block';
    failureAlert.style.display = 'block';
    failureMsg.textContent = 'Publication network request failed.';
  }
});

// Logout
if (logoutBtn) {
  logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('admin_token');
    localStorage.removeItem('admin_username');
    window.location.href = '/admin';
  });
}

// Initial page load
updateStatusPanel();
loadHistory();
