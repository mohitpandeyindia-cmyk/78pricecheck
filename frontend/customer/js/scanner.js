/* ==========================================================================
   78 PRICE CHECK — SCANNER PAGE SCRIPT (scanner.js)
   Canonical runtime script for #scanner-view & CameraManager (Stage 2 Isolation)
   ========================================================================== */

// Scanner Runtime State Variables
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

let cameraStartTime = 0;
let firstDecodeTime = 0;
let lastApiDuration = 0;
let lastRenderDuration = 0;
let cameraInitDuration = 0;
let frameCount = 0;
let lastFpsCalculationTime = Date.now();
let currentFps = 0;
let ambientLightInterval = null;
let cachedHotDeals = [];

// Helper to access result state card elements safely
function getStates() {
  return {
    'camera-opening': document.getElementById('state-camera-opening'),
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
}

const CameraManager = {
  state: 'IDLE',
  html5Qrcode: null,
  config: null,
  isIOS: false,
  activeTrack: null,

  init() {
    this.isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
                 (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

    this.config = {
      fps: 15,
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.CODE_128
      ],
      qrbox: (width, height) => {
        let boxWidth = Math.round(width * 0.80);
        if (boxWidth < 280) boxWidth = 280;
        if (boxWidth > 450) boxWidth = 450;
        if (boxWidth > width) boxWidth = width;

        let boxHeight = Math.round(boxWidth / 2.2);
        if (boxHeight > height) boxHeight = height;

        const reader = document.getElementById('reader');
        if (reader) {
          const domWidth = reader.clientWidth;
          const domHeight = reader.clientHeight;
          const scale = Math.max(domWidth / width, domHeight / height);
          const visualWidth = Math.round(boxWidth * scale);
        }
        return { width: boxWidth, height: boxHeight };
      }
    };

    // Auto-recovery Page Visibility listener
    document.addEventListener('visibilitychange', async () => {
      if (document.visibilityState === 'visible') {
        if (this.state === 'READY') {
          const video = document.querySelector('#reader video');
          let isStreamActive = false;
          if (video && video.srcObject) {
            isStreamActive = video.srcObject.getTracks().some(track => track.readyState === 'live');
          }
          if (!isStreamActive) {
            console.log('[CameraManager] Inactive stream recovered on visibility active');
            await this.recover();
          }
        }
      }
    });
  },

  async start() {
    console.log('[Diag] CameraManager.start() invoked. State:', this.state);

    // Reset scanning lock flags on session start
    isScanPaused = false;
    lookupInProgress = false;

    if (this.state === 'READY' || this.state === 'STARTING') {
      console.log('[Diag] Camera start rejected: already in state', this.state);
      return;
    }

    // Check for Insecure Context / Missing MediaDevices (HTTP block)
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      console.error('[Diag] Secure context validation failed. isSecureContext:', window.isSecureContext, 'mediaDevices:', !!navigator.mediaDevices);
      StateManager.transitionTo('ERROR', {
        type: 'cameraUnavailable',
        errorString: 'Insecure Context / HTTPS Block',
        errorDesc: 'WebRTC camera access requires a Secure Context (HTTPS). Mobile web browsers block camera access on plain HTTP connections.'
      });
      return;
    }

    // Check container existence and dimensions
    const readerEl = document.getElementById('reader');
    if (readerEl) {
      const rect = readerEl.getBoundingClientRect();
      console.log(`[Diag] Container "#reader" dimensions: width=${rect.width}px, height=${rect.height}px, offsetWidth=${readerEl.offsetWidth}px, offsetHeight=${readerEl.offsetHeight}px, display=${window.getComputedStyle(readerEl).display}`);
      if (rect.width === 0 || rect.height === 0) {
        console.warn('[Diag] Warning: Container "#reader" has 0 width or height! This may cause html5-qrcode initialization to throw.');
      }
    } else {
      console.error('[Diag] Error: Container "#reader" is missing from the DOM!');
    }

    this.state = 'STARTING';
    console.log('[Diag] Transitioned CameraManager state to STARTING. Initializing Html5Qrcode...');

    try {
      if (!this.html5Qrcode) {
        this.html5Qrcode = new Html5Qrcode("reader");
      }
      console.log('[Diag] Html5Qrcode instance initialized successfully.');
    } catch (qrInitErr) {
      console.error('[Diag] Failed to initialize Html5Qrcode instance:', qrInitErr);
      this.state = 'IDLE';
      throw qrInitErr;
    }

    cameraStartTime = performance.now();
    isCameraRunning = true;
    lastScannedBarcode = "";
    lastScanTime = 0;
    firstDecodeTime = 0;
    currentFps = 0;
    frameCount = 0;
    updateDebugOverlay();

    const oldDebugs = document.querySelectorAll('.error-debug-details');
    oldDebugs.forEach(el => el.remove());

    try {
      // Build dynamic scanning configuration
      const scanConfig = {
        fps: this.config.fps,
        formatsToSupport: this.config.formatsToSupport
      };

      if (this.isIOS) {
        console.log('[CameraManager] iOS device detected. Requesting HD ideal constraints and bypassing qrbox crop...');
        // Request HD ideal constraints on iOS within videoConstraints configuration object
        scanConfig.videoConstraints = {
          facingMode: "environment",
          width: { ideal: 1280 },
          height: { ideal: 720 }
        };
        // Disable qrbox on iOS so the decoder scans the full frame
        await this.html5Qrcode.start({ facingMode: "environment" }, scanConfig, onBarcodeDecoded, onBarcodeScanError);
      } else {
        scanConfig.qrbox = this.config.qrbox;
        let cameraIdToUse = null;
        try {
          const devices = await Html5Qrcode.getCameras();
          if (devices && devices.length > 0) {
            const backCam = devices.find(d => {
              const label = (d.label || '').toLowerCase();
              return label.includes('back') || label.includes('rear') || label.includes('environment') || label.includes('main');
            });
            cameraIdToUse = backCam ? backCam.deviceId : devices[0].deviceId;
          }
        } catch (e) {
          console.warn('[CameraManager] Camera devices enumeration failed, falling back to environment constraints:', e);
        }

        const cameraArg = cameraIdToUse ? cameraIdToUse : { facingMode: "environment" };
        await this.html5Qrcode.start(cameraArg, scanConfig, onBarcodeDecoded, onBarcodeScanError);
      }

      this.state = 'READY';
      console.log('[CameraManager] Camera start succeeded.');

      cameraInitDuration = Math.round(performance.now() - cameraStartTime);
      if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) {
        console.log(`[METRICS] Camera initialized successfully in ${cameraInitDuration}ms`);
        updateDebugOverlay();
      }
      saveDiagnosticsTelemetry({
        cameraStartupTime: cameraInitDuration,
        cameraPermission: 'Granted'
      });

      this.applyFocusConstraints();
      startAmbientLightDetection();
      showState('idle');

    } catch (err) {
      console.warn('[CameraManager] Main camera start path failed, attempting fallback...', err);

      const fallbackConfig = {
        fps: this.config.fps,
        formatsToSupport: this.config.formatsToSupport
      };
      if (!this.isIOS) {
        fallbackConfig.qrbox = this.config.qrbox;
      }

      try {
        // Recreate Html5Qrcode to clear any stuck internal state
        this.html5Qrcode = new Html5Qrcode("reader");

        await this.html5Qrcode.start({ facingMode: "environment" }, fallbackConfig, onBarcodeDecoded, onBarcodeScanError);
        this.state = 'READY';
        saveDiagnosticsTelemetry({
          cameraStartupTime: Math.round(performance.now() - cameraStartTime),
          cameraPermission: 'Granted'
        });
        this.applyFocusConstraints();
        startAmbientLightDetection();
        showState('idle');
      } catch (err2) {
        console.warn('[CameraManager] Fallback environment camera failed, trying user camera...', err2);
        try {
          // Recreate Html5Qrcode to clear any stuck internal state
          this.html5Qrcode = new Html5Qrcode("reader");

          await this.html5Qrcode.start({ facingMode: "user" }, fallbackConfig, onBarcodeDecoded, onBarcodeScanError);
          this.state = 'READY';
          saveDiagnosticsTelemetry({
            cameraStartupTime: Math.round(performance.now() - cameraStartTime),
            cameraPermission: 'Granted'
          });
          startAmbientLightDetection();
          showState('idle');
        } catch (err3) {
          this.state = 'ERROR';
          isCameraRunning = false;
          ErrorManager.handleError('CameraManager', err3, { action: 'start' });
        }
      }
    }
  },

  async stop() {
    // Reset scanning lock flags on session stop/exit
    isScanPaused = false;
    lookupInProgress = false;

    if (this.state === 'STOPPED' || this.state === 'IDLE' || !this.html5Qrcode) {
      return;
    }

    try {
      if (this.html5Qrcode.isScanning) {
        await this.html5Qrcode.stop();
      }
      this.state = 'STOPPED';
      isCameraRunning = false;
      stopAmbientLightDetection();
      console.log('[CameraManager] Camera stopped successfully.');
    } catch (e) {
      console.error('[CameraManager] Camera stop failed:', e);
    }
  },

  applyFocusConstraints() {
    try {
      const video = document.querySelector('#reader video');
      if (video) {
        const checkTrack = () => {
          if (!video.srcObject) return;
          this.activeTrack = video.srcObject.getVideoTracks()[0];
          if (this.activeTrack) {
            const label = this.activeTrack.label || 'Camera Stream';
            let resolution = 'Unknown';
            let hasTorch = 'Not Supported';

            if (typeof this.activeTrack.getSettings === 'function') {
              const settings = this.activeTrack.getSettings();
              console.log('[CameraManager] Deployed Video Track Settings:', JSON.stringify(settings));
              if (settings.width && settings.height) {
                resolution = `${settings.width} × ${settings.height}`;
              }
            }

            if (typeof this.activeTrack.getCapabilities === 'function') {
              const capabilities = this.activeTrack.getCapabilities();
              console.log('[CameraManager] Deployed Video Track Capabilities:', JSON.stringify(capabilities));
              if (capabilities.torch) {
                hasTorch = 'Supported';
              }
            }

            saveDiagnosticsTelemetry({
              cameraLabel: label,
              cameraResolution: resolution,
              cameraTorch: hasTorch
            });

            if (this.isIOS) {
              // Manually adjust visual viewfinder brackets on iOS where qrbox cropping is disabled
              const reader = document.getElementById('reader');
              if (reader) {
                const domWidth = reader.clientWidth;
                const domHeight = reader.clientHeight;
                let boxWidth = Math.round(domWidth * 0.80);
                if (boxWidth < 280) boxWidth = 280;
                if (boxWidth > 450) boxWidth = 450;
              }
            }

            if (typeof this.activeTrack.getCapabilities === 'function') {
              const capabilities = this.activeTrack.getCapabilities();
              if (capabilities.focusMode && capabilities.focusMode.includes('continuous')) {
                this.activeTrack.applyConstraints({
                  advanced: [{ focusMode: 'continuous' }]
                }).catch(e => console.log('[CameraManager] Continuous autofocus track constraint failed:', e));
              }
            }
          }
        };

        // Execute immediately
        checkTrack();
        // Also bind to play event to ensure we log correctly after layout settles
        video.addEventListener('playing', checkTrack, { once: true });
        // Fail-safe timeout
        setTimeout(checkTrack, 500);
      }
    } catch (focusErr) {
      console.warn('[CameraManager] Autofocus track capabilities validation failed:', focusErr);
    }
  },

  async setTorch(on) {
    if (!this.activeTrack) {
      const video = document.querySelector('#reader video');
      if (video && video.srcObject) {
        this.activeTrack = video.srcObject.getVideoTracks()[0];
      }
    }

    if (this.activeTrack && typeof this.activeTrack.getCapabilities === 'function') {
      try {
        const capabilities = this.activeTrack.getCapabilities();
        if (capabilities.torch) {
          await this.activeTrack.applyConstraints({
            advanced: [{ torch: on }]
          });
          console.log(`[CameraManager] Torch set to: ${on}`);
          return true;
        }
      } catch (err) {
        console.warn('[CameraManager] Failed to apply torch constraint:', err);
      }
    }
    return false;
  },

  async recover() {
    if (this.state !== 'READY' && this.state !== 'RECOVERING') {
      return;
    }

    console.log('[CameraManager] Recovering active stream due to visibility changes...');
    this.state = 'RECOVERING';
    try {
      await this.stop();
      await this.start();
    } catch (e) {
      console.error('[CameraManager] Stream recovery failed:', e);
    }
  }
};

