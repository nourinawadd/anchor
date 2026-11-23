// AI assistant (orchestrator) — mounted at /api/ai/assistant by routes/ai.js,
// which applies auth first. One message in, one merged answer out.
// See docs/orchestrator.md.
import express from 'express';
import rateLimit from 'express-rate-limit';
import asyncHandler from '../middleware/asyncHandler.js';
import { requireString, badRequest } from '../middleware/validate.js';
import { runAssistantTurn, MAX_MESSAGE_LEN } from '../services/orchestrator/orchestrator.js';

const router = express.Router();

// A message can fan out to several agents and LLM calls; cap bursts per user
// on top of the daily AI quota. Disabled in tests.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `assistant:${req.user._id}`,
  skip: () => process.env.NODE_ENV === 'test',
  message: { message: 'Too many assistant messages, please slow down' },
});

// POST /api/ai/assistant  { message }
router.post('/', limiter, asyncHandler(async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest('Request body must be a JSON object');
  const extra = Object.keys(body).filter(k => k !== 'message');
  if (extra.length) throw badRequest(`Unexpected field(s): ${extra.join(', ')}`);
  const message = requireString(body.message, { min: 1, max: MAX_MESSAGE_LEN, field: 'message' }).trim();
  if (!message) throw badRequest('message must not be empty');

  res.json(await runAssistantTurn({ user: req.user, message, log: req.log }));
}));

export default router;
