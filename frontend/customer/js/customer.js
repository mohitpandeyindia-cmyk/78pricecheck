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
let lastScannedBarcode = ""; // Prevent repeated lookups of same item
let lastScanTime = 0;
let lastSeenTime = 0; // Track when current barcode was last seen in viewport
let lastDetectedBarcode = ""; // Track consecutive frame detections
let firstDetectedTime = 0; // Timestamp of first detection frame
let detectionCount = 0; // Counter for stability
let isScanPaused = false; // Throttling scanner
let lookupInProgress = false; // Concurrency lock
let isCameraRunning = false; // Recovery track
let recentScans = [];
let currentRecoveryBarcode = null;
let cameraPermissionGranted = false;

// Dev-mode performance metrics and overlay variables
const DEBUG_MODE = 
  window.location.hostname === 'localhost' || 
  window.location.hostname === '127.0.0.1' || 
  window.location.hostname.startsWith('192.168.') || 
  window.location.hostname.startsWith('10.') || 
  window.location.hostname.startsWith('172.');
let cameraStartTime = 0;
let firstDecodeTime = 0;
let lastApiDuration = 0;
let lastRenderDuration = 0;
let cameraInitDuration = 0;
let frameCount = 0;
let lastFpsCalculationTime = Date.now();
let currentFps = 0;
let ambientLightInterval = null;

// Scan Lock background cleaner: resets barcode lock if absent for 2 seconds
setInterval(() => {
  if (lastScannedBarcode && Date.now() - lastSeenTime > 2000) {
    if (DEBUG_MODE) console.log(`[DEBUG] Scan lock on barcode ${lastScannedBarcode} cleared after 2.0s of absence.`);
    lastScannedBarcode = "";
  }
}, 500);

// Query browser camera permission state on load safely
try {
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
} catch (err) {
  console.warn('Synchronous camera permission query failed or not supported:', err);
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

// FPS frame counting tracker
function registerFrameForFps() {
  frameCount++;
  const now = Date.now();
  const elapsed = now - lastFpsCalculationTime;
  if (elapsed >= 1000) {
    currentFps = Math.round((frameCount * 1000) / elapsed);
    frameCount = 0;
    lastFpsCalculationTime = now;
    updateDebugOverlay();
  }
}

// Development-only metrics card overlay (Milestone 6.2)
function updateDebugOverlay() {
  const overlay = document.getElementById('debug-overlay');
  if (!overlay) return;

  if (!DEBUG_MODE) {
    overlay.style.display = 'none';
    return;
  }

  overlay.style.display = 'block';

  const camStart = cameraInitDuration > 0 ? `${cameraInitDuration} ms` : '-';
  const firstDec = firstDecodeTime > 0 ? `${firstDecodeTime - cameraStartTime} ms` : '-';
  const apiTime = lastApiDuration > 0 ? `${lastApiDuration} ms` : '-';
  const renderTime = lastRenderDuration > 0 ? `${lastRenderDuration} ms` : '-';

  // Retrieve active stream resolution
  let resStr = '-';
  const video = document.querySelector('#reader video');
  if (video) {
    resStr = `${video.videoWidth}×${video.videoHeight}`;
  }

  overlay.innerHTML = `
    Camera Start: ${camStart}<br>
    First Decode: ${firstDec}<br>
    API: ${apiTime}<br>
    Render: ${renderTime}<br>
    FPS: ${currentFps}<br>
    Resolution: ${resStr}
  `;
}

// Canvas-based ambient light analyzer loop
function startAmbientLightDetection() {
  if (ambientLightInterval) clearInterval(ambientLightInterval);

  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 12;
  const ctx = canvas.getContext('2d');

  ambientLightInterval = setInterval(() => {
    const video = document.querySelector('#reader video');
    if (video && video.readyState >= 2) { // HAVE_CURRENT_DATA or higher
      try {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imgData.data;

        let totalLuminance = 0;
        const len = data.length;
        for (let i = 0; i < len; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          // Standard luminance weights
          const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
          totalLuminance += luminance;
        }

        const avgLuminance = totalLuminance / (canvas.width * canvas.height);
        const suggestion = document.getElementById('low-light-suggestion');
        if (suggestion) {
          if (avgLuminance < 45) {
            suggestion.style.display = 'block';
          } else {
            suggestion.style.display = 'none';
          }
        }
      } catch (err) {
        // Suppress canvas security restrictions if any
      }
    }
  }, 1000);
}

function stopAmbientLightDetection() {
  if (ambientLightInterval) {
    clearInterval(ambientLightInterval);
    ambientLightInterval = null;
  }
  const suggestion = document.getElementById('low-light-suggestion');
  if (suggestion) suggestion.style.display = 'none';
}

// Future-ready Torch / Flashlight track controls
window.setScannerTorch = async function(enabled) {
  const video = document.querySelector('#reader video');
  if (video && video.srcObject) {
    const track = video.srcObject.getVideoTracks()[0];
    if (track && typeof track.getCapabilities === 'function') {
      try {
        const capabilities = track.getCapabilities();
        if (capabilities.torch) {
          await track.applyConstraints({
            advanced: [{ torch: enabled }]
          });
          if (DEBUG_MODE) console.log(`[DEBUG] Torch successfully set to: ${enabled}`);
          return true;
        } else {
          if (DEBUG_MODE) console.log('[DEBUG] Torch capability is not supported on this track.');
        }
      } catch (err) {
        console.warn('Failed to apply torch constraints:', err);
      }
    }
  }
  return false;
};

// Stop scanner without clearing active state trace
async function stopCameraScannerSilent() {
  if (html5QrcodeScanner) {
    try {
      if (html5QrcodeScanner.isScanning) {
        await html5QrcodeScanner.stop();
      }
    } catch (err) {
      console.warn('Failed to stop camera silently:', err);
    }
  }
  stopAmbientLightDetection();
}

// Page Visibility API camera auto-recovery listener
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    if (isCameraRunning) {
      const video = document.querySelector('#reader video');
      let isStreamActive = false;
      if (video && video.srcObject) {
        isStreamActive = video.srcObject.getTracks().some(track => track.readyState === 'live');
      }

      if (!isStreamActive) {
        if (DEBUG_MODE) console.log('[DEBUG] Camera stream inactive upon visibility recovery. Restarting...');
        await stopCameraScannerSilent();
        startCameraScanner();
      }
    }
  }
});

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

