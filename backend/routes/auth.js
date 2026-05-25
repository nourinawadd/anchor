import express from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import User from '../models/User.js';
import { sign } from '../utils/jwt.js';

const router = express.Router();

const MIN_PASSWORD = 8;

// Dummy hash compared against when no user is found, so /login takes the same
// time whether or not the email exists (mitigates user-enumeration timing).
const DUMMY_HASH = bcrypt.hashSync('timing-attack-placeholder', 12);

// Only expose non-sensitive fields to the client.
const publicUser = (user) => ({
  id:       user._id,
  name:     user.name,
  email:    user.email,
  settings: user.settings,
});

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,           // 1 minute
  max: 5,                        // 5 attempts per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts, please try again later' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,      // 1 hour
  max: 10,                       // 10 accounts per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many accounts created, please try again later' },
});

// ─── POST /api/auth/register ──────────────────────────────────────────────────
router.post('/register', registerLimiter, async (req, res) => {
  const name     = (req.body.name  ?? '').trim();
  const email    = (req.body.email ?? '').trim().toLowerCase();
  const password = req.body.password ?? '';

  if (!name || !email || !password)
    return res.status(400).json({ message: 'name, email and password are required' });

  if (password.length < MIN_PASSWORD)
    return res.status(400).json({ message: `Password must be at least ${MIN_PASSWORD} characters` });

  // Defensive duplicate check; the unique index is the source of truth (E11000 → 409 via errorHandler).
  if (await User.findOne({ email }))
    return res.status(409).json({ message: 'Email already registered' });

  const user = await User.create({ name, email, passwordHash: password });
  res.status(201).json({ token: sign(user._id), user: publicUser(user) });
});

// ─── POST /api/auth/login ─────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  const email    = (req.body.email ?? '').trim().toLowerCase();
  const password = req.body.password ?? '';

  if (!email || !password)
    return res.status(400).json({ message: 'email and password are required' });

  const user = await User.findOne({ email });

  // Always run a bcrypt comparison — against the real hash if the user exists,
  // otherwise against a dummy — so the response time doesn't reveal whether the
  // email is registered. The result of the dummy compare is discarded.
  const valid = user
    ? await user.comparePassword(password)
    : (await bcrypt.compare(password, DUMMY_HASH), false);

  if (!user || !valid)
    return res.status(401).json({ message: 'Invalid credentials' });

  res.json({ token: sign(user._id), user: publicUser(user) });
});

export default router;
