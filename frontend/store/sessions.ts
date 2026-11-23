// ─── Shared session data model & helpers ──────────────────────────────────────
// Single source of truth consumed by HistoryScreen, DashboardScreen,
// ActiveSessionScreen, and SessionCompleteScreen.

// ─── Types ────────────────────────────────────────────────────────────────────
// Custom Breaks (Countdown sessions). `startAfter` / `duration` are minutes.
export type BreakPlan = {
  planned: { startAfter: number; duration: number }[];
  allowance: { maxBreaks: number | null; maxMinutes: number | null } | null;
  unlockAppsDuringBreak: boolean;
};

export type BreakRecord = {
  type: 'PLANNED' | 'ON_DEMAND';
  plannedIndex: number | null;   // index into BreakPlan.planned; null for ON_DEMAND
  duration: number;              // minutes
  startedAtISO: string;
  endedAtISO: string | null;     // null while the break is in progress
  endedEarly: boolean;
};

export type SessionRecord = {
  id: string;
  title: string;        // custom name given by user
  categoryId: string;   // reference to the category
  duration: number;     // minutes: actual focus time once ended, else planned
  startTime: string;    // "HH:MM"
  endTime: string;      // "HH:MM"
  focusScore: number | null;
  completed: boolean;
  dateStr: string;      // "YYYY-MM-DD"  (local time, no UTC shift)

  // Lifecycle fields (optional — absent on seed data). Used on launch to
  // finalize or resume a session left ACTIVE by an app kill.
  status?: string;                  // PENDING | ACTIVE | COMPLETED | ABANDONED
  timerMode?: string;               // COUNTDOWN | POMODORO | STOPWATCH
  startedAtISO?: string | null;     // full start timestamp (ISO)
  plannedDuration?: number | null;  // planned focus minutes
  plannedDurationSec?: number | null; // planned focus seconds (source of truth)
  actualDurationSec?: number | null;  // real focus seconds; null until ended
  pomodoroWork?: number | null;     // minutes per focus phase
  pomodoroBreak?: number | null;    // minutes per break phase
  blockedApps?: string[];

  // Custom Breaks — always present after normalizeBreakFields().
  breakPlan: BreakPlan | null;
  breaks: BreakRecord[];
  activeBreak: BreakRecord | null;
  breakMinutes: number;          // total minutes spent on breaks
  breaksTaken: number;
  allowanceRemaining: { breaks: number | null; minutes: number | null } | null;
};

export type BreakFieldKey =
  | 'breakPlan' | 'breaks' | 'activeBreak'
  | 'breakMinutes' | 'breaksTaken' | 'allowanceRemaining';

/** Just the Custom Breaks part of a session (what the break endpoints return). */
export type SessionBreakState = Pick<SessionRecord, BreakFieldKey>;

/** Break fields as the API may send them: any of them (and parts of the
 *  break plan) can be missing. */
export type RawBreakState =
  Partial<Pick<SessionRecord, Exclude<BreakFieldKey, 'breakPlan'>>>
  & { breakPlan?: Partial<BreakPlan> | null };

/** A SessionRecord as the API may send it: break fields can be missing. */
export type RawSessionRecord = Omit<SessionRecord, BreakFieldKey> & RawBreakState;

function normalizeBreakPlan(plan: Partial<BreakPlan> | null | undefined): BreakPlan | null {
  if (!plan) return null;
  return {
    planned:               Array.isArray(plan.planned) ? plan.planned : [],
    allowance:             plan.allowance ?? null,
    // Default to keeping apps blocked — the conservative choice for a focus app.
    unlockAppsDuringBreak: plan.unlockAppsDuringBreak ?? false,
  };
}

