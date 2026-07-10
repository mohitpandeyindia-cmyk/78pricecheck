# 78 PriceCheck – Version 1 Production Deployment Guide

This document outlines the step-by-step instructions and security configurations for deploying the frozen **Version 1** of **78 PriceCheck** on a live server in the supermarket.

---

## 1. Prerequisites & Environment Configuration

### Environmental Variables:
Define the following environment variables in your production server environment:

```bash
NODE_ENV=production
PORT=8080
JWT_SECRET=your_long_secure_secret_key_string_here
```

> [!IMPORTANT]
> **JWT Secret Security Enforcement**:
> The server refuses to start if `JWT_SECRET` is missing. If it is omitted from the environment, the backend logs a fatal error and exits immediately to prevent insecure fallbacks.

---

## 2. Hardened Production Security Rules

### A. Domain & Same-Origin Structure
To avoid CORS complexity and simplify deployment, both applications run on the same origin (sharing cookies and local storage tokens securely):
*   **Customer Application**: `https://price.78supermaart.com` (served at `/`)
*   **Admin Portal**: `https://price.78supermaart.com/admin` (served at `/admin`)

### B. Database File Protection
*   The SQLite database file (`backend/data/seventyeightos.db`) is stored strictly outside the served static directories (`frontend/`).
*   **Ensure the database data directory is never exposed** in Nginx or Express static serving rules. The SQLite database file must never be downloadable through the web server.

### C. Upload Directory & Memory Leak Protection
*   File uploads utilize **memory storage** (`multer.memoryStorage()`).
*   Spreadsheet uploads exist solely as temporary buffers in RAM and are garbage collected immediately upon request completion. **No files are written to or retained on the server disk during import.**
*   The upload size limit is enforced at **20 MB**, rejecting non-`.xlsx` extensions.

### D. Development Route Disablement
*   The `/api/admin/setup` database reset route is disabled when `NODE_ENV=production`. Any attempt to call it returns a **403 Forbidden** response.
*   Database schema initialization runs automatically on startup only if the SQLite file does not exist.

### E. Administrator Registration Lock
*   After the very first administrator is registered, the `/api/admin/register` endpoint is locked.
*   Subsequent registration attempts return a **403 Forbidden** error. Additional admins must be added via authenticated portal procedures.

### F. Rate Limiting on Login
*   Authentication endpoints (`POST /api/admin/login`) enforce rate limits:
    *   **Maximum 5 failed attempts per minute per IP address**.
    *   Throttled IPs receive a **429 Too Many Requests** response indicating wait time.

### G. HTTPS Enforcement
*   When `NODE_ENV=production`, the Express server automatically redirects all plain HTTP requests to HTTPS by validating the `x-forwarded-proto` proxy headers.

### H. Security Headers Middleware
Every HTTP response is injected with standard security headers:
*   `X-Content-Type-Options: nosniff` (prevents MIME type sniffing)
*   `X-Frame-Options: DENY` (blocks clickjacking attempts)
*   `Referrer-Policy: no-referrer-when-downgrade`
*   `Content-Security-Policy`: Restricts scripts and styles to self and verified CDN resources (`https://unpkg.com`).

---

## 3. Production Log Separation

Logs are physically written to separate files under the root `logs/` directory:
1.  **Application Log (`logs/app.log`)**: Tracks server startup, database initialization, and system operations.
2.  **Error Log (`logs/error.log`)**: Records server exceptions and caught database errors.
3.  **Access Log (`logs/access.log`)**: Logs incoming requests (Method, URL, IP, StatusCode).
*   **Privacy Restriction**: The logs never record sensitive data such as passwords, JWT session tokens, or raw spreadsheet cell values.

---

## 4. Daily Database Backup (SQLite)

### Nightly Backup Cron:
Configure a daily cron job on the production server to copy the database file, compress it, and retain the last seven backups.

