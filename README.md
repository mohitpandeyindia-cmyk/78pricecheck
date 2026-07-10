# SEVENTYEIGHTOS (78OS)

**SEVENTYEIGHTOS** (78OS) is the digital operating platform for **78 Supermaart**.

This repository contains the architecture, designs, and source code for the platform applications. The first system application being built is **78 PriceCheck**, a mobile-first web app that enables customers to scan barcodes to check current product prices and allows store administrators to upload product databases via Excel spreadsheets.

---

## Project Directory Structure

The project is structured as follows:

```
78OS
│
├── docs/             # Documentation files (Project Samvidhan [Constitution], SRS, Coding Rules, API Specs, Walkthroughs, Implementation Plan, Changelog)
├── frontend/         # Customer scan viewport, admin screens, HTML/CSS styles, and app scripts
├── backend/          # Local server scripts and service utilities
├── database/         # Local data store configurations and backup files
├── uploads/          # Directory reserved for admin spreadsheet uploads and file staging
├── assets/           # Media, product category icons, and logo graphics
└── README.md         # Project overview and run instructions
```

---

## Applications

### 1. 78 PriceCheck
*   **Customer Experience**: Mobile-optimized, ultra-fast video camera scanning for product barcodes. Instant visual feedback on prices, discounts, and availability.
*   **Admin Tools**: Simple, local spreadsheet uploads (`.xlsx`/`.xls`) with auto-validation and catalog syncing. Offline-ready manual edit panels.

---

## Documentation

For technical details, design specifications, and development logs, please see the [docs/](file:///c:/seventyeightos/docs/) folder:
- **[PROJECT_SAMVIDHAN.md](file:///c:/seventyeightos/docs/PROJECT_SAMVIDHAN.md)**: Governing constitution (design specifications, customer rights, performance guarantees, UI principles, engineering rules).
- **[SRS.md](file:///c:/seventyeightos/docs/SRS.md)**: Software Requirements Specification.
- **[CODING_RULES.md](file:///c:/seventyeightos/docs/CODING_RULES.md)**: Mandated development rules.
- **[API.md](file:///c:/seventyeightos/docs/API.md)**: API endpoints contract specification and json schema examples.
- **[walkthrough.md](file:///c:/seventyeightos/docs/walkthrough.md)**: Historical summary of completed project milestones.
- **[IMPLEMENTATION_PLAN.md](file:///c:/seventyeightos/docs/IMPLEMENTATION_PLAN.md)**: File components, architecture, and phase objectives.
- **[CHANGELOG.md](file:///c:/seventyeightos/docs/CHANGELOG.md)**: Project history and version records.
