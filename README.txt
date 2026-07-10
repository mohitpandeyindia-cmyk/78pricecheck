========================================================================
             78 PriceCheck – Version 1.0.0 Release Package
========================================================================

Welcome to the frozen Version 1 release package of 78 PriceCheck.
This package contains the fully integrated backend service and the
isolated frontend clients (Customer SPA and Admin Portal).

------------------------------------------------------------------------
1. Directory Structure
------------------------------------------------------------------------
- backend/            Contains the compiled Node.js backend.
  - dist/             Compiled Javascript binaries.
  - package.json      Server configuration and dependency specifications.
- frontend/           Static client pages.
  - customer/         Customer price checker Single Page Application.
  - admin/            Admin uploader portal.
- docs/               System manuals and manuals.
  - PRODUCTION_DEPLOYMENT.md Detailed Nginx, SSL, PM2, and backup setups.
  - OPERATIONS_MANUAL.md     Staff handbook and daily update workflows.
- .env.example        Environment variables guide.

------------------------------------------------------------------------
2. Production Startup Instructions
------------------------------------------------------------------------
To install and start the server:

1. Install Node.js (v18.0.0 or higher) on your server.
2. Open a terminal, go to the backend directory, and install dependencies:
   cd backend
   npm install --omit=dev

3. Create your production environment file (copy .env.example to .env):
   On Windows (PowerShell):
     Copy-Item .env.example .env
   On Linux/macOS:
     cp .env.example .env

4. Edit the .env file in the backend directory and configure:
   JWT_SECRET=your_secure_custom_key_here

5. Start the server:
   npm start

6. Open the applications in your browser:
   - Customer Portal: http://localhost:8080/
   - Admin Portal: http://localhost:8080/admin

* Note: For production use, read docs/PRODUCTION_DEPLOYMENT.md to configure
  SSL/HTTPS certificates (required for WebRTC camera access on mobile devices)
  and PM2 background service control.
========================================================================
