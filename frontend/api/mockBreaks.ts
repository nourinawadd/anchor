// frontend/api/mockBreaks.ts
// ─── TEMPORARY: Custom Breaks mock ────────────────────────────────────────────
// Stands in for the backend's Custom Breaks support until it ships.
// Enable with EXPO_PUBLIC_MOCK_BREAKS=1 in frontend/.env, then restart with
// `npx expo start -c` (EXPO_PUBLIC_* vars are inlined at bundle time).
//
// It sits in front of apiFetch (one hook in api/client.ts) and:
//   • fully fakes POST /sessions/:id/breaks/start and /breaks/end;
//   • remembers the breakPlan sent with POST /sessions (the real server
//     ignores it) and adds break fields to that response;
//   • adds break fields to GET /sessions and PATCH /sessions/:id/end, and
//     closes any open break when a session ends.
// Everything else passes straight through to the real server. State is kept
// in AsyncStorage so it survives an app kill, like server data would.
//
// Rules (should match the real server):
//   • one break open at a time;
//   • each planned break can be taken once;
//   • on-demand breaks need an allowance, and are charged at their full length
//     when they start (no refund for ending early);
//   • a break never runs past its length (it closes itself at its end time).
//
// To remove: delete this file, the hook in api/client.ts, and the
// EXPO_PUBLIC_MOCK_BREAKS lines in .env / .env.example.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type {
  BreakPlan, BreakRecord, RawSessionRecord, SessionBreakState,
} from '../store/sessions';

export const MOCK_BREAKS_ENABLED =
  ['1', 'true'].includes((process.env.EXPO_PUBLIC_MOCK_BREAKS ?? '').toLowerCase());

if (MOCK_BREAKS_ENABLED) console.info('[mock-breaks] Custom Breaks mock is ON');

type Passthrough = <T>(path: string, token: string | null, options: RequestInit) => Promise<T>;

type Entry = {
  plan:   BreakPlan | null;
  breaks: BreakRecord[];   // includes the open break (endedAtISO === null)
  active: boolean;         // session status is ACTIVE
};

const STORAGE_KEY = '@anchor:mockBreaks:v1';
const MIN_MS = 60_000;

// ─── Persistence (serialized so concurrent calls can't clobber each other) ─────
let cache: Record<string, Entry> | null = null;
let chain: Promise<unknown> = Promise.resolve();

function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function load(): Promise<Record<string, Entry>> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    cache = raw ? JSON.parse(raw) : {};
  } catch {
    cache = {};
  }
  return cache!;
}

