// Pure scheduler rules (services/planner/scheduler.js). No database, no AI.
import { describe, it, expect } from 'vitest';
import {
  schedule, splitIntoChunks, chunkLength, DEFAULT_HOUR_SCORES, REVIEW_MINUTES,
} from '../services/planner/scheduler.js';
import { shiftDateStr, weekdayOfDateStr } from '../utils/datetime.js';

const TODAY = '2026-03-02';   // a Monday
const day = (n) => shiftDateStr(TODAY, n);

const SETTINGS = {
  windows: [0, 1, 2, 3, 4, 5, 6].map(weekday => ({ weekday, start: 960, end: 1320 })),   // 16:00–22:00
  maxDailyMinutes: 240,
  sessionLength: 50,
  breakBetween: 10,
  noStudyAfter: 1380,
};

const task = (over = {}) => ({
  id: over.id ?? 't1', categoryId: 'cat', kind: 'STUDY', deadline: day(5), difficulty: 2, remainingMinutes: 180, ...over,
});

const run = (over = {}) => schedule({ tasks: [task()], settings: SETTINGS, today: TODAY, nowMinute: 0, ...over });

function assertValid({ blocks }, { tasks, settings = SETTINGS, busy = [], nowMinute = 0 }) {
  const byTask = new Map(tasks.map(t => [t.id, t]));
  const perDay = new Map();
  for (const b of blocks) {
    const t = byTask.get(b.taskId);
    expect(b.dateStr < t.deadline).toBe(true);                         // before the deadline day
    expect(b.dateStr >= TODAY).toBe(true);                             // not in the past
    if (b.dateStr === TODAY) expect(b.startMinute).toBeGreaterThanOrEqual(nowMinute);
    const wd = weekdayOfDateStr(b.dateStr);
    const inWindow = settings.windows.some(w => w.weekday === wd && b.startMinute >= w.start
      && b.startMinute + b.durationMinutes <= Math.min(w.end, settings.noStudyAfter));
    expect(inWindow).toBe(true);
    perDay.set(b.dateStr, [...(perDay.get(b.dateStr) ?? []), b]);
  }
  for (const [d, list] of perDay) {
    const all = [...list, ...busy.filter(x => x.dateStr === d)].sort((a, b) => a.startMinute - b.startMinute);
    for (let i = 1; i < all.length; i++) {
      const prevEnd = all[i - 1].startMinute + all[i - 1].durationMinutes;
      expect(all[i].startMinute).toBeGreaterThanOrEqual(prevEnd + settings.breakBetween);   // no overlap, gap kept
    }
    const minutes = all.reduce((a, b) => a + b.durationMinutes, 0);
    expect(minutes).toBeLessThanOrEqual(settings.maxDailyMinutes);
  }
}

describe('chunking', () => {
  it('sizes blocks by difficulty from the preferred session length', () => {
    expect(chunkLength(3, 50)).toBe(50);
    expect(chunkLength(2, 50)).toBe(45);
    expect(chunkLength(1, 50)).toBe(30);
    expect(chunkLength(1, 20)).toBe(15);   // never below 15
  });

  it('splits minutes into blocks and folds a short tail into the last block', () => {
    expect(splitIntoChunks(180, 50)).toEqual([50, 50, 50, 30]);
    expect(splitIntoChunks(110, 50)).toEqual([50, 60]);
    expect(splitIntoChunks(10, 50)).toEqual([15]);
    expect(splitIntoChunks(0, 50)).toEqual([]);
  });
});

