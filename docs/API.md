# 78 PriceCheck: API Documentation

This document maintains the complete API contract specifications for **78 PriceCheck** on the **78OS** platform. All API routes serve JSON payloads and enforce strict schema matching.

---

## 1. Public Telemetry & Health APIs

### 1.1 GET /api/version
Returns the application and platform metadata, catalog version information, and live product counts.

*   **URL**: `/api/version`
*   **Method**: `GET`
*   **Request Parameters**: None
*   **Request Body**: None
*   **Success Response**:
    *   **Status Code**: `200 OK`
    *   **JSON Schema**:
        *   `application` (string): Application branding name.
        *   `version` (string): Semantic version.
        *   `databaseVersion` (string): Internal SQLite database version.
        *   `catalogVersion` (string): Formatting version string (`YYYYMMDD-seq`).
        *   `lastCatalogUpload` (string | null): ISO-8601 UTC timestamp of last import.
        *   `productsCount` (number): Live product rows in database.
*   **Example JSON**:
    ```json
    {
      "application": "78 PriceCheck",
      "version": "0.3.0",
      "databaseVersion": "3",
      "catalogVersion": "20260710-001",
      "lastCatalogUpload": "2026-07-10T03:39:16.000Z",
      "productsCount": 12543
    }
    ```

### 1.2 GET /api/health
Tests service status and verifies active SQLite database connection response.

*   **URL**: `/api/health`
*   **Method**: `GET`
*   **Request Parameters**: None
*   **Request Body**: None
*   **Success Response**:
    *   **Status Code**: `200 OK`
    *   **JSON Schema**:
        *   `status` (string): Health code (`"ok"`).
        *   `database` (string): Status of connection (`"connected"`).
        *   `version` (string): API release iteration (`"1.0.0"`).
*   **Error Responses**:
    *   **Status Code**: `500 Internal Server Error` (if database probe fails).
    *   **JSON Body**:
        ```json
        {
          "status": "error",
          "database": "disconnected",
          "version": "1.0.0"
        }
        ```
*   **Example JSON (Success)**:
    ```json
    {
      "status": "ok",
      "database": "connected",
      "version": "1.0.0"
    }
    ```

---

## 2. Setup & Configuration APIs

### 2.1 GET /api/admin/setup-status
Checks if the system has been initialized and seeded.

*   **URL**: `/api/admin/setup-status`
*   **Method**: `GET`
*   **Request Parameters**: None
*   **Request Body**: None
*   **Success Response**:
    *   **Status Code**: `200 OK`
    *   **JSON Schema**:
        *   `setupCompleted` (boolean): `true` if initial migrations and default seeder have run.
        *   `lastUpdated` (string | null): ISO-8601 timestamp of the last setup execution.
*   **Example JSON**:
    ```json
    {
      "setupCompleted": true,
      "lastUpdated": "2026-07-09T20:21:14.247Z"
    }
    ```

### 2.2 POST /api/admin/setup
Initializes database tables and seeds sample inventory records.

*   **URL**: `/api/admin/setup`
*   **Method**: `POST`
*   **Request Parameters**: None
*   **Request Body**: None
*   **Success Response**:
    *   **Status Code**: `200 OK`
    *   **JSON Schema**:
        *   `success` (boolean): `true`
        *   `message` (string): Success detail.
*   **Error Responses**:
    *   **Status Code**: `500 Internal Server Error` (if SQL migration fails).
    *   **JSON Body**:
        ```json
        {
          "success": false,
          "message": "Database setup initialization failed",
          "error": "Error details"
        }
        ```
*   **Example JSON**:
    ```json
    {
      "success": true,
      "message": "System database initialized and seeded with sample products successfully."
    }
    ```

---

## 3. Authentication & Security APIs

### 3.1 POST /api/admin/register
Registers the first store administrator account. This endpoint is locked once an admin account is created.

*   **URL**: `/api/admin/register`
*   **Method**: `POST`
*   **Request Parameters**: None
*   **Request Body**:
    *   `username` (string): Admin login name.
    *   `password` (string): Admin password (minimum length: 8 recommended).
*   **Success Response**:
    *   **Status Code**: `200 OK`
    *   **JSON Schema**:
        *   `success` (boolean): `true`
        *   `message` (string): Description of account registration.
*   **Error Responses**:
    *   **Status Code**: `400 Bad Request` (if username or password are missing/invalid).
    *   **Status Code**: `403 Forbidden` (if an administrator already exists).
    *   **JSON Body (403)**:
        ```json
        {
          "success": false,
          "message": "Registration locked. Admin account already exists."
        }
        ```
*   **Example JSON**:
    ```json
    {
      "success": true,
      "message": "Admin account created successfully."
    }
    ```

### 3.2 POST /api/admin/login
Authenticates administrator credentials and returns a secure JWT bearer token.

*   **URL**: `/api/admin/login`
*   **Method**: `POST`
*   **Request Parameters**: None
*   **Request Body**:
    *   `username` (string): Login name.
    *   `password` (string): Plaintext password.
*   **Success Response**:
    *   **Status Code**: `200 OK`
    *   **JSON Schema**:
        *   `success` (boolean): `true`
        *   `token` (string): JWT token signed by server (expires in 12 hours).
*   **Error Responses**:
    *   **Status Code**: `401 Unauthorized` (if username or password does not match).
    *   **JSON Body (401)**:
        ```json
        {
          "success": false,
          "message": "Invalid username or password"
        }
        ```
*   **Example JSON**:
    ```json
    {
      "success": true,
      "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
    }
    ```

---

## 4. Product Lookup & Search APIs

