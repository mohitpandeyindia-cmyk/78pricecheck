# 78 PriceCheck – Store Operations Manual (Samvidhan Handbook)

This manual is the definitive operational handbook for Store Managers and Supervisors running **78 PriceCheck**. It outlines standard workflows, maintenance intervals, emergency recoveries, and key performance metrics to ensure high availability and customer satisfaction on the shop floor.

---

## 1. Staff Responsibilities & Ownership Matrix

To maintain pricing integrity and scanner reliability, specific roles are assigned to store personnel:

*   **Store Manager (System Owner)**:
    *   Maintains ultimate responsibility for price verification accuracy.
    *   Reviews monthly scanner logs and decides on system adjustments.
    *   Coordinates with IT Support during server outages.
*   **Inventory Supervisor (Data Manager)**:
    *   Performs daily product catalogue uploads from the store ERP.
    *   Resolves catalogue errors and missing barcode logs.
    *   Verifies nightly database backup success status.
*   **Floor Clerks (Aisle Supervisors)**:
    *   Execute weekly physical QR code label inspections.
    *   Report damaged labels or physical barcode scanner issues on shelves.
    *   Assist customers on how to use the price check screen.

---

## 2. Standard Maintenance Schedules

### Daily Procedures (Inventory Supervisor):
1.  **Export**: Export the latest active pricing list from the ERP at 7:30 AM (before store opening).
2.  **Upload**: Log into the Admin Portal (`https://price.78supermaart.com/admin`) and upload the new catalog Excel spreadsheet.
3.  **Confirm**: Assert that the upload screen returns the green "Success" badge showing the correct row count.
4.  **Verification**: Walk the floor and scan 3–5 random products from different departments. Ensure "Today's Price" matches the shelf tag.

### Weekly Maintenance (Floor Clerks & Data Manager):
1.  **QR Code Inspection**: Walk all aisles and inspect every printed QR code sticker. Look for:
    *   Scratches, tears, or faded inks.
    *   Glared placements (re-position if overhead lighting reflects heavily).
2.  **Backup Verification**: The Data Manager must log into the backup directory and check that nightly `.bak.gz` archives have been successfully written for the last 7 days.
3.  **Audit Logs Review**: Check the admin upload history for failed uploads and ensure error CSVs were investigated.

### Monthly Maintenance (Store Manager & Supervisor):
1.  **Backup Restore Test**: Restore the latest compressed SQLite backup file into a local test environment. Verify that the test system successfully reads the tables.
2.  **Device Compatibility Check**: Test the scanning client across 3–4 different customer mobile devices (Android Chrome, Samsung Internet, iOS Safari). Ensure lookup latency is under 1.5 seconds.
3.  **Cleaning**: Clean dust or plastic residues from camera housings on static kiosk checking stands (if applicable).

---

## 3. Emergency Recovery Protocols

In case of outages, follow these recovery procedures immediately:

### Case A: Customer scanning shows "Network Error" or "Unable to Connect"
1.  **Check Internet**: Verify if other store internet services (POS, Wi-Fi) are online.
2.  **Server Check**: Open `https://price.78supermaart.com/api/health` on a mobile device. If it responds with database status `"connected"`, the network issue is local to the customer's phone or carrier.
3.  **Action**: If the health check fails, contact IT support to restart the backend application node.

### Case B: Uploading the catalogue returns "Header Mismatch" or fails
1.  **Check Format**: Open the uploaded Excel file. Ensure columns are exactly: `Barcode`, `Product Name`, `MRP`, `Sale Price` (in row 1).
2.  **Restore Last Version**: If the upload is corrupt and cannot be immediately fixed, the database transaction has automatically rolled back to protect the active catalogue. Keep using the existing system; do not force setup re-runs.

### Case C: Power Outage / Server System Crash
1.  **Automatic Auto-Start**: The system is managed by PM2. Once power returns and the host reboots, the server process will auto-spawn in under 5 seconds.
2.  **Manual Start (If PM2 fails)**:
    If the server is offline after a reboot, log in via command line and execute:
    ```bash
    pm2 restart pricecheck-backend
    ```

---

## 4. Incident Management & Reporting

When a customer reports a pricing discrepancy or scanning issue, document it in the **Incident Log** using the following details:
1.  **Date & Time** of the incident.
2.  **Barcode scanned** (e.g. `780003001`).
3.  **Problem details**:
    *   *Scan failed to decode* (blurry camera focus, lighting glare).
    *   *Price discrepancy* (Today's Price showed `$12` but checkout charged `$14`).
    *   *Product not found* (returns coral error screen).
4.  **Action Taken**: E.g., fixed item pricing in ERP database, re-printed shelf QR tag, or replaced faded barcode label.

---

## 5. System Performance Key Performance Indicators (KPIs)

Ensure the system operates within standard thresholds. Review these monthly:

*   **API Lookup Response Latency**: **< 150 ms** (Sub-second check guarantees seamless client feedback).
*   **First Contentful Paint (FCP)**: **< 400 ms** (Fast client rendering prevents customer exits).
*   **Database Import Time (25,000 items)**: **< 3.0 seconds** (Prevents server stalls during morning catalog swaps).
*   **Scan Success Rate**: **> 98%** of scanned items should return either a pricing card or a clear "Product is unavailable or not found" notification (zero raw page errors).
*   **System Uptime**: **> 99.9%** availability during store hours.

---

## 6. Pre-Launch Verification Checklist

Before declaring the system live for store shoppers, the Store Manager must sign off on:
*   [ ] **SSL Security Setup**: Unified URL `https://price.78supermaart.com` verified securely with HTTPS.
*   [ ] **Initial Admin Registered**: Staff user credentials successfully logged and portal locked to public registrations.
*   [ ] **Daily backup cron enabled**: Nightly backup files saved successfully to backup server.
*   [ ] **Standard QR signs printed**: Placed standard matte laminated QR codes on shelves.
*   [ ] **Staff briefing completed**: Clerks trained to assist customers and execute the morning update routine.