// Scoped Scanner background initializer
function initScannerBackground() {
  const bgEl = document.getElementById('scanner-background');
  if (bgEl && typeof ThemeManager !== 'undefined') {
    const theme = ThemeManager.getTheme();
    const asset = ThemeManager.getBackgroundAsset(theme);
    console.log(`[ScannerPage] Loaded background asset: ${asset} for theme: ${theme}`);
    bgEl.style.backgroundImage = `url(${asset})`;
  }
}

// State display helper (Rule 1: Visibility Manager Only)
function showState(activeStateKey) {
  const states = getStates();
  Object.keys(states).forEach(key => {
    if (states[key]) {
      if (key === activeStateKey) {
        states[key].style.removeProperty('display');
      } else {
        states[key].style.display = 'none';
      }
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

  if (typeof DEBUG_MODE !== 'undefined' && !DEBUG_MODE) {
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
          if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) console.log(`[DEBUG] Torch successfully set to: ${enabled}`);
          return true;
        } else {
          if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) console.log('[DEBUG] Torch capability is not supported on this track.');
        }
      } catch (err) {
        console.warn('Failed to apply torch constraints:', err);
      }
    }
  }
  return false;
};

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
  const scanFeedback = document.getElementById('scan-feedback');
  if (!scanFeedback) return;

  // Format the name slightly to fit within the pill nicely
  const displayName = productName.length > 18 ? productName.slice(0, 18) + '...' : productName;
  scanFeedback.textContent = `✓ ${displayName} recognised`;
  scanFeedback.classList.remove('error-feedback');
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

