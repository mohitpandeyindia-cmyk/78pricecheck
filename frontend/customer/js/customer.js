// customer.js
const startScanBtn = document.getElementById('start-scan-btn');
const welcomeView = document.getElementById('welcome-view');
const scannerView = document.getElementById('scanner-view');
const backBtn = document.getElementById('back-btn');

const resultPanel = document.getElementById('result-panel');
const scanFeedback = document.getElementById('scan-feedback');
const recentScansList = document.getElementById('recent-scans-list');

// Pricing Result States
const states = {
  idle: document.getElementById('state-idle'),
  loading: document.getElementById('state-loading'),
  single: document.getElementById('state-single'),
  multiple: document.getElementById('state-multiple'),
  notFound: document.getElementById('state-not-found'),
  cameraDenied: document.getElementById('state-camera-denied'),
  cameraUnavailable: document.getElementById('state-camera-unavailable'),
  networkError: document.getElementById('state-network-error'),
  serverError: document.getElementById('state-server-error')
};

let html5QrcodeScanner = null;
let lastScannedBarcode = null;
let lastScanTime = 0;
let recentScans = [];
let currentRecoveryBarcode = null;
let cameraPermissionGranted = false;

// Query browser camera permission state on load
if (navigator.permissions && navigator.permissions.query) {
  navigator.permissions.query({ name: 'camera' }).then(permissionStatus => {
    console.log('Initial camera permission state:', permissionStatus.state);
    if (permissionStatus.state === 'granted') {
      cameraPermissionGranted = true;
    }
    permissionStatus.onchange = () => {
      cameraPermissionGranted = (permissionStatus.state === 'granted');
      console.log('Camera permission state changed to:', permissionStatus.state);
    };
  }).catch(err => {
    console.warn('Camera permission query not supported in this browser', err);
  });
}

// Initialize Session History from LocalStorage
try {
  const cached = localStorage.getItem('recent_scans');
  if (cached) {
    recentScans = JSON.parse(cached);
    renderRecentScans();
  }
} catch (e) {
  console.warn('Failed to load cached scan history', e);
}

// State display helper
function showState(activeStateKey) {
  Object.keys(states).forEach(key => {
    if (key === activeStateKey) {
      states[key].style.display = 'flex';
    } else {
      states[key].style.display = 'none';
    }
  });
}

// Synthesize short high-frequency beep on successful decodes
function playSuccessBeep() {
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    
    oscillator.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    
    oscillator.type = 'sine';
    oscillator.frequency.value = 2000; // High-frequency tone
    gainNode.gain.setValueAtTime(0.08, audioCtx.currentTime);
    
    oscillator.start();
    oscillator.stop(audioCtx.currentTime + 0.08); // 80ms duration
  } catch (e) {
    console.warn('Audio Context tone synthesis block:', e);
  }
}

// Trigger haptic vibration on successful scans
function triggerHapticVibrate() {
  if (navigator.vibrate) {
    navigator.vibrate(80); // 80ms vibration pulse
  }
}

// Trigger border-flash visual highlight effect when rendering a new product card
function applyCardHighlight() {
  const detailsCard = document.getElementById('details-card');
  if (detailsCard) {
    detailsCard.classList.remove('pulse-highlight');
    detailsCard.classList.add('scanned');
    void detailsCard.offsetWidth; // Force CSS repaint reflow
    detailsCard.classList.add('pulse-highlight');
    setTimeout(() => {
      detailsCard.classList.remove('scanned');
    }, 300);
  }
}

// Reset barcode expand/collapse state to default collapsed
function resetBarcodeCollapse() {
  const singleBarcodeArea = document.getElementById('single-barcode-area');
  const toggle = document.getElementById('single-barcode-toggle');
  if (singleBarcodeArea && toggle) {
    singleBarcodeArea.classList.remove('expanded');
    const chevron = toggle.querySelector('.barcode-toggle-chevron');
    if (chevron) {
      chevron.classList.remove('expanded');
      chevron.textContent = '▼';
    }
  }
}

// Flash small "Price Updated" success confirmation indicator
function triggerFeedbackPopup() {
  if (scanFeedback) {
    scanFeedback.classList.add('visible');
    setTimeout(() => {
      scanFeedback.classList.remove('visible');
    }, 300);
  }
}

