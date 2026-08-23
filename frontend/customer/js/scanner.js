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

// Helper to extract genuine barcode bounding box from ZXing / html5-qrcode result points
function extractBboxFromDecodedResult(decodedResult, video) {
  if (!decodedResult || !video || !(video.videoWidth > 0)) return null;

  let points = null;
  if (Array.isArray(decodedResult.resultPoints)) {
    points = decodedResult.resultPoints;
  } else if (decodedResult.result && Array.isArray(decodedResult.result.resultPoints)) {
    points = decodedResult.result.resultPoints;
  } else if (typeof decodedResult.getResultPoints === 'function') {
    try { points = decodedResult.getResultPoints(); } catch (e) {}
  } else if (decodedResult.result && typeof decodedResult.result.getResultPoints === 'function') {
    try { points = decodedResult.result.getResultPoints(); } catch (e) {}
  }

  if (!points || !Array.isArray(points) || points.length < 2) return null;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let validCount = 0;

  points.forEach(pt => {
    if (!pt) return;
    let px = null, py = null;
    if (typeof pt.x === 'number') px = pt.x;
    else if (typeof pt.getX === 'function') { try { px = pt.getX(); } catch (e) {} }
    else if (typeof pt[0] === 'number') px = pt[0];

    if (typeof pt.y === 'number') py = pt.y;
    else if (typeof pt.getY === 'function') { try { py = pt.getY(); } catch (e) {} }
    else if (typeof pt[1] === 'number') py = pt[1];

    if (px !== null && py !== null && !isNaN(px) && !isNaN(py)) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
      validCount++;
    }
  });

  if (validCount >= 2 && minX !== Infinity && maxX !== -Infinity && (maxX - minX) > 0) {
    const boxW = Math.round(maxX - minX);
    const boxH = Math.round(maxY - minY);
    const cX = Math.round((minX + maxX) / 2);
    const cY = Math.round((minY + maxY) / 2);
    const pctW = Number(((boxW / video.videoWidth) * 100).toFixed(1));
    const pctH = Number(((boxH / video.videoHeight) * 100).toFixed(1));
    return {
      width: boxW,
      height: boxH,
      centerX: cX,
      centerY: cY,
      pctW: pctW,
      pctH: pctH
    };
  }

  return null;
}

