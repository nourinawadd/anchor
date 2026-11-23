// Study Planner scheduler — a PURE function (no database, no AI, no clock):
// the same input always gives the same plan, so it is fully unit-testable.
//
//   schedule({ tasks, settings, hourScores, busy, today, nowMinute })
//     → { blocks, warnings }
//
// Guarantees (test/plannerScheduler.test.js):
//   - no block on or after its task's deadline day, and none in the past;
//   - blocks never overlap each other or `busy` intervals, and keep
//     `breakBetween` minutes apart;
//   - every block sits inside the user's study windows and before noStudyAfter;
//   - no day exceeds maxDailyMinutes (busy minutes included);
//   - when time runs out the plan is partial and a NOT_ENOUGH_TIME warning
//     says how many minutes didn't fit — it never throws.
//
// Placement is greedy: tasks by earliest deadline (then hardest first); each
// chunk goes to the best-scoring free slot. The score prefers the user's
// high-focus hours (more so for hard tasks), earlier days for close
// deadlines, and spreading one task across days.
import { shiftDateStr, diffDays, weekdayOfDateStr } from '../../utils/datetime.js';

export const STEP_MINUTES     = 15;
export const MIN_BLOCK        = 15;
export const REVIEW_MINUTES   = 30;
export const MAX_PLAN_DAYS    = 60;
const REVIEW_KINDS = new Set(['EXAM', 'QUIZ']);

// Exams and quizzes get a short review the day before, unless a kept block
// already covers it (`hasReview`, set when re-planning).
const wantsReview = (t) => REVIEW_KINDS.has(t.kind) && !t.hasReview;

const ceilTo = (m, step) => Math.ceil(m / step) * step;
const round5 = (m) => Math.round(m / 5) * 5;

/** Default focus-quality curve (0..1) when the user has little history. */
export const DEFAULT_HOUR_SCORES = Object.freeze(Array.from({ length: 24 }, (_, h) => {
  if (h >= 9 && h <= 11) return 0.7;
  if (h >= 16 && h <= 18) return 0.65;
  if (h >= 12 && h <= 20) return 0.55;
  if (h >= 7 && h <= 22) return 0.45;
  return 0.2;
}));

/** Block length for a task, from the user's preferred session length. */
export function chunkLength(difficulty, sessionLength) {
  if (difficulty >= 3) return sessionLength;
  if (difficulty === 2) return Math.max(MIN_BLOCK, round5(sessionLength * 0.9));
  return Math.max(MIN_BLOCK, round5(sessionLength * 0.6));
}

/** Split `minutes` into chunks of `len`; a tail under MIN_BLOCK joins the last chunk. */
export function splitIntoChunks(minutes, len) {
  if (minutes <= 0) return [];
  if (minutes <= len) return [Math.max(MIN_BLOCK, minutes)];
  const chunks = [];
  let left = minutes;
  while (left > 0) {
    const c = Math.min(len, left);
    left -= c;
    if (left > 0 && left < MIN_BLOCK) { chunks.push(c + left); left = 0; } else chunks.push(c);
  }
  return chunks;
}

// ─── Free-time bookkeeping ───────────────────────────────────────────────────

function mergeIntervals(list) {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    if (e <= s) continue;
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e); else out.push([s, e]);
  }
  return out;
}

function subtract(intervals, [cs, ce]) {
  const out = [];
  for (const [s, e] of intervals) {
    if (ce <= s || cs >= e) { out.push([s, e]); continue; }
    if (cs > s) out.push([s, cs]);
    if (ce < e) out.push([ce, e]);
  }
  return out;
}

function windowsForDay(dateStr, settings) {
  const wd = weekdayOfDateStr(dateStr);
  const raw = (settings.windows ?? [])
    .filter(w => w.weekday === wd)
    .map(w => [w.start, Math.min(w.end, settings.noStudyAfter)]);
  return mergeIntervals(raw);
}

// ─── Main ────────────────────────────────────────────────────────────────────

/**
 * @param tasks       [{ id, categoryId, kind, deadline 'YYYY-MM-DD', difficulty 1-3, remainingMinutes, hasReview? }]
 * @param settings    { windows:[{weekday,start,end}], maxDailyMinutes, sessionLength, breakBetween, noStudyAfter }
 * @param hourScores  number[24] in 0..1 (focus quality per local hour)
 * @param busy        [{ dateStr, startMinute, durationMinutes }] kept blocks / existing commitments
 * @param today       'YYYY-MM-DD' (user's local day)
 * @param nowMinute   minutes since local midnight now (nothing is planned before it today)
 */
