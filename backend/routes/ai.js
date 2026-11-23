import express from 'express';
import auth from '../middleware/auth.js';
import AIInsight from '../models/AIInsight.js';
import { getOrGenerateInsight, isInsightFresh, MIN_SESSIONS } from '../services/aiInsightsService.js';
import { getSuggestion } from '../services/aiSuggestionService.js';
import coachRoutes from './coach.js';
import assistantRoutes from './assistant.js';

const router = express.Router();

router.use(auth);

// AI Focus Coach conversations (auth applied above).
router.use('/coach', coachRoutes);

// AI assistant orchestrator: routes a message to the coach / planner agents.
router.use('/assistant', assistantRoutes);

// Provider failures never reach here: llm/generate falls back to a rule-based
// answer (insight.source === 'fallback'). What's left is "not enough data" and
// genuine bugs.
function handleAIError(err, req, res) {
  if (err.code === 'NOT_ENOUGH_DATA') {
    return res.status(400).json({
      message: err.message,
      code: err.code,
      sessionCount: err.sessionCount,
      sessionsNeeded: MIN_SESSIONS,
    });
  }
  req.log.error({ err }, 'AI route error');
  return res.status(500).json({ message: err.message || 'AI service error' });
}

// POST /api/ai/insights/generate - force regenerate
router.post('/insights/generate', async (req, res) => {
  try {
    const { insight, cached } = await getOrGenerateInsight(req.user._id, { force: true });
    res.json({ insight, cached });
  } catch (err) {
    handleAIError(err, req, res);
  }
});

// GET /api/ai/insights - return latest cached or generate
router.get('/insights', async (req, res) => {
  try {
    const existing = await AIInsight.findOne({ userId: req.user._id }).sort({ generatedAt: -1 });
    if (isInsightFresh(existing)) {
      return res.json({ insight: existing, cached: true });
    }

    // No existing or stale — try to generate new one
    try {
      const { insight, cached } = await getOrGenerateInsight(req.user._id, { force: true });
      res.json({ insight, cached });
    } catch (genErr) {
      // If can't generate (not enough data) but we have an old one, return the old one
      if (genErr.code === 'NOT_ENOUGH_DATA' && existing) {
        return res.json({ insight: existing, cached: true, stale: true });
      }
      // If no insight exists at all and can't generate, tell the client how
      // close the user is so the empty state can show real progress.
      if (genErr.code === 'NOT_ENOUGH_DATA' && !existing) {
        return res.json({
          insight: null,
          needsMoreData: true,
          sessionCount: genErr.sessionCount,
          sessionsNeeded: MIN_SESSIONS,
        });
      }
      throw genErr;
    }
  } catch (err) {
    handleAIError(err, req, res);
  }
});

// GET /api/ai/suggestion - lightweight Dashboard tip
router.get('/suggestion', async (req, res) => {
  try {
    const { suggestion, source, cached } = await getSuggestion(req.user._id);
    res.json({ suggestion, source, cached });
  } catch (err) {
    if (err.code === 'NOT_ENOUGH_DATA') {
      return res.status(204).end();
    }
    handleAIError(err, req, res);
  }
});

export default router;