// Add a newly verified item to session history
function addToHistory(product) {
  // Check for duplicates in history, move to top if present
  recentScans = recentScans.filter(item => item.barcode !== product.barcode);
  
  recentScans.unshift({
    name: product.name,
    barcode: product.barcode,
    salePrice: product.salePrice,
    mrp: product.mrp,
    wholesalePrice: product.wholesalePrice,
    wholesaleQty: product.wholesaleQty,
    scannedAt: Date.now()
  });
  
  // Limit cache history list to 5 items
  if (recentScans.length > 5) {
    recentScans.pop();
  }
  
  try {
    localStorage.setItem('recent_scans', JSON.stringify(recentScans));
  } catch (e) {
    console.warn('Failed to save scan history to localStorage', e);
  }
  
  renderRecentScans();
}

// Sturdier render RecentScans stub
function renderRecentScans() {
  // Chips rendering is deprecated, history is now displayed inside the slide-up bottom sheet
}

// Format double values into localized currency
function formatCurrency(val) {
  if (val === undefined || val === null) return 'N/A';
  return '₹' + Number(val).toFixed(2);
}

// Fetch pricing values from endpoint
async function lookupBarcode(barcode) {
  currentRecoveryBarcode = barcode;
  showState('loading');
  
  try {
    const response = await fetch(`/api/products/lookup/${barcode}`);
    
    if (response.status === 200) {
      const data = await response.json();
      applyCardHighlight();
      
      if (data.multipleMatches && data.products.length > 1) {
        // Render scrollable multiple matches grid
        showState('multiple');
        const listContainer = document.getElementById('multi-list');
        listContainer.innerHTML = '';
        
        data.products.forEach(p => {
          const card = document.createElement('div');
          card.className = 'multi-item-card';
          
          let bulkHtml = '';
          if (p.wholesalePrice !== undefined && p.wholesalePrice !== null && p.wholesaleQty !== undefined && p.wholesaleQty !== null) {
            const savings = Number(p.salePrice) - Number(p.wholesalePrice);
            bulkHtml = `
              <div class="bulk-offer-panel" style="margin-top: 8px; padding: 10px; border-radius: 10px; font-size: 0.8rem; grid-template-columns: 1fr auto 1fr;">
                <div class="bulk-left-col">
                  <div class="bulk-title" style="font-size: 0.75rem;">BULK OFFER</div>
                  <div class="bulk-subtitle" style="font-size: 0.7rem;">Buy ${p.wholesaleQty}+</div>
                </div>
                <div class="bulk-divider-dashed" style="height: 32px;"></div>
                <div class="bulk-right-col">
                  <div class="bulk-price" style="font-size: 1rem;">${formatCurrency(p.wholesalePrice)} each</div>
                  <div class="bulk-savings-pill" style="font-size: 0.65rem; padding: 1px 6px;">Save ${formatCurrency(savings)}</div>
                </div>
              </div>
            `;
          }

          card.innerHTML = `
            <div class="multi-item-name">${p.name}</div>
            <div class="multi-barcode-badge monospace">${p.barcode}</div>
            <div class="multi-pricing-container">
              <div class="multi-mrp-row">
                <span class="multi-mrp-label-inline">MRP:</span>
                <span class="multi-mrp-val">${formatCurrency(p.mrp)}</span>
              </div>
              <div class="multi-price-block">
                <span class="multi-price-label">Today's Price</span>
                <span class="multi-price-val">${formatCurrency(p.salePrice)}</span>
              </div>
              ${bulkHtml}
            </div>
          `;
          
          // Clicking item adds it to session history
          card.addEventListener('click', () => {
            addToHistory(p);
            
            // Set product title row collapse status
            resetBarcodeCollapse();

            showState('single');
            document.getElementById('single-name').textContent = p.name;
            document.getElementById('single-barcode').textContent = p.barcode;
            document.getElementById('single-sale-price').textContent = formatCurrency(p.salePrice);
            document.getElementById('single-mrp').textContent = formatCurrency(p.mrp);
            
            const bulkContainer = document.getElementById('single-bulk-container');
            if (p.wholesalePrice !== undefined && p.wholesalePrice !== null && p.wholesaleQty !== undefined && p.wholesaleQty !== null) {
              document.getElementById('single-bulk-qty').textContent = `Buy ${p.wholesaleQty} or more`;
              document.getElementById('single-bulk-price').textContent = `${formatCurrency(p.wholesalePrice)} each`;
              const savings = (Number(p.salePrice) - Number(p.wholesalePrice)) * Number(p.wholesaleQty);
              document.getElementById('single-bulk-savings').textContent = 'Save ' + formatCurrency(savings).replace('.00', '');
              bulkContainer.style.display = 'flex';
            } else {
              bulkContainer.style.display = 'none';
            }
            
            applyCardHighlight();
          });
          
          listContainer.appendChild(card);
        });
        
        // Auto-add first match to history logs
        addToHistory(data.products[0]);
      } else if (data.products && data.products.length > 0) {
        // Render single product details card
        const p = data.products[0];
        
        // Set product title row collapse status
        resetBarcodeCollapse();

        showState('single');
        document.getElementById('single-name').textContent = p.name;
        document.getElementById('single-barcode').textContent = p.barcode;
        document.getElementById('single-sale-price').textContent = formatCurrency(p.salePrice);
        document.getElementById('single-mrp').textContent = formatCurrency(p.mrp);
        
        const bulkContainer = document.getElementById('single-bulk-container');
        if (p.wholesalePrice !== undefined && p.wholesalePrice !== null && p.wholesaleQty !== undefined && p.wholesaleQty !== null) {
          document.getElementById('single-bulk-qty').textContent = `Buy ${p.wholesaleQty} or more`;
          document.getElementById('single-bulk-price').textContent = `${formatCurrency(p.wholesalePrice)} each`;
          const savings = (Number(p.salePrice) - Number(p.wholesalePrice)) * Number(p.wholesaleQty);
          document.getElementById('single-bulk-savings').textContent = 'Save ' + formatCurrency(savings).replace('.00', '');
          bulkContainer.style.display = 'flex';
        } else {
          bulkContainer.style.display = 'none';
        }
        
        addToHistory(p);
      } else {
        showState('notFound');
      }
    } else if (response.status === 404) {
      showState('notFound');
    } else {
      // Trigger server failure recovery screen
      showState('serverError');
    }
  } catch (err) {
    // Trigger network failure recovery screen
    showState('networkError');
    
    // Automatically attempt background lookup reconnects every 3 seconds
    setTimeout(() => {
      const activeStateVisible = states.networkError.style.display === 'flex';
      if (activeStateVisible && currentRecoveryBarcode === barcode) {
        lookupBarcode(barcode);
      }
    }, 3000);
  }
}

