/* ==========================================================================
   78 PRICE CHECK — SCANNER PAGE SCRIPT (scanner.js)
   Canonical runtime script for #scanner-view & CameraManager (Stage 2 Isolation)
   ========================================================================== */

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
      if (DEBUG_MODE) {
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

// Scanner state visual updates (laser control, scanning status text)
(function monitorScannerState() {
  const laserLine = document.querySelector('.scanner-laser-beam');
  const statusDot = document.querySelector('.guidance-dot');
  const statusText = document.querySelector('.guidance-text');
  
  if (laserLine) {
    laserLine.style.animationPlayState = 'running';
    laserLine.style.display = 'block';
  }
  
  let lastState = null;
  
  setInterval(() => {
    const state = StateManager.currentState;
    if (state === lastState) return;
    lastState = state;
    
    if (statusDot && statusText) {
      if (state === 'SCANNING') {
        statusDot.className = 'guidance-dot scanning';
        statusText.textContent = 'Align barcode within frame';
      } else if (state === 'LOOKUP') {
        statusDot.className = 'guidance-dot loading';
        statusText.textContent = 'Looking up product...';
      } else if (state === 'DISPLAY_RESULT') {
        statusDot.className = 'guidance-dot ready';
        statusText.textContent = 'Barcode detected';
      } else {
        statusDot.className = 'guidance-dot offline';
        statusText.textContent = 'Scanner ready';
      }
    }
  }, 100);
})();
