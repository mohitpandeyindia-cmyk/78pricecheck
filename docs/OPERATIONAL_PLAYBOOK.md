# 78 PriceCheck – Store Operational Playbook

This document defines the quality assurance procedures, shelf QR code layouts, real-store scanner audits, and daily maintenance workflows for store personnel operating **78 PriceCheck**.

---

## 1. Verifying with a Real Supermarket Catalogue

Before opening the system to customers, the catalogue must be verified in a local staging environment using the actual store spreadsheet database.

### Ingestion Audit Procedure:
1.  **Export Production Sheet**: Export the current product catalog from the store ERP as an Excel spreadsheet conforming to the verified template (headers: `Barcode`, `Product Name`, `MRP`, `Sale Price`).
2.  **Upload to Staging**: Log in to the Admin Portal (`https://price.78supermaart.com/admin`) and upload the file. Confirm the upload finishes successfully and shows the correct total row counts.
3.  **Random Audit (100–200 Products)**: Query 150 random barcodes on the shop floor client and cross-check pricing accuracy.
4.  **Targeted Constraint Checks**:
    *   **Normal Barcodes**: Scan standard 13-digit EAN and 12-digit UPC barcodes. Verify prices match exactly.
    *   **Trailing-Zero Barcode Pairs**: Verify zero-padding lookup logic by scanning a short barcode (e.g. `780001`) that maps to a padded product barcode (e.g. `7800010`). Ensure both show up correctly.
    *   **Duplicate Products (Multiple MRPs)**: Confirm that if a barcode has multiple listings with different MRPs (e.g. old vs. new stock batches), both items are displayed to the customer sorted by MRP in ascending order (cheaper first), with the prompt advising them to compare the price tags.
    *   **Boundary Checking**: Verify catalog indexes by checking:
        *   The very first product row in the Excel sheet.
        *   A product near the absolute middle of the database.
        *   The very last product row in the Excel sheet.

---

## 2. Testing Under Real Store Conditions

Lab testing cannot duplicate supermarket layouts. Verify the scanning workflow on-site across different aisles:

### Environmental Checks:
*   **Lighting Glare**: Scan products located under bright fluorescent overhead tubes and LED spotlights. Verify the camera focus decodes successfully despite reflections.
*   **Reflective Packaging**: Test shiny plastic wrappers, foil bags (e.g. potato chips), and metallic cans. Adjust scan angles to reduce label reflections.
*   **Curved Surfaces**: Test cylindrical packaging (e.g. soft drink bottles, yogurt cups, spray cans). Align barcodes vertically in the guide frame if needed.
*   **Small & Damaged Barcodes**: Test scanning tiny barcode labels or labels with slight creases, dust, or scratches to determine decoding thresholds.

### Hardware Compatibility Audit:
Verify camera stream frames and lookup speeds on:
1.  **Android Devices**: Google Chrome and Samsung Internet.
2.  **Apple Devices (iPhones/iPads)**: Mobile Safari.
3.  **Desktop Devices**: Google Chrome and Microsoft Edge (verify admin portal and templates download layouts).

---

## 3. Standard QR Code Positioning

To ensure customers scan quickly without friction, adhere to a unified print design standard:

*   **Design Unity**: Use the same green-and-white QR banner design throughout all aisles.
*   **Destination Link**: All shelf codes redirect to the unified customer SPA root:
    ```
    https://price.78supermaart.com
    ```
*   **Signage Wording**: Print the clear call-to-action message on shelf borders:
    ```
    Scan here to check today's price
    ```
*   **Print Specs**:
    *   Print QR codes at a minimum size of **3 cm × 3 cm**.
    *   Use a **matte laminated finish** to prevent glare from overhead supermarket spotlights.
    *   Position QR tags at eye level where practical (or clearly aligned next to price tags on shelf edges).

---

## 4. Daily Staff Operational Procedure

A simple, repeatable 6-step workflow for store managers and clerks to update prices daily:

```
[1. Export Catalogue from ERP]
             │
             ▼
[2. Log into Admin Portal]
             │
             ▼
[3. Upload Excel Spreadsheet]
             │
             ▼
[4. Verify Success Status Message]
             │
             ▼
[5. Scan 3-5 Random Items on Floor]
             │
             ▼
[6. Verify Pricing: Update Complete]
```

1.  **Export**: Export the day's active price catalogue spreadsheet from the ERP system.
2.  **Login**: Open the Admin Portal and authenticate.
3.  **Upload**: Click the file selector, select the new spreadsheet, and click **"Upload Catalog"**.
4.  **Confirm**: Wait for the green success message to verify all rows parsed successfully and transactions committed.
5.  **Audit**: Walk to the supermarket floor and scan 3–5 random items using a mobile device.
6.  **Complete**: Once the pricing matches, the catalog update is officially complete.

---

## 5. Live Launch Observation Log

Avoid introducing new features during the first two weeks of store staging. Instead, have clerks log observations on customer interactions:
*   *Popular Items*: Which categories or products do customers scan most frequently?
*   *Not Founds*: Note the barcode of any scan that returns a "Product is unavailable or not found" status to check if it's missing from the ERP.
*   *Hesitations*: Observe if customers pause or get confused at any step of the camera permissions or multi-mrp selections.