// Start camera scan stream
// Start camera scan stream
function startCameraScanner() {
  console.log('[Camera Debug] Scan button clicked');
  console.log('[Camera Debug] Camera initialization started');
  
  showState('idle');
  lastScannedBarcode = null;
  lastScanTime = 0;

  // Clear previous debug details if any
  const oldDebugs = document.querySelectorAll('.error-debug-details');
  oldDebugs.forEach(el => el.remove());

  // 1. Log window.isSecureContext and navigator.mediaDevices diagnostics
  console.log('[Camera Debug] window.isSecureContext:', window.isSecureContext);
  console.log('[Camera Debug] navigator.mediaDevices:', !!navigator.mediaDevices);
  if (navigator.mediaDevices) {
    console.log('[Camera Debug] navigator.mediaDevices.getUserMedia:', !!navigator.mediaDevices.getUserMedia);
  }

  // 2. Check for Insecure Context / Missing MediaDevices (HTTP block)
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error('[Camera Debug] Secure context validation failed.');
    showState('cameraUnavailable');
    const retryBtn = document.getElementById('retry-camera-unavailable-btn');
    if (retryBtn) retryBtn.style.display = 'none';
    const desc = states.cameraUnavailable.querySelector('.error-desc');
    if (desc) {
      desc.innerHTML = 'WebRTC camera access requires a <strong>Secure Context (HTTPS)</strong>.<br><br>' +
        'Mobile web browsers block camera access on plain HTTP connections.<br><br>' +
        '<strong>To fix this:</strong><br>' +
        '1. Deploy the server behind an HTTPS reverse proxy (e.g. Certbot/Nginx/Caddy).<br>' +
        '2. For local network testing on Android, open Chrome, go to <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>, add your server URL (e.g. <code>http://192.168.x.x:8080</code>), enable, and restart Chrome.';
    }
    return;
  }

  // 3. Query and Log Camera Permission State asynchronously (keeps thread synchronous)
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: 'camera' })
      .then(perm => {
        console.log('[Camera Debug] Camera permission state:', perm.state);
        // If state is already explicitly denied, trigger error guide
        if (perm.state === 'denied') {
          logAndShowDeniedError(new Error('Permission denied by browser settings (Permissions API reported denied).'));
        }
      })
      .catch(permErr => {
        console.warn('[Camera Debug] Failed to query camera permission state:', permErr.message || permErr);
      });
  }

  // 4. Request camera stream via native getUserMedia (must run synchronously in event thread for iOS Safari!)
  console.log('[Camera Debug] Requesting native camera permission prompt via getUserMedia...');
  navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    .then(stream => {
      console.log('[Camera Debug] getUserMedia() succeeded with environment constraints.');
      handleCameraStreamSuccess(stream);
    })
    .catch(err => {
      console.warn('[Camera Debug] getUserMedia() with environment constraints failed:', err.message || err);
      console.log('[Camera Debug] Retrying getUserMedia() with fallback constraints...');
      navigator.mediaDevices.getUserMedia({ video: true })
        .then(stream => {
          console.log('[Camera Debug] getUserMedia() succeeded with fallback constraints.');
          handleCameraStreamSuccess(stream);
        })
        .catch(fallbackErr => {
          console.error('[Camera Debug] getUserMedia() failed entirely:', fallbackErr.message || fallbackErr);
          logAndShowDeniedError(fallbackErr);
        });
    });
}