export function schedule({ tasks, settings, hourScores = DEFAULT_HOUR_SCORES, busy = [], today, nowMinute = 0 }) {
  const gap = settings.breakBetween ?? 0;
  const maxDaily = settings.maxDailyMinutes;
  const scores = hourScores.length === 24 ? hourScores : DEFAULT_HOUR_SCORES;
  const warnings = [];
  const blocks = [];

  const open = tasks
    .filter(t => t.remainingMinutes > 0 || wantsReview(t))
    .sort((a, b) => (a.deadline === b.deadline
      ? (b.difficulty - a.difficulty) || String(a.id).localeCompare(String(b.id))
      : a.deadline < b.deadline ? -1 : 1));

  const lastDeadline = open.reduce((m, t) => (t.deadline > m ? t.deadline : m), today);
  const horizonEnd = shiftDateStr(today, MAX_PLAN_DAYS - 1);
  const lastDay = lastDeadline > horizonEnd ? horizonEnd : shiftDateStr(lastDeadline, -1);

  // Free intervals and load per day.
  const free = new Map();
  const load = new Map();
  for (let d = today; d <= lastDay; d = shiftDateStr(d, 1)) {
    let iv = windowsForDay(d, settings);
    if (d === today) iv = subtract(iv, [0, ceilTo(nowMinute + 5, STEP_MINUTES)]);
    free.set(d, iv);
    load.set(d, 0);
  }
  for (const b of busy) {
    if (!free.has(b.dateStr)) continue;
    free.set(b.dateStr, subtract(free.get(b.dateStr), [b.startMinute - gap, b.startMinute + b.durationMinutes + gap]));
    load.set(b.dateStr, load.get(b.dateStr) + b.durationMinutes);
  }

  const perTaskDay = new Map();   // `${taskId}|${dateStr}` → blocks placed
  const countOn = (taskId, d) => perTaskDay.get(`${taskId}|${d}`) ?? 0;

  function reserve(task, d, start, len, kind) {
    free.set(d, subtract(free.get(d), [start, start + len + gap]));
    load.set(d, load.get(d) + len);
    perTaskDay.set(`${task.id}|${d}`, countOn(task.id, d) + 1);
    blocks.push({ taskId: task.id, categoryId: task.categoryId, dateStr: d, startMinute: start, durationMinutes: len, kind });
  }

  /** Best slot for a `len`-minute block of `task` within [firstDay, endDay]. */
  function bestSlot(task, len, firstDay, endDay, { preferLate = false } = {}) {
    let best = null;
    const span = Math.max(1, diffDays(today, endDay));
    for (let d = firstDay; d <= endDay; d = shiftDateStr(d, 1)) {
      if (!free.has(d) || load.get(d) + len > maxDaily) continue;
      const dayIdx = diffDays(today, d);
      const same = countOn(task.id, d);
      for (const [s, e] of free.get(d)) {
        for (let t = ceilTo(s, STEP_MINUTES); t + len <= e; t += STEP_MINUTES) {
          const hs = scores[Math.floor(t / 60)] ?? 0.4;
          const urgency = preferLate ? dayIdx / span : 1 - dayIdx / span;
          const score = 3 * hs * (0.5 + task.difficulty / 3)
            + 1.5 * urgency
            - (same >= 1 ? 1.5 : 0) - (same >= 2 ? 3 : 0)
            - (t >= 21 * 60 ? 0.5 : 0);
          if (!best || score > best.score + 1e-9) best = { d, t, score };
        }
      }
    }
    return best;
  }

  for (const task of open) {
    const taskLastDay = shiftDateStr(task.deadline, -1);
    if (task.deadline <= today) {
      warnings.push({ code: 'DEADLINE_TOO_SOON', taskId: task.id, minutes: task.remainingMinutes,
        message: 'The deadline is today or has passed, so no study time could be planned before it.' });
      continue;
    }
    const endDay = taskLastDay > lastDay ? lastDay : taskLastDay;

    // A short review the day before an exam or quiz, placed first so study
    // blocks can't take its slot. Falls back to any earlier day.
    if (wantsReview(task)) {
      const slot = bestSlot(task, REVIEW_MINUTES, endDay, endDay)
        ?? bestSlot(task, REVIEW_MINUTES, today, endDay, { preferLate: true });
      if (slot) reserve(task, slot.d, slot.t, REVIEW_MINUTES, 'REVIEW');
    }

    const len = chunkLength(task.difficulty, settings.sessionLength);
    let unscheduled = 0;
    for (const chunk of splitIntoChunks(task.remainingMinutes, len)) {
      const slot = bestSlot(task, chunk, today, endDay);
      if (slot) reserve(task, slot.d, slot.t, chunk, 'STUDY'); else unscheduled += chunk;
    }
    if (unscheduled > 0) {
      warnings.push({ code: 'NOT_ENOUGH_TIME', taskId: task.id, minutes: unscheduled,
        message: `${unscheduled} minutes didn't fit before the deadline. Add study time, raise your daily limit or lower the estimate.` });
    }
  }

  blocks.sort((a, b) => (a.dateStr === b.dateStr ? a.startMinute - b.startMinute : a.dateStr < b.dateStr ? -1 : 1));
  return { blocks, warnings };
}
