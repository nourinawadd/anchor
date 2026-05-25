import 'dotenv/config';
import express  from 'express';
import mongoose from 'mongoose';
import cors     from 'cors';
import helmet   from 'helmet';
import './models/User.js';
import './models/NFCTag.js';
import './models/UserTag.js';
import './models/Session.js';
import './models/FocusLog.js';
import './models/Statistics.js';
import './models/AIInsight.js';
import authRoutes      from './routes/auth.js';
import userRoutes      from './routes/user.js';
import sessionRoutes   from './routes/sessions.js';
import analyticsRoutes from './routes/analytics.js';
import errorHandler    from './middleware/errorHandler.js';
import aiRoutes        from './routes/ai.js';

// ─── Fail fast on misconfiguration ──────────────────────────────────────────
// Better to crash on boot than to run with a weak/absent secret or open CORS.
function assertEnv() {
  const required = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'MONGO_URI', 'CORS_ORIGINS'];
  const missing  = required.filter(key => !process.env[key]);
  if (missing.length)
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if (process.env.JWT_SECRET.length < 32)
    throw new Error('JWT_SECRET must be at least 32 characters');
}
assertEnv();

const app  = express();
const PORT = process.env.PORT || 5000;

// Trust the first proxy hop so express-rate-limit sees real client IPs.
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({
  origin:      process.env.CORS_ORIGINS.split(',').map(o => o.trim()),
  credentials: false,
}));
app.use(express.json({ limit: '100kb' }));

app.use('/api/auth',      authRoutes);
app.use('/api/user',      userRoutes);
app.use('/api/sessions',  sessionRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/ai',        aiRoutes);

app.get('/api/health', (_, res) => res.json({ status: 'ok', ts: new Date() }));

app.use(errorHandler);

mongoose.connect(process.env.MONGO_URI)
  .then(() => {
    console.log('MongoDB connected');
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  })
  .catch(err => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });