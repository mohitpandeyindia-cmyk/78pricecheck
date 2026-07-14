// customer.js
if (window.HTML_BUILD && window.APP_BUILD && window.HTML_BUILD !== window.APP_BUILD.build) {
  console.warn(`[Build Mismatch] HTML expected ${window.HTML_BUILD}, but JS is ${window.APP_BUILD.build}. Forcing refresh...`);
  window.location.reload();
  throw new Error('[Build Mismatch] Execution halted for reload.');
}

// Telemetry Diagnostics Saver
function saveDiagnosticsTelemetry(metrics) {
  try {
    const existing = JSON.parse(localStorage.getItem('78pricecheck_telemetry') || '{}');
    const updated = Object.assign(existing, metrics);
    localStorage.setItem('78pricecheck_telemetry', JSON.stringify(updated));
  } catch (e) {
    // Fail silently
  }
}

const startScanBtn = document.getElementById('start-scan-btn');
const welcomeView = document.getElementById('welcome-view');
const scannerView = document.getElementById('scanner-view');
const backBtn = document.getElementById('back-btn');

const resultPanel = document.getElementById('result-panel');
const scanFeedback = document.getElementById('scan-feedback');
const recentScansList = document.getElementById('recent-scans-list');

// Pricing Result States
const states = {
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

// Centralized Layout Manager
const LayoutManager = {
  recalculateLayout() {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    
    // 1. Set app height variable for devices/browsers that have dvh constraints
    document.documentElement.style.setProperty('--app-height', `${height}px`);
    
    // 2. Set responsive scale factor based on viewport size (reference 375x667)
    const scaleWidth = Math.min(width / 375, 1.25);
    const scaleHeight = Math.min(height / 667, 1.25);
    const scale = Math.min(scaleWidth, scaleHeight);
    document.documentElement.style.setProperty('--responsive-scale', scale.toFixed(2));
    
    console.log(`[LayoutManager] Recalculated size: ${width}x${height}, scale: ${scale.toFixed(2)}`);
  },
  init() {
    this.recalculateLayout();
    window.addEventListener('resize', () => this.recalculateLayout());
    
    // Listen to orientation change via matchMedia API
    const orientationQuery = window.matchMedia('(orientation: landscape)');
    if (typeof orientationQuery.addEventListener === 'function') {
      orientationQuery.addEventListener('change', () => this.recalculateLayout());
    } else if (typeof orientationQuery.addListener === 'function') {
      orientationQuery.addListener(() => this.recalculateLayout());
    }
  }
};

// Feature Flags Configurator
const FeatureFlags = {
  features: {
    FEATURE_BULK_OFFERS: true,
    FEATURE_RECENT: true,
    FEATURE_DEBUG: DEBUG_MODE,
    FEATURE_TORCH: true,
    FEATURE_PRODUCT_IMAGES: false
  },
  isEnabled(key) {
    return !!this.features[key];
  }
};

// Centralized Event Analytics Service
const AnalyticsService = {
  listeners: [],
  
  subscribe(callback) {
    this.listeners.push(callback);
  },
  
  logEvent(eventName, eventData = {}) {
    const payload = {
      event: eventName,
      data: eventData,
      timestamp: Date.now()
    };
    
    if (FeatureFlags.isEnabled('FEATURE_DEBUG')) {
      console.log(`[Analytics Service] Logged: ${eventName}`, eventData);
    }
    
    this.listeners.forEach(cb => {
      try {
        cb(payload);
      } catch (err) {
        console.error('[Analytics Service] Listener invocation failed:', err);
      }
    });
  }
};

// Centralized Error Boundaries Manager
const ErrorManager = {
  handleError(managerName, error, context = {}) {
    console.error(`[ErrorManager] Boundary caught exception in [${managerName}]:`, error, context);
    
    AnalyticsService.logEvent('error_occurred', {
      manager: managerName,
      errorName: error ? error.name : 'UnknownError',
      errorMessage: error ? error.message : String(error),
      context: context
    });
    
    if (managerName === 'CameraManager') {
      const errName = error ? error.name : '';
      const errMsg = error ? (error.message || String(error)) : '';
      const isPermissionDenied = 
        errName === 'NotAllowedError' || 
        errName === 'PermissionDeniedError' || 
        errMsg.toLowerCase().includes('permission') || 
        errMsg.toLowerCase().includes('notallowed');
        
      if (isPermissionDenied) {
        saveDiagnosticsTelemetry({ cameraPermission: 'Denied' });
        StateManager.transitionTo('ERROR', {
          type: 'cameraDenied',
          errorDesc: 'Camera permission is blocked or denied.<br><br>' +
            '<strong>To allow access:</strong><br>' +
            '1. Tap the lock icon (🔒) or settings icon in your Chrome address bar.<br>' +
            '2. Select <strong>"Site settings"</strong> -> <strong>"Camera"</strong> -> <strong>"Allow"</strong>, then reload the page.'
        });
      } else {
        saveDiagnosticsTelemetry({ cameraPermission: 'Failed / Unavailable' });
        StateManager.transitionTo('ERROR', {
          type: 'cameraUnavailable',
          errorDesc: 'Unable to open camera hardware stream.<br><br>Please check camera connections or restart your browser.'
        });
      }
    }
  }
};

// Centralized DOM Render Queue
const DOMRenderQueue = {
  queue: [],
  ticking: false,
  
  enqueue(fn) {
    this.queue.push(fn);
    if (!this.ticking) {
      this.ticking = true;
      requestAnimationFrame(() => this.flush());
    }
  },
  
  flush() {
    while (this.queue.length > 0) {
      const fn = this.queue.shift();
      try {
        fn();
      } catch (err) {
        console.error('[DOMRenderQueue] Execution error:', err);
      }
    }
    this.ticking = false;
  }
};

// Centralized UI State Machine
const StateManager = {
  currentState: 'BOOTING',
  
  transitionTo(newState, data = {}) {
    console.log(`[StateManager] Transition: ${this.currentState} -> ${newState}`);
    this.currentState = newState;
    
    DOMRenderQueue.enqueue(() => {
      this.updateUI(newState, data);
    });
  },
  
  updateUI(state, data) {
    switch (state) {
      case 'BOOTING':
      case 'INITIALIZING':
        welcomeView.style.display = 'flex';
        scannerView.classList.remove('active');
        setTimeout(() => {
          if (this.currentState === 'BOOTING' || this.currentState === 'INITIALIZING') {
            scannerView.style.display = 'none';
          }
        }, 400);
        break;
        
      case 'READY':
        welcomeView.style.display = 'flex';
        scannerView.classList.remove('active');
        setTimeout(() => {
          if (this.currentState === 'READY') {
            scannerView.style.display = 'none';
          }
        }, 400);
        break;
        
      case 'SCANNING':
        welcomeView.style.display = 'flex';
        scannerView.style.display = 'flex';
        setTimeout(() => {
          scannerView.classList.add('active');
        }, 20);
        showState('camera-opening'); // Show premium custom Opening Camera state first
        break;
        
      case 'LOOKUP':
        welcomeView.style.display = 'flex';
        scannerView.style.display = 'flex';
        scannerView.classList.add('active');
        showState('loading');
        break;
        
      case 'DISPLAY_RESULT':
        welcomeView.style.display = 'flex';
        scannerView.style.display = 'flex';
        scannerView.classList.add('active');
        if (data.type === 'single') {
          showState('single');
        } else if (data.type === 'multiple') {
          showState('multiple');
        } else {
          showState('idle');
        }
        break;
        
      case 'OFFLINE':
        welcomeView.style.display = 'flex';
        scannerView.style.display = 'flex';
        scannerView.classList.add('active');
        showState('networkError');
        break;
        
      case 'ERROR':
        welcomeView.style.display = 'flex';
        scannerView.style.display = 'flex';
        scannerView.classList.add('active');
        if (data.type === 'cameraDenied') {
          showState('cameraDenied');
          const desc = states.cameraDenied.querySelector('.error-desc');
          if (desc && data.errorDesc) {
            desc.innerHTML = data.errorDesc;
          }
        } else if (data.type === 'cameraUnavailable') {
          showState('cameraUnavailable');
          const desc = states.cameraUnavailable.querySelector('.error-desc');
          if (desc && data.errorDesc) {
            desc.innerHTML = data.errorDesc;
          }
        } else if (data.type === 'notFound') {
          showState('notFound');
        } else {
          showState('serverError');
        }
        break;
    }
  }
};

// Camera Lifecycle Abstraction Manager
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
    
    if (DEBUG_MODE) cameraStartTime = Date.now();
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
      if (this.isIOS) {
        console.log('[CameraManager] iOS device detected. Bypassing enumeration.');
        await this.html5Qrcode.start({ facingMode: "environment" }, this.config, onBarcodeDecoded, onBarcodeScanError);
      } else {
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
        await this.html5Qrcode.start(cameraArg, this.config, onBarcodeDecoded, onBarcodeScanError);
      }
      
      this.state = 'READY';
      console.log('[CameraManager] Camera start succeeded.');
      
      if (DEBUG_MODE) {
        cameraInitDuration = Date.now() - cameraStartTime;
        console.log(`[METRICS] Camera initialized successfully in ${cameraInitDuration}ms`);
        updateDebugOverlay();
      }
      saveDiagnosticsTelemetry({ 
        cameraStartupTime: cameraInitDuration || (Date.now() - cameraStartTime),
        cameraPermission: 'Granted'
      });
      
      this.applyFocusConstraints();
      startAmbientLightDetection();
      showState('idle');
      
    } catch (err) {
      console.warn('[CameraManager] Main camera start path failed, attempting fallback...', err);
      try {
        await this.html5Qrcode.start({ facingMode: "environment" }, this.config, onBarcodeDecoded, onBarcodeScanError);
        this.state = 'READY';
        saveDiagnosticsTelemetry({ 
          cameraStartupTime: Date.now() - cameraStartTime,
          cameraPermission: 'Granted'
        });
        this.applyFocusConstraints();
        startAmbientLightDetection();
        showState('idle');
      } catch (err2) {
        console.warn('[CameraManager] Fallback environment camera failed, trying user camera...', err2);
        try {
          await this.html5Qrcode.start({ facingMode: "user" }, this.config, onBarcodeDecoded, onBarcodeScanError);
          this.state = 'READY';
          saveDiagnosticsTelemetry({ 
            cameraStartupTime: Date.now() - cameraStartTime,
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
      if (video && video.srcObject) {
        this.activeTrack = video.srcObject.getVideoTracks()[0];
        if (this.activeTrack) {
          const label = this.activeTrack.label || 'Camera Stream';
          let resolution = 'Unknown';
          let hasTorch = 'Not Supported';
          
          if (typeof this.activeTrack.getSettings === 'function') {
            const settings = this.activeTrack.getSettings();
            if (settings.width && settings.height) {
              resolution = `${settings.width} × ${settings.height}`;
            }
          }
          
          if (typeof this.activeTrack.getCapabilities === 'function') {
            const capabilities = this.activeTrack.getCapabilities();
            if (capabilities.torch) {
              hasTorch = 'Supported';
            }
          }
          
          saveDiagnosticsTelemetry({
            cameraLabel: label,
            cameraResolution: resolution,
            cameraTorch: hasTorch
          });
          
          if (typeof this.activeTrack.getCapabilities === 'function') {
            const capabilities = this.activeTrack.getCapabilities();
            if (capabilities.focusMode && capabilities.focusMode.includes('continuous')) {
              this.activeTrack.applyConstraints({
                advanced: [{ focusMode: 'continuous' }]
              }).catch(e => console.log('[CameraManager] Continuous autofocus track constraint failed:', e));
            }
          }
        }
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

// Initialize Layout and Camera Managers
LayoutManager.init();
CameraManager.init();

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
if (FeatureFlags.isEnabled('FEATURE_RECENT')) {
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
    StateManager.transitionTo('LOOKUP');
  }
  
  try {
    const response = await fetch(`/api/products/lookup/${barcode}`);
    const apiEnd = Date.now();
    lastApiDuration = apiEnd - apiStart;
    saveDiagnosticsTelemetry({ avgScanTime: lastApiDuration });
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
          StateManager.transitionTo('DISPLAY_RESULT', { type: 'multiple' });
          AnalyticsService.logEvent('multiple_matches_shown', { barcode: barcode, count: data.products.length });
          const announcer = document.getElementById('a11y-announcer');
          if (announcer) {
            announcer.textContent = `Multiple matches found. ${data.products.length} matching items displayed.`;
          }
          const listContainer = document.getElementById('multi-list');
          listContainer.innerHTML = '';
          
          data.products.forEach(p => {
            const card = document.createElement('div');
            card.className = 'multi-item-card';
            
            let bulkHtml = '';
            if (FeatureFlags.isEnabled('FEATURE_BULK_OFFERS') && p.wholesalePrice !== undefined && p.wholesalePrice !== null && p.wholesaleQty !== undefined && p.wholesaleQty !== null) {
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
                StateManager.transitionTo('DISPLAY_RESULT', { type: 'single' });
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
          
          StateManager.transitionTo('DISPLAY_RESULT', { type: 'single' });
          const announcer = document.getElementById('a11y-announcer');
          if (announcer) {
            announcer.textContent = `Product found: ${p.name}. Price is ${formatCurrency(p.salePrice)}.`;
          }
          document.getElementById('single-name').textContent = p.name;
          document.getElementById('single-barcode').textContent = p.barcode;
          document.getElementById('single-sale-price').innerHTML = formatPremiumPrice(p.salePrice);
          document.getElementById('single-mrp').textContent = formatCurrency(p.mrp);
          
          const bulkContainer = document.getElementById('single-bulk-container');
          if (FeatureFlags.isEnabled('FEATURE_BULK_OFFERS') && p.wholesalePrice !== undefined && p.wholesalePrice !== null && p.wholesaleQty !== undefined && p.wholesaleQty !== null) {
            AnalyticsService.logEvent('bulk_offer_shown', { barcode: p.barcode });
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
  
  // A11y and Telemetry Hooks
  AnalyticsService.logEvent('scan_success', { barcode: decodedText });
  const announcer = document.getElementById('a11y-announcer');
  if (announcer) {
    announcer.textContent = "Barcode scanned successfully. Fetching details.";
  }
  
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
startScanBtn.addEventListener('click', (e) => {
  const rect = startScanBtn.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  
  const ripple = document.createElement('span');
  ripple.className = 'ripple-effect';
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  
  const size = Math.max(rect.width, rect.height);
  ripple.style.width = `${size}px`;
  ripple.style.height = `${size}px`;
  ripple.style.marginLeft = `-${size / 2}px`;
  ripple.style.marginTop = `-${size / 2}px`;
  
  startScanBtn.appendChild(ripple);
  setTimeout(() => ripple.remove(), 400);
  
  setTimeout(() => {
    console.log('[Diag] Scan button click delay timeout expired. Transitioning state to SCANNING...');
    StateManager.transitionTo('SCANNING');
    console.log('[Diag] Deferring camera start to allow browser layout reflow and display flex changes...');
    setTimeout(async () => {
      try {
        console.log('[Diag] Executing camera start after layout delay...');
        await CameraManager.start();
      } catch (err) {
        console.error('[Diag] Camera startup task failed:', err);
      }
    }, 150);
  }, 150);
});

backBtn.addEventListener('click', () => {
  CameraManager.stop();
  StateManager.transitionTo('READY');
});

// Brand Header Home navigation
const headerBrandBtn = document.getElementById('header-brand-btn');
if (headerBrandBtn) {
  headerBrandBtn.addEventListener('click', () => {
    CameraManager.stop();
    StateManager.transitionTo('READY');
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

// Complete Startup Boot Sequence
StateManager.transitionTo('READY');
AnalyticsService.logEvent('app_opened');

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

document.getElementById('retry-camera-unavailable-btn').addEventListener('click', () => {
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

// Register PWA Service Worker with Environment Profiles & Update Manager
const appBuild = window.APP_BUILD || { environment: 'production', serviceWorkerEnabled: true, build: 'v1.1.0' };

if ('serviceWorker' in navigator) {
  if (appBuild.environment === 'development' || appBuild.serviceWorkerEnabled === false) {
    console.log('[PWA] Service Worker disabled in development or via Kill Switch. Cleaning up...');
    navigator.serviceWorker.getRegistrations().then(registrations => {
      if (registrations.length > 0) {
        Promise.all(registrations.map(reg => reg.unregister())).then(() => {
          if ('caches' in window) {
            caches.keys().then(keys => {
              Promise.all(keys.map(key => caches.delete(key))).then(() => {
                window.location.reload();
              });
            });
          } else {
            window.location.reload();
          }
        });
      }
    });
  } else {
    // Staging or Production: Register Service Worker
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').then(reg => {
        console.log('[PWA] Service Worker registered scope:', reg.scope);
        
        // Check for updates
        reg.update();
        
        // Listen for new service worker installs
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', () => {
              // If new worker is fully installed but waiting
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                const banner = document.getElementById('pwa-update-banner');
                if (banner) {
                  banner.style.display = 'flex';
                }
                
                // Kiosk Auto-update timeout: 30 minutes
                setTimeout(() => {
                  if (newWorker.state === 'installed') {
                    console.log('[PWA] Update banner ignored for 30 mins. Forcing background skipWaiting...');
                    newWorker.postMessage('SKIP_WAITING');
                  }
                }, 30 * 60 * 1000);
              }
            });
          }
        });
      }).catch(err => {
        console.warn('[PWA] Service Worker registration failed:', err);
      });
    });
    
    // Listen for controller changes to trigger exactly one reload
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!refreshing) {
        refreshing = true;
        console.log('[PWA] Service Worker controller changed. Reloading page...');
        window.location.reload();
      }
    });
    
    // Bind banner click reload action
    const reloadBtn = document.getElementById('pwa-reload-btn');
    if (reloadBtn) {
      reloadBtn.addEventListener('click', () => {
        navigator.serviceWorker.ready.then(reg => {
          if (reg.waiting) {
            reg.waiting.postMessage('SKIP_WAITING');
          } else {
            window.location.reload();
          }
        });
      });
    }
  }
}