describe('schedule — hard rules', () => {
  it('places every minute before the deadline, inside study windows, without overlaps', () => {
    const tasks = [task({ id: 'a', remainingMinutes: 300 }), task({ id: 'b', deadline: day(3), remainingMinutes: 120, difficulty: 3 })];
    const out = schedule({ tasks, settings: SETTINGS, today: TODAY, nowMinute: 0 });
    assertValid(out, { tasks });
    expect(out.warnings).toEqual([]);
    const minutes = (id) => out.blocks.filter(b => b.taskId === id).reduce((a, b) => a + b.durationMinutes, 0);
    expect(minutes('a')).toBe(300);
    expect(minutes('b')).toBe(120);
  });

  it('never plans before "now" today', () => {
    const nowMinute = 18 * 60 + 7;
    const out = run({ nowMinute });
    assertValid(out, { tasks: [task()], nowMinute });
    for (const b of out.blocks.filter(x => x.dateStr === TODAY)) expect(b.startMinute).toBeGreaterThanOrEqual(18 * 60 + 15);
  });

  it('respects busy time (kept blocks) and counts it toward the daily limit', () => {
    const busy = [{ dateStr: day(0), startMinute: 960, durationMinutes: 200 }];
    const out = run({ busy });
    assertValid(out, { tasks: [task()], busy });
    const day0 = out.blocks.filter(b => b.dateStr === day(0)).reduce((a, b) => a + b.durationMinutes, 0);
    expect(day0 + 200).toBeLessThanOrEqual(SETTINGS.maxDailyMinutes);
  });

  it('caps each day at maxDailyMinutes', () => {
    const settings = { ...SETTINGS, maxDailyMinutes: 60 };
    const tasks = [task({ remainingMinutes: 600, deadline: day(20) })];
    const out = schedule({ tasks, settings, today: TODAY });
    assertValid(out, { tasks, settings });
  });

  it('returns a partial plan with NOT_ENOUGH_TIME instead of failing', () => {
    const tasks = [task({ remainingMinutes: 2000, deadline: day(2) })];
    const out = schedule({ tasks, settings: SETTINGS, today: TODAY });
    assertValid(out, { tasks });
    const placed = out.blocks.reduce((a, b) => a + b.durationMinutes, 0);
    expect(out.warnings).toEqual([expect.objectContaining({ code: 'NOT_ENOUGH_TIME', taskId: 't1', minutes: 2000 - placed })]);
  });

  it('warns DEADLINE_TOO_SOON for a deadline today and plans nothing for it', () => {
    const out = run({ tasks: [task({ deadline: TODAY })] });
    expect(out.blocks).toEqual([]);
    expect(out.warnings[0].code).toBe('DEADLINE_TOO_SOON');
  });

  it('honors noStudyAfter even when a window runs later', () => {
    const settings = { ...SETTINGS, noStudyAfter: 18 * 60 };
    const out = schedule({ tasks: [task()], settings, today: TODAY });
    assertValid(out, { tasks: [task()], settings });
    for (const b of out.blocks) expect(b.startMinute + b.durationMinutes).toBeLessThanOrEqual(18 * 60);
  });
});

describe('schedule — preferences', () => {
  it('puts hard work in the user\'s best focus hours', () => {
    const hourScores = DEFAULT_HOUR_SCORES.map((_, h) => (h === 19 ? 1 : 0.1));
    const out = run({ tasks: [task({ difficulty: 3, remainingMinutes: 150, deadline: day(6) })], hourScores });
    for (const b of out.blocks) expect(Math.floor(b.startMinute / 60)).toBe(19);
  });

  it('spreads one task across days instead of stacking a single day', () => {
    const out = run({ tasks: [task({ remainingMinutes: 180, deadline: day(6) })] });
    const days = new Set(out.blocks.map(b => b.dateStr));
    expect(days.size).toBeGreaterThanOrEqual(3);
  });

  it('adds a review block the day before an exam, unless one is kept already', () => {
    const exam = task({ kind: 'EXAM', deadline: day(4), remainingMinutes: 100 });
    const out = run({ tasks: [exam] });
    const review = out.blocks.filter(b => b.kind === 'REVIEW');
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ dateStr: day(3), durationMinutes: REVIEW_MINUTES });

    const again = run({ tasks: [{ ...exam, hasReview: true }] });
    expect(again.blocks.filter(b => b.kind === 'REVIEW')).toHaveLength(0);
  });

  it('is deterministic', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b', deadline: day(4), difficulty: 3 })];
    const a = schedule({ tasks, settings: SETTINGS, today: TODAY, nowMinute: 600 });
    const b = schedule({ tasks, settings: SETTINGS, today: TODAY, nowMinute: 600 });
    expect(a).toEqual(b);
  });
});
