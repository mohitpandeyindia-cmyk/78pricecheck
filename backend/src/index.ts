import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { initializeDatabase } from './db';
import versionRouter from './routes/version';
import adminRouter from './routes/admin';
import authRouter from './routes/auth';
import productsRouter from './routes/products';

const app = express();
const PORT = process.env.PORT || 8080;

// Trust reverse proxies for client IP rate limiting and secure context evaluation
app.set('trust proxy', true);

// Set standard HTTP security headers (Helmet equivalent)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  res.setHeader('Content-Security-Policy', "default-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; media-src 'self' blob:; img-src 'self' data:; connect-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com;");
  next();
});

// Configure production HTTPS redirection
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https' && !req.secure) {
      res.redirect(`https://${req.headers.host}${req.url}`);
      return;
    }
    next();
  });
}

// Ensure logs directory exists
const logDir = path.resolve(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir);
}

// Create write streams for logging
const appLogStream = fs.createWriteStream(path.join(logDir, 'app.log'), { flags: 'a' });
const errorLogStream = fs.createWriteStream(path.join(logDir, 'error.log'), { flags: 'a' });
const accessLogStream = fs.createWriteStream(path.join(logDir, 'access.log'), { flags: 'a' });

export function logApp(msg: string) {
  const line = `[${new Date().toISOString()}] INFO: ${msg}\n`;
  console.log(line.trim());
  appLogStream.write(line);
}

export function logError(msg: string, err?: any) {
  const errMsg = err ? ` ${err.message || err}` : '';
  const line = `[${new Date().toISOString()}] ERROR: ${msg}.${errMsg}\n`;
  console.error(line.trim());
  errorLogStream.write(line);
}

// Request access logging middleware (Access Log - does not log passwords or JWT tokens)
app.use((req, res, next) => {
  const ip = (req.headers['x-forwarded-for'] as string || req.ip || 'unknown').split(',')[0].trim();
  res.on('finish', () => {
    const line = `[${new Date().toISOString()}] ${ip} - ${req.method} ${req.originalUrl || req.url} - ${res.statusCode}\n`;
    accessLogStream.write(line);
  });
  next();
});

// Enable CORS and body parsing
app.use(cors());
app.use(express.json());

// API Health Endpoint (Safe: does not expose env vars, internal paths, or secrets)
app.get('/api/health', async (req, res) => {
  let dbConnected = false;
  try {
    const { getDb } = require('./db');
    const db = await getDb();
    await db.get('SELECT 1');
    dbConnected = true;
  } catch (e) {
    // Suppress DB internal trace logging here
  }
  
  res.json({
    status: 'healthy',
    version: '1.0.0',
    uptime: process.uptime(),
    database: dbConnected ? 'connected' : 'disconnected'
  });
});

// Diagnostic path debug endpoint
app.get('/api/debug-paths', async (req, res) => {
  try {
    const fs = require('fs');
    const { getDb } = require('./db');
    const db = await getDb();
    
    let adminCount = 0;
    let productCount = 0;
    let dbError = null;
    
    try {
      const admins = await db.get('SELECT COUNT(*) as count FROM admins');
      adminCount = admins ? admins.count : 0;
      const products = await db.get('SELECT COUNT(*) as count FROM products');
      productCount = products ? products.count : 0;
    } catch (dbErr: any) {
      dbError = dbErr.message;
    }

    const dirContents = (p: string) => {
      try { return fs.readdirSync(p); } catch (e: any) { return e.message; }
    };
    res.json({
      cwd: process.cwd(),
      dirname: __dirname,
      resolvedFrontend: path.resolve(__dirname, '../../frontend'),
      databasePath: process.env.DATABASE_PATH || 'default',
      databaseFileExists: fs.existsSync(process.env.DATABASE_PATH || 'c:/seventyeightos/backend/database/78pricecheck.db'),
      adminCount,
      productCount,
      dbError,
      rootContents: dirContents('/'),
      appContents: dirContents('/app'),
      cwdContents: dirContents(process.cwd()),
      frontendContents: dirContents(path.resolve(__dirname, '../../frontend'))
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API Routes
app.use('/api', versionRouter);
app.use('/api', adminRouter);
app.use('/api', authRouter);
app.use('/api', productsRouter);

// Serve static frontend files if they exist
const FRONTEND_PATH = path.resolve(__dirname, '../../frontend');

// Dynamic PWA Cache-Busting static options configuration
const customerStaticOptions = {
  setHeaders: (res: any, filePath: string) => {
    const filename = path.basename(filePath);
    if (filename === 'sw.js' || filename === 'index.html') {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    } else if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
};

// Mount routes for Customer Application
app.use('/', express.static(path.join(FRONTEND_PATH, 'customer'), customerStaticOptions));

// Serve admin static pages explicitly
app.get('/admin', (req, res) => {
  res.sendFile(path.join(FRONTEND_PATH, 'admin/login.html'));
});

app.get('/admin/upload', (req, res) => {
  res.sendFile(path.join(FRONTEND_PATH, 'admin/index.html'));
});

app.get('/admin/history', (req, res) => {
  res.sendFile(path.join(FRONTEND_PATH, 'admin/history.html'));
});

// Serve admin assets under '/admin' prefix
app.use('/admin', express.static(path.join(FRONTEND_PATH, 'admin')));

// Serve SPA fallback route for any other request (for future client routes)
app.get('*', (req, res, next) => {
  // If request is for an API route that wasn't matched, return 404
  if (req.url.startsWith('/api')) {
    res.status(404).json({ error: 'API endpoint not found' });
    return;
  }
  
  // Otherwise, fallback to customer welcome page
  const indexPath = path.join(FRONTEND_PATH, 'customer/index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error(`[Static Files Error] Failed to serve index.html from path: "${indexPath}". Error:`, err);
      // If frontend hasn't been built yet, output simple landing info
      res.status(200).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>SEVENTYEIGHTOS Backend</title>
          <style>
            body { font-family: sans-serif; background: #08090c; color: #fff; text-align: center; padding-top: 100px; }
            h1 { color: #39ff14; }
          </style>
        </head>
        <body>
          <h1>78OS Backend is Running</h1>
          <p>Version API is online at <a href="/api/version" style="color: #ffb000;">/api/version</a></p>
        </body>
        </html>
      `);
    }
  });
});

// Database initialization and server startup
async function startServer() {
  if (!process.env.JWT_SECRET) {
    console.error('\n================================================================');
    console.error('  FATAL ERROR: Environment Misconfiguration Detected            ');
    console.error('  The mandatory "JWT_SECRET" environment variable is missing.     ');
    console.error('  Please set it in your system or environment before starting.   ');
    console.error('================================================================\n');
    process.exit(1);
  }

  try {
    logApp('Initializing SQLite database...');
    // Initialize DB schema (without seeding by default)
    await initializeDatabase(false);
    logApp('SQLite database initialized successfully.');

    app.listen(PORT, () => {
      console.log(`===============================================`);
      console.log(`  SEVENTYEIGHTOS BACKEND SERVING ONLINE        `);
      console.log(`  Listening at: http://localhost:${PORT}        `);
      console.log(`===============================================`);
      logApp(`Server started and listening on port ${PORT}`);
    });
  } catch (error) {
    logError('Fatal: Failed to start backend server', error);
    process.exit(1);
  }
}

startServer();
