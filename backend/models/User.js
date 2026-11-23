import mongoose from 'mongoose';
import bcrypt   from 'bcryptjs'; 

const NotifySchema = new mongoose.Schema({
  dailyNudge:      { type: Boolean, default: true },
  inSessionAlerts: { type: Boolean, default: true },
  dailySummary:    { type: Boolean, default: true },
  streakAlert:     { type: Boolean, default: true },
  goalNudge:       { type: Boolean, default: true },
  goalAchieved:    { type: Boolean, default: true },
}, { _id: false });

const CategorySchema = new mongoose.Schema({
  id:   { type: String, required: true },  // unique within user
  name: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

// Study Planner availability (see services/planner). Minutes from local
// midnight; weekday 0 = Sunday. Edited via /api/planner/settings.
const StudyWindowSchema = new mongoose.Schema({
  weekday: { type: Number, required: true, min: 0, max: 6 },
  start:   { type: Number, required: true, min: 0, max: 1440 },
  end:     { type: Number, required: true, min: 0, max: 1440 },
}, { _id: false });

const DEFAULT_STUDY_WINDOWS = () => [0, 1, 2, 3, 4, 5, 6].map(weekday => (
  weekday === 5 || weekday === 6
    ? { weekday, start: 600, end: 1320 }    // Fri/Sat 10:00–22:00
    : { weekday, start: 960, end: 1320 }    // other days 16:00–22:00
));

const PlannerSettingsSchema = new mongoose.Schema({
  windows:         { type: [StudyWindowSchema], default: DEFAULT_STUDY_WINDOWS },
  maxDailyMinutes: { type: Number, default: 240, min: 30, max: 960 },
  sessionLength:   { type: Number, default: 50,  min: 15, max: 180 },
  breakBetween:    { type: Number, default: 10,  min: 0,  max: 60 },
  noStudyAfter:    { type: Number, default: 1380, min: 60, max: 1440 },   // 23:00
}, { _id: false });

const SettingsSchema = new mongoose.Schema({
  defaultTimerMode: {
    type:    String,
    enum:    ['COUNTDOWN', 'POMODORO', 'STOPWATCH'],
    default: 'COUNTDOWN',
  },
  defaultDuration: { type: Number, default: 45 },
  pomodoroWork:    { type: Number, default: 25 },
  pomodoroBreak:   { type: Number, default: 5  },
  dailyGoalMinutes:  { type: Number, default: 120 },
  weeklyGoalMinutes: { type: Number, default: 600 },

  notificationsEnabled: { type: Boolean, default: true },
  // Evening hour for the daily summary + goal nudge (streak alert fires at +1).
  reminderHour:         { type: Number, default: 20 },
  // Morning hour for the start nudge — sent only if no session exists that day.
  nudgeHour:            { type: Number, default: 9 },
  notify:               { type: NotifySchema, default: () => ({}) },

  // IANA timezone (e.g. "Europe/Istanbul"). Drives all server-side
  // hour-of-day / "today" calculations. Defaults to UTC.
  timezone: { type: String, default: 'UTC' },

  planner: { type: PlannerSettingsSchema, default: () => ({}) },
}, { _id: false });

const UserSchema = new mongoose.Schema({
  email:        { type: String, required: true, unique: true, lowercase: true, trim: true },
  // Optional: social-only accounts (Google/Apple) never set a password. A user
  // with no passwordHash simply cannot authenticate via /login (see guard below).
  passwordHash: { type: String },
  // Optional: Apple only returns a name on the first authorization and the user
  // may decline it, so a name is not guaranteed. Routes supply a fallback.
  name:         { type: String, trim: true },

  // Linked third-party identities. `sub` claim from a verified provider ID token.
  // Sparse + unique: at most one account per provider identity, but accounts
  // without the field (e.g. password-only users) don't collide on null.
  googleId:     { type: String, index: { unique: true, sparse: true } },
  appleId:      { type: String, index: { unique: true, sparse: true } },

  // User-defined session categories (e.g. 'Work', 'Fitness', 'Reading')
  categories:   { type: [CategorySchema], default: () => ([]) },

  settings:     { type: SettingsSchema, default: () => ({}) },
  pushTokens:   { type: [String], default: [] },

  // Default true so accounts created before this feature (and social accounts,
  // whose email the provider already verified) hydrate as verified with no
  // migration. /register sets false explicitly when verification is required.
  emailVerified: { type: Boolean, default: true },
  verification: {
    type: new mongoose.Schema({
      codeHash:   { type: String, default: null },  // bcrypt hash of the 6-digit code
      expiresAt:  { type: Date,   default: null },
      attempts:   { type: Number, default: 0 },     // failed tries; locks at max
      lastSentAt: { type: Date,   default: null },  // resend cooldown anchor
    }, { _id: false }),
    default: () => ({}),
  },

  // Forgot-password flow. Kept separate from `verification` so a pending email
  // verification and a password reset can't clobber each other. Same shape:
  // a bcrypt-hashed 6-digit code with TTL, attempt locking and a resend anchor.
  passwordReset: {
    type: new mongoose.Schema({
      codeHash:   { type: String, default: null },
      expiresAt:  { type: Date,   default: null },
      attempts:   { type: Number, default: 0 },
      lastSentAt: { type: Date,   default: null },
    }, { _id: false }),
    default: () => ({}),
  },

  notifyState: {
    type: new mongoose.Schema({
      summaryDateStr: { type: String, default: '' },
      streakDateStr:  { type: String, default: '' },
      goalDateStr:    { type: String, default: '' },
      nudgeDateStr:   { type: String, default: '' },
    }, { _id: false }),
    default: () => ({}),
  },
}, {
  timestamps: true,
});

UserSchema.pre('save', async function () {
  if (!this.isModified('passwordHash')) return;
  // A social account may clear/lack a password; only hash a real value.
  if (!this.passwordHash) return;
  this.passwordHash = await bcrypt.hash(this.passwordHash, 12);
});

UserSchema.methods.comparePassword = function (candidate) {
  // Social-only users have no hash — never authenticate them via password.
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(candidate, this.passwordHash);
};

UserSchema.methods.toJSON = function () {
  const obj = this.toObject();
  delete obj.passwordHash;
  delete obj.verification;    // never expose the code hash / attempt state
  delete obj.passwordReset;   // ditto for the reset code
  return obj;
};

export default mongoose.model('User', UserSchema);