Create a script `/opt/pricecheck/backup.sh`:
```bash
#!/bin/bash
BACKUP_DIR="/var/backups/pricecheck"
DB_FILE="/opt/pricecheck/backend/data/seventyeightos.db"
DATE=$(date +\%Y\%m\%d_\%H\%M\%S)

mkdir -p "$BACKUP_DIR"

# Copy and compress the database file
sqlite3 "$DB_FILE" ".backup '$BACKUP_DIR/db_$DATE.bak'"
gzip "$BACKUP_DIR/db_$DATE.bak"

# Keep only the last 7 days of backups
find "$BACKUP_DIR" -name "db_*.bak.gz" -mtime +7 -exec rm {} \;
```

Set the cron schedule (`crontab -e`) to execute nightly at 2:00 AM:
```cron
0 2 * * * /bin/bash /opt/pricecheck/backup.sh > /dev/null 2>&1
```

> [!IMPORTANT]
> **Backup Integrity Verification**:
> Periodically restore a compressed backup into a local staging or test environment to verify database integrity. A backup that cannot be successfully restored is not a valid backup.

---

## 5. PM2 Process Management & Restart Policy

To keep the application running continuously in the background and ensure it automatically restarts on crash or system reboot, use a process manager like **PM2**:

1.  **Install PM2 globally**:
    ```bash
    npm install pm2 -g
    ```
2.  **Start the server process**:
    ```bash
    pm2 start dist/index.js --name "pricecheck-backend" --env JWT_SECRET="your_production_secret" NODE_ENV="production" PORT="8080"
    ```
3.  **Configure automatic restart on system reboot**:
    ```bash
    pm2 startup
    pm2 save
    ```
4.  **Verify Restart Policies**:
    *   *System reboot test*: Restart the server OS; verify PM2 auto-spawns the Node process on boot.
    *   *Unexpected crash test*: Run `pm2 kill` or simulate a process crash; verify PM2 restarts the process in under 1 second.

---

## 6. Lightweight Operational Monitoring

Monitor the following system parameters regularly to ensure high availability:
*   **CPU & Memory usage** (ensure Node.js runs within limits).
*   **Disk space** (to prevent log directory overflow).
*   **SQLite database file size** (monitor catalog table growth).
*   **Backup success status** (assert `.bak.gz` files exist in backup directories).

---

## 7. QR Code Print Recommendations

Place shelf QR codes to redirect customers to `https://price.78supermaart.com`. To ensure high scan reliability in-store:
*   **High Error Correction**: Generate QR codes using Level Q (25%) or Level H (30%) error correction to tolerate scratches or dust.
*   **Printed Size**: Minimum dimensions around **3 cm × 3 cm**.
*   **Paper Finish**: Matte finish is preferred (avoid glossy coatings to prevent overhead light glare).
*   **Location**: Place labels at eye level where practical (e.g. shelf borders or cart handle attachments).

---

## 8. Future Migration Path (PostgreSQL/MySQL)

While Version 1 utilizes SQLite to keep local hosting simple and zero-configuration, the backend architecture is decoupled:
*   **Abstraction Layer**: Database access is fully wrapped inside `backend/src/db.ts`.
*   **SQL Schema Compliance**: SQLite tables and queries use standard SQL syntax.
*   **Migration steps**: To move to PostgreSQL/MySQL under high load:
    1.  Install pg/mysql drivers.
    2.  Update connection pool parameters in `db.ts`.
    3.  Export schema and import into the new database server without altering routing or business logic.

---

## 9. Production Launch Checklist

Before opening the portal to supermarket customers, verify:
*   [ ] **SSL/HTTPS certificate** installed and active.
*   [ ] **Valid, unique `JWT_SECRET`** environment variable set.
*   [ ] **First administrator account** created (confirming registration lock triggers afterwards).
*   [ ] **Nginx reverse proxy** forwards `X-Forwarded-Proto` header.
*   [ ] **Health endpoint** verified at `/api/health`.
*   [ ] **Complete catalogue** uploaded successfully.
*   [ ] **Camera barcode scanning** and EAN trailing-zero lookups tested on both Android and iOS devices.
*   [ ] **Daily backup script** and PM2 configuration verified.