let carouselIndex = 0;
let carouselTimer = null;

function getCategoryTheme(name) {
  const lower = name.toLowerCase();
  if (lower.includes('milk') || lower.includes('bread') || lower.includes('apple') || lower.includes('rice') || lower.includes('oil') || lower.includes('dal') || lower.includes('sugar') || lower.includes('flour') || lower.includes('atta') || lower.includes('salt') || lower.includes('biscuit') || lower.includes('noodle')) {
    return 'theme-green';
  }
  if (lower.includes('cleaner') || lower.includes('detergent') || lower.includes('dish') || lower.includes('tide') || lower.includes('surf') || lower.includes('wash') || lower.includes('tissue') || lower.includes('spray')) {
    return 'theme-orange';
  }
  if (lower.includes('shampoo') || lower.includes('toothpaste') || lower.includes('lotion') || lower.includes('cream') || lower.includes('hair') || lower.includes('face') || lower.includes('brush') || lower.includes('deodorant')) {
    return 'theme-blue';
  }
  return 'theme-purple';
}

function updateCoverFlowCardNode(card, p, stateClass, isHero) {
  const theme = getCategoryTheme(p.name);
  card.className = `promo-card ${stateClass} ${theme}`;

  const mrpVal = Math.round(Number(p.mrp));
  const saleVal = Math.round(Number(p.salePrice));
  const discVal = Math.round(Number(p.discountPercent));

  card.innerHTML = `
    <div class="promo-card-badge ${isHero ? 'badge-hot' : ''}">${isHero ? `🔥 SAVE ${discVal}%` : `SAVE ${discVal}%`}</div>
    <div class="promo-card-name">${escapeHtml(p.name)}</div>
    <div class="promo-card-prices">
      <span class="promo-card-sale">₹${saleVal}</span>
      <span class="promo-card-mrp">MRP ₹${mrpVal}</span>
    </div>
  `;

  // Interactive preview: Clicking populates Section 3 via renderV2ProductCard
  card.onclick = () => {
    renderV2ProductCard(p, p.barcode);
    applyCardHighlight();
  };
}

