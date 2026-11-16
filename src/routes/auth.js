import express from 'express';
import { AppError } from '../utils/errors.js';
import {
  hashPassword,
  verifyPassword,
  signAuthToken,
} from '../utils/security.js';
import {
  createUser,
  getUserByEmail,
  getUserById,
} from '../db/index.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createAuthRouter() {
  const router = express.Router();

  router.post('/auth/register', (req, res, next) => {
    try {
      const { email, password } = req.body || {};
      const normalizedEmail = (email || '').toString().trim().toLowerCase();

      if (!normalizedEmail || !EMAIL_REGEX.test(normalizedEmail)) {
        throw new AppError('Please provide a valid email address.', 400, 'INVALID_EMAIL');
      }

      if (!password || typeof password !== 'string' || password.length < 6) {
        throw new AppError('Password must be at least 6 characters long.', 400, 'WEAK_PASSWORD');
      }

      const existing = getUserByEmail(normalizedEmail);
      if (existing) {
        throw new AppError('An account with this email already exists.', 409, 'EMAIL_EXISTS');
      }

      const passwordHash = hashPassword(password);
      const user = createUser({ email: normalizedEmail, passwordHash });
      const token = signAuthToken(user);

      res.status(201).json({
        user,
        token,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/auth/login', (req, res, next) => {
    try {
      const { email, password } = req.body || {};
      const normalizedEmail = (email || '').toString().trim().toLowerCase();

      if (!normalizedEmail || !password) {
        throw new AppError('Email and password are required.', 400, 'MISSING_CREDENTIALS');
      }

      const userRecord = getUserByEmail(normalizedEmail);
      if (!userRecord || !verifyPassword(password, userRecord.password_hash)) {
        throw new AppError('Invalid email or password.', 401, 'INVALID_CREDENTIALS');
      }

      const user = {
        id: userRecord.id,
        email: userRecord.email,
        created_at: userRecord.created_at,
      };
      const token = signAuthToken(user);

      res.status(200).json({
        user,
        token,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/auth/me', (req, res, next) => {
    try {
      if (!req.user?.id) {
        throw new AppError('Not authenticated.', 401, 'UNAUTHORIZED');
      }
      const user = getUserById(req.user.id);
      if (!user) {
        throw new AppError('User account not found.', 404, 'USER_NOT_FOUND');
      }
      res.status(200).json({ user });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
