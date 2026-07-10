# SEVENTYEIGHTOS: Software Requirements Specification (SRS)

This document details the functional, non-functional, and technical requirements for **78 PriceCheck**, the first application built on the **SEVENTYEIGHTOS** operating platform.

---

## 1. Functional Requirements

### 1.1 Customer Interface (Mobile-First View)
*   **FR-1.1.1: Barcode Scan Engine**
    *   The app must capture and process live video streams from the customer's camera.
    *   The scanner must recognize common commercial barcodes (EAN-13, EAN-8, UPC-A, UPC-E, Code-128, Code-39).
    *   Visual indicators (a red/amber scan line and targeting reticle) must guide the user's scan placement.
*   **FR-1.1.2: Manual Search Alternative**
    *   If a customer cannot scan a barcode, they must be able to search manually by barcode string or product name.
    *   The search bar must provide instant auto-suggestions matching product names or barcode prefixes as the user types.
*   **FR-1.1.3: Real-Time Price Card Display**
    *   Upon a successful scan or search, the app must display a card containing:
        *   Product Name (large type).
        *   Barcoded number.
        *   Current selling price (conspicuous glowing text).
        *   Original price with strike-through and computed saving percentage (only if the current price is less than original price).
        *   Stock availability indicator (In Stock, Low Stock, Out of Stock).
        *   Category/Department badge.
*   **FR-1.1.4: Scan History Drawer**
    *   The app must maintain a history list of recently scanned products during the active session.
    *   The user must be able to view their running scan count and the estimated cumulative value of their selected items.
    *   A single-button option to clear the history must be provided.

### 1.2 Administrative Interface (Dashboard View)
*   **FR-1.2.1: Bulk Product Import (Excel)**
    *   Administrators must be able to drag-and-drop or select an Excel spreadsheet (`.xlsx` or `.xls`) to bulk upload product data.
    *   The system must read the sheet columns client-side: `Barcode`, `Name`, `Category`, `Price`, `OriginalPrice`, `StockStatus`.
    *   If a barcode already exists, the system must perform an *upsert* (update price/stock/details). If it is new, it must be appended.
*   **FR-1.2.2: Excel Schema Validation**
    *   The upload processor must validate that:
        *   Barcodes are present and contain only alphanumeric values.
        *   Prices are numeric and non-negative.
        *   Required columns (`Barcode`, `Name`, `Price`) are present.
    *   Invalid rows must be flagged with an error count without stopping the insertion of valid rows.
*   **FR-1.2.3: Manual Inventory Management**
    *   Administrators must have a visual form to add, edit, or delete individual products.
*   **FR-1.2.4: Catalog Inventory Table**
    *   A searchable, filterable, and paginated table of all current products in the catalog must be visible.
    *   Allows sorting by Name, Price, and Category.
*   **FR-1.2.5: Excel Schema Template Export**
    *   The admin dashboard must provide a "Download Template" button. Clicking this generates and downloads a `.xlsx` spreadsheet matching the required schema with three rows of sample data.

---

## 2. Non-Functional Requirements

### 2.1 Performance & Latency
*   **NFR-2.1.1: Local Execution Speed**
    *   Product lookups from the local catalog must take less than 10 milliseconds.
    *   Excel parsing for up to 5,000 products must complete in under 2 seconds.
*   **NFR-2.1.2: No External Server Latency**
    *   All business logic, search index lookups, and file imports must run fully inside the client's web browser.

### 2.2 Offline Availability & Data Resilience
*   **NFR-2.2.1: Persistent Database (LocalStorage)**
    *   Catalog data must be synced with the browser's `localStorage` so it persists across refreshes and restarts.
*   **NFR-2.2.2: Local Script Distribution**
    *   External packages (`html5-qrcode.min.js` and `xlsx.full.min.js`) must be stored locally in the `frontend/lib/` directory so the app does not require a live WAN connection to download CDN files at load time.

### 2.3 Environment & Hosting Simplicity
*   **NFR-2.3.1: Zero-Installation Hosting**
    *   The application must be deployable on Windows workstations without installing runtime platforms (Node.js, IIS, Python, or Docker).
    *   A native PowerShell script utilizing standard system .NET components will provide the local static web server to resolve origin security requirements.

### 2.4 Browser Camera Security Origin
*   **NFR-2.4.1: Secure Origin Compliance**
    *   Modern web browsers restrict media capture device access (`getUserMedia`) to secure contexts (`https://` or `localhost`).
    *   The server script must bind to `http://localhost` or `http://127.0.0.1` on port `8080` to satisfy origin security policies.