function renderHotDealsCarousel() {
  const track = document.getElementById('promo-carousel-track');
  if (!track) return;

  if (carouselTimer) {
    clearInterval(carouselTimer);
    carouselTimer = null;
  }

  if (!cachedHotDeals || cachedHotDeals.length === 0) {
    track.innerHTML = `
      <div class="promo-slide active">
        <div class="promo-details promo-details--empty">
          <span class="promo-name">No offers available today.</span>
        </div>
      </div>
    `;
    return;
  }

  const N = cachedHotDeals.length;

  // Initialize exactly 5 DOM nodes in track
  track.innerHTML = '';
  const nodes = [];
  for (let i = 0; i < 5; i++) {
    const card = document.createElement('div');
    nodes.push(card);
    track.appendChild(card);
  }

  // Helper to populate 5 nodes based on carouselIndex
  const populateNodesAtRest = () => {
    for (let i = 0; i < 5; i++) {
      const prodIdx = (carouselIndex + i - 1 + N * 100) % N;
      const p = cachedHotDeals[prodIdx];
      let stateClass = 'promo-card--side';
      let isHero = false;

      if (i === 0 || i === 4) {
        stateClass = 'promo-card--hidden';
      } else if (i === 2) {
        stateClass = 'promo-card--hero';
        isHero = true;
      }

      updateCoverFlowCardNode(nodes[i], p, stateClass, isHero);
    }
  };

  populateNodesAtRest();

  // Diagnostic Bounding Box Report
  try {
    const box = document.querySelector('.scanner-v2-carousel-box');
    if (box && nodes.length === 5) {
      const vRect = box.getBoundingClientRect();
      const tRect = track.getBoundingClientRect();
      const getLayoutBox = (el) => ({
        left: Math.round(el.offsetLeft + tRect.left - vRect.left),
        width: Math.round(el.offsetWidth),
        right: Math.round(el.offsetLeft + tRect.left - vRect.left + el.offsetWidth)
      });
      const getVisualBox = (el) => {
        const r = el.getBoundingClientRect();
        return {
          left: Math.round(r.left - vRect.left),
          width: Math.round(r.width),
          right: Math.round(r.right - vRect.left)
        };
      };

      console.log('=== V2.4 CAROUSEL GEOMETRY DIAGNOSIS ===');
      console.table({
        VIEWPORT: { left: 0, width: Math.round(vRect.width), right: Math.round(vRect.width) },
        CARD_1_LEFT_UnscaledLayout: getLayoutBox(nodes[1]),
        CARD_1_LEFT_TransformedVisual: getVisualBox(nodes[1]),
        CARD_2_HERO_UnscaledLayout: getLayoutBox(nodes[2]),
        CARD_2_HERO_TransformedVisual: getVisualBox(nodes[2]),
        CARD_3_RIGHT_UnscaledLayout: getLayoutBox(nodes[3]),
        CARD_3_RIGHT_TransformedVisual: getVisualBox(nodes[3])
      });
    }
  } catch (e) {
    console.error('Diagnostic error:', e);
  }

  let cycleCount = 0;
  const cycleLogs = [];

  // Auto-slide 1 card every 4 seconds via single track transform translateX(-40%)
  carouselTimer = setInterval(() => {
    cycleCount++;
    const viewportBox = document.querySelector('.scanner-v2-carousel-box');

    const beforeRecycleOffsets = {
      leftOffset: nodes[1] ? nodes[1].offsetLeft : null,
      heroOffset: nodes[2] ? nodes[2].offsetLeft : null,
      rightOffset: nodes[3] ? nodes[3].offsetLeft : null
    };

    // Phase 1: Animate track transform from -20% to -40% over 380ms
    track.style.transition = 'transform 380ms cubic-bezier(0.22, 1, 0.36, 1)';
    track.style.transform = 'translateX(-40%)';

    // Update card scale/shadow classes continuously during slide
    const children = Array.from(track.children);
    if (children.length === 5) {
      const p1 = cachedHotDeals[(carouselIndex + 0 + N * 100) % N];
      const p2 = cachedHotDeals[(carouselIndex + 1 + N * 100) % N];
      const p3 = cachedHotDeals[(carouselIndex + 2 + N * 100) % N];
      const p4 = cachedHotDeals[(carouselIndex + 3 + N * 100) % N];

      children[1].className = `promo-card promo-card--hidden ${getCategoryTheme(p1.name)}`;
      children[2].className = `promo-card promo-card--side ${getCategoryTheme(p2.name)}`;
      children[3].className = `promo-card promo-card--hero ${getCategoryTheme(p3.name)}`;
      children[4].className = `promo-card promo-card--side ${getCategoryTheme(p4.name)}`;
    }

    // Phase 2: After 380ms transition completes, recycle offscreen node & reset track instantly
    setTimeout(() => {
      carouselIndex = (carouselIndex + 1) % N;

      // Disable transition for instant reset
      track.style.transition = 'none';

      // Move first card node (hidden-left) to end of track
      const firstNode = track.firstElementChild;
      if (firstNode) {
        track.appendChild(firstNode);
      }

      // Re-populate node data at baseline position (-20%)
      const updatedNodes = Array.from(track.children);
      for (let i = 0; i < 5; i++) {
        const prodIdx = (carouselIndex + i - 1 + N * 100) % N;
        const p = cachedHotDeals[prodIdx];
        let stateClass = 'promo-card--side';
        let isHero = false;

        if (i === 0 || i === 4) {
          stateClass = 'promo-card--hidden';
        } else if (i === 2) {
          stateClass = 'promo-card--hero';
          isHero = true;
        }

        updateCoverFlowCardNode(updatedNodes[i], p, stateClass, isHero);
      }

      const afterRecycleOffsets = {
        leftOffset: updatedNodes[1] ? updatedNodes[1].offsetLeft : null,
        heroOffset: updatedNodes[2] ? updatedNodes[2].offsetLeft : null,
        rightOffset: updatedNodes[3] ? updatedNodes[3].offsetLeft : null
      };

      const computedTrackStyle = window.getComputedStyle(track);

      const cycleData = {
        cycleNumber: cycleCount,
        activeIndices: [
          (carouselIndex - 1 + N) % N,
          carouselIndex % N,
          (carouselIndex + 1) % N,
          (carouselIndex + 2) % N,
          (carouselIndex + 3) % N
        ].join(','),
        trackTransform: computedTrackStyle.transform,
        transitionEnabled: track.style.transition !== 'none',
        leftNodeIdx: 1,
        heroNodeIdx: 2,
        rightNodeIdx: 3,
        trackClientWidth: track.clientWidth,
        trackScrollWidth: track.scrollWidth,
        viewportClientWidth: viewportBox ? viewportBox.clientWidth : null,
        beforeLeft: beforeRecycleOffsets.leftOffset,
        beforeHero: beforeRecycleOffsets.heroOffset,
        beforeRight: beforeRecycleOffsets.rightOffset,
        afterLeft: afterRecycleOffsets.leftOffset,
        afterHero: afterRecycleOffsets.heroOffset,
        afterRight: afterRecycleOffsets.rightOffset
      };

      cycleLogs.push(cycleData);
      if (cycleLogs.length <= 20) {
        console.log(`[FORENSIC CYCLE ${cycleCount}]`, cycleData);
      }
      if (cycleCount === 20) {
        console.log('=== FORENSIC 20-CYCLE SUMMARY TRACE ===');
        console.table(cycleLogs);
      }

      // Reset track transform to baseline -20%
      track.style.transform = 'translateX(-20%)';
      void track.offsetWidth; // Force CSS reflow

      // Re-enable CSS transition for next cycle
      track.style.transition = '';
    }, 380);
  }, 4000);
}

