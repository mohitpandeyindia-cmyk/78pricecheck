/* ==========================================================================
   78 PRICE CHECK — CUSTOMER MAIN APPLICATION INFRASTRUCTURE (customer.js)
   Canonical shared infrastructure script (Stage 2 Isolation)
   ========================================================================== */

// Shared Debug & Diagnostics Utilities (Layer 1 Component)
const DEBUG_MODE = window.location.hostname === 'localhost' ||
                   window.location.hostname === '127.0.0.1' ||
                   window.location.search.includes('debug=true');

function saveDiagnosticsTelemetry(data) {
  try {
    const existing = JSON.parse(localStorage.getItem('scanner_diagnostics_telemetry') || '{}');
    const updated = { ...existing, ...data, lastUpdated: new Date().toISOString() };
    localStorage.setItem('scanner_diagnostics_telemetry', JSON.stringify(updated));
  } catch (e) {
    console.warn('Failed to save diagnostics telemetry to localStorage', e);
  }
}

// App SPA Page Navigation Router
const startScanBtn = document.getElementById('start-scan-btn');
const welcomeView = document.getElementById('welcome-view');
const scannerView = document.getElementById('scanner-view');
const backBtn = document.getElementById('header-back-btn');

function showPage(pageId) {
  const pages = [welcomeView, scannerView];
  pages.forEach(el => {
    if (el) {
      if (el.id === pageId) {
        el.style.display = 'flex';
        el.classList.add('active-page');
      } else {
        el.style.display = 'none';
        el.classList.remove('active-page');
      }
    }
  });
}

// Centralized Layout Manager
const LayoutManager = {
  recalculateLayout() {
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;

    // Scale container dynamically based on aspect ratio
    const appShell = document.querySelector('.app-shell') || document.querySelector('.view-container');
    if (appShell) {
      if (width < 360) {
        appShell.classList.add('compact-screen');
      } else {
        appShell.classList.remove('compact-screen');
      }
    }
  },

  init() {
    this.recalculateLayout();
    window.addEventListener('resize', () => this.recalculateLayout());
    window.addEventListener('orientationchange', () => {
      setTimeout(() => this.recalculateLayout(), 100);
    });
  }
};

// Feature Flags Engine
const FeatureFlags = {
  flags: {
    FEATURE_BULK_OFFERS: true,
    FEATURE_RECENT: true
  },
  isEnabled(flagName) {
    return !!this.flags[flagName];
  }
};

// Analytics Service Mock
const AnalyticsService = {
  logEvent(eventName, payload = {}) {
    if (DEBUG_MODE) {
      console.log(`[Analytics] Event: ${eventName}`, payload);
    }
  }
};

// Centralized Global Error Manager
const ErrorManager = {
  handleError(context, error, metadata = {}) {
    console.error(`[ErrorManager] Exception in ${context}:`, error, metadata);
    saveDiagnosticsTelemetry({
      lastErrorContext: context,
      lastErrorMessage: error ? error.message : String(error),
      lastErrorTime: new Date().toISOString()
    });
  }
};

// DOM Render Queue for Batch Operations
const DOMRenderQueue = {
  queue: [],
  isScheduled: false,
  enqueue(renderFn) {
    this.queue.push(renderFn);
    if (!this.isScheduled) {
      this.isScheduled = true;
      requestAnimationFrame(() => this.flush());
    }
  },
  flush() {
    while (this.queue.length > 0) {
      const fn = this.queue.shift();
      try {
        fn();
      } catch (err) {
        ErrorManager.handleError('DOMRenderQueue', err);
      }
    }
    this.isScheduled = false;
  }
};

// State Machine Engine
const StateManager = {
  currentState: 'IDLE',
  transitionTo(newState, payload = {}) {
    if (DEBUG_MODE) console.log(`[StateManager] Transitioning from ${this.currentState} to ${newState}`, payload);
    const oldState = this.currentState;
    this.currentState = newState;

    // Page visibility routing
    if (newState === 'SCANNING' || newState === 'LOOKUP' || newState === 'DISPLAY_RESULT') {
      showPage('scanner-view');
    } else if (newState === 'READY') {
      showPage('welcome-view');
    }

    // Execute state display helper defined in scanner.js
    if (typeof showState === 'function') {
      if (newState === 'SCANNING') {
        showState('idle');
      } else if (newState === 'LOOKUP') {
        showState('loading');
      } else if (newState === 'DISPLAY_RESULT') {
        if (payload.type === 'multiple') {
          showState('multiple');
        } else {
          showState('single');
        }
      } else if (newState === 'ERROR') {
        showState(payload.type || 'serverError');
      }
    }

    AnalyticsService.logEvent('state_change', { from: oldState, to: newState, payload });
  }
};