/** Safe defaults for any Custom Breaks fields the backend didn't send. */
export function normalizeBreakState(raw: RawBreakState | null | undefined): SessionBreakState {
  return {
    breakPlan:          normalizeBreakPlan(raw?.breakPlan),
    breaks:             Array.isArray(raw?.breaks) ? raw.breaks : [],
    activeBreak:        raw?.activeBreak ?? null,
    breakMinutes:       raw?.breakMinutes ?? 0,
    breaksTaken:        raw?.breaksTaken ?? 0,
    allowanceRemaining: raw?.allowanceRemaining ?? null,
  };
}

/** Fill in safe defaults for Custom Breaks fields the backend doesn't return yet. */
export function normalizeBreakFields(record: RawSessionRecord): SessionRecord {
  return { ...record, ...normalizeBreakState(record) };
}

export type SessionCategory = {
  id: string;
  name: string;
  createdAt: string;
};

// ─── Date helpers ─────────────────────────────────────────────────────────────
/** Local YYYY-MM-DD string — avoids toISOString() UTC offset issues */
export function toDateStr(d: Date): string {
  const y   = d.getFullYear();
  const m   = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** YYYY-MM-DD for n days before today */
export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDateStr(d);
}

/** Zero-padded "HH:MM" for a given Date */
export function fmtHHMM(d: Date): string {
  return (
    String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0')
  );
}

// ─── Aggregate helpers ────────────────────────────────────────────────────────
/** Consecutive days (from today backwards) that have at least one completed session.
 *  Today having no session yet does NOT break the streak — it's only broken once a
 *  full day passes with no session. So if there's nothing logged today, we start
 *  counting from yesterday and keep the streak alive. */
export function computeStreak(sessions: SessionRecord[]): number {
  const done = new Set(sessions.filter(s => s.completed).map(s => s.dateStr));
  const d = new Date();
  if (!done.has(toDateStr(d))) d.setDate(d.getDate() - 1);
  let streak = 0;
  while (done.has(toDateStr(d))) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

/** Longest ever consecutive-day streak across all completed sessions */
export function computeLongestStreak(sessions: SessionRecord[]): number {
  const sorted = [...new Set(sessions.filter(s => s.completed).map(s => s.dateStr))].sort();
  let max = 0, cur = 0, prev: string | null = null;
  for (const ds of sorted) {
    const diff = prev
      ? Math.round((new Date(ds + 'T12:00:00').getTime() - new Date(prev + 'T12:00:00').getTime()) / 86_400_000)
      : null;
    cur = diff === 1 ? cur + 1 : 1;
    if (cur > max) max = cur;
    prev = ds;
  }
  return max;
}

/** Total focus hours from completed sessions, formatted to 1 decimal */
export function computeFocusHours(sessions: SessionRecord[]): string {
  const mins = sessions
    .filter(s => s.completed)
    .reduce((acc, s) => acc + s.duration, 0);
  return (mins / 60).toFixed(1);
}

/** Today's completed focus minutes as a percentage of goalMins (0–100, clamped) */
export function computeDailyProgress(sessions: SessionRecord[], goalMins: number): number {
  const today     = toDateStr(new Date());
  const todayMins = sessions
    .filter(s => s.completed && s.dateStr === today)
    .reduce((acc, s) => acc + s.duration, 0);
  return Math.min(Math.round((todayMins / Math.max(goalMins, 1)) * 100), 100);
}

/** Average focus score of today's completed sessions (0 if none) */
export function computeTodayScore(sessions: SessionRecord[]): number {
  const today = toDateStr(new Date());
  const todayDone = sessions.filter(
    s => s.completed && s.focusScore !== null && s.dateStr === today,
  );
  if (todayDone.length === 0) return 0;
  return Math.round(
    todayDone.reduce((a, s) => a + (s.focusScore ?? 0), 0) / todayDone.length,
  );
}

// ─── Seed data ────────────────────────────────────────────────────────────────
// (Removed) The old SEED_SESSIONS demo list lived here. It was unused —
// sessions now load from the server (App.tsx) — and predated the categoryId
// model (it still carried a freeform `type`), so it was dropped during the
// category migration.
