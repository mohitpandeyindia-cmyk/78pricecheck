// diagnostics.js - Temporary Scanner Diagnostics Mode for iOS/Android Comparative Analysis

(function initDiagnostics() {
  console.log('[Diagnostics] Initializing temporary scanner diagnostics mode with lens switching checks...');

  // State Containers
  let totalAttempts = 0;
  let successAttempts = 0;
  let failedAttempts = 0;
  let currentFailedAttemptsCount = 0;
  let sessionStartTime = performance.now();
  
  let latencies = [];
  let fastestDecode = 9999;
  let slowestDecode = 0;

  let lastGetImageDataTime = 0;
  let isDecoding = false;
  let lastLatency = 0;

  // Frame stats
  let processedFramesCount = 0;
  let processedFps = 0;
  let frameTimestamps = [];
  
  let barcodeTests = [];
  let availableCameras = [];
  let selectedCameraId = '';

  // 1. Hook Canvas getContext/getImageData to calculate ZXing decode latency
  const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  CanvasRenderingContext2D.prototype.getImageData = function(...args) {
    lastGetImageDataTime = performance.now();
    isDecoding = true;
    processedFramesCount++;
    frameTimestamps.push(lastGetImageDataTime);
    
    const now = performance.now();
    frameTimestamps = frameTimestamps.filter(t => now - t < 1000);
    processedFps = frameTimestamps.length;

    return originalGetImageData.apply(this, args);
  };

  function recordDecodeDuration() {
    if (isDecoding) {
      const now = performance.now();
      const duration = now - lastGetImageDataTime;
      isDecoding = false;
      lastLatency = duration;
      latencies.push(duration);
      fastestDecode = Math.min(fastestDecode, duration);
      slowestDecode = Math.max(slowestDecode, duration);
    }
  }

  // 2. Register global callbacks called by customer.js hooks
  window.onDiagnosticsScanDecoded = function(barcodeValue) {
    recordDecodeDuration();
    totalAttempts++;
    successAttempts++;
    
    const now = performance.now();
    const timeToSuccess = Math.round(now - sessionStartTime);

    const distanceVal = document.getElementById('diag-distance-select')?.value || '20 cm';
    const pkgVal = document.getElementById('diag-package-select')?.value || 'Flat Glossy';

    const testEntry = {
      barcode: barcodeValue,
      format: 'EAN_13',
      distance: distanceVal,
      packageType: pkgVal,
      decodeTimeMs: Math.round(lastLatency),
      success: true,
      failedAttemptsBeforeSuccess: currentFailedAttemptsCount,
      timeToFirstSuccessMs: timeToSuccess
    };
    
    barcodeTests.push(testEntry);
    currentFailedAttemptsCount = 0;
    sessionStartTime = performance.now();
    
    updatePanel();
  };

  window.onDiagnosticsScanError = function(errorMessage) {
    recordDecodeDuration();
    totalAttempts++;
    failedAttempts++;
    currentFailedAttemptsCount++;
    updatePanel();
  };

  // 3. Inject CSS Styles
  const style = document.createElement('style');
  style.innerHTML = `
    #diagnostics-panel {
      position: fixed;
      top: 10px;
      left: 10px;
      width: 320px;
      max-height: 85vh;
      overflow-y: auto;
      background: rgba(10, 15, 10, 0.95);
      border: 2px solid #54b419;
      color: #fff;
      font-family: 'Courier New', Courier, monospace;
      font-size: 11px;
      padding: 12px;
      border-radius: 8px;
      z-index: 99999;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.6);
      line-height: 1.35;
    }
    #diagnostics-panel h3 {
      margin: 0 0 8px 0;
      color: #54b419;
      font-size: 12px;
      border-bottom: 1px solid #333;
      padding-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .diag-section {
      margin-bottom: 8px;
      border-bottom: 1px solid #222;
      padding-bottom: 6px;
    }
    .diag-label {
      color: #888;
    }
    .diag-value {
      color: #a5d6a7;
      font-weight: bold;
    }
    .diag-select {
      background: #222;
      color: #fff;
      border: 1px solid #444;
      font-size: 11px;
      width: 100%;
      padding: 3px;
      border-radius: 4px;
      margin-top: 2px;
    }
    .diag-button {
      background: #54b419;
      color: #000;
      border: none;
      font-weight: bold;
      width: 100%;
      padding: 6px;
      border-radius: 4px;
      cursor: pointer;
      margin-top: 6px;
      text-transform: uppercase;
    }
    .diag-button:hover {
      background: #66ff00;
    }
  `;
  document.head.appendChild(style);

  // 4. Inject Panel Markup
  const panel = document.createElement('div');
  panel.id = 'diagnostics-panel';
  document.body.appendChild(panel);

  function getBrowserName() {
    const ua = navigator.userAgent;
    if (ua.includes('Chrome')) return 'Chrome';
    if (ua.includes('Safari')) return 'Safari';
    if (ua.includes('Firefox')) return 'Firefox';
    return 'Unknown';
  }

  function getIOSVersion() {
    const match = navigator.userAgent.match(/OS (\d+)_(\d+)_?(\d+)?/);
    return match ? `${match[1]}.${match[2]}` : 'N/A';
  }

  function getCapabilitiesFormatted() {
    const caps = window.activeTrackCapabilities || {};
    const formatRange = (range) => range ? `[${range.min} - ${range.max}]` : 'Unsupported';
    
    return {
      focusMode: caps.focusMode ? JSON.stringify(caps.focusMode) : 'Unsupported',
      zoom: caps.zoom ? formatRange(caps.zoom) : 'Unsupported',
      torch: caps.torch ? 'Supported' : 'Unsupported',
      exposureMode: caps.exposureMode ? JSON.stringify(caps.exposureMode) : 'Unsupported',
      whiteBalanceMode: caps.whiteBalanceMode ? JSON.stringify(caps.whiteBalanceMode) : 'Unsupported'
    };
  }

  // 5. Enumerate Cameras
  async function loadCameras() {
    try {
      if (typeof Html5Qrcode !== 'undefined') {
        const devices = await Html5Qrcode.getCameras();
        availableCameras = devices || [];
        updatePanel();
      }
    } catch (err) {
      console.warn('[Diagnostics] Failed to load cameras list:', err);
    }
  }

  // Handle active track polling to detect lens changes
  setInterval(() => {
    const video = document.querySelector('#reader video');
    if (video && video.srcObject) {
      const track = video.srcObject.getVideoTracks()[0];
      if (track) {
        const currentLabel = track.label || 'Unknown';
        const currentSettings = track.getSettings ? track.getSettings() : {};
        const currentCaps = track.getCapabilities ? track.getCapabilities() : {};
        
        // Log changes if any values shift dynamically
        if (window.activeTrackSettings && window.activeTrackSettings.width !== currentSettings.width) {
          console.log('[Diagnostics] Camera settings dynamically changed! Old width:', window.activeTrackSettings.width, 'New width:', currentSettings.width);
        }

        window.activeTrackSettings = currentSettings;
        window.activeTrackCapabilities = currentCaps;
      }
    }
  }, 500);

  // 6. Update HTML Panel values
  function updatePanel() {
    const settings = window.activeTrackSettings || {};
    const caps = getCapabilitiesFormatted();
    
    const successRate = totalAttempts > 0 ? ((successAttempts / totalAttempts) * 100).toFixed(1) : '0.0';
    const avgLatency = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
    const resolutionStr = settings.width ? `${settings.width} × ${settings.height}` : 'Unknown';
    const facingModeStr = settings.facingMode || 'Unknown';
    const settingsFps = settings.frameRate ? Math.round(settings.frameRate) : 'Unknown';
    const devId = settings.deviceId ? `${settings.deviceId.substring(0, 8)}...` : 'Unknown';
    const trackLabel = settings.label || 'Unknown';

    const currentBarcode = barcodeTests.length > 0 ? barcodeTests[barcodeTests.length - 1].barcode : 'None';

    // Populate camera selector options
    let cameraOptionsHtml = `<option value="">-- Auto Back Camera --</option>`;
    availableCameras.forEach((cam, idx) => {
      const selected = selectedCameraId === cam.deviceId ? 'selected' : '';
      cameraOptionsHtml += `<option value="${cam.deviceId}" ${selected}>Cam ${idx + 1}: ${cam.label}</option>`;
    });

    panel.innerHTML = `
      <h3>Scanner Diagnostics</h3>
      
      <div class="diag-section">
        <span class="diag-label">Active Lens Label:</span> <span class="diag-value" style="color: #64b5f6;">${trackLabel}</span><br>
        <span class="diag-label">Camera Resolution:</span> <span class="diag-value">${resolutionStr}</span><br>
        <span class="diag-label">Delivered FPS:</span> <span class="diag-value">${settingsFps}</span><br>
        <span class="diag-label">Processed FPS:</span> <span class="diag-value">${processedFps}</span><br>
        <span class="diag-label">Successful Decodes:</span> <span class="diag-value">${successAttempts}</span><br>
        <span class="diag-label">Failed Decodes:</span> <span class="diag-value">${failedAttempts}</span><br>
        <span class="diag-label">Success Rate:</span> <span class="diag-value">${successRate}%</span><br>
        <span class="diag-label">Avg Decode Time:</span> <span class="diag-value">${avgLatency} ms</span>
      </div>

      <div class="diag-section">
        <strong>Hardware Camera Selector:</strong>
        <select id="diag-camera-select" class="diag-select">
          ${cameraOptionsHtml}
        </select>
      </div>

      <div class="diag-section">
        <strong>Camera Settings:</strong><br>
        Facing Mode: <span class="diag-value">${facingModeStr}</span><br>
        Frame Rate: <span class="diag-value">${settingsFps}</span><br>
        Width: <span class="diag-value">${settings.width || 'Unknown'}</span><br>
        Height: <span class="diag-value">${settings.height || 'Unknown'}</span><br>
        Device ID: <span class="diag-value">${devId}</span>
      </div>

      <div class="diag-section">
        <strong>Capabilities:</strong><br>
        Focus Mode: <span class="diag-value">${caps.focusMode}</span><br>
        Zoom: <span class="diag-value">${caps.zoom}</span><br>
        Torch: <span class="diag-value">${caps.torch}</span><br>
        Exposure: <span class="diag-value">${caps.exposureMode}</span><br>
        White Balance: <span class="diag-value">${caps.whiteBalanceMode}</span>
      </div>

      <div class="diag-section">
        <span class="diag-label">Current Barcode:</span> <span class="diag-value" style="color: #66ff00;">${currentBarcode}</span>
      </div>

      <div class="diag-section">
        <label class="diag-label">Current Distance Test:</label>
        <select id="diag-distance-select" class="diag-select">
          <option value="10 cm">10 cm</option>
          <option value="15 cm">15 cm</option>
          <option value="20 cm" selected>20 cm</option>
          <option value="25 cm">25 cm</option>
          <option value="30 cm">30 cm</option>
          <option value="35 cm">35 cm</option>
        </select>

        <label class="diag-label" style="margin-top: 6px; display:block;">Product Type Test:</label>
        <select id="diag-package-select" class="diag-select">
          <option value="Flat Matte">Flat Matte</option>
          <option value="Flat Glossy" selected>Flat Glossy</option>
          <option value="Curved Bottle">Curved Bottle</option>
          <option value="Plastic Bag">Plastic Bag</option>
          <option value="Box">Box</option>
          <option value="Carton">Carton</option>
        </select>
      </div>

      <button id="diag-export-btn" class="diag-button">Export Report</button>
    `;

    // Bind Event Listeners
    document.getElementById('diag-export-btn')?.addEventListener('click', exportReport);
    
    const camSelect = document.getElementById('diag-camera-select');
    if (camSelect) {
      camSelect.addEventListener('change', async (e) => {
        const forcedId = e.target.value;
        selectedCameraId = forcedId;
        console.log('[Diagnostics] Switching camera output to device ID:', forcedId);
        
        if (typeof CameraManager !== 'undefined') {
          await CameraManager.stop();
          sessionStartTime = performance.now();
          currentFailedAttemptsCount = 0;
          
          setTimeout(async () => {
            await CameraManager.start(forcedId || null);
          }, 300);
        }
      });
    }
  }

  // 7. Generate JSON Report Download
  function exportReport() {
    const avgLatency = latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;

    const report = {
      device: navigator.userAgent,
      browser: getBrowserName(),
      iosVersion: getIOSVersion(),
      cameraSettings: window.activeTrackSettings || {},
      cameraCapabilities: window.activeTrackCapabilities || {},
      scannerConfiguration: {
        fps: 15,
        formats: ['EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128']
      },
      decodeStatistics: {
        attempts: totalAttempts,
        successes: successAttempts,
        failed: failedAttempts,
        successRate: totalAttempts > 0 ? ((successAttempts / totalAttempts) * 100).toFixed(2) + '%' : '0%',
        averageLatencyMs: avgLatency,
        fastestLatencyMs: fastestDecode === 9999 ? 0 : Math.round(fastestDecode),
        slowestLatencyMs: Math.round(slowestDecode)
      },
      frameStatistics: {
        deliveredFps: window.activeTrackSettings?.frameRate || 30,
        processedFps: processedFps,
        droppedFrames: Math.max(0, Math.round((window.activeTrackSettings?.frameRate || 30) - processedFps))
      },
      barcodeTests: barcodeTests
    };

    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `scanner_diagnostics_${getBrowserName().toLowerCase()}_report.json`;
    link.click();
    URL.revokeObjectURL(url);
    console.log('[Diagnostics] Telemetry report exported successfully.');
  }

  // Start initialization loop
  setInterval(() => {
    updatePanel();
  }, 1000);

  // Enumerate cameras once after load delay
  setTimeout(() => {
    loadCameras();
  }, 1500);

  updatePanel();
})();
