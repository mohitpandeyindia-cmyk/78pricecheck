import 'dotenv/config';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

if (!process.env.JWT_SECRET) {
  console.error('\n================================================================');
  console.error('  FATAL ERROR: Environment Misconfiguration Detected            ');
  console.error('  The mandatory "JWT_SECRET" environment variable is missing.     ');
  console.error('  Please set it in your system or environment before starting.   ');
  console.error('================================================================\n');
  process.exit(1);
}

export const JWT_SECRET = process.env.JWT_SECRET;

export interface AuthenticatedRequest extends Request {
  admin?: {
    id: number;
    username: string;
  };
}

export function authenticateToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  // Authorization: Bearer <TOKEN>
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    res.status(401).json({
      success: false,
      message: 'Access denied. Token is missing.',
    });
    return;
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      res.status(403).json({
        success: false,
        message: 'Invalid or expired token.',
      });
      return;
    }

    // Attach admin details to request
    (req as AuthenticatedRequest).admin = decoded as { id: number; username: string };
    next();
  });
}
