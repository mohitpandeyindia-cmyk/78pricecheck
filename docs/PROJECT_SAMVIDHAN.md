# SEVENTYEIGHTOS: Project Samvidhan (Governing Constitution)

This document is the supreme governing constitution for the development and operation of **78 PriceCheck** on the **78OS** digital operating platform. All engineering architectures, database implementations, API contracts, and user experience components must comply strictly with the articles and rules established herein.

---

## PART I: THE CONSTITUTIONAL ARTICLES

### Article I – Project Identity
*   **Project Name**: 78 PriceCheck
*   **Platform**: 78OS
*   **Owner**: 78 Supermaart

### Article II – Customer Rights
Every customer using the system has the absolute right to:
1.  **See the latest verified price**: Displayed immediately without stall or cache lag.
2.  **Get a response in under 3 seconds**: Entire page load, camera initialization, and lookup must take under 3 seconds total.
3.  **Never be asked to log in**: Zero signup screens, authorization checks, or profiling blocks for customers checking prices.
4.  **Continue scanning without restarting the camera**: The scanning canvas must remain active, allowing sequential checks without screen reloading.

### Article III – System Principles
1.  **Barcode-first lookup**: Searching must prioritize direct, exact barcode recognition.
2.  **Excel is the single source of truth**: Store product pricing is defined solely by the complete product catalogue replacement from the administrator's Excel upload.
3.  **Mobile-first design**: Layouts must fit naturally on handheld screens with one-handed controls.
4.  **No unnecessary animations**: Minimize decorative motions that consume processing power or delay visual readouts.
5.  **No feature that slows scanning**: If a potential feature degrades camera decoding speed, it is strictly forbidden.

### Article IV – Engineering Rules
1.  **No breaking API contracts** without prior written approval.
2.  **No database schema changes** without prior written approval.
3.  **One milestone at a time**: Deliver and finalize milestones sequentially.
4.  **Every milestone must be testable**: Code changes must include test cases and verify successfully.
5.  **Production-quality code only**: Clean patterns, full TypeScript typing, error boundaries, and no debug artifacts left in production.
6.  **Milestone Documentation Requirement**: Every completed milestone must document: Files created, Files modified, Database changes, New APIs, Test checklist, Known limitations, Manual testing steps, and Rollback instructions.

### Article V – UI Constitution
1.  **Dedicated scanner page**: High-visibility viewport for barcode tracking.
2.  **Camera remains active**: Keep the media stream hot during customer lookup sessions.
3.  **40% camera / 60% product information**: Proportional layout split on mobile viewports to allow simultaneous sight of the scanning target and the product details.
4.  **Show "Today's Price"**: Explicit, large, high-contrast label displaying the final selling price.
5.  **Show "Barcode Detected"**: Visual indicator popup immediately upon barcode decoding to confirm read action.

### Article VI – Performance Constitution
1.  **Barcode lookup under 1 second**: Local database query response times must be fast and sub-second.
2.  **Usable on mid-range Android devices**: Code and CSS layouts must compile for high-performance execution on basic mobile processors.
3.  **Database indexed**: Key fields (e.g. barcodes, names) must be indexed.
4.  **Lightweight frontend**: Minimize CSS payload, zero heavy framework scripts, and keep assets lightweight.

### Article VII – Price Integrity
The selling price displayed to customers must always match the latest verified price imported by an administrator. The application must never estimate, calculate, or infer a selling price. If no verified price exists, it must clearly inform the customer that the product is unavailable or not found.

### Article VIII – Future Amendments
*   Only the project owner (78 Supermaart) can amend this constitution.

### Article IX – Application Isolation & Routing
1.  **Frontend Separation**: The Customer Application and the Admin Portal must be built as two physically and architecturally independent frontend clients served from separate directories.
2.  **Shared Service Layer**: All database and business logic must remain inside the backend REST APIs. The frontend clients must communicate exclusively via HTTP.
3.  **Directory Mapping**:
    *   `/` -> Serves Customer Application (`frontend/customer/`)
    *   `/admin` -> Serves Admin Login (`frontend/admin/login.html`)
    *   `/admin/upload` -> Serves Upload Portal (`frontend/admin/index.html`)
    *   `/admin/history` -> Serves Upload History (`frontend/admin/history.html`)
4.  **No Merging**: Under no circumstances should the customer and admin code bases or pages be merged.

---

## PART II: DESIGN SYSTEM & AESTHETICS

This section defines the visual styling tokens required to maintain a clean, modern, and welcoming supermarket service feel across 78OS.

### 1. Color Palette
We use functional, bright retail colors that align with premium supermarket service branding:
*   **Backgrounds**:
    *   Base Canvas: `#f8f9fa` (Light grey/off-white)
    *   Elevated Cards & Containers: `#ffffff` (Pure white)
*   **Accents / Statuses**:
    *   Primary Accent: `#1b5e20` (Dark retail green matching 78 Supermaart branding)
    *   Secondary Green: `#2e7d32` (For success states and "Today's Price")
    *   Error: `#ff453a` / `#dc3545` (Coral Red/Red - represents item not found or connection issues)
    *   Muted Info: `#6c757d` (Cool gray for helper labels, barcodes, and borders)
*   **Borders**: `1px solid #dee2e6` (Clean light grey borders)

### 2. Typography
*   **Main Font**: `Outfit` (imported from Google Fonts) for headers and instructions.
*   **Numbers & Prices**: Monospace (`JetBrains Mono` or similar system monospace font) to render prices and barcodes clearly without layout shifting.

### 3. UI Effects & Shapes
*   **Soft Rounded Corners**: Use `border-radius: 8px` on buttons, inputs, and cards.
*   **Subtle Shadows Only**: Flat, light shadows to elevate cards from backgrounds (`box-shadow: 0 4px 12px rgba(0, 0, 0, 0.05)`).
*   **No Decorative Effects**: No glassmorphism, no neon glows, no futuristic styling, and no cyberpunk elements.

---

## PART III: PRODUCT APPLICATION FLOWS

### 1. Customer Price Verification
1.  **Scanning**: Viewport scans code -> emits "Barcode Detected" feedback -> decodes.
2.  **Display**: Displays product name, glowing price under "Today's Price" (Sale Price), and MRP.
3.  **Session History**: Lists recently scanned items at the bottom.

### 2. Administrator Controls
1.  **Dashboard**: Metrics (total products, low stock alerts).
2.  **Import**: Drag-and-drop Excel spreadsheets to atomically replace the product catalogue. If validation fails for any row, the upload is rejected.