// Phase 1 Forensic Diagnostic Telemetry Engine (?scannerDebug=1)
const DiagnosticTelemetry = {
  isScannerDebug: false,
  failedDecodeCount: 0,
  successfulDecodeCount: 0,
  firstDecodeLatencyMs: null,
  lastDecodeTimestamp: null,
  interDecodeIntervalMs: null,
  lastDecodedFormat: 'N/A',
  lastBarcodeOccupancy: null,
  occupancyNote: 'Genuine barcode result points unavailable from decoder (recorded as NULL).',

  init() {
    try {
      this.isScannerDebug = new URLSearchParams(window.location.search).get('scannerDebug') === '1';
    } catch (e) {
      this.isScannerDebug = false;
    }
    if (this.isScannerDebug) {
      console.log('[DiagnosticTelemetry] Hidden Diagnostic Mode Active (?scannerDebug=1)');
      this.updatePanel();
    }
  },

  recordFrameError() {
    this.failedDecodeCount++;
    if (this.isScannerDebug) {
      this.updatePanel();
    }
  },

  recordSuccessfulDecode(decodedText, decodedResult) {
    this.successfulDecodeCount++;
    const now = performance.now();
    if (this.lastDecodeTimestamp !== null) {
      this.interDecodeIntervalMs = Math.round(now - this.lastDecodeTimestamp);
    }
    this.lastDecodeTimestamp = now;

    if (cameraStartTime > 0 && this.firstDecodeLatencyMs === null) {
      this.firstDecodeLatencyMs = Math.round(now - cameraStartTime);
    }

    if (decodedResult) {
      if (decodedResult.resultFormat && decodedResult.resultFormat.formatName) {
        this.lastDecodedFormat = decodedResult.resultFormat.formatName;
      } else if (decodedResult.format && decodedResult.format.formatName) {
        this.lastDecodedFormat = decodedResult.format.formatName;
      } else if (typeof decodedResult.resultFormat === 'string') {
        this.lastDecodedFormat = decodedResult.resultFormat;
      } else if (typeof decodedResult.format === 'string') {
        this.lastDecodedFormat = decodedResult.format;
      }
    }

    const video = document.querySelector('#reader video');
    this.lastBarcodeOccupancy = extractBboxFromDecodedResult(decodedResult, video);

    if (this.isScannerDebug) {
      this.updatePanel();
    }
  },

  updatePanel() {
    if (!this.isScannerDebug) return;

    let panel = document.getElementById('scanner-debug-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'scanner-debug-panel';
      panel.style.cssText = `
        position: fixed;
        bottom: 10px;
        left: 10px;
        right: 10px;
        max-height: 48vh;
        overflow-y: auto;
        background: rgba(15, 23, 42, 0.94);
        color: #38bdf8;
        border: 1.5px solid #0284c7;
        border-radius: 8px;
        padding: 10px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
        line-height: 1.4;
        z-index: 999999;
        box-shadow: 0 10px 25px rgba(0,0,0,0.6);
        pointer-events: auto;
      `;
      document.body.appendChild(panel);
    }

    const video = document.querySelector('#reader video');
    const track = CameraManager.activeTrack || (video && video.srcObject ? video.srcObject.getVideoTracks()[0] : null);

    let settings = {};
    let capabilities = {};
    if (track) {
      if (typeof track.getSettings === 'function') {
        try { settings = track.getSettings() || {}; } catch(e) {}
      }
      if (typeof track.getCapabilities === 'function') {
        try { capabilities = track.getCapabilities() || {}; } catch(e) {}
      }
    }

    const totalDecodes = this.failedDecodeCount + this.successfulDecodeCount;
    const runningSec = cameraStartTime > 0 ? ((performance.now() - cameraStartTime) / 1000).toFixed(1) : '0.0';
    const decodesPerSec = runningSec > 0 ? (totalDecodes / runningSec).toFixed(1) : '0';

    const isIOS = CameraManager.isIOS;
    const reqRes = '640x480 (ideal)';
    const reqFacing = 'environment';
    const reqFps = CameraManager.config ? CameraManager.config.fps : 15;
    const reqCrop = 'ENABLED (Android-equivalent formula)';

    const actWidth = video && video.videoWidth > 0 ? video.videoWidth : (settings.width || 'N/A');
    const actHeight = video && video.videoHeight > 0 ? video.videoHeight : (settings.height || 'N/A');
    const actRes = `${actWidth} × ${actHeight}`;
    const actFacing = settings.facingMode || (track ? track.label : 'N/A');
    const actFps = currentFps > 0 ? currentFps : (settings.frameRate ? Math.round(settings.frameRate) : 'N/A');

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dpr = window.devicePixelRatio || 1;

    let qW = 'N/A', qH = 'N/A', qL = 'N/A', qT = 'N/A', qPctW = 'N/A', qPctH = 'N/A';
    const reader = document.getElementById('reader');
    if (typeof CameraManager.config?.qrbox === 'function' && reader) {
      const rRect = reader.getBoundingClientRect();
      const qDim = CameraManager.config.qrbox(rRect.width || vw, rRect.height || vh);
      if (qDim && qDim.width && qDim.height) {
        qW = qDim.width;
        qH = qDim.height;
        qL = Math.round(((rRect.width || vw) - qW) / 2);
        qT = Math.round(((rRect.height || vh) - qH) / 2);
        qPctW = ((qW / vw) * 100).toFixed(1);
        qPctH = ((qH / vh) * 100).toFixed(1);
      }
    }

    let occHtml = '';
    if (this.lastBarcodeOccupancy) {
      const o = this.lastBarcodeOccupancy;
      occHtml = `BBox: ${o.width}x${o.height}px | Center: (${o.centerX}, ${o.centerY}) | BBox % width: ${o.pctW}% | BBox % height: ${o.pctH}%`;
    } else {
      occHtml = this.occupancyNote;
    }

    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; font-weight:bold; border-bottom:1px solid #0369a1; padding-bottom:4px; margin-bottom:6px; color:#f0f9ff;">
        <span>🔍 IOS QRBOX EXPERIMENT (ios_vga_qrbox)</span>
        <button onclick="document.getElementById('scanner-debug-panel').style.display='none'" style="background:none; border:none; color:#f43f5e; font-weight:bold; cursor:pointer; padding:0 4px;">✕</button>
      </div>

      <div style="margin-bottom:6px;">
        <strong style="color:#fde047;">EXPERIMENT IDENTIFIER:</strong> ios_vga_qrbox<br>
        Resolution requested: 640×480<br>
        Resolution actual: ${actRes}<br>
        QRBOX: ENABLED
      </div>

      <div style="margin-bottom:6px;">
        <strong style="color:#fde047;">VIEWPORT & DEVICE:</strong><br>
        Viewport: ${vw} × ${vh}<br>
        DPR: ${dpr} | OS: ${isIOS ? 'iOS' : 'Android/Desktop'}<br>
        UserAgent: ${navigator.userAgent}
      </div>

      <div style="margin-bottom:6px;">
        <strong style="color:#fde047;">QRBOX FORENSIC GEOMETRY:</strong><br>
        width = ${qW}px | height = ${qH}px<br>
        left = ${qL}px | top = ${qT}px<br>
        QRBOX %: width = ${qPctW}% | height = ${qPctH}%
      </div>

      <div style="margin-bottom:6px;">
        <strong style="color:#fde047;">COORDINATE SYSTEM:</strong><br>
        Viewport (CSS px) mapped to Video Stream (${actRes} hardware px) via html5-qrcode canvas crop
      </div>

      <div style="margin-bottom:6px;">
        <strong style="color:#fde047;">DECODER TELEMETRY:</strong><br>
        Running Time: ${runningSec}s | Attempts/sec: ${decodesPerSec} FPS<br>
        Successful Decodes: ${this.successfulDecodeCount} | Failed Attempts: ${this.failedDecodeCount}<br>
        First Decode Latency: ${this.firstDecodeLatencyMs !== null ? this.firstDecodeLatencyMs + 'ms' : 'Waiting...'}<br>
        Inter-Decode Interval: ${this.interDecodeIntervalMs !== null ? this.interDecodeIntervalMs + 'ms' : 'N/A'}<br>
        Last Decoded Format: ${this.lastDecodedFormat}
      </div>

      <div>
        <strong style="color:#fde047;">BARCODE GEOMETRY (BBOX):</strong><br>
        ${occHtml}
      </div>
    `;
  }
};

// Phase 2A Silent Admin-Controlled Diagnostic Telemetry Pipeline
const SilentDiagnosticService = {
  activeSessionId: null,
  checkInterval: null,
  aggregateInterval: null,
  failedFramesCount: 0,
  lastScanTimestamp: null,

  hasRegisteredDeviceThisVisit: false,

  async init() {
    this.registerDeviceIfNeeded();
    await this.checkActiveSession();
    if (!this.checkInterval) {
      this.checkInterval = setInterval(() => this.checkActiveSession(), 15000);
    }
  },

  registerDeviceIfNeeded() {
    try {
      const devId = this.getOrCreateDeviceId();
      if (!devId || devId === 'unknown' || this.hasRegisteredDeviceThisVisit) return;
      this.hasRegisteredDeviceThisVisit = true;
      fetch('/api/diagnostics/register-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: devId,
          os: CameraManager.isIOS ? 'iOS' : this.getDeviceClassification(),
          browser: /CriOS|Chrome/.test(navigator.userAgent) ? 'Chrome' : (/Safari/.test(navigator.userAgent) ? 'Safari' : 'Other'),
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          devicePixelRatio: window.devicePixelRatio || 1,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight
        })
      }).catch(() => {});
    } catch (e) {}
  },

  async checkActiveSession() {
    try {
      const res = await fetch('/api/diagnostics/active-session');
      if (res.ok) {
        const data = await res.json();
        if (data.active && data.sessionId) {
          if (this.activeSessionId !== data.sessionId) {
            this.activeSessionId = data.sessionId;
            console.log('[SilentDiagnostic] Active admin session detected:', this.activeSessionId);
            this.sendDeviceTelemetry();
            this.startAggregateTimer();
          }
        } else {
          if (this.activeSessionId) {
            console.log('[SilentDiagnostic] Admin session ended');
            this.activeSessionId = null;
            this.stopAggregateTimer();
          }
        }
      }
    } catch (e) {
      // Fail silently
    }
  },

  getOrCreateDeviceId() {
    const STORAGE_KEY = '78pricecheck_device_id';
    try {
      let deviceId = localStorage.getItem(STORAGE_KEY);
      if (!deviceId) {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
          deviceId = crypto.randomUUID();
        } else {
          deviceId = 'dev_' + Date.now() + '_' + Math.random().toString(36).substring(2, 11);
        }
        localStorage.setItem(STORAGE_KEY, deviceId);
      }
      return deviceId;
    } catch (e) {
      return 'unknown';
    }
  },

  getDeviceClassification() {
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/.test(ua);
    return isIOS ? 'iOS' : (isAndroid ? 'Android' : 'Other');
  },

  async sendDeviceTelemetry() {
    if (!this.activeSessionId) return;

    const video = document.querySelector('#reader video');
    const track = CameraManager.activeTrack || (video && video.srcObject ? video.srcObject.getVideoTracks()[0] : null);

    let settings = {};
    let capabilities = {};
    if (track) {
      if (typeof track.getSettings === 'function') {
        try { settings = track.getSettings() || {}; } catch(e) {}
      }
      if (typeof track.getCapabilities === 'function') {
        try { capabilities = track.getCapabilities() || {}; } catch(e) {}
      }
    }

    const ua = navigator.userAgent;
    const isIOS = CameraManager.isIOS;
    const classification = this.getDeviceClassification();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const devId = this.getOrCreateDeviceId();

    let qW = null, qH = null, qPctW = null, qPctH = null;
    const reader = document.getElementById('reader');
    if (typeof CameraManager.config?.qrbox === 'function' && reader) {
      const rRect = reader.getBoundingClientRect();
      const qDim = CameraManager.config.qrbox(rRect.width || vw, rRect.height || vh);
      if (qDim && qDim.width && qDim.height) {
        qW = qDim.width;
        qH = qDim.height;
        qPctW = Number(((qW / vw) * 100).toFixed(1));
        qPctH = Number(((qH / vh) * 100).toFixed(1));
      }
    }

    const payload = {
      sessionId: this.activeSessionId,
      type: 'device',
      data: {
        scannerExperiment: 'ios_vga_qrbox',
        deviceId: devId,
        os: isIOS ? 'iOS' : (classification === 'Android' ? 'Android' : navigator.platform),
        browser: /CriOS|Chrome/.test(ua) ? 'Chrome' : (/Safari/.test(ua) ? 'Safari' : 'Other'),
        userAgent: ua,
        platform: navigator.platform,
        devicePixelRatio: window.devicePixelRatio || 1,
        viewportWidth: vw,
        viewportHeight: vh,
        classification: classification,
        facingMode: settings.facingMode || 'environment',
        cameraLabel: track ? track.label : null,
        requestedWidth: 640,
        requestedHeight: 480,
        videoWidth: video ? video.videoWidth : (settings.width || null),
        videoHeight: video ? video.videoHeight : (settings.height || null),
        aspectRatio: video && video.videoHeight > 0 ? (video.videoWidth / video.videoHeight) : (settings.aspectRatio || null),
        actualFps: currentFps > 0 ? currentFps : (settings.frameRate || null),
        qrboxWidth: qW,
        qrboxHeight: qH,
        qrboxPctW: qPctW,
        qrboxPctH: qPctH,

        zoomSupported: capabilities.zoom ? 1 : (capabilities.zoom === false ? 0 : null),
        zoomMin: capabilities.zoom ? capabilities.zoom.min : null,
        zoomMax: capabilities.zoom ? capabilities.zoom.max : null,
        zoomStep: capabilities.zoom ? capabilities.zoom.step : null,
        focusModeSupported: capabilities.focusMode ? 1 : (capabilities.focusMode === false ? 0 : null),
        availableFocusModes: capabilities.focusMode ? JSON.stringify(capabilities.focusMode) : null,
        focusDistanceSupported: capabilities.focusDistance ? 1 : (capabilities.focusDistance === false ? 0 : null),
        torchSupported: capabilities.torch ? 1 : (capabilities.torch === false ? 0 : null),
        exposureSupported: capabilities.exposureMode ? 1 : (capabilities.exposureMode === false ? 0 : null)
      }
    };

    try {
      await fetch('/api/diagnostics/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {}
  },

  async recordScanEvent(barcode, decodedResult) {
    if (!this.activeSessionId) return;

    const now = performance.now();
    const video = document.querySelector('#reader video');
    const timeSinceStartMs = cameraStartTime > 0 ? Math.round(now - cameraStartTime) : null;
    const timeSincePrevMs = this.lastScanTimestamp !== null ? Math.round(now - this.lastScanTimestamp) : null;
    this.lastScanTimestamp = now;

    let format = 'N/A';
    if (decodedResult) {
      if (decodedResult.resultFormat && decodedResult.resultFormat.formatName) {
        format = decodedResult.resultFormat.formatName;
      } else if (decodedResult.format && decodedResult.format.formatName) {
        format = decodedResult.format.formatName;
      } else if (typeof decodedResult.resultFormat === 'string') {
        format = decodedResult.resultFormat;
      } else if (typeof decodedResult.format === 'string') {
        format = decodedResult.format;
      }
    }

    const bbox = extractBboxFromDecodedResult(decodedResult, video);
    const devId = this.getOrCreateDeviceId();

    const payload = {
      sessionId: this.activeSessionId,
      type: 'scan_event',
      data: {
        scannerExperiment: 'ios_vga_qrbox',
        deviceId: devId,
        barcode: barcode,
        format: format,
        deviceOs: CameraManager.isIOS ? 'iOS' : this.getDeviceClassification(),
        browser: /CriOS|Chrome/.test(navigator.userAgent) ? 'Chrome' : (/Safari/.test(navigator.userAgent) ? 'Safari' : 'Other'),
        requestedWidth: 640,
        requestedHeight: 480,
        videoWidth: video ? video.videoWidth : null,
        videoHeight: video ? video.videoHeight : null,
        timeSinceStartMs: timeSinceStartMs,
        timeSincePrevScanMs: timeSincePrevMs,
        decodeAttemptsSincePrev: this.failedFramesCount,
        bboxWidth: bbox ? bbox.width : null,
        bboxHeight: bbox ? bbox.height : null,
        bboxCenterX: bbox ? bbox.centerX : null,
        bboxCenterY: bbox ? bbox.centerY : null,
        bboxPctW: bbox ? bbox.pctW : null,
        bboxPctH: bbox ? bbox.pctH : null
      }
    };

    this.failedFramesCount = 0;

    try {
      await fetch('/api/diagnostics/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {}
  },

  recordFrameError() {
    this.failedFramesCount++;
  },

  async recordMeaningfulEvent(eventType, errorMessage = null) {
    if (!this.activeSessionId) return;

    const payload = {
      sessionId: this.activeSessionId,
      type: 'event',
      data: {
        eventType: eventType,
        classification: this.getDeviceClassification(),
        errorMessage: errorMessage,
        decodeAttempts: this.failedFramesCount
      }
    };

    try {
      await fetch('/api/diagnostics/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {}
  },

  startAggregateTimer() {
    if (this.aggregateInterval) clearInterval(this.aggregateInterval);
    this.aggregateInterval = setInterval(() => this.sendIntervalAggregate(), 30000);
  },

  stopAggregateTimer() {
    if (this.aggregateInterval) {
      clearInterval(this.aggregateInterval);
      this.aggregateInterval = null;
    }
  },

  async sendIntervalAggregate() {
    if (!this.activeSessionId) return;

    const failed = this.failedFramesCount;
    this.failedFramesCount = 0;

    const payload = {
      sessionId: this.activeSessionId,
      type: 'interval_aggregate',
      data: {
        eventType: 'interval_aggregate',
        classification: this.getDeviceClassification(),
        failedAttempts: failed,
        avgFps: currentFps > 0 ? currentFps : 15,
        durationSec: 30
      }
    };

    try {
      await fetch('/api/diagnostics/telemetry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (e) {}
  }
};

const CameraManager = {
  state: 'IDLE',
  html5Qrcode: null,
  config: null,
  isIOS: false,
  activeTrack: null,

  init() {
    DiagnosticTelemetry.init();
    SilentDiagnosticService.init();

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

      // Controlled Single-Variable Experiment: Reuse exact same Android qrbox calculation on iOS
      scanConfig.qrbox = this.config.qrbox;

      if (this.isIOS) {
        console.log('[CameraManager] iOS device detected. Controlled Experiment (ios_vga_qrbox): Requesting 640x480 ideal resolution WITH Android-equivalent qrbox crop...');
        scanConfig.videoConstraints = {
          facingMode: "environment",
          width: { ideal: 640 },
          height: { ideal: 480 }
        };
        await this.html5Qrcode.start({ facingMode: "environment" }, scanConfig, onBarcodeDecoded, onBarcodeScanError);
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

            DiagnosticTelemetry.updatePanel();
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

const CAROUSEL_THEMES = ['theme-green', 'theme-blue', 'theme-yellow', 'theme-orange', 'theme-purple', 'theme-red'];

function getCategoryTheme(prodIdx, usedThemes = []) {
  let themeIdx = Math.abs((prodIdx * 7 + 13) % CAROUSEL_THEMES.length);
  let attempts = 0;
  while (usedThemes.includes(CAROUSEL_THEMES[themeIdx]) && attempts < CAROUSEL_THEMES.length) {
    themeIdx = (themeIdx + 1) % CAROUSEL_THEMES.length;
    attempts++;
  }
  return CAROUSEL_THEMES[themeIdx];
}

function updateV4CardContent(cardNode, p, stateClass, isHero, theme) {
  cardNode.setAttribute('data-theme', theme);
  cardNode.className = `promo-card ${stateClass} ${theme}`;

  const mrpVal = Math.round(Number(p.mrp));
  const saleVal = Math.round(Number(p.salePrice));
  const discVal = Math.round(Number(p.discountPercent));

  cardNode.innerHTML = `
    <div class="promo-card-badge">${isHero ? `🔥 SAVE ${discVal}%` : `SAVE ${discVal}%`}</div>
    <div class="promo-card-name">${escapeHtml(p.name)}</div>
    <div class="promo-card-prices">
      <span class="promo-card-sale">₹${saleVal}</span>
      <span class="promo-card-mrp"><span class="promo-card-mrp-label">MRP</span> <span class="promo-card-mrp-val">₹${mrpVal}</span></span>
    </div>
  `;

  // Preserved Click-to-Preview behavior (Section 3 integration)
  cardNode.onclick = () => {
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

  // Initialize exactly 5 DOM nodes in track (V4.4 Conveyor Track)
  track.innerHTML = '';
  const nodes = [];
  for (let i = 0; i < 5; i++) {
    const card = document.createElement('div');
    nodes.push(card);
    track.appendChild(card);
  }

  // Initial full population of all 5 nodes at rest with 3 distinct visible themes
  const usedThemes = [];
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

    const theme = getCategoryTheme(prodIdx, usedThemes);
    if (i >= 1 && i <= 3) {
      usedThemes.push(theme); // Track themes used by visible cards
    }

    updateV4CardContent(nodes[i], p, stateClass, isHero, theme);
  }

  // Baseline rest position (-20% track width = -33.33% viewport width)
  track.style.transition = 'none';
  track.style.transform = 'translateX(-20%)';

  // Synchronized 380ms Conveyor Track Timer Pipeline (Every 4 seconds)
  carouselTimer = setInterval(() => {
    // 1. Initiate synchronized 380ms slide AND card scale/shadow transitions simultaneously at t = 0
    track.style.transition = 'transform 380ms cubic-bezier(0.22, 1, 0.36, 1)';
    track.style.transform = 'translateX(-40%)';

    // Simultaneously update class roles for the 380ms movement so cards scale smoothly while translating:
    // Node 1 (Left card): moves offscreen left, scales 0.93 -> 0.85, fades out
    // Node 2 (Hero card): moves to Left slot, shrinks 1.06 -> 0.93
    // Node 3 (Right card): moves to Hero center slot, grows 0.93 -> 1.06
    // Node 4 (Hidden Right card): slides into Right slot from offscreen right, scales 0.85 -> 0.93, fades in
    const slidingNodes = Array.from(track.children);
    if (slidingNodes.length === 5) {
      const theme1 = slidingNodes[1].getAttribute('data-theme') || 'theme-green';
      const theme2 = slidingNodes[2].getAttribute('data-theme') || 'theme-green';
      const theme3 = slidingNodes[3].getAttribute('data-theme') || 'theme-green';
      const theme4 = slidingNodes[4].getAttribute('data-theme') || 'theme-green';

      slidingNodes[1].className = `promo-card promo-card--hidden ${theme1}`;
      slidingNodes[2].className = `promo-card promo-card--side ${theme2}`;
      slidingNodes[3].className = `promo-card promo-card--hero ${theme3}`;
      slidingNodes[4].className = `promo-card promo-card--side ${theme4}`;

      // Update 🔥 icon to follow Hero position exclusively
      const b2 = slidingNodes[2].querySelector('.promo-card-badge');
      if (b2) {
        b2.textContent = b2.textContent.replace('🔥 ', '');
      }
      const b3 = slidingNodes[3].querySelector('.promo-card-badge');
      if (b3 && !b3.textContent.includes('🔥')) {
        b3.textContent = '🔥 ' + b3.textContent;
      }
    }

    // 2. Invisible DOM Recycling & Rest Reset at transition end (t = 380ms)
    setTimeout(() => {
      carouselIndex = (carouselIndex + 1) % N;

      // Disable transitions temporarily during DOM re-parenting and rest reset
      track.style.transition = 'none';
      const currentNodes = Array.from(track.children);
      currentNodes.forEach(card => card.style.transition = 'none');

      // Move offscreen left node (DOM Index 0) to end of track (DOM Index 4)
      const firstNode = track.firstElementChild;
      if (firstNode) {
        track.appendChild(firstNode);
      }

      // Reset transform to baseline rest position (-20%)
      track.style.transform = 'translateX(-20%)';
      void track.offsetWidth; // Force layout reflow

      // Re-assign classes and populate ONLY recycled offscreen end node (DOM Index 4)
      const updatedNodes = Array.from(track.children);
      const visibleThemes = [
        updatedNodes[1].getAttribute('data-theme'),
        updatedNodes[2].getAttribute('data-theme'),
        updatedNodes[3].getAttribute('data-theme')
      ];

      for (let i = 0; i < 5; i++) {
        const cardNode = updatedNodes[i];
        let stateClass = 'promo-card--side';
        let isHero = false;

        if (i === 0 || i === 4) {
          stateClass = 'promo-card--hidden';
        } else if (i === 2) {
          stateClass = 'promo-card--hero';
          isHero = true;
        }

        if (i === 4) {
          // Newly recycled end node: Populate with next incoming product & distinct non-duplicate theme
          const prodIdx = (carouselIndex + 3 + N * 100) % N;
          const p = cachedHotDeals[prodIdx];
          const theme = getCategoryTheme(prodIdx, visibleThemes);
          updateV4CardContent(cardNode, p, stateClass, isHero, theme);
        } else {
          // Traveling nodes (0..3): Retain innerHTML & product! Apply baseline rest state class
          const theme = cardNode.getAttribute('data-theme') || 'theme-green';
          cardNode.className = `promo-card ${stateClass} ${theme}`;
        }
      }

      // Re-enable transitions on track and cards for next cycle
      void track.offsetWidth;
      track.style.transition = '';
      updatedNodes.forEach(card => card.style.transition = '');
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

// Reusable Forensic Dynamic-Fit Engine for Geometric Dynamic Zones
const DynamicTextFitEngine = {
  _observerInitialized: false,

  // Forensic Fixed Artwork Exclusions & Vacant Typography Rectangles (Relative to Outer Compartments)
  SPECS: {
    // MRP: Vacant area inside blue MRP compartment
    mrp:           { insetTopPct: 0.04, insetRightPct: 0.04, insetBottomPct: 0.04, insetLeftPct: 0.04 },
    // Sale Price: Vacant SALE VALUE rectangle after vertical blue divider artwork
    sale:          { insetTopPct: 0.04, insetRightPct: 0.04, insetBottomPct: 0.04, insetLeftPct: 0.04 },
    // OFF %: Target actual VACANT DISCOUNT-VALUE BOX (X=736..948, Y=35..192 | Center X=842, Y=113.5)
    off:           { insetTopPct: 0.04, insetRightPct: 0.04, insetBottomPct: 0.04, insetLeftPct: 0.04 },
    // YOU SAVE: Target actual GREEN SAVINGS VALUE BOX (X=351..563, Y=430..520 | Center X=457, Y=475)
    savings:       { insetTopPct: 0.04, insetRightPct: 0.04, insetBottomPct: 0.04, insetLeftPct: 0.04 },
    // Wholesale Qty: Target actual VACANT QUANTITY BOX (X=875..975, Y=35..180 | Center X=925, Y=107.5)
    wholesaleQty:  { insetTopPct: 0.04, insetRightPct: 0.04, insetBottomPct: 0.04, insetLeftPct: 0.04 },
    // Wholesale Price: Target actual VACANT WHOLESALE PRICE BOX (X=765..975, Y=180..280 | Center X=870, Y=230)
    wholesalePrice:{ insetTopPct: 0.04, insetRightPct: 0.04, insetBottomPct: 0.04, insetLeftPct: 0.04 }
  },

  fitGroupToZone(element, containerZone, options = {}) {
    if (!element || !containerZone) return;
    const minFontSize = options.minFontSize || 8;
    const maxFontSize = options.maxFontSize || 120;
    const step = options.step || 0.5;
    const spec = options.spec || { insetTopPct: 0.04, insetRightPct: 0.04, insetBottomPct: 0.04, insetLeftPct: 0.04 };

    const style = window.getComputedStyle(containerZone);
    const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);

    const outerW = Math.max(0, containerZone.clientWidth - padX);
    const outerH = Math.max(0, containerZone.clientHeight - padY);

    // Derive explicit Vacant Typography Rectangle bounds (excluding fixed artwork)
    const availableWidth = Math.max(0, outerW * (1 - spec.insetLeftPct - spec.insetRightPct));
    const availableHeight = Math.max(0, outerH * (1 - spec.insetTopPct - spec.insetBottomPct));

    if (availableWidth <= 0 || availableHeight <= 0) return;

    let fontSize = maxFontSize;
    element.style.fontSize = `${fontSize}px`;

    let rect = element.getBoundingClientRect();

    // Enforce GLYPHS ⊂ VACANT TYPOGRAPHY RECTANGLE & FIXED ARTWORK ∩ DYNAMIC GLYPHS = ∅
    while (fontSize > minFontSize && (rect.width > availableWidth || rect.height > availableHeight)) {
      fontSize -= step;
      element.style.fontSize = `${fontSize}px`;
      rect = element.getBoundingClientRect();
    }
  },

  fitCardUnits() {
    requestAnimationFrame(() => {
      const stateSingle = document.getElementById('state-single');
      if (!stateSingle || stateSingle.clientWidth <= 0) return;

      const mrpUnit = document.getElementById('esl-mrp-unit');
      const mrpBox = document.getElementById('esl-mrp-value-box');
      if (mrpUnit && mrpBox) {
        this.fitGroupToZone(mrpUnit, mrpBox, { minFontSize: 8, maxFontSize: 48, spec: this.SPECS.mrp });
      }

      const saleUnit = document.getElementById('esl-sale-unit');
      const saleBox = document.getElementById('esl-sale-value-box');
      if (saleUnit && saleBox) {
        this.fitGroupToZone(saleUnit, saleBox, { minFontSize: 12, maxFontSize: 140, spec: this.SPECS.sale });
      }

      const offUnit = document.getElementById('esl-off-unit');
      const zoneOffBox = document.getElementById('esl-zone-off-pct-value-box');
      if (offUnit && zoneOffBox) {
        this.fitGroupToZone(offUnit, zoneOffBox, { minFontSize: 14, maxFontSize: 56, spec: this.SPECS.off });
      }

      const qtyUnit = document.getElementById('esl-qty-unit');
      const zoneQtyBox = document.getElementById('esl-zone-ws-qty-value-box');
      if (qtyUnit && zoneQtyBox) {
        this.fitGroupToZone(qtyUnit, zoneQtyBox, { minFontSize: 10, maxFontSize: 36, spec: this.SPECS.wholesaleQty });
      }

      const priceUnit = document.getElementById('esl-price-unit');
      const zoneWsPriceBox = document.getElementById('esl-zone-ws-price-value-box');
      if (priceUnit && zoneWsPriceBox) {
        this.fitGroupToZone(priceUnit, zoneWsPriceBox, { minFontSize: 10, maxFontSize: 28, spec: this.SPECS.wholesalePrice });
      }

      const saveUnit = document.getElementById('esl-save-unit');
      const zoneSaveBox = document.getElementById('esl-zone-savings-value-box');
      if (saveUnit && zoneSaveBox) {
        this.fitGroupToZone(saveUnit, zoneSaveBox, { minFontSize: 10, maxFontSize: 28, spec: this.SPECS.savings });
      }
    });
  },

  initResizeObserver() {
    if (typeof ResizeObserver !== 'undefined' && !this._observerInitialized) {
      const stateSingle = document.getElementById('state-single');
      if (stateSingle) {
        const ro = new ResizeObserver(() => {
          this.fitCardUnits();
        });
        ro.observe(stateSingle);
        this._observerInitialized = true;
      }
    }
  }
};

// Render V2 Premium Product Result Card (ESL Shelf Label Architecture)
function renderV2ProductCard(p, barcode) {
  resetBarcodeCollapse();

  // 1. TEMPLATE MODE SELECTION FIRST (Establishes coordinate system before measurement)
  const wQtyNum = Number(p.wholesaleQty);
  const wPriceNum = Number(p.wholesalePrice);
  const hasWholesale = FeatureFlags.isEnabled('FEATURE_BULK_OFFERS') &&
                       p.wholesaleQty !== undefined && p.wholesaleQty !== null &&
                       p.wholesalePrice !== undefined && p.wholesalePrice !== null &&
                       !isNaN(wQtyNum) && wQtyNum > 0 &&
                       !isNaN(wPriceNum) && wPriceNum > 0;

  const cardEl = document.getElementById('state-single');
  if (cardEl) {
    if (hasWholesale) {
      cardEl.classList.add('esl-mode-wholesale');
      cardEl.classList.remove('esl-mode-off');
    } else {
      cardEl.classList.add('esl-mode-off');
      cardEl.classList.remove('esl-mode-wholesale');
    }

    // Enable translucent debug overlay if ?debug=1 URL parameter is set
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('debug') === '1') {
      cardEl.classList.add('esl-debug-compartments');
    }
  }

  StateManager.transitionTo('DISPLAY_RESULT', { type: 'single' });
  const announcer = document.getElementById('a11y-announcer');
  if (announcer) {
    announcer.textContent = `Product found: ${p.name}. Price is ${formatCurrency(p.salePrice)}.`;
  }

  // Trigger micro-animation enter
  const stateSingle = document.getElementById('state-single');
  if (stateSingle) {
    stateSingle.classList.remove('v5-animate-enter');
    void stateSingle.offsetWidth;
    stateSingle.classList.add('v5-animate-enter');
  }

  // Zone 1: Product Name (Max 2 lines, Retail Heavy All-Caps, +35% Size)
  const nameEl = document.getElementById('single-name');
  if (nameEl) {
    const uppercaseName = (p.name || '').toUpperCase();
    nameEl.textContent = uppercaseName;
    nameEl.classList.remove('esl-name--medium', 'esl-name--long');
    const len = uppercaseName.length;
    if (len > 30) {
      nameEl.classList.add('esl-name--long');
    } else if (len > 18) {
      nameEl.classList.add('esl-name--medium');
    }
  }
  const barcodeEl = document.getElementById('single-barcode');
  if (barcodeEl) barcodeEl.textContent = p.barcode;

  // Calculate numeric prices
  const mrpVal = Math.round(Number(p.mrp));
  const rawSale = Number(p.salePrice);
  const saleVal = Math.round(rawSale);
  const savingsVal = mrpVal > saleVal ? (mrpVal - saleVal) : 0;

  // Zone 3: Price Area (MRP & Sale Price)
  const mrpBox = document.getElementById('esl-mrp-value-box');
  if (mrpBox) {
    mrpBox.innerHTML = `<div class="esl-mrp-unit" id="esl-mrp-unit"><span class="esl-mrp-sym">₹</span><span class="esl-mrp-num" id="single-mrp">${mrpVal}</span></div>`;
  }

  const saleBox = document.getElementById('esl-sale-value-box');
  if (saleBox) {
    saleBox.innerHTML = `<div class="esl-sale-unit" id="esl-sale-unit"><span class="esl-rupee">₹</span><span class="esl-sale-num" id="single-sale-price">${saleVal}</span></div>`;
  }

  // Dynamic Geometric Zone Containers
  const zoneOffPct = document.getElementById('esl-zone-off-pct');
  const zoneWsQty = document.getElementById('esl-zone-ws-qty');
  const zoneWsPrice = document.getElementById('esl-zone-ws-price');
  const zoneSavings = document.getElementById('esl-zone-savings');

  const zoneOffBox = document.getElementById('esl-zone-off-pct-value-box');
  const zoneQtyBox = document.getElementById('esl-zone-ws-qty-value-box');
  const zoneWsPriceBox = document.getElementById('esl-zone-ws-price-value-box');

  if (hasWholesale) {
    if (zoneOffPct) zoneOffPct.innerHTML = '';
    if (zoneOffBox) zoneOffBox.innerHTML = '';

    const wPrice = Math.round(wPriceNum);
    const qtyStr = String(p.wholesaleQty);
    const priceStr = `₹${wPrice}`;

    if (zoneQtyBox) {
      zoneQtyBox.innerHTML = `<div class="esl-ws-qty-unit" id="esl-qty-unit">${qtyStr}</div>`;
    }

    if (zoneWsPriceBox) {
      zoneWsPriceBox.innerHTML = `<div class="esl-ws-price-unit" id="esl-price-unit">${priceStr}</div>`;
    }
  } else {
    if (zoneWsQty) zoneWsQty.innerHTML = '';
    if (zoneQtyBox) zoneQtyBox.innerHTML = '';
    if (zoneWsPrice) zoneWsPrice.innerHTML = '';
    if (zoneWsPriceBox) zoneWsPriceBox.innerHTML = '';

    let discountPercent = 0;
    if (mrpVal > saleVal && mrpVal > 0) {
      discountPercent = Math.round(((mrpVal - saleVal) / mrpVal) * 100);
    }

    if (zoneOffBox) {
      zoneOffBox.innerHTML = `
        <div class="esl-off-pct-unit" id="esl-off-unit">
          <span class="esl-off-num">${discountPercent}</span><span class="esl-off-sym">%</span>
        </div>
      `;
    }
  }

  // Geometric Dynamic Zone 4: GREEN_SAVINGS_VALUE_BOX (X=351..563, Y=430..520 | Center X=457, Y=475)
  const zoneSaveBox = document.getElementById('esl-zone-savings-value-box');
  if (zoneSaveBox) {
    if (savingsVal > 0) {
      zoneSaveBox.innerHTML = `<div class="esl-save-unit" id="esl-save-unit"><span class="esl-save-sym">₹</span><span class="esl-save-num">${savingsVal}</span></div>`;
    } else {
      zoneSaveBox.innerHTML = `<div class="esl-save-unit" id="esl-save-unit"><span class="esl-save-sym">₹</span><span class="esl-save-num">0</span></div>`;
    }
  }

  // Initialize ResizeObserver on first render & trigger text fitting on settled layout
  DynamicTextFitEngine.initResizeObserver();
  DynamicTextFitEngine.fitCardUnits();

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
function onBarcodeDecoded(decodedText, decodedResult) {
  DiagnosticTelemetry.recordSuccessfulDecode(decodedText, decodedResult);
  SilentDiagnosticService.recordScanEvent(decodedText, decodedResult);

  const videoEl = document.querySelector('#reader video');
  const actRes = videoEl ? `${videoEl.videoWidth}×${videoEl.videoHeight}` : 'Unknown';
  const timeToDecodeMs = cameraStartTime > 0 ? Math.round(performance.now() - cameraStartTime) : 'N/A';
  console.log(`[DiagnosticExperiment] Barcode Decoded: ${decodedText} | Resolution: ${actRes} | Time from Start: ${timeToDecodeMs}ms | Attempts: ${SilentDiagnosticService.failedFramesCount} | UserAgent: ${navigator.userAgent}`);

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
  DiagnosticTelemetry.recordFrameError();
  SilentDiagnosticService.recordFrameError();
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
