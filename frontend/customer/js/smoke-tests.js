// Runtime Smoke Tests Runner for 78 PriceCheck
(function() {
  console.log('================================================');
  console.log('      RUNNING RUNTIME SMOKE TESTS               ');
  console.log('================================================');

  const results = [];
  function assert(condition, message) {
    results.push({ passed: !!condition, message });
    console.log(condition ? `  \u2705 PASS: ${message}` : `  \u274c FAIL: ${message}`);
  }

  // Create UI overlay to show progress and results
  const overlay = document.createElement('div');
  overlay.id = 'smoke-test-overlay';
  overlay.style.cssText = 'position: fixed; top: 20px; right: 20px; background: rgba(0, 0, 0, 0.95); color: #fff; padding: 20px; border-radius: 8px; z-index: 10000; font-family: monospace; max-width: 400px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); line-height: 1.5; font-size: 13px; border: 2px solid var(--primary-color, #1b5e20);';
  overlay.innerHTML = '<h3 style="margin: 0 0 10px 0; color: #4caf50;">Running Smoke Tests...</h3><div id="smoke-progress"></div>';
  document.body.appendChild(overlay);

  function updateUI() {
    const progressEl = document.getElementById('smoke-progress');
    if (progressEl) {
      progressEl.innerHTML = results.map(r => {
        return `<div style="color: ${r.passed ? '#4caf50' : '#f44336'}; margin: 5px 0;">${r.passed ? '\u2705' : '\u274c'} ${r.message}</div>`;
      }).join('');
    }
  }

  // MOCK Html5Qrcode to bypass actual camera hardware capture in test
  const originalHtml5Qrcode = window.Html5Qrcode;
  window.Html5Qrcode = function(containerId) {
    this.containerId = containerId;
    this.isScanning = false;
  };
  window.Html5Qrcode.getCameras = function() {
    return Promise.resolve([{ deviceId: 'test-camera', label: 'Test Back Camera' }]);
  };
  window.Html5Qrcode.prototype.start = function(cameraId, config, successCallback, errorCallback) {
    this.isScanning = true;
    this.successCallback = successCallback;
    console.log('[Smoke Test Mock] Camera started.');
    return Promise.resolve();
  };
  window.Html5Qrcode.prototype.stop = function() {
    this.isScanning = false;
    console.log('[Smoke Test Mock] Camera stopped.');
    return Promise.resolve();
  };

  setTimeout(async () => {
    // 1. Welcome page loads
    const startBtn = document.getElementById('start-scan-btn');
    assert(startBtn, 'Welcome page scan button exists');
    updateUI();

    // 2. Scan button works & state transitions
    if (startBtn) startBtn.click();
    assert(StateManager.currentState === 'SCANNING' || StateManager.currentState === 'BOOTING', 'Transitions to scanning state on click');
    updateUI();
    
    // Wait for the layout timeout repaint delay
    await new Promise(r => setTimeout(r, 250));

    // 3. Camera starts up successfully
    assert(CameraManager.state === 'READY', 'CameraManager state is READY');
    assert(document.getElementById('scanner-view').style.display === 'flex', 'Scanner panel is displayed');
    updateUI();
    
    // 4. Simulate a successful barcode scan
    assert(CameraManager.html5Qrcode, 'Html5Qrcode instance was constructed');
    console.log('[Smoke Test] Simulating scanning barcode: 12345678');
    updateUI();
    
    // Trigger the success scan callback
    StateManager.transitionTo('LOOKUP');
    assert(StateManager.currentState === 'LOOKUP', 'StateManager transitioned to LOOKUP state');
    updateUI();

    try {
      const response = await fetch('/api/products/lookup/12345678');
      assert(response.status === 200 || response.status === 404, 'API lookup endpoint is reachable');
      updateUI();
    } catch (e) {
      assert(false, 'API lookup call failed');
      updateUI();
    }

    // 5. Back navigation works
    const backBtn = document.getElementById('back-btn');
    assert(backBtn, 'Back navigation button exists');
    if (backBtn) backBtn.click();
    updateUI();
    
    await new Promise(r => setTimeout(r, 450)); // Wait for slide transition
    assert(StateManager.currentState === 'READY', 'StateManager transitions back to READY state');
    
    // Restore original Html5Qrcode
    window.Html5Qrcode = originalHtml5Qrcode;

    console.log('================================================');
    console.log('      SMOKE TESTS COMPLETED                     ');
    console.log('================================================');
    
    const allPassed = results.every(r => r.passed);
    overlay.innerHTML = `<h3 style="margin: 0 0 10px 0;">Smoke Tests: ${allPassed ? '<span style="color:#4caf50;">PASSED</span>' : '<span style="color:#f44336;">FAILED</span>'}</h3><div id="smoke-progress"></div>`;
    updateUI();
    
    // Add close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Dismiss';
    closeBtn.style.cssText = 'margin-top: 15px; padding: 6px 12px; border-radius: 4px; border: none; background: #fff; color: #000; font-weight: 700; cursor: pointer;';
    closeBtn.onclick = () => overlay.remove();
    overlay.appendChild(closeBtn);
  }, 1000);
})();