// Handle native stream authorization success
function handleCameraStreamSuccess(nativeStream) {
  // Stop native tracks immediately to free hardware context before initializing the library
  if (nativeStream) {
    try {
      nativeStream.getTracks().forEach(track => track.stop());
      console.log('[Camera Debug] Native temporary stream stopped successfully.');
    } catch (stopErr) {
      console.warn('[Camera Debug] Failed to stop native temporary stream:', stopErr);
    }
  }

  // Log available devices, then start scanner
  navigator.mediaDevices.enumerateDevices()
    .then(devices => {
      const cameras = devices.filter(d => d.kind === 'videoinput');
      console.log(`[Camera Debug] Available camera devices (${cameras.length}):`);
      cameras.forEach((c, idx) => {
        console.log(`  - [${idx}] ID: ${c.deviceId || 'empty'}, Label: "${c.label || 'no label'}"`);
      });
      startScannerLibrary();
    })
    .catch(enumErr => {
      console.warn('[Camera Debug] Failed to enumerate devices:', enumErr.message || enumErr);
      startScannerLibrary();
    });
}

// Start html5-qrcode scanner loop
function startScannerLibrary() {
  if (!html5QrcodeScanner) {
    html5QrcodeScanner = new Html5Qrcode("reader");
  }

  const config = {
    fps: 10,
    qrbox: (width, height) => {
      return { width: Math.round(width * 0.8), height: Math.round(height * 0.45) };
    }
  };

  console.log('[Camera Debug] Html5Qrcode.start() called with facingMode: "environment"');
  html5QrcodeScanner.start(
    { facingMode: "environment" },
    config,
    onBarcodeDecoded,
    onBarcodeScanError
  ).then(() => {
    console.log('[Camera Debug] Html5Qrcode.start() succeeded with environment constraints.');
  }).catch(err => {
    console.warn('[Camera Debug] Html5Qrcode.start() with environment constraints failed:', err.message || err);
    
    console.log('[Camera Debug] Retrying Html5Qrcode.start() with default fallback constraints {}');
    html5QrcodeScanner.start(
      {},
      config,
      onBarcodeDecoded,
      onBarcodeScanError
    ).then(() => {
      console.log('[Camera Debug] Html5Qrcode.start() fallback succeeded.');
    }).catch(fallbackErr => {
      console.error('[Camera Debug] Html5Qrcode.start() fallback failed:', fallbackErr.message || fallbackErr);
      logAndShowDeniedError(fallbackErr);
    });
  });
}