async function fetchHotDeals() {
  try {
    const response = await fetch('/api/products/hot-deals');
    if (!response.ok) throw new Error('Hot deals API response failed');
    const data = await response.json();
    if (data.success && Array.isArray(data.products)) {
      cachedHotDeals = data.products;
    }
  } catch (err) {
    console.warn('[HotDeals] Failed to load precomputed hot deals, using fallback:', err);
    cachedHotDeals = [];
  }
  renderHotDealsCarousel();
}

// Format price as whole number without decimals (V5.3 Specification)
function formatV3PriceHTML(val, isRupeeBlack = true) {
  if (val === undefined || val === null) return 'N/A';
  const num = Number(val);
  const whole = isNaN(num) ? '0' : Math.round(num).toString();
  const rupeeClass = isRupeeBlack ? 'rupee-symbol rupee-symbol--black' : 'rupee-symbol';
  return `<span class="${rupeeClass}">₹</span><span class="price-whole">${whole}</span>`;
}

// Render V2 Premium Product Result Card (Type 1: Single Savings / Type 2: Bulk Offer)
function renderV2ProductCard(p, barcode) {
  resetBarcodeCollapse();

  StateManager.transitionTo('DISPLAY_RESULT', { type: 'single' });
  const announcer = document.getElementById('a11y-announcer');
  if (announcer) {
    announcer.textContent = `Product found: ${p.name}. Price is ${formatCurrency(p.salePrice)}.`;
  }

  // Trigger V5 180ms micro-animations
  const stateSingle = document.getElementById('state-single');
  if (stateSingle) {
    stateSingle.classList.remove('v5-animate-enter');
    void stateSingle.offsetWidth;
    stateSingle.classList.add('v5-animate-enter');
  }

  // Band 1: Hero Name (with V5 dynamic font scaling)
  const nameEl = document.getElementById('single-name');
  if (nameEl) {
    nameEl.textContent = p.name;
    nameEl.classList.remove('hero-name--short', 'hero-name--medium', 'hero-name--long');
    const len = (p.name || '').length;
    if (len <= 16) {
      nameEl.classList.add('hero-name--short');
    } else if (len <= 30) {
      nameEl.classList.add('hero-name--medium');
    } else {
      nameEl.classList.add('hero-name--long');
    }
  }
  const barcodeEl = document.getElementById('single-barcode');
  if (barcodeEl) barcodeEl.textContent = p.barcode;

  // Band 2: 3-Column Pricing Grid
  const priceEl = document.getElementById('single-sale-price');
  if (priceEl) {
    priceEl.innerHTML = formatV3PriceHTML(p.salePrice, true);
  }

  const mrpEl = document.getElementById('single-mrp');
  if (mrpEl) mrpEl.textContent = formatCurrency(p.mrp);

  const mrpVal = Number(p.mrp);
  const saleVal = Number(p.salePrice);
  const discountCol = document.getElementById('single-discount-col');
  const discountEl = document.getElementById('single-discount-percent');

  let discountPercent = 0;
  if (mrpVal > saleVal && mrpVal > 0) {
    discountPercent = Math.round(((mrpVal - saleVal) / mrpVal) * 100);
    if (discountEl) {
      discountEl.innerHTML = `<div class="v5-discount-stack"><span class="v5-discount-num">${discountPercent}%</span><span class="v5-discount-off">OFF</span></div>`;
    }
    if (discountCol) discountCol.style.visibility = 'visible';
  } else {
    if (discountEl) {
      discountEl.innerHTML = `<svg class="v5-cash-coin-icon" viewBox="0 0 24 24" fill="none" stroke="#16a34a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 9.5h4.5a1.5 1.5 0 0 1 0 3H9.5a1.5 1.5 0 0 0 0 3H15"/></svg>`;
    }
    if (discountCol) discountCol.style.visibility = 'visible';
  }

  // Band 3: Dynamic Reward Capsule (Type 1: Single Savings / Type 2: Bulk Offer)
  const footerText = document.getElementById('single-footer-text');
  if (footerText) {
    const hasBulk = FeatureFlags.isEnabled('FEATURE_BULK_OFFERS') &&
                    p.wholesalePrice !== undefined && p.wholesalePrice !== null &&
                    p.wholesaleQty !== undefined && p.wholesaleQty !== null;

    if (hasBulk) {
      // Type 2: Bulk Offer (Spread throughout footer: GET Qty @ StruckSalePrice WholesalePrice)
      AnalyticsService.logEvent('bulk_offer_shown', { barcode: p.barcode });
      footerText.innerHTML = `<div class="v5-bulk-row"><span class="v5-bulk-prefix">GET</span><span class="v5-bulk-qty">${p.wholesaleQty}</span><span class="v5-bulk-at">@</span><span class="v5-bulk-struck">${formatCurrency(p.salePrice)}</span><span class="v5-bulk-hero">${formatV3PriceHTML(p.wholesalePrice, false)}</span></div>`;
    } else {
      // Type 1: Single Product (YOU SAVE ₹XX on one line)
      const savingsVal = mrpVal > saleVal ? (mrpVal - saleVal) : 0;
      footerText.innerHTML = `<div class="v5-save-row"><span class="v5-save-label">YOU SAVE</span><span class="v5-save-val">${formatV3PriceHTML(savingsVal, false)}</span></div>`;
    }
  }

  addToHistory(p);
  triggerFeedbackPopup(p.name);
  lastScannedBarcode = barcode || p.barcode;
}