### 4.1 GET /api/products/lookup/:barcode
Retrieves detailed product pricing and stock information. Publicly accessible. Supports EAN/UPC barcode mapping and automated trailing-zero fallback lookup.

*   **URL**: `/api/products/lookup/:barcode`
*   **Method**: `GET`
*   **Request Parameters**:
    *   `barcode` (string, required): The target product barcode.
*   **Request Body**: None
*   **Success Response**:
    *   **Status Code**: `200 OK`
    *   **JSON Schema**:
        *   `multipleMatches` (boolean): `true` if there are multiple matches due to trailing-zero fallback search, `false` otherwise.
        *   `products` (array): List of matched product details, sorted by MRP in ascending order.
            *   `barcode` (string): Scanned/matching barcode.
            *   `name` (string): Product title.
            *   `mrp` (number): Max Retail Price (MRP).
            *   `salePrice` (number): Current selling price (glowing Today's Price).
*   **Error Responses**:
    *   **Status Code**: `404 Not Found` (if no active products match, adhering to Article VII: Price Integrity).
    *   **JSON Body (404)**:
        ```json
        {
          "success": false,
          "message": "Product is unavailable or not found"
        }
        ```
*   **Example JSON**:
    ```json
    {
      "multipleMatches": false,
      "products": [
        {
          "barcode": "7800000000021",
          "name": "Artisanal White Bread 500g",
          "mrp": 2.2,
          "salePrice": 1.89
        }
      ]
    }
    ```

### 4.2 GET /api/products/search
Provides quick product auto-suggestions for manual inputs. Matches barcode prefixes or product names.

*   **URL**: `/api/products/search`
*   **Method**: `GET`
*   **Request Parameters**:
    *   `q` (string, required): Search query string.
*   **Request Body**: None
*   **Success Response**:
    *   **Status Code**: `200 OK`
    *   **JSON Schema**: Array of matching product elements.
        *   `barcode` (string): Code.
        *   `name` (string): Name.
        *   `mrp` (number): MRP.
        *   `salePrice` (number): Current selling price.
*   **Example JSON**:
    ```json
    [
      {
        "barcode": "7800000000021",
        "name": "Artisanal White Bread 500g",
        "mrp": 2.2,
        "salePrice": 1.89
      }
    ]
    ```

---

## Administrator Endpoints (Protected)

### 1. Download Blank Excel Template
Returns a blank Excel spreadsheet containing the required column headers for catalog import.

*   **URL**: `/api/admin/template`
*   **Method**: `GET`
*   **Request Headers**: None
*   **Request Body**: None
*   **Success Response**:
    *   **Status Code**: `200 OK`
    *   **Content-Type**: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
    *   **Content-Disposition**: `attachment; filename=78pricecheck_template.xlsx`
    *   **Response Body**: Binary spreadsheet stream.

---

### 2. Transactional Catalogue Upload
Accepts a multipart form Excel sheet, runs row-level validation, and replacements inside a transaction.

*   **URL**: `/api/admin/upload`
*   **Method**: `POST`
*   **Request Headers**:
    *   `Authorization`: `Bearer <JWT_TOKEN>`
*   **Request Body (multipart/form-data)**:
    *   `file` (File, required): The Excel spreadsheet containing the product catalog.
*   **Success Response**:
    *   **Status Code**: `200 OK`
    *   **Response Body**:
        ```json
        {
          "success": true,
          "totalRows": 12543,
          "successfulRows": 12543,
          "failedRows": 0,
          "processingTimeMs": 842
        }
        ```
*   **Error Responses**:
    *   **Status Code**: `400 Bad Request` (Validation errors present)
    *   **Response Body**:
        ```json
        {
          "success": false,
          "summary": {
            "totalRows": 10,
            "successfulRows": 0,
            "failedRows": 2,
            "processingTimeMs": 15,
            "status": "Failed"
          },
          "errors": [
            {
              "row": 3,
              "barcode": "890111",
              "name": "Bad Product",
              "error": "Sale Price ($12) must not exceed MRP ($10)."
            }
          ]
        }
        ```
    *   **Status Code**: `401 Unauthorized` (Token missing or invalid)
    *   **Response Body**:
        ```json
        {
          "success": false,
          "message": "Access denied. Token missing or invalid."
        }
        ```

---

### 3. Retrieve Upload History Logs
Returns a sorted log of all spreadsheet catalog uploads.

*   **URL**: `/api/admin/upload-history`
*   **Method**: `GET`
*   **Request Headers**:
    *   `Authorization`: `Bearer <JWT_TOKEN>`
*   **Request Body**: None
*   **Success Response**:
    *   **Status Code**: `200 OK`
    *   **Response Body**:
        ```json
        [
          {
            "id": 1,
            "filename": "catalog_2026.xlsx",
            "uploadedBy": "admin2",
            "totalRows": 12543,
            "successfulRows": 12543,
            "failedRows": 0,
            "status": "Success",
            "processingTimeMs": 842,
            "uploadedAt": "2026-07-10 03:00:00"
          }
        ]
        ```

---

### 4. Download Validation Error Report
Downloads the detailed row validation errors for a failed upload run as a CSV file.

*   **URL**: `/api/admin/upload-errors/:id`
*   **Method**: `GET`
*   **Request Headers**:
    *   `Authorization`: `Bearer <JWT_TOKEN>`
*   **Request Body**: None
*   **Success Response**:
    *   **Status Code**: `200 OK`
    *   **Content-Type**: `text/csv`
    *   **Content-Disposition**: `attachment; filename=upload_errors_1.csv`
    *   **Response Body**:
        ```csv
        Row,Barcode,Product Name,Error Description
        3,890111,"Bad Product","Sale Price ($12) must not exceed MRP ($10)."
        ```

