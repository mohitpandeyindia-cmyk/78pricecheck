# 78 PriceCheck – Release Verification Walkthrough

This document outlines the design structure, features, screen paths, test runs, and manual verification instructions for the complete **78 PriceCheck** customer and administrator portals.

---

## 1. Goal & Architectural Layout

**78 PriceCheck** is a lightweight, responsive supermercado price verification platform. The application enforces a strict separation of concerns:
*   **Decoupled Frontend**: Serves static HTML/CSS/JS files directly from the Express server. The client communicates with database models exclusively through secure public and protected APIs.
*   **Administrative Dashboard (`frontend/admin/`)**: Flat, white-and-green business software theme optimized for auditing catalog updates, error log checks, and transaction replacements.
*   **Customer Price Verifier (`frontend/customer/`)**: Bright, modern light-mode supermarket style (white canvas backgrounds, brand-aligned green accents `#1b5e20`, clean Outfit typography, soft rounded corners, and flat shadows) featuring EAN barcode scanning, split viewports (40% viewfinder, 60% result panels), and rapid error recovery guides.

---

## 2. Completed Client File Layout

```
frontend/
├── customer/
│   ├── index.html        <- Customer Welcome page (served at /)
│   ├── scanner.html      <- Customer QR/Barcode scanning panel (served at /scanner.html)
│   ├── css/
│   │   └── customer.css  <- Modern light supermarket styling sheet
│   └── js/
│       └── customer.js   <- Camera feed decoder, synthetic tone beep oscillator, and EAN lookup handler
└── admin/
    ├── login.html        <- Admin Login credentials page (served at /admin)
    ├── index.html        <- Catalog Uploader dashboard (served at /admin/upload)
    ├── history.html      <- Run history auditing log grid (served at /admin/history)
    ├── css/
    │   └── style.css     <- Shared white-and-green layout stylesheet
    └── js/
        ├── auth.js       <- Session JWT bearer token handler and redirects controller
        ├── login.js      <- Authentication submission processor
        ├── upload.js     <- Progress bar and spreadsheet upload engine
        └── history.js    <- Log list loader and error report CSV downloader
```

---

## 3. Customer Experience UI Features

1.  **Welcome Screen**: Grocery logo, store branding details, and a high-contrast **"Scan Barcode"** button.
2.  **Scanner Viewport (Split Layout)**:
    *   **Upper 40% Viewport**: Embedded `html5-qrcode` viewfinder with center guides box and moving laser line.
    *   **Lower 60% Panel**: Sliding details console showing live search status, product stats, and logs.
3.  **Pricing result overlay states**:
    *   *Idle State*: "Align product barcode in the box above to verify price."
    *   *Loading State*: "Looking up price..." displays instantly on decode.
    *   *Single Match Card*: Product title, large green Today's Price (`Today's Price: ₹10.00`), and struck-through MRP.
    *   *Multiple Matches list*: "Multiple matching products found. Compare by MRP to identify the correct product." Renders separate cards sorted by MRP in ascending order.
    *   *Product Not Found Card*: Friendly alert "Product not found. Please try scanning again or ask a store associate for assistance."
4.  **Automatic Recovery Screens**:
    *   **Camera Permission Denied**: "Camera access is required to scan product barcodes. Please enable camera permission and try again."
    *   **Camera Unavailable**: "Unable to access the camera. Please close other applications using the camera and try again."
    *   **Network Error**: "Unable to connect. Please check your internet connection."
    *   **Server Error**: "Price service is temporarily unavailable. Please try again shortly."
5.  **Scan Success Tones & Beeps**: Synthesizes a high-frequency confirmation tone beep via `AudioContext` and issues a haptic vibration pulse (`navigator.vibrate(80)`).
6.  **Debouncing duplicate same-scans**: Throttles lookups of the same barcode by 2 seconds, but triggers instantly when scanning a different barcode.
7.  **Visual Highlight Pulse**: Flashes a green outline highlight on `#result-panel` for ~300ms on new decodes.

---

## 4. Integration Test Results

We ran both automated backend verification scripts:
*   `npm run test` (Lookup logic): **22 assertions passed successfully**.
*   `npm run test:import` (Import engine): **35 assertions passed successfully**.
*   **Total Integration Checked: 57 assertions passed, 0 failed.**

---

## 5. Manual Verification Instructions

### A. Customer Price Checking Flow
1.  Open your mobile browser and navigate to `http://localhost:8080/`.
2.  Observe the bright green-and-white supermarket greeting layout. Click the primary **"Scan Barcode"** button.
3.  Verify the browser redirects to `/scanner.html` and the camera permission popup appears.
    *   *Denial test*: Deny access and confirm the Camera Permission Denied screen displays with a retry button.
    *   *Permission success*: Accept permission and see the upper viewfinder activate.
4.  Align a product barcode. Confirm:
    *   Vibration triggers and a clean confirmation beep sounds.
    *   "Barcode Detected" flashes.
    *   "Looking up price..." displays, followed by the single product card flashing green briefly (300ms highlight).
5.  Try scanning the same barcode repeatedly; verify lookup throttle halts duplicate queries for 2 seconds. Scan a different barcode; verify it updates immediately.
6.  Scan a code that matches multiple products due to zero-variant configurations. Verify the list renders sorted by price with comparison instruction details.

### B. Admin Portal Catalogue Flow
1.  Navigate to `http://localhost:8080/admin/upload` (or hit `/admin` when auth-token is wiped). Verify the router redirects you to `/admin`.
2.  Enter admin credentials (`admin2` / `password123`). Submit and verify redirect to `/admin/upload`.
3.  Examine the **Current Catalogue** status panel. Verify products count, version name (`YYYYMMDD-seq`), and formatted timestamp display accurately.
4.  Download the template, add invalid rows (such as Sale Price exceeding MRP), and upload the sheet. Observe progress indicator completing and the uploader log console displaying employee-friendly validation error logs.
5.  Click "Download CSV Error Report" on the error block; verify the browser downloads the CSV file.
6.  Upload a valid spreadsheet. Observe the success display, and verify the status panel auto-refreshes to show updated catalog details.
7.  Audit the history table at `/admin/history`. Click logout and verify the session token is wiped from `localStorage`, redirecting you back to `/admin`.
