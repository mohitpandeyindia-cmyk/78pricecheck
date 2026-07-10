# SEVENTYEIGHTOS: Changelog

All notable changes to the **SEVENTYEIGHTOS** and **78 PriceCheck** projects will be documented in this file.

---

## [0.1.0-draft] - 2026-07-10

### Added
- **Project Documentation**: Created the core documentation files inside the `docs/` directory:
  - `PROJECT_SAMVIDHAN.md`: The supreme governing constitution for the project, incorporating customer rights, system principles, performance guarantees, visual styling parameters, and engineering rules.
  - `SRS.md`: Outlined the functional specifications (camera scanning, manual auto-suggest lookup, price detail modals, history running values) and non-functional specifications (performance, offline-readiness, secure context compatibility).
  - `CODING_RULES.md`: Mandated coding, scoping, performance, and architecture rules for developers.
  - `IMPLEMENTATION_PLAN.md`: Mapped the file layout, modular logic components, Excel imports/exports, local PowerShell listener code blocks, and execution phases.
  - `CHANGELOG.md`: Set up this version tracking log.
- **Constitutional Amendment**: Incorporated Article VII (Price Integrity) into `PROJECT_SAMVIDHAN.md`, guaranteeing that displayed prices strictly match administrator-imported data and requiring clear unavailable/not-found notices for products missing a verified price.

## [0.2.0] - 2026-07-10

### Added
- **Authentication System**:
  - Integrated `bcryptjs` for secure admin password hashing.
  - Integrated `jsonwebtoken` for stateless token generation with 12-hour expiration.
  - Created first-time admin registration `POST /api/admin/register` (automatically locking once the first admin user is written).
  - Created admin login `POST /api/admin/login` returning bearer JWT tokens.
  - Created authentication token verification middleware `src/middleware/auth.ts`.
  - Protected admin database setup route `POST /api/admin/setup` using the authentication middleware.
- **Product Lookup API**:
  - Created `GET /api/products/lookup/:barcode` which returns matched products sorted by MRP in ascending order.
  - Implemented the Trailing-Zero Lookup Enhancement matching exact barcode and barcode with trailing zero, merging results and deduplicating by barcode.
  - Created prefix-optimized autocomplete search route `GET /api/products/search`.
- **Database Migrations**:
  - Added SQLite schema migrations for `admins` and `upload_history` tables.
  - Configured optimized queries using index on `barcode` (PRIMARY KEY) and added name/barcode query indexes.
- **Automated Tests**:
  - Created test suite `src/test/lookup.test.ts` running 17 assertions covering exact match, trailing-zero fallback, combined results, duplicate removal, pricing sort order, and unavailable 404 responses.

## [0.3.0] - 2026-07-10

### Added
- **Excel Import Engine**:
  - Installed SheetJS (`xlsx`) and `multer` libraries.
  - Implemented blank Excel template generator (`GET /api/admin/template`) yielding exactly 4 columns: `Barcode`, `Product Name`, `MRP`, `Sale Price`.
  - Implemented transactional catalogue upload (`POST /api/admin/upload`). The endpoint validates all rows first; if any errors exist, it rejects the entire file and logs error details. If validation succeeds, it opens a database transaction, deletes all existing products, inserts the new catalogue, commits, and logs success metrics in history.
  - Implemented upload history tracking (`GET /api/admin/upload-history`) returning simplified catalogue replace statistics (`totalRows`, `successfulRows`, `failedRows`, `status`, `processingTimeMs`).
  - Implemented error report download (`GET /api/admin/upload-errors/:id`) generating dynamically compiled downloadable CSV files.
- **Product Model Simplification**:
  - Removed `Brand`, `Category`, and `isActive` fields from database schema, API models, and response wrappers.
  - Converted `products` table primary key to auto-incrementing `id` to allow duplicate barcode entries (for separate products or zero-variants) while keeping indexing on `barcode`.
- **Automated Integration Tests**:
  - Created test suite `src/test/import.test.ts` running 25 integration assertions verifying template structures, header validation, row checking, atomic transaction rollbacks, history logging, error CSV generation, and successful replacements.
- **Verification Confirmation**:
  - Executed lookup and import integration tests. Both test suites passed 100% (22 lookup + 25 import = 47 assertions passing successfully).

## [0.4.0] - 2026-07-10

### Added
- **Clean White Admin Portal**:
  - Built a separate static multi-page portal layout (`admin.html`, `history.html`, `login.html`, `style.css`).
  - Styled with a flat white-and-green aesthetic (light grays, dark text, `#1b5e20` retail brand green accents).
  - Integrated local JWT token checks and automatic login redirection logic (`js/auth.js`, `js/login.js`, `js/upload.js`, `js/history.js`).
  - Added **Current Catalogue** status panel displaying live products count, catalog version (`YYYYMMDD-seq`), and last updated timestamp.
  - Handled employee-friendly uploader row error details.
  - Implemented case-insensitive header column mapping and in-file duplicate barcode checks.

## [0.5.0] - 2026-07-10

### Added
- **Customer Experience Single-Page Application (SPA)**:
  - Authored `docs/CUSTOMER_EXPERIENCE.md` covering the customer journey, mobile-first design system rules, accessibility parameters, performance targets, and scanner behavior.
  - Implemented the entire customer interface as a Single-Page Application (`frontend/customer/index.html`) using dynamic view switches.
  - Specified smart scan debouncing (pausing repeat scans for 2 seconds only on the same barcode, immediate scanning for different barcodes).
  - Defined automatic error recovery screens for Camera Permission Denied, Camera Unavailable, Network Failure, and Server Failure.
  - Defined dynamic loading feedback ("Looking up price..."), multiple-match helper hints ("Compare the MRP to identify the correct product."), AudioContext success beep synthesize tone, and subtle ~300ms visual highlight animations.
  - Transitioned the visual design to a bright, modern white-and-green supermarket aesthetic (off-white background, white card outlines, `#1b5e20` retail brand green accent).

## [1.0.0] - 2026-07-10

### Added
- **Production Security Hardening & Version 1 Freeze**:
  - Disabled the development database setup/reset route (`POST /api/admin/setup`) completely in production.
  - Locked the public administrator registration endpoint (`POST /api/admin/register`) after the very first admin user is registered.
  - Enforced mandatory `JWT_SECRET` existence checks on startup, exiting immediately if missing to prevent insecure fallbacks.
  - Built physical log stream separation mapping to separate `app.log`, `error.log`, and `access.log` files, ensuring no sensitive credentials or spreadsheet values are logged.
  - Configured standard HTTP security headers (X-Content-Type-Options, X-Frame-Options, Referrer-Policy, and Content-Security-Policy).
  - Implemented IP-based failed login rate limiting on authentication routes (maximum 5 attempts per minute per IP address).
  - Enforced 20MB file upload limits and strict `.xlsx` file extension filtering on catalogue uploads.
  - Implemented automatic HTTPS redirects for production environments.
  - Created a lightweight and secure health monitoring endpoint (`GET /api/health`).
  - Authored the comprehensive **Production Deployment Guide** (`docs/PRODUCTION_DEPLOYMENT.md`) detailing setup, PM2 process management, and nightly database cron backups.