// Shared Text & Formatting Helpers
function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
}

function formatCurrency(val) {
  if (val === undefined || val === null) return 'N/A';
  return '₹' + Number(val).toFixed(2);
}

function formatPremiumPrice(val) {
  if (val === undefined || val === null) return 'N/A';
  const formatted = Number(val).toFixed(2);
  const parts = formatted.split('.');
  const wholeNumber = parts[0];
  const decimalNumber = parts[1] || '00';
  return `<span class="price-currency">₹</span><span class="price-whole">${wholeNumber}</span><span class="price-decimal">.${decimalNumber}</span>`;
}

// Theme Manager - Decoupled asset mapper for design system themes (Layer 1)
const ThemeManager = {
  getTheme() {
    const hour = new Date().getHours();
    if (hour >= 6 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'night';
  },

  getBackgroundAsset(theme) {
    const mapping = {
      morning: 'assets/backgrounds/morning.webp',
      afternoon: 'assets/backgrounds/afternoon.webp',
      evening: 'assets/backgrounds/evening.webp',
      night: 'assets/backgrounds/night.webp'
    };
    return mapping[theme] || 'assets/backgrounds/morning.webp';
  }
};

// Initialize Layout and Camera Managers on Page Load
document.addEventListener('DOMContentLoaded', () => {
  LayoutManager.init();
  if (typeof initScannerBackground === 'function') initScannerBackground();
  if (typeof CameraManager !== 'undefined' && CameraManager.init) CameraManager.init();
  if (typeof fetchHotDeals === 'function') fetchHotDeals();
});

// Navigation Click Handlers
if (startScanBtn) {
  startScanBtn.addEventListener('click', (e) => {
    // Add ripple effect feedback
    const ripple = document.createElement('span');
    ripple.className = 'btn-ripple';
    startScanBtn.appendChild(ripple);

    setTimeout(() => {
      ripple.remove();
    }, 600);

    console.log('[App] Start Scanning button clicked. Transitioning state to SCANNING...');
    StateManager.transitionTo('SCANNING');

    // Trigger Camera Startup asynchronously
    setTimeout(async () => {
      try {
        if (typeof CameraManager !== 'undefined' && CameraManager.start) {
          await CameraManager.start();
        }
      } catch (err) {
        console.error('[App] Camera startup exception in click handler:', err);
        if (typeof logAndShowDeniedError === 'function') {
          logAndShowDeniedError(err);
        }
      }
    }, 150);
  });
}

if (backBtn) {
  backBtn.addEventListener('click', async () => {
    console.log('[App] Header Back button clicked. Returning to Welcome View...');
    if (typeof CameraManager !== 'undefined' && CameraManager.stop) {
      await CameraManager.stop();
    }
    StateManager.transitionTo('READY');
  });
}

// Complete Startup Boot Sequence
StateManager.transitionTo('READY');
AnalyticsService.logEvent('app_opened');

// Register PWA Service Worker with Environment Profiles & Update Manager
const appBuild = window.APP_BUILD || { environment: 'production', serviceWorkerEnabled: true, build: 'v1.1.0' };

if (appBuild.serviceWorkerEnabled && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((registration) => {
        console.log(`[PWA Service Worker] Registered successfully in [${appBuild.environment}] mode with scope:`, registration.scope);

        // Listen for new service worker updates
        registration.addEventListener('updatefound', () => {
          const installingWorker = registration.installing;
          if (installingWorker) {
            installingWorker.addEventListener('statechange', () => {
              if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                console.log('[PWA Update] New version available! Prompting user to reload...');
                showUpdateToast(registration);
              }
            });
          }
        });
      })
      .catch((error) => {
        console.warn('[PWA Service Worker] Registration failed:', error);
      });
  });
}

function showUpdateToast(registration) {
  const toast = document.createElement('div');
  toast.id = 'pwa-update-toast';
  toast.className = 'pwa-toast visible';
  toast.innerHTML = `
    <div class="toast-content">
      <span>A new version of 78 Price Check is available!</span>
      <button id="pwa-reload-btn" class="toast-action-btn">Update Now</button>
    </div>
  `;
  document.body.appendChild(toast);

  const reloadBtn = document.getElementById('pwa-reload-btn');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => {
      if (registration.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
      window.location.reload();
    });
  }
}

// Load Runtime Smoke Tests if requested in the URL
if (window.location.search.includes('smoke=true')) {
  const script = document.createElement('script');
  script.src = 'js/smoke-tests.js';
  document.body.appendChild(script);
}