// Two-stage product recognition and update indicator (Milestone 6.2)
function triggerFeedbackPopup(productName) {
  if (!scanFeedback) return;
  
  // Format the name slightly to fit within the pill nicely
  const displayName = productName.length > 18 ? productName.slice(0, 18) + '...' : productName;
  scanFeedback.textContent = `✓ ${displayName} recognised`;
  scanFeedback.classList.add('visible');
  
  // Morph to "✓ Price Updated" after 250ms
  setTimeout(() => {
    scanFeedback.style.opacity = '0';
    setTimeout(() => {
      scanFeedback.textContent = '✓ Price Updated';
      scanFeedback.style.opacity = '';
    }, 100);
    
    // Hide completely after 300ms more
    setTimeout(() => {
      scanFeedback.classList.remove('visible');
    }, 300);
  }, 250);
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

// Premium currency parts formatter
function formatPremiumPrice(val) {
  if (val === undefined || val === null) return 'N/A';
  const formatted = Number(val).toFixed(2);
  const parts = formatted.split('.');
  const wholeNumber = parts[0];
  const decimalNumber = parts[1] || '00';
  return `<span class="price-currency">₹</span><span class="price-whole">${wholeNumber}</span><span class="price-decimal">.${decimalNumber}</span>`;
}

// Fetch pricing values from endpoint
// Fetch pricing values from endpoint
async function lookupBarcode(barcode) {
  if (lookupInProgress) {
    if (DEBUG_MODE) console.log(`[DEBUG] Lookup request blocked: barcode ${barcode} is already in progress.`);
    return;
  }
  
  lookupInProgress = true;
  currentRecoveryBarcode = barcode;
  
  // Dev metrics start
  const apiStart = Date.now();
  if (firstDecodeTime === 0) {
    firstDecodeTime = apiStart;
    if (DEBUG_MODE) console.log(`[METRICS] First successful decode at: ${apiStart - cameraStartTime}ms from camera start`);
  }
  
  // Transition card out: add replacing class to single state or multi state
  const singleState = document.getElementById('state-single');
  const multiState = document.getElementById('state-multiple');
  const priceValEl = document.getElementById('single-sale-price');
  
  if (singleState) singleState.classList.add('replacing');
  if (multiState) multiState.classList.add('replacing');
  if (priceValEl) priceValEl.classList.add('faded');
  
  // Switch to loading state if no card is visible yet
  const statesKeys = Object.keys(states);
  let anyProductVisible = false;
  statesKeys.forEach(k => {
    if ((k === 'single' || k === 'multiple') && states[k].style.display === 'flex') {
      anyProductVisible = true;
    }
  });
  if (!anyProductVisible) {
    showState('loading');
  }
  
  try {
    const response = await fetch(`/api/products/lookup/${barcode}`);
    const apiEnd = Date.now();
    lastApiDuration = apiEnd - apiStart;
    if (DEBUG_MODE) {
      console.log(`[METRICS] API request duration: ${lastApiDuration}ms`);
      updateDebugOverlay();
    }
    
    // Wait for the slide-out visual transition to finish (150ms)
    setTimeout(async () => {
      const renderStart = Date.now();
      
      if (response.status === 200) {
        const data = await response.json();
        
        // Remove old details layout styles
        if (singleState) singleState.classList.remove('replacing');
        if (multiState) multiState.classList.remove('replacing');
        
        if (data.multipleMatches && data.products.length > 1) {
          showState('multiple');
          const listContainer = document.getElementById('multi-list');
          listContainer.innerHTML = '';
          
          data.products.forEach(p => {
            const card = document.createElement('div');
            card.className = 'multi-item-card';
            
            let bulkHtml = '';
            if (p.wholesalePrice !== undefined && p.wholesalePrice !== null && p.wholesaleQty !== undefined && p.wholesaleQty !== null) {
              const savings = (Number(p.salePrice) - Number(p.wholesalePrice)) * Number(p.wholesaleQty);
              bulkHtml = `
                <div class="bulk-offer-panel" style="margin-top: 8px; padding: 10px; border-radius: 10px; font-size: 0.8rem; display: flex; justify-content: space-between; align-items: center; width: 100%;">
                  <div class="bulk-left-col" style="display: flex; flex-direction: column; align-items: flex-start;">
                    <div class="bulk-header-row" style="display: flex; align-items: center; gap: 4px;">
                      <svg class="bulk-tag-icon" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--primary-color);">
                        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
                        <line x1="7" y1="7" x2="7.01" y2="7"></line>
                      </svg>
                      <span class="bulk-title" style="font-size: 0.75rem; font-weight: 700; color: var(--primary-color);">Bulk Offer</span>
                    </div>
                    <div class="bulk-subtitle" style="font-size: 0.7rem; color: var(--text-muted);">Buy ${p.wholesaleQty}+</div>
                  </div>
                  <div class="bulk-right-col" style="display: flex; flex-direction: column; align-items: flex-end;">
                    <div class="bulk-price" style="font-size: 1rem; font-weight: 800; color: var(--primary-color);">${formatCurrency(p.wholesalePrice)} each</div>
                    <div class="bulk-savings-text" style="font-size: 0.7rem; font-weight: 700; color: #2e7d32;">You save ${formatCurrency(savings).replace('.00', '')}</div>
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
            
            card.addEventListener('click', () => {
              addToHistory(p);
              resetBarcodeCollapse();
              
              // Slide down transition
              if (singleState) singleState.classList.add('replacing');
              setTimeout(() => {
                showState('single');
                 document.getElementById('single-name').textContent = p.name;
                 document.getElementById('single-barcode').textContent = p.barcode;
                 document.getElementById('single-sale-price').innerHTML = formatPremiumPrice(p.salePrice);
                 document.getElementById('single-mrp').textContent = formatCurrency(p.mrp);
                
                const bulkContainer = document.getElementById('single-bulk-container');
                if (p.wholesalePrice !== undefined && p.wholesalePrice !== null && p.wholesaleQty !== undefined && p.wholesaleQty !== null) {
                  document.getElementById('single-bulk-qty').textContent = `Buy ${p.wholesaleQty}+`;
                  document.getElementById('single-bulk-price').textContent = `${formatCurrency(p.wholesalePrice)} each`;
                  const savings = (Number(p.salePrice) - Number(p.wholesalePrice)) * Number(p.wholesaleQty);
                  document.getElementById('single-bulk-savings').textContent = 'You save ' + formatCurrency(savings).replace('.00', '');
                  bulkContainer.style.display = 'flex';
                } else {
                  bulkContainer.style.display = 'none';
                }
                
                if (singleState) singleState.classList.remove('replacing');
                if (priceValEl) priceValEl.classList.remove('faded');
                applyCardHighlight();
              }, 150);
            });
            
            listContainer.appendChild(card);
          });
          
          addToHistory(data.products[0]);
          lookupInProgress = false;
        } else if (data.products && data.products.length > 0) {
          const p = data.products[0];
          resetBarcodeCollapse();
          
          showState('single');
          document.getElementById('single-name').textContent = p.name;
          document.getElementById('single-barcode').textContent = p.barcode;
          document.getElementById('single-sale-price').innerHTML = formatPremiumPrice(p.salePrice);
          document.getElementById('single-mrp').textContent = formatCurrency(p.mrp);
          
          const bulkContainer = document.getElementById('single-bulk-container');
          if (p.wholesalePrice !== undefined && p.wholesalePrice !== null && p.wholesaleQty !== undefined && p.wholesaleQty !== null) {
            document.getElementById('single-bulk-qty').textContent = `Buy ${p.wholesaleQty}+`;
            document.getElementById('single-bulk-price').textContent = `${formatCurrency(p.wholesalePrice)} each`;
            const savings = (Number(p.salePrice) - Number(p.wholesalePrice)) * Number(p.wholesaleQty);
            document.getElementById('single-bulk-savings').textContent = 'You save ' + formatCurrency(savings).replace('.00', '');
            bulkContainer.style.display = 'flex';
          } else {
            bulkContainer.style.display = 'none';
          }
          
          if (singleState) singleState.classList.remove('replacing');
          if (priceValEl) priceValEl.classList.remove('faded');
          
          addToHistory(p);
          triggerFeedbackPopup(p.name);
          
          // Lock scan to this barcode to prevent accidental duplicates
          lastScannedBarcode = barcode;
          
          // API/Render metrics
          const renderEnd = Date.now();
          lastRenderDuration = renderEnd - renderStart;
          if (DEBUG_MODE) {
            console.log(`[METRICS] UI rendering duration: ${lastRenderDuration}ms`);
            console.log(`[METRICS] Total decode-to-render: ${renderEnd - apiStart}ms`);
            updateDebugOverlay();
          }
          
          // Resume decoding after 1.0s debounce pause
          setTimeout(() => {
            resetScannerStatusLine();
            lookupInProgress = false;
            isScanPaused = false;
          }, 1000);
        } else {
          showState('notFound');
          // Resume scanning after failure
          setTimeout(() => {
            resetScannerStatusLine();
            lookupInProgress = false;
            isScanPaused = false;
          }, 1000);
        }
      } else {
        // Recovery trigger: handle bad responses
        handleLookupFailure();
      }
    }, 150);
    
  } catch (err) {
    if (DEBUG_MODE) console.error('[DEBUG] Lookup fetch error:', err);
    handleLookupFailure();
  }
}

// Graceful lookup error fallback
function handleLookupFailure() {
  if (scanFeedback) {
    scanFeedback.textContent = "Unable to retrieve price. Please try again.";
    scanFeedback.classList.add('visible');
    setTimeout(() => {
      scanFeedback.classList.remove('visible');
    }, 2000);
  }
  
  // Revert card replacement visual classes
  const singleState = document.getElementById('state-single');
  const multiState = document.getElementById('state-multiple');
  const priceValEl = document.getElementById('single-sale-price');
  if (singleState) singleState.classList.remove('replacing');
  if (multiState) multiState.classList.remove('replacing');
  if (priceValEl) priceValEl.classList.remove('faded');
  
  // Revert back to previous displays if applicable, or stay idle
  const isSingleActive = document.getElementById('single-name').textContent !== '-';
  if (isSingleActive) {
    showState('single');
  } else {
    showState('idle');
  }
  
  // Auto-resume scanner loop
  setTimeout(() => {
    resetScannerStatusLine();
    lookupInProgress = false;
    isScanPaused = false;
  }, 1000);
}

// Reset status bar display
function resetScannerStatusLine() {
  const dot = document.querySelector('.status-dot');
  const text = document.querySelector('.status-text');
  if (dot && text) {
    dot.style.backgroundColor = '#ffffff';
    dot.style.boxShadow = 'none';
    text.textContent = 'Align barcode inside the frame';
  }
}

// Start camera scan stream
// Start camera scan stream
function startCameraScanner() {
  console.log('[Camera Debug] Scan button clicked');
  console.log('[Camera Debug] Camera initialization started');
  
  showState('idle');
  isCameraRunning = true;
  lastScannedBarcode = "";
  lastScanTime = 0;
  firstDecodeTime = 0;
  currentFps = 0;
  frameCount = 0;
  updateDebugOverlay();

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

  // 4. Start scanner library directly to avoid camera hardware context lock race conditions
  startScannerLibrary();
}

// Start html5-qrcode scanner loop
function startScannerLibrary() {
  if (!html5QrcodeScanner) {
    html5QrcodeScanner = new Html5Qrcode("reader");
  }

  const config = {
    fps: 15,
    qrbox: (width, height) => {
      // Dynamic bounds (preferred 80% width, clamped min: 280px, max: 450px)
      let boxWidth = Math.round(width * 0.80);
      if (boxWidth < 280) boxWidth = 280;
      if (boxWidth > 450) boxWidth = 450;
      if (boxWidth > width) boxWidth = width;
      
      let boxHeight = Math.round(boxWidth / 2.2);
      if (boxHeight > height) boxHeight = height;
      
      // Calculate DOM scaled size to align CSS overlay brackets perfectly
      const reader = document.getElementById('reader');
      if (reader) {
        const domWidth = reader.clientWidth;
        const domHeight = reader.clientHeight;
        const scale = Math.max(domWidth / width, domHeight / height);
        const visualWidth = Math.round(boxWidth * scale);
        const visualHeight = Math.round(boxHeight * scale);
        
        const brackets = document.querySelector('.scanner-brackets');
        if (brackets) {
          brackets.style.width = `${visualWidth}px`;
          brackets.style.height = `${visualHeight}px`;
        }
      }
      
      return { width: boxWidth, height: boxHeight };
    }
  };

  if (DEBUG_MODE) cameraStartTime = Date.now();
  
  // Detect iOS Safari or WebKit to bypass async enumeration and preserve user gesture context
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

  if (isIOS) {
    console.log('[Camera Debug] iOS device detected. Bypassing enumeration to preserve user-gesture token.');
    html5QrcodeScanner.start(
      { facingMode: "environment" },
      config,
      onBarcodeDecoded,
      onBarcodeScanError
    ).then(() => {
      console.log('[Camera Debug] iOS camera start succeeded.');
      if (DEBUG_MODE) {
        cameraInitDuration = Date.now() - cameraStartTime;
        console.log(`[METRICS] Camera initialized successfully in ${cameraInitDuration}ms`);
        updateDebugOverlay();
      }
      startAmbientLightDetection();
      
      // Safely apply continuous autofocus track constraints
      try {
        const video = document.querySelector('#reader video');
        if (video && video.srcObject) {
          const track = video.srcObject.getVideoTracks()[0];
          if (track && typeof track.getCapabilities === 'function') {
            const capabilities = track.getCapabilities();
            if (capabilities.focusMode && capabilities.focusMode.includes('continuous')) {
              track.applyConstraints({
                advanced: [{ focusMode: 'continuous' }]
              }).catch(e => console.log('[Camera Debug] Continuous autofocus track constraint failed:', e));
            }
          }
        }
      } catch (focusErr) {
        console.warn('[Camera Debug] Autofocus track capabilities validation failed:', focusErr);
      }
    }).catch(startErr => {
      console.warn('[Camera Debug] iOS environment start failed, trying user camera...', startErr);
      html5QrcodeScanner.start(
        { facingMode: "user" },
        config,
        onBarcodeDecoded,
        onBarcodeScanError
      ).then(() => {
        console.log('[Camera Debug] iOS user camera succeeded.');
        if (DEBUG_MODE) {
          cameraInitDuration = Date.now() - cameraStartTime;
          updateDebugOverlay();
        }
        startAmbientLightDetection();
      }).catch(finalErr => {
        console.error('[Camera Debug] iOS camera start failed entirely:', finalErr);
        logAndShowDeniedError(finalErr);
      });
    });
  } else {
    // Non-iOS: Enumerate cameras via the library helper (requests permissions safely)
    Html5Qrcode.getCameras().then(devices => {
      let cameraIdToUse = null;
      if (devices && devices.length > 0) {
        // Find environment/rear camera device label
        const backCam = devices.find(d => {
          const label = (d.label || '').toLowerCase();
          return label.includes('back') || label.includes('rear') || label.includes('environment') || label.includes('main');
        });
        // Ensure we only use it if deviceId is non-empty string
        const candidateId = backCam ? backCam.deviceId : devices[0].deviceId;
        if (candidateId) {
          cameraIdToUse = candidateId;
        }
      }
      
      // Fall back to environment constraints object if device ID is missing
      const cameraArg = cameraIdToUse ? cameraIdToUse : { facingMode: "environment" };
      console.log('[Camera Debug] html5QrcodeScanner.start() with:', cameraArg);

      html5QrcodeScanner.start(
        cameraArg,
        config,
        onBarcodeDecoded,
        onBarcodeScanError
      ).then(() => {
        console.log('[Camera Debug] Html5Qrcode.start() succeeded.');
        if (DEBUG_MODE) {
          cameraInitDuration = Date.now() - cameraStartTime;
          console.log(`[METRICS] Camera initialized successfully in ${cameraInitDuration}ms`);
          updateDebugOverlay();
        }
        startAmbientLightDetection();
        
        // Safely apply continuous autofocus tracks constraints
        try {
          const video = document.querySelector('#reader video');
          if (video && video.srcObject) {
            const track = video.srcObject.getVideoTracks()[0];
            if (track && typeof track.getCapabilities === 'function') {
              const capabilities = track.getCapabilities();
              if (capabilities.focusMode && capabilities.focusMode.includes('continuous')) {
                track.applyConstraints({
                  advanced: [{ focusMode: 'continuous' }]
                }).catch(e => console.log('[Camera Debug] Continuous autofocus track constraint failed:', e));
              }
            }
          }
        } catch (focusErr) {
          console.warn('[Camera Debug] Autofocus track capabilities validation failed:', focusErr);
        }
      }).catch(startErr => {
        console.warn('[Camera Debug] html5QrcodeScanner.start() failed, trying environment constraints...', startErr);
        
        // Fallback 1: Force environment constraints
        html5QrcodeScanner.start(
          { facingMode: "environment" },
          config,
          onBarcodeDecoded,
          onBarcodeScanError
        ).then(() => {
          console.log('[Camera Debug] Fallback environment camera succeeded.');
          if (DEBUG_MODE) {
            cameraInitDuration = Date.now() - cameraStartTime;
            updateDebugOverlay();
          }
          startAmbientLightDetection();
        }).catch(fallbackErr => {
          console.warn('[Camera Debug] Fallback environment failed, trying user camera...', fallbackErr);
          
          // Fallback 2: Try front-facing camera
          html5QrcodeScanner.start(
            { facingMode: "user" },
            config,
            onBarcodeDecoded,
            onBarcodeScanError
          ).then(() => {
            console.log('[Camera Debug] Fallback user camera succeeded.');
            if (DEBUG_MODE) {
              cameraInitDuration = Date.now() - cameraStartTime;
              updateDebugOverlay();
            }
            startAmbientLightDetection();
          }).catch(finalErr => {
            console.error('[Camera Debug] Camera start failed entirely:', finalErr);
            logAndShowDeniedError(finalErr);
          });
        });
      });
    }).catch(enumErr => {
      console.warn('[Camera Debug] getCameras() failed, falling back directly to environment constraints:', enumErr);
      
      // Direct fallback to environment constraints if enumeration fails
      html5QrcodeScanner.start(
        { facingMode: "environment" },
        config,
        onBarcodeDecoded,
        onBarcodeScanError
      ).then(() => {
        console.log('[Camera Debug] Direct environment constraints camera succeeded.');
        if (DEBUG_MODE) {
          cameraInitDuration = Date.now() - cameraStartTime;
          updateDebugOverlay();
        }
        startAmbientLightDetection();
      }).catch(directErr => {
        console.error('[Camera Debug] Direct environment constraints failed, trying user camera...', directErr);
        
        html5QrcodeScanner.start(
          { facingMode: "user" },
          config,
          onBarcodeDecoded,
          onBarcodeScanError
        ).then(() => {
          console.log('[Camera Debug] Fallback user camera succeeded.');
          if (DEBUG_MODE) {
            cameraInitDuration = Date.now() - cameraStartTime;
            updateDebugOverlay();
          }
          startAmbientLightDetection();
        }).catch(finalErr => {
          console.error('[Camera Debug] Camera start failed entirely:', finalErr);
          logAndShowDeniedError(finalErr);
        });
      });
    });
  }
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
  
  // Track last seen timestamp to calculate disappearance intervals for anti-double scans
  lastSeenTime = now;
  
  // Ignore subsequent scans if lookup is in progress or scan debouncing is active
  if (isScanPaused || lookupInProgress) return;
  
  // Anti-double scan check: ignore stationary scanned barcode
  if (decodedText === lastScannedBarcode) {
    return;
  }
  
  // Time-based confidence check (consistent across 15fps to 60fps frame rates)
  if (decodedText === lastDetectedBarcode) {
    detectionCount++;
  } else {
    lastDetectedBarcode = decodedText;
    firstDetectedTime = now;
    detectionCount = 1;
    return; // Wait for next frame to build confidence
  }
  
  const elapsedStableTime = now - firstDetectedTime;
  const isStable = (detectionCount >= 2) || (elapsedStableTime >= 100);
  if (!isStable) {
    return;
  }
  
  // Stable detection confirmed! Reset transient state frame counters
  detectionCount = 0;
  lastDetectedBarcode = "";
  
  // Lock the scanner loop
  isScanPaused = true;
  lastScanTime = now;
  
  // 1. Log metrics in dev environment
  if (DEBUG_MODE) {
    console.log(`[DEBUG] Stable barcode detected: ${decodedText} (stable for ${elapsedStableTime}ms, frames: ${detectionCount})`);
  }
  
  // 2. Flash brackets green for 200ms
  const brackets = document.querySelector('.scanner-brackets');
  if (brackets) {
    brackets.classList.add('flash-green');
    setTimeout(() => {
      brackets.classList.remove('flash-green');
    }, 200);
  }
  
  // 3. Update top status label to green dot and "✓ Barcode detected"
  const dot = document.querySelector('.status-dot');
  const text = document.querySelector('.status-text');
  if (dot && text) {
    dot.style.backgroundColor = '#2e7d32';
    dot.style.boxShadow = '0 0 8px #2e7d32';
    text.textContent = '✓ Barcode detected';
  }
  
  // 4. Synthesize beep and haptic feedback
  triggerHapticVibrate();
  playSuccessBeep();
  
  // 5. Lookup details from backend catalog
  lookupBarcode(decodedText);
}

function onBarcodeScanError(errorMessage) {
  // Increment frames for real-time FPS overlay calculation
  registerFrameForFps();
}

// Stop camera scan stream
function stopCameraScanner() {
  isCameraRunning = false;
  if (html5QrcodeScanner && html5QrcodeScanner.isScanning) {
    html5QrcodeScanner.stop().then(() => {
      console.log('Camera stream stopped successfully.');
    }).catch(err => {
      console.warn('Failed to stop camera stream:', err);
    });
  }
  stopAmbientLightDetection();
  const overlay = document.getElementById('debug-overlay');
  if (overlay) overlay.style.display = 'none';
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
      document.getElementById('single-sale-price').innerHTML = formatPremiumPrice(item.salePrice);
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