// Fetch pricing values from endpoint
async function lookupBarcode(barcode) {
  if (lookupInProgress) {
    if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) console.log(`[DEBUG] Lookup request blocked: barcode ${barcode} is already in progress.`);
    return;
  }

  lookupInProgress = true;
  currentRecoveryBarcode = barcode;

  // Dev metrics start
  const apiStart = Date.now();
  if (firstDecodeTime === 0) {
    firstDecodeTime = performance.now();
    if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) console.log(`[METRICS] First successful decode at: ${Math.round(firstDecodeTime - cameraStartTime)}ms from camera start`);
  }

  // Transition card out: add replacing class to single state or multi state
  const singleState = document.getElementById('state-single');
  const multiState = document.getElementById('state-multiple');
  const priceValEl = document.getElementById('single-sale-price');

  if (singleState) singleState.classList.add('replacing');
  if (multiState) multiState.classList.add('replacing');
  if (priceValEl) priceValEl.classList.add('faded');

  // Switch to loading state if no card is visible yet
  const states = getStates();
  const statesKeys = Object.keys(states);
  let anyProductVisible = false;
  statesKeys.forEach(k => {
    if ((k === 'single' || k === 'multiple') && states[k] && states[k].style.display === 'flex') {
      anyProductVisible = true;
    }
  });
  if (!anyProductVisible) {
    StateManager.transitionTo('LOOKUP');
  }
  setScannerGuidance('Scanning…');

  // Barcode character and Unicode points inspection
  const inspectPlatform = /iPad|iPhone|iPod/.test(navigator.userAgent) ? 'iOS' : 'Android/Desktop';
  const inspectBarcodeString = (bc, platform) => {
    if (typeof bc !== 'string') return;
    const len = bc.length;
    const pts = [];
    for (let i = 0; i < len; i++) {
      pts.push(`U+${bc.charCodeAt(i).toString(16).padStart(4, '0')}`);
    }
    if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) {
      console.log(`[LookupPipeline] [${platform}] Decoded Barcode: "${bc}" (Length: ${bc.length})`);
      console.log(`[LookupPipeline] [${platform}] Unicode points: ${pts.join(', ')}`);
      saveDiagnosticsTelemetry({
        lastInspectedBarcode: bc,
        lastInspectedBarcodeLength: len,
        lastInspectedBarcodeUnicode: pts.join(', ')
      });
    }
  };
  inspectBarcodeString(barcode, inspectPlatform);

  const lookupUrl = `/api/products/lookup/${encodeURIComponent(barcode)}`;
  if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) {
    console.log(`[LookupPipeline] URL before fetch: "${lookupUrl}"`);
    console.log(`[LookupPipeline] HTTP Method: GET`);

    saveDiagnosticsTelemetry({
      lastLookupUrl: lookupUrl,
      lastLookupMethod: 'GET',
      lastLookupStatus: 'Pending...',
      lastLookupHeaders: '',
      lastLookupRawBody: '',
      lastLookupError: '',
      lastLookupJsonError: '',
      lastLookupStack: ''
    });
  }

  try {
    if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) {
      console.log(`[LookupPipeline] Sending Network Request...`);
    }
    const response = await fetch(lookupUrl);
    if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) {
      console.log(`[LookupPipeline] Network Request completed. Status: ${response.status}`);

      const headersObj = {};
      response.headers.forEach((val, key) => {
        headersObj[key] = val;
      });
      console.log(`[LookupPipeline] Response Headers:`, JSON.stringify(headersObj));

      saveDiagnosticsTelemetry({
        lastLookupStatus: response.status,
        lastLookupHeaders: JSON.stringify(headersObj)
      });
    }

    let rawText = '';
    try {
      rawText = await response.text();
      if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) {
        console.log(`[LookupPipeline] Raw Response Body:`, rawText);
        saveDiagnosticsTelemetry({
          lastLookupRawBody: rawText.substring(0, 1000)
        });
      }
    } catch (readErr) {
      if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) {
        console.error(`[LookupPipeline] Failed to read raw response text:`, readErr);
        saveDiagnosticsTelemetry({
          lastLookupRawBody: `Error reading body: ${readErr.message}`
        });
      }
      throw readErr;
    }

    const apiEnd = Date.now();
    lastApiDuration = apiEnd - apiStart;
    saveDiagnosticsTelemetry({ avgScanTime: lastApiDuration });
    if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) {
      console.log(`[METRICS] API request duration: ${lastApiDuration}ms`);
      updateDebugOverlay();
    }

    // Wait for the slide-out visual transition to finish (150ms)
    setTimeout(async () => {
      const renderStart = Date.now();

      if (response.status === 200) {
        let data;
        try {
          data = JSON.parse(rawText);
        } catch (jsonErr) {
          console.error(`[LookupPipeline] JSON Parsing Failed! Raw Text: "${rawText}"`, jsonErr);
          saveDiagnosticsTelemetry({
            lastLookupJsonError: jsonErr.message
          });
          handleLookupFailure();
          return;
        }

        // Remove old details layout styles
        if (singleState) singleState.classList.remove('replacing');
        if (multiState) multiState.classList.remove('replacing');

        if (data.multipleMatches && data.products.length > 1) {
          StateManager.transitionTo('DISPLAY_RESULT', { type: 'multiple' });
          AnalyticsService.logEvent('multiple_matches_shown', { barcode: barcode, count: data.products.length });
          const announcer = document.getElementById('a11y-announcer');
          if (announcer) {
            announcer.textContent = `Multiple matches found. ${data.products.length} matching items displayed.`;
          }

          const multiTitle = document.getElementById('multi-title');
          if (multiTitle) multiTitle.innerHTML = `TAP MRP PRINTED<br>ON YOUR PRODUCT`;

          const listContainer = document.getElementById('multi-list');
          if (listContainer) {
            listContainer.innerHTML = '';
            data.products.forEach(p => {
              const btn = document.createElement('button');
              btn.className = 'multi-mrp-btn';
              const formattedMrp = Number(p.mrp).toFixed(2);
              const parts = formattedMrp.split('.');
              btn.innerHTML = `MRP ₹<span class="mrp-btn-value"><span class="mrp-btn-whole">${parts[0]}</span><span class="mrp-btn-decimal">.${parts[1] || '00'}</span></span>`;
              btn.addEventListener('click', () => {
                const detailsCard = document.getElementById('details-card');
                if (detailsCard) detailsCard.classList.add('card-content-updating');
                setTimeout(() => {
                  renderV2ProductCard(p, barcode);
                  if (detailsCard) detailsCard.classList.remove('card-content-updating');
                }, 120);
              });
              listContainer.appendChild(btn);
            });
          }

          addToHistory(data.products[0]);
          lastScannedBarcode = barcode;

          // Resume decoding after 1.0s debounce pause
          setTimeout(() => {
            resetScannerStatusLine();
            lookupInProgress = false;
            isScanPaused = false;
          }, 1000);
        } else if (data.products && data.products.length > 0) {
          const p = data.products[0];
          renderV2ProductCard(p, barcode);

          if (singleState) singleState.classList.remove('replacing');
          if (priceValEl) priceValEl.classList.remove('faded');

          // API/Render metrics
          const renderEnd = Date.now();
          lastRenderDuration = renderEnd - renderStart;
          if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) {
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
          StateManager.transitionTo('ERROR', { type: 'notFound' });
          AnalyticsService.logEvent('product_not_found', { barcode: barcode });
          const announcer = document.getElementById('a11y-announcer');
          if (announcer) {
            announcer.textContent = "Product details not found.";
          }
          // Resume scanning after failure
          setTimeout(() => {
            resetScannerStatusLine();
            lookupInProgress = false;
            isScanPaused = false;
          }, 1000);
        }
      } else {
        if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) {
          console.warn(`[LookupPipeline] Non-200 Response status: ${response.status}. Raw content:`, rawText);
        }
        handleLookupFailure();
      }
    }, 150);

  } catch (err) {
    if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) {
      console.error(`[LookupPipeline] Fetch Rejected Exception:`, err);
      console.error(`[LookupPipeline] Stack Trace:`, err.stack);
      saveDiagnosticsTelemetry({
        lastLookupStatus: 'REJECTED',
        lastLookupError: err.message,
        lastLookupStack: err.stack
      });
    }
    handleLookupFailure();
  }
}