// Unified error handler displaying Chrome permission instructions & raw developer console details
function logAndShowDeniedError(err) {
  const errName = err ? err.name : 'UnknownError';
  const errMsg = err ? (err.message || String(err)) : 'Unknown camera access exception.';
  const fullErrorString = `${errName}: ${errMsg}`;
  
  console.error('[Camera Debug] Camera initialization exception:', fullErrorString);

  const isPermissionDenied = 
    errName === 'NotAllowedError' || 
    errName === 'PermissionDeniedError' || 
    errMsg.toLowerCase().includes('permission') || 
    errMsg.toLowerCase().includes('notallowed');

  if (isPermissionDenied) {
    showState('cameraDenied');
    const desc = states.cameraDenied.querySelector('.error-desc');
    if (desc) {
      desc.innerHTML = 'Camera permission is blocked or denied.<br><br>' +
        '<strong>To allow access:</strong><br>' +
        '1. Tap the lock icon (🔒) or settings icon in your Chrome address bar.<br>' +
        '2. Select <strong>"Site settings"</strong>.<br>' +
        '3. Locate <strong>"Camera"</strong> and change it to <strong>"Allow"</strong>, then reload the page.';
    }
    appendDebugInfo(states.cameraDenied, fullErrorString);
  } else {
    showState('cameraUnavailable');
    const desc = states.cameraUnavailable.querySelector('.error-desc');
    if (desc) {
      desc.textContent = 'Unable to open camera hardware stream. Please check camera connections or restart browser.';
    }
    appendDebugInfo(states.cameraUnavailable, fullErrorString);
  }
}

// Append exact exception details on card
function appendDebugInfo(container, errText) {
  const div = document.createElement('div');
  div.className = 'error-debug-details';
  div.style.cssText = 'font-family: monospace; font-size: 0.75rem; margin-top: 15px; color: #721c24; background-color: #f8d7da; border: 1px solid #f5c2c7; padding: 10px; border-radius: 6px; word-break: break-all; text-align: left; width: 100%;';
  div.innerHTML = `<strong>Developer Exception:</strong><br>${errText}`;
  container.appendChild(div);
}

// Handler functions
function onBarcodeDecoded(decodedText) {
  const now = Date.now();
  if (decodedText === lastScannedBarcode && (now - lastScanTime) < 2000) {
    return;
  }
  lastScannedBarcode = decodedText;
  lastScanTime = now;
  triggerFeedbackPopup();
  triggerHapticVibrate();
  playSuccessBeep();
  lookupBarcode(decodedText);
}

function onBarcodeScanError(errorMessage) {
  // Suppress logs
}

// Stop camera scan stream
function stopCameraScanner() {
  if (html5QrcodeScanner && html5QrcodeScanner.isScanning) {
    html5QrcodeScanner.stop().then(() => {
      console.log('Camera stream stopped successfully.');
    }).catch(err => {
      console.warn('Failed to stop camera stream:', err);
    });
  }
}

// UI Triggers & SPA screen toggles
startScanBtn.addEventListener('click', () => {
  welcomeView.style.display = 'none';
  scannerView.style.display = 'flex';
  startCameraScanner();
});

backBtn.addEventListener('click', () => {
  stopCameraScanner();
  scannerView.style.display = 'none';
  welcomeView.style.display = 'flex';
});

// Brand Header Home navigation
const headerBrandBtn = document.getElementById('header-brand-btn');
if (headerBrandBtn) {
  headerBrandBtn.addEventListener('click', () => {
    stopCameraScanner();
    scannerView.style.display = 'none';
    welcomeView.style.display = 'flex';
  });
}

// Collapsible barcode details click binder
const singleBarcodeToggle = document.getElementById('single-barcode-toggle');
if (singleBarcodeToggle) {
  singleBarcodeToggle.addEventListener('click', () => {
    const singleBarcodeArea = document.getElementById('single-barcode-area');
    const chevron = singleBarcodeToggle.querySelector('.barcode-toggle-chevron');
    if (singleBarcodeArea && chevron) {
      const isExpanded = singleBarcodeArea.classList.toggle('expanded');
      chevron.classList.toggle('expanded');
      chevron.textContent = isExpanded ? '▲' : '▼';
    }
  });
}

// Bottom Sheet slide-up controls
const openHistoryBtn = document.getElementById('open-history-btn');
const closeHistoryBtn = document.getElementById('close-history-btn');
const historySheet = document.getElementById('history-sheet');
const historySheetOverlay = document.getElementById('history-sheet-overlay');