async function save(): Promise<void> {
  if (!cache) return;
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache)).catch(() => {});
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
function httpError(status: number, code: string, message: string): Error {
  const err: any = new Error(message);
  err.status = status;
  err.code   = code;
  return err;
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const capMs = (b: BreakRecord) => Date.parse(b.startedAtISO) + b.duration * MIN_MS;
const openBreak = (e: Entry) => e.breaks.find(b => b.endedAtISO === null) ?? null;

/** Close the open break at `atMs`, never past its scheduled end. */
function closeOpen(e: Entry, atMs: number): void {
  const open = openBreak(e);
  if (!open) return;
  const end = Math.min(atMs, capMs(open));
  open.endedAtISO = new Date(end).toISOString();
  open.endedEarly = end < capMs(open);
}

/** A break that reached its length closes itself (not "early"). */
function settle(e: Entry, nowMs: number): void {
  const open = openBreak(e);
  if (open && nowMs >= capMs(open)) closeOpen(e, capMs(open));
}

function onDemandUsed(e: Entry) {
  const od = e.breaks.filter(b => b.type === 'ON_DEMAND');
  return { count: od.length, minutes: od.reduce((a, b) => a + b.duration, 0) };
}

function stateOf(e: Entry, nowMs = Date.now()): SessionBreakState {
  settle(e, nowMs);
  const spentMs = e.breaks.reduce((acc, b) => {
    const start = Date.parse(b.startedAtISO);
    const end   = b.endedAtISO ? Date.parse(b.endedAtISO) : Math.min(nowMs, capMs(b));
    return acc + Math.max(0, end - start);
  }, 0);
  const allowance = e.plan?.allowance ?? null;
  const used = onDemandUsed(e);
  return {
    breakPlan:    e.plan,
    breaks:       e.breaks.map(b => ({ ...b })),
    activeBreak:  openBreak(e) ? { ...openBreak(e)! } : null,
    breakMinutes: Math.round(spentMs / MIN_MS),
    breaksTaken:  e.breaks.length,
    allowanceRemaining: allowance
      ? {
          breaks:  allowance.maxBreaks  == null ? null : Math.max(0, allowance.maxBreaks  - used.count),
          minutes: allowance.maxMinutes == null ? null : Math.max(0, allowance.maxMinutes - used.minutes),
        }
      : null,
  };
}

/** Validate the breakPlan sent on session create, like the server would. */
function parsePlan(raw: any, timerMode: unknown): BreakPlan | null {
  if (raw == null) return null;
  if (timerMode !== undefined && timerMode !== 'COUNTDOWN') return null;  // Countdown only
  const bad = (msg: string) => httpError(400, 'INVALID_BREAK', `breakPlan: ${msg}`);
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('must be an object');

  const plannedRaw = raw.planned ?? [];
  if (!Array.isArray(plannedRaw)) throw bad('planned must be an array');
  const planned = plannedRaw.map((p: any, i: number) => {
    if (!isInt(p?.startAfter) || p.startAfter < 1) throw bad(`planned[${i}].startAfter must be a whole number ≥ 1`);
    if (!isInt(p?.duration) || p.duration < 1 || p.duration > 60) throw bad(`planned[${i}].duration must be 1–60`);
    return { startAfter: p.startAfter, duration: p.duration };
  });

  let allowance: BreakPlan['allowance'] = null;
  if (raw.allowance != null) {
    const { maxBreaks = null, maxMinutes = null } = raw.allowance;
    if (maxBreaks  !== null && (!isInt(maxBreaks)  || maxBreaks  < 0)) throw bad('allowance.maxBreaks must be a whole number ≥ 0');
    if (maxMinutes !== null && (!isInt(maxMinutes) || maxMinutes < 0)) throw bad('allowance.maxMinutes must be a whole number ≥ 0');
    allowance = { maxBreaks, maxMinutes };
  }

  return { planned, allowance, unlockAppsDuringBreak: raw.unlockAppsDuringBreak === true };
}

function parseBody(options: RequestInit): any {
  try { return typeof options.body === 'string' ? JSON.parse(options.body) : {}; } catch { return {}; }
}

/** Find (or create, for sessions the mock hasn't seen) the entry for a session. */
async function entryFor(
  store: Record<string, Entry>, id: string, token: string | null, real: Passthrough,
): Promise<Entry> {
  if (store[id]) return store[id];
  const list = await real<RawSessionRecord[]>('/sessions', token, {});
  const s = list.find(r => r.id === id);
  if (!s) throw httpError(404, 'SESSION_NOT_ACTIVE', 'Session not found');
  store[id] = { plan: null, breaks: [], active: s.status === 'ACTIVE' };
  return store[id];
}

// ─── Mocked break endpoints ──────────────────────────────────────────────────
function mockStart(e: Entry, body: any): SessionBreakState {
  const now = Date.now();
  if (!e.active) throw httpError(409, 'SESSION_NOT_ACTIVE', 'Session is not active');
  settle(e, now);
  if (openBreak(e)) throw httpError(409, 'BREAK_ALREADY_OPEN', 'A break is already in progress');

  let record: BreakRecord;
  if (body?.type === 'PLANNED') {
    const idx = body.plannedIndex;
    const planned = isInt(idx) ? e.plan?.planned[idx] : undefined;
    if (!planned) throw httpError(400, 'INVALID_BREAK', 'Unknown planned break');
    if (e.breaks.some(b => b.type === 'PLANNED' && b.plannedIndex === idx)) {
      throw httpError(409, 'PLANNED_BREAK_TAKEN', 'This planned break was already taken');
    }
    record = {
      type: 'PLANNED', plannedIndex: idx, duration: planned.duration,
      startedAtISO: new Date(now).toISOString(), endedAtISO: null, endedEarly: false,
    };
  } else if (body?.type === 'ON_DEMAND') {
    const dur = body.duration;
    if (!isInt(dur) || dur < 1 || dur > 60) throw httpError(400, 'INVALID_BREAK', 'duration must be 1–60 minutes');
    const allowance = e.plan?.allowance;
    if (!allowance) {
      throw httpError(409, 'ALLOWANCE_EXCEEDED', "On-demand breaks aren't enabled for this session.");
    }
    const used = onDemandUsed(e);
    if (allowance.maxBreaks != null && used.count + 1 > allowance.maxBreaks) {
      throw httpError(409, 'ALLOWANCE_EXCEEDED', "You've used all your on-demand breaks.");
    }
    if (allowance.maxMinutes != null && used.minutes + dur > allowance.maxMinutes) {
      const left = Math.max(0, allowance.maxMinutes - used.minutes);
      throw httpError(409, 'ALLOWANCE_EXCEEDED', `Only ${left} break minute${left === 1 ? '' : 's'} left.`);
    }
    record = {
      type: 'ON_DEMAND', plannedIndex: null, duration: dur,
      startedAtISO: new Date(now).toISOString(), endedAtISO: null, endedEarly: false,
    };
  } else {
    throw httpError(400, 'INVALID_BREAK', "type must be 'PLANNED' or 'ON_DEMAND'");
  }

  e.breaks.push(record);
  return stateOf(e, now);
}

function mockEnd(e: Entry): SessionBreakState {
  const now = Date.now();
  if (!e.active) throw httpError(409, 'SESSION_NOT_ACTIVE', 'Session is not active');
  settle(e, now);
  if (!openBreak(e)) throw httpError(409, 'NO_OPEN_BREAK', 'No break is in progress');
  closeOpen(e, now);
  return stateOf(e, now);
}

// ─── Router ────────────────────────────────────────────────────────────────────
const RE_BREAK = /^\/sessions\/([^/?]+)\/breaks\/(start|end)$/;
const RE_END   = /^\/sessions\/([^/?]+)\/end$/;
const RE_ONE   = /^\/sessions\/([^/?]+)$/;

export function mockApiFetch<T>(
  path: string, token: string | null, options: RequestInit, real: Passthrough,
): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const bare   = path.split('?')[0];
  let m: RegExpMatchArray | null;

  // Break endpoints — fully mocked.
  if (method === 'POST' && (m = bare.match(RE_BREAK))) {
    const [, id, action] = m;
    return locked(async () => {
      const store = await load();
      const e = await entryFor(store, id, token, real);
      const result = action === 'start' ? mockStart(e, parseBody(options)) : mockEnd(e);
      await save();
      return result as T;
    });
  }

  // Create — validate + remember the plan, then let the real server create it.
  if (method === 'POST' && bare === '/sessions') {
    return locked(async () => {
      const body = parseBody(options);
      const plan = parsePlan(body.breakPlan, body.timerMode);
      const created = await real<RawSessionRecord>(path, token, options);
      const store = await load();
      store[created.id] = { plan, breaks: [], active: true };
      await save();
      return { ...created, ...stateOf(store[created.id]) } as T;
    });
  }

  // End — real server ends it; mock closes any open break and stops new ones.
  if (method === 'PATCH' && (m = bare.match(RE_END))) {
    const id = m[1];
    return locked(async () => {
      const res = await real<{ session?: RawSessionRecord }>(path, token, options);
      const store = await load();
      const e = store[id];
      if (e) {
        const endedAt = Date.parse(parseBody(options).endedAt);
        closeOpen(e, Number.isFinite(endedAt) ? endedAt : Date.now());
        e.active = false;
        await save();
        if (res?.session) res.session = { ...res.session, ...stateOf(e) };
      }
      return res as T;
    });
  }

  // List — add break fields; sync sessions that ended without going through /end here.
  if (method === 'GET' && bare === '/sessions') {
    return locked(async () => {
      const list = await real<RawSessionRecord[]>(path, token, options);
      const store = await load();
      let changed = false;
      const merged = list.map(r => {
        const e = store[r.id];
        if (!e) return r;
        if (e.active && r.status && r.status !== 'ACTIVE') {
          closeOpen(e, Date.now());
          e.active = false;
          changed = true;
        }
        return { ...r, ...stateOf(e) };
      });
      if (changed) await save();
      return merged as T;
    });
  }

  // Delete — forget the session's mock state too.
  if (method === 'DELETE' && (m = bare.match(RE_ONE))) {
    const id = m[1];
    return locked(async () => {
      const res = await real<T>(path, token, options);
      const store = await load();
      if (store[id]) { delete store[id]; await save(); }
      return res;
    });
  }

  return real<T>(path, token, options);
}
