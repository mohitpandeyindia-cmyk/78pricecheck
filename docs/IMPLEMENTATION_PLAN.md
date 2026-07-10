# Milestone 5 Implementation Plan – Customer Experience (SPA Architecture)

We will build the customer-facing price lookup application using a Single-Page Application (SPA) architecture, served from `/` and completely isolated from the Admin Portal.

---

## User Review Required

> [!IMPORTANT]
> **Single-Page Application (SPA) Architecture**:
> *   `frontend/customer/` contains only `index.html`, `css/customer.css`, and `js/customer.js`.
> *   `scanner.html` is removed. All transitions between the **Welcome Screen** and **Active Scanner Viewport** occur dynamically on the same page.
> *   The camera stream initializes only when the customer taps **"Scan Barcode"** and is stopped when they tap **"Back"**.

> [!TIP]
> **Supermarket Aesthetic**:
> *   A bright, clean, premium supermarket service appearance.
> *   Light gray canvas (`#f8f9fa`), white rounded cards (`#ffffff`), and green accents matching 78 Supermaart branding (`#1b5e20`).

---

## Proposed Changes

### Folder Re-organization

```
frontend/
├── customer/
│   ├── index.html        <- Welcome screen and camera split viewport (SPA)
│   ├── css/
│   │   └── customer.css  <- Light supermarket stylesheet
│   └── js/
│       └── customer.js   <- Decoded EAN lookup and state controller
└── admin/
    ├── login.html
    ├── index.html
    ├── history.html
    ├── css/
    │   └── style.css
    └── js/
        ├── auth.js
        ├── login.js
        ├── upload.js
        └── history.js
```

### Backend Component

#### [MODIFY] [index.ts](file:///c:/seventyeightos/backend/src/index.ts)
*   Mount customer SPA static path:
    *   `/` -> Serves `frontend/customer`
*   Remove any explicit route handler for `/scanner.html` (all falls back to customer SPA).

### Frontend - Customer Application

#### [NEW] [customer/index.html](file:///c:/seventyeightos/frontend/customer/index.html)
*   Houses the `#welcome-view` and `#scanner-view` state containers on the same page.
*   `#scanner-view` contains the 40% camera preview viewfinder and the 60% result panel overlays (idle, loading, single, multiple, not found, error recovery alerts).

#### [NEW] [customer/css/customer.css](file:///c:/seventyeightos/frontend/customer/css/customer.css)
*   Supermarket styling sheet featuring white cards, clean grays, green accents, and PWA-friendly responsive layouts.

#### [NEW] [customer/js/customer.js](file:///c:/seventyeightos/frontend/js/customer.js)
*   Enables smooth state transitions, manages the camera scanner session, decodes EAN scans, and executes `/api/products/lookup/:barcode`.

---

## Verification Plan

### Automated Tests
*   `npm run test` (Lookup APIs)
*   `npm run test:import` (Excel import logic)

### Manual Verification
*   Open `http://localhost:8080/`. Confirm bright welcome screen loads.
*   Tap "Scan Barcode". Observe viewfinder slides in and camera starts on the same page (no reload).
*   Test successful lookup beeps/vibrations and error recovery retry paths.
*   Tap "Back" to stop camera and return to welcome view.