// Graceful lookup error fallback
function handleLookupFailure() {
  const scanFeedback = document.getElementById('scan-feedback');
  if (scanFeedback) {
    scanFeedback.textContent = "Unable to retrieve price, please try again.";
    scanFeedback.classList.add('error-feedback');
    scanFeedback.classList.add('visible');
    setTimeout(() => {
      scanFeedback.classList.remove('visible');
      scanFeedback.classList.remove('error-feedback');
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
  if (!navigator.onLine) {
    StateManager.transitionTo('OFFLINE');
  } else {
    StateManager.transitionTo('ERROR', { type: 'serverError' });
  }

  // Auto-resume scanner loop
  setTimeout(() => {
    resetScannerStatusLine();
    lookupInProgress = false;
    isScanPaused = false;
  }, 1000);
}

// Guidance dialogue controller with smooth fade transition
let guidanceTransitionTimer = null;
function setScannerGuidance(text) {
  const el = document.getElementById('guidance-text') || document.querySelector('.guidance-text');
  if (!el) return;
  if (el.textContent === text && el.style.opacity !== '0') return;

  if (guidanceTransitionTimer) {
    clearTimeout(guidanceTransitionTimer);
  }

  el.style.opacity = '0';
  guidanceTransitionTimer = setTimeout(() => {
    el.textContent = text;
    el.style.opacity = '1';
  }, 120);
}

// Reset status bar display
function resetScannerStatusLine() {
  setScannerGuidance('Align');
  const dot = document.querySelector('.status-dot');
  const text = document.querySelector('.status-text');
  if (dot && text) {
    dot.style.backgroundColor = '#ffffff';
    dot.style.boxShadow = 'none';
    text.textContent = 'Align barcode inside the frame';
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
    StateManager.transitionTo('ERROR', { type: 'cameraDenied', errorString: fullErrorString });
  } else {
    StateManager.transitionTo('ERROR', { type: 'cameraUnavailable', errorString: fullErrorString });
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

  // Candidate barcode detected — prompt user to hold steady
  setScannerGuidance('Steady');

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

  // Signal barcode found on guidance capsule
  setScannerGuidance('Found');

  // A11y and Telemetry Hooks
  AnalyticsService.logEvent('scan_success', { barcode: decodedText });
  const announcer = document.getElementById('a11y-announcer');
  if (announcer) {
    announcer.textContent = "Barcode scanned successfully. Fetching details.";
  }

  // 1. Log metrics in dev environment
  if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) {
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

function closeHistorySheet() {
  const historySheet = document.getElementById('history-sheet');
  const historySheetOverlay = document.getElementById('history-sheet-overlay');
  if (historySheet && historySheetOverlay) {
    historySheet.style.transform = 'translate(-50%, 100%)';
    setTimeout(() => {
      historySheet.style.display = 'none';
      historySheetOverlay.style.display = 'none';
    }, 300);
  }
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

      const hName = document.getElementById('single-name');
      if (hName) hName.textContent = item.name;
      const hBarcode = document.getElementById('single-barcode');
      if (hBarcode) hBarcode.textContent = item.barcode;
      const hPrice = document.getElementById('single-sale-price');
      if (hPrice) hPrice.innerHTML = formatPremiumPrice(item.salePrice);
      const hMrp = document.getElementById('single-mrp');
      if (hMrp) hMrp.textContent = formatCurrency(item.mrp);

      const discountBadge = document.getElementById('single-discount-badge');
      if (discountBadge) {
        const mrpVal = Number(item.mrp);
        const saleVal = Number(item.salePrice);
        if (mrpVal > saleVal && mrpVal > 0) {
          const discountPercent = Math.round(((mrpVal - saleVal) / mrpVal) * 100);
          const savedVal = (mrpVal - saleVal).toFixed(2).replace(/\.00$/, '');

          const percentEl = document.getElementById('single-discount-percent');
          if (percentEl) percentEl.textContent = `${discountPercent}%`;

          const savedEl = document.getElementById('single-saved-amount');
          if (savedEl) savedEl.textContent = `₹${savedVal}`;

          discountBadge.style.display = 'flex';
        } else {
          discountBadge.style.display = 'none';
        }
      }

      const bulkContainer = document.getElementById('single-bulk-container');
      if (bulkContainer && item.wholesalePrice !== undefined && item.wholesalePrice !== null && item.wholesaleQty !== undefined && item.wholesaleQty !== null) {
        const bQty = document.getElementById('single-bulk-qty');
        if (bQty) bQty.textContent = `Buy ${item.wholesaleQty} or more`;
        const bPrice = document.getElementById('single-bulk-price');
        if (bPrice) bPrice.textContent = `${formatCurrency(item.wholesalePrice)} each`;
        const savings = (Number(item.salePrice) - Number(item.wholesalePrice)) * Number(item.wholesaleQty);
        const bSavings = document.getElementById('single-bulk-savings');
        if (bSavings) bSavings.textContent = 'Save ' + formatCurrency(savings).replace('.00', '');
        bulkContainer.style.display = 'flex';
      } else if (bulkContainer) {
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

// Bind DOM event listeners for Scanner Page
document.addEventListener('DOMContentLoaded', () => {
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

  const openHistoryBtn = document.getElementById('open-history-btn');
  const closeHistoryBtn = document.getElementById('close-history-btn');
  const historySheetOverlay = document.getElementById('history-sheet-overlay');

  if (openHistoryBtn && historySheetOverlay) {
    openHistoryBtn.addEventListener('click', () => {
      renderRecentScansBottomSheet();
      historySheetOverlay.style.display = 'block';
      const historySheet = document.getElementById('history-sheet');
      if (historySheet) {
        historySheet.style.display = 'flex';
        setTimeout(() => {
          historySheet.style.transform = 'translate(-50%, 0)';
        }, 10);
      }
    });
  }

  if (closeHistoryBtn) {
    closeHistoryBtn.addEventListener('click', closeHistorySheet);
  }
  if (historySheetOverlay) {
    historySheetOverlay.addEventListener('click', closeHistorySheet);
  }

  const retryDenied = document.getElementById('retry-camera-denied-btn');
  if (retryDenied) {
    retryDenied.addEventListener('click', () => {
      console.log('[Diag] Retry Camera Denied clicked. Transitioning state to SCANNING...');
      StateManager.transitionTo('SCANNING');
      setTimeout(async () => {
        try {
          await CameraManager.start();
        } catch (err) {
          console.error('[Diag] Retry camera startup failed:', err);
        }
      }, 150);
    });
  }

  const retryUnavailable = document.getElementById('retry-camera-unavailable-btn');
  if (retryUnavailable) {
    retryUnavailable.addEventListener('click', () => {
      console.log('[Diag] Retry Camera Unavailable clicked. Transitioning state to SCANNING...');
      StateManager.transitionTo('SCANNING');
      setTimeout(async () => {
        try {
          await CameraManager.start();
        } catch (err) {
          console.error('[Diag] Retry camera startup failed:', err);
        }
      }, 150);
    });
  }

  const retryNetwork = document.getElementById('retry-network-btn');
  if (retryNetwork) {
    retryNetwork.addEventListener('click', () => {
      if (currentRecoveryBarcode) {
        lookupBarcode(currentRecoveryBarcode);
      }
    });
  }

  const retryServer = document.getElementById('retry-server-btn');
  if (retryServer) {
    retryServer.addEventListener('click', () => {
      if (currentRecoveryBarcode) {
        lookupBarcode(currentRecoveryBarcode);
      }
    });
  }

  // Initialize Session History from LocalStorage
  if (typeof FeatureFlags !== 'undefined' && FeatureFlags.isEnabled('FEATURE_RECENT')) {
    try {
      const cached = localStorage.getItem('recent_scans');
      if (cached) {
        recentScans = JSON.parse(cached);
        renderRecentScans();
      }
    } catch (e) {
      console.warn('Failed to load cached scan history', e);
    }
  } else {
    const container = document.querySelector('.recently-scanned-trigger-container');
    if (container) container.style.display = 'none';
  }

  // Scan Lock background cleaner: resets barcode lock if absent for 2 seconds
  setInterval(() => {
    if (lastScannedBarcode && Date.now() - lastSeenTime > 2000) {
      if (typeof DEBUG_MODE !== 'undefined' && DEBUG_MODE) console.log(`[DEBUG] Scan lock on barcode ${lastScannedBarcode} cleared after 2.0s of absence.`);
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
});

// Auto-playing promotions carousel runner
(function initPromotionsCarousel() {
  const track = document.getElementById('promo-carousel-track');
  if (!track) return;

  let currentSlideIndex = 0;

  setInterval(() => {
    const slides = track.querySelectorAll('.promo-slide');
    if (slides.length <= 1) return;

    slides[currentSlideIndex].classList.remove('active');
    currentSlideIndex = (currentSlideIndex + 1) % slides.length;
    if (slides[currentSlideIndex]) {
      slides[currentSlideIndex].classList.add('active');
    }
  }, 4000); // Transitions every 4 seconds
})();

// Scanner state visual updates (laser control, scanning status text)
(function monitorScannerState() {
  const laserLine = document.querySelector('.scanner-laser-beam');

  if (laserLine) {
    laserLine.style.animationPlayState = 'running';
    laserLine.style.display = 'block';
  }

  let lastState = null;
  let lastLowLight = null;

  setInterval(() => {
    if (typeof StateManager === 'undefined') return;
    const state = StateManager.currentState;
    const lowLightEl = document.getElementById('low-light-suggestion');
    const isLowLight = lowLightEl && lowLightEl.style.display !== 'none';

    if (state === lastState && isLowLight === lastLowLight) return;
    lastState = state;
    lastLowLight = isLowLight;

    if (isLowLight) {
      setScannerGuidance('Low-light');
    } else if (state === 'LOOKUP' || lookupInProgress) {
      setScannerGuidance('Scanning…');
    } else if (state === 'DISPLAY_RESULT' && isScanPaused) {
      setScannerGuidance('Found');
    } else if (state === 'SCANNING' && !isScanPaused) {
      setScannerGuidance('Align');
    } else if (state === 'READY') {
      setScannerGuidance('Align');
    }
  }, 100);
})();
