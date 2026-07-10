import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDb } from '../db';
import { JWT_SECRET } from '../middleware/auth';

const router = Router();

// POST /api/admin/register - Creates the first admin account
router.post('/admin/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({
        success: false,
        message: 'Username and password are required.',
      });
      return;
    }

    if (typeof username !== 'string' || typeof password !== 'string' || password.length < 6) {
      res.status(400).json({
        success: false,
        message: 'Invalid credentials. Password must be at least 6 characters.',
      });
      return;
    }

    const db = await getDb();

    // Check if any admin exists in the database
    const adminExists = await db.get<{ count: number }>('SELECT COUNT(*) as count FROM admins');
    
    if (adminExists && adminExists.count > 0) {
      res.status(403).json({
        success: false,
        message: 'Registration locked. Admin account already exists.',
      });
      return;
    }

    // Hash the password with bcryptjs
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Insert the first admin
    await db.run(
      'INSERT INTO admins (username, password_hash) VALUES (?, ?)',
      username.trim(),
      passwordHash
    );

    res.json({
      success: true,
      message: 'Admin account created successfully.',
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Failed to register admin account',
      error: error.message || error,
    });
  }
});

// Simple in-memory rate limiter for failed logins
interface FailedLoginRecord {
  count: number;
  resetTime: number;
}
const failedLoginsMap = new Map<string, FailedLoginRecord>();

// POST /api/admin/login - Authenticates admin and returns a JWT token
router.post('/admin/login', async (req: Request, res: Response): Promise<void> => {
  const ip = (req.headers['x-forwarded-for'] as string || req.ip || 'unknown').split(',')[0].trim();
  
  // Check rate limit
  const rateLimitRecord = failedLoginsMap.get(ip);
  if (rateLimitRecord && Date.now() < rateLimitRecord.resetTime && rateLimitRecord.count >= 5) {
    const waitTimeSec = Math.ceil((rateLimitRecord.resetTime - Date.now()) / 1000);
    res.status(429).json({
      success: false,
      message: `Too many failed login attempts. Please try again in ${waitTimeSec} seconds.`,
    });
    return;
  }

  try {
    const { username, password } = req.body;

    if (!username || !password) {
      res.status(400).json({
        success: false,
        message: 'Username and password are required.',
      });
      return;
    }

    const db = await getDb();

    // Find the admin user
    const admin = await db.get<{ id: number; username: string; password_hash: string }>(
      'SELECT id, username, password_hash FROM admins WHERE username = ?',
      username.trim()
    );

    if (!admin) {
      // Register failed attempt
      registerFailedAttempt(ip);
      res.status(401).json({
        success: false,
        message: 'Invalid username or password.',
      });
      return;
    }

    // Compare passwords
    const match = await bcrypt.compare(password, admin.password_hash);
    if (!match) {
      // Register failed attempt
      registerFailedAttempt(ip);
      res.status(401).json({
        success: false,
        message: 'Invalid username or password.',
      });
      return;
    }

    // Success: clear rate limit history
    failedLoginsMap.delete(ip);

    // Generate JWT token
    const token = jwt.sign(
      { id: admin.id, username: admin.username },
      JWT_SECRET,
      { expiresIn: '12h' }
    );

    res.json({
      success: true,
      token,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: 'Login failed',
      error: error.message || error,
    });
  }
});

function registerFailedAttempt(ip: string) {
  const record = failedLoginsMap.get(ip);
  if (!record || Date.now() > record.resetTime) {
    failedLoginsMap.set(ip, {
      count: 1,
      resetTime: Date.now() + 60000 // 1 minute lock window
    });
  } else {
    record.count++;
  }
}

export default router;