if (openHistoryBtn && historySheet && historySheetOverlay) {
  openHistoryBtn.addEventListener('click', () => {
    renderRecentScansBottomSheet();
    historySheetOverlay.style.display = 'block';
    historySheet.style.display = 'flex';
    setTimeout(() => {
      historySheet.style.transform = 'translate(-50%, 0)';
    }, 10);
  });
}

function closeHistorySheet() {
  if (historySheet && historySheetOverlay) {
    historySheet.style.transform = 'translate(-50%, 100%)';
    setTimeout(() => {
      historySheet.style.display = 'none';
      historySheetOverlay.style.display = 'none';
    }, 300);
  }
}

if (closeHistoryBtn) {
  closeHistoryBtn.addEventListener('click', closeHistorySheet);
}
if (historySheetOverlay) {
  historySheetOverlay.addEventListener('click', closeHistorySheet);
}

// Render dynamic recent scans rows in the slide-up bottom sheet
function renderRecentScansBottomSheet() {
  const listContainer = document.getElementById('sheet-list-container');
  if (!listContainer) return;
  listContainer.innerHTML = '';
  
  if (recentScans.length === 0) {
    listContainer.innerHTML = '<span class="history-empty text-muted" style="text-align: center; display: block; padding: 20px;">No items scanned yet in this session.</span>';
    return;
  }

  // Display maximum 2 items only
  const displayItems = recentScans.slice(0, 2);

  displayItems.forEach((item, index) => {
    const itemDiv = document.createElement('div');
    itemDiv.className = 'sheet-item';
    
    // Relative timestamp calculation
    let timeString = 'Just now';
    if (item.scannedAt) {
      const diff = Math.floor((Date.now() - item.scannedAt) / 1000);
      if (diff < 60) {
        timeString = 'Just now';
      } else {
        const mins = Math.floor(diff / 60);
        timeString = `${mins} min ago`;
      }
    } else {
      timeString = index === 0 ? 'Just now' : '2 min ago';
    }

    itemDiv.innerHTML = `
      <div class="sheet-thumb-placeholder">🛒</div>
      <div class="sheet-item-middle">
        <span class="sheet-item-name">${item.name}</span>
        <div class="sheet-item-price-time">
          <span class="sheet-item-price">${formatCurrency(item.salePrice)}</span>
          <span class="sheet-item-time">${timeString}</span>
        </div>
      </div>
      <span class="sheet-item-chevron">&gt;</span>
    `;

    itemDiv.addEventListener('click', () => {
      closeHistorySheet();
      
      // Reset product title row collapse status
      resetBarcodeCollapse();

      showState('single');
      document.getElementById('single-name').textContent = item.name;
      document.getElementById('single-barcode').textContent = item.barcode;
      document.getElementById('single-sale-price').textContent = formatCurrency(item.salePrice);
      document.getElementById('single-mrp').textContent = formatCurrency(item.mrp);
      
      const bulkContainer = document.getElementById('single-bulk-container');
      if (item.wholesalePrice !== undefined && item.wholesalePrice !== null && item.wholesaleQty !== undefined && item.wholesaleQty !== null) {
        document.getElementById('single-bulk-qty').textContent = `Buy ${item.wholesaleQty} or more`;
        document.getElementById('single-bulk-price').textContent = `${formatCurrency(item.wholesalePrice)} each`;
        const savings = (Number(item.salePrice) - Number(item.wholesalePrice)) * Number(item.wholesaleQty);
        document.getElementById('single-bulk-savings').textContent = 'Save ' + formatCurrency(savings).replace('.00', '');
        bulkContainer.style.display = 'flex';
      } else {
        bulkContainer.style.display = 'none';
      }
      
      applyCardHighlight();
    });

    listContainer.appendChild(itemDiv);

    if (index < displayItems.length - 1) {
      const div = document.createElement('div');
      div.className = 'sheet-item-divider';
      listContainer.appendChild(div);
    }
  });
}

document.getElementById('retry-camera-denied-btn').addEventListener('click', () => {
  startCameraScanner();
});

document.getElementById('retry-camera-unavailable-btn').addEventListener('click', () => {
  startCameraScanner();
});

document.getElementById('retry-network-btn').addEventListener('click', () => {
  if (currentRecoveryBarcode) {
    lookupBarcode(currentRecoveryBarcode);
  }
});

document.getElementById('retry-server-btn').addEventListener('click', () => {
  if (currentRecoveryBarcode) {
    lookupBarcode(currentRecoveryBarcode);
  }
});
