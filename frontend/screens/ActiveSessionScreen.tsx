import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform,
  Alert, Animated, Modal, Easing, AppState,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NavProps } from '../App';
import {
  toDateStr, fmtHHMM, normalizeBreakState, recordedBreakMs,
  type BreakPlan, type BreakRecord, type RawBreakState, type SessionBreakState,
} from '../store/sessions';
import CircularProgress from '../components/CircularProgress';
import { colors, spacing, radii, fontSize } from '../constants/theme';
import { apiFetch } from '../api/client';
import { startBreak, endBreak, BreakError } from '../api/breaks';
import { hLight, hMedium, hSuccess } from '../utils/haptics';
import { initNFC, readTag, cancelScan, isNFCSupported } from '../utils/nfc';
import { isPadDevice, useResponsive } from '../utils/responsive';
import { addSessionEvent } from '../utils/calendar';
import { scheduleSessionAlert, cancelSessionAlert } from '../notifications';
import {
  isSupported as screenTimeSupported,
  hasSelection as screenTimeHasSelection,
  applyShield as applyScreenTimeShield,
  clearShield as clearScreenTimeShield,
  getSelectionSummary,
  summaryTotal,
} from 'anchor-screen-time';
import {
  isSupported as liveActivitySupported,
  startActivity as startLiveActivity,
  updateActivity as updateLiveActivity,
  endActivity as endLiveActivity,
} from 'anchor-live-activity';

// Slate background of the focus screen (matches the dark blue-grey mockup).
const SLATE      = '#313852';
const RING_TRACK = 'rgba(255,255,255,0.12)';
const RING_ARC   = 'rgba(255,255,255,0.92)';

function fmt(secs: number) {
  const m = Math.floor(secs / 60).toString().padStart(2, '0');
  const s = (secs % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

type NfcModalPhase = 'scanning' | 'unregistered';

/** A Custom Break in progress on this screen (Countdown only). */
type CustomBreak = {
  type: 'PLANNED' | 'ON_DEMAND';
  plannedIndex: number | null;
  duration: number;         // minutes
  savedFocusSecs: number;   // focus time left when the break started; restored after
  startedAtMs: number;      // wall-clock start (for the local break-time fallback)
  synced: boolean;          // server confirmed the start (set later for planned breaks)
};
type NewBreak = Omit<CustomBreak, 'savedFocusSecs' | 'startedAtMs'>;

const ON_DEMAND_PRESETS = [5, 10, 15];

/** The Custom Breaks plan passed by CreateSession as JSON, or null if none/invalid. */
function parseBreakPlanParam(raw: string | undefined): BreakPlan | null {
  if (!raw) return null;
  try {
    return normalizeBreakState({ breakPlan: JSON.parse(raw) }).breakPlan;
  } catch {
    console.warn('[breaks] ignoring malformed breakPlan param');
    return null;
  }
}

// The screen stays mounted for the whole session (App hides it while the user
// is elsewhere); `visible` is false then, and its popups stay hidden.
export default function ActiveSessionScreen({ nav, visible = true }: { nav: NavProps; visible?: boolean }) {
  const { isWide } = useResponsive();
  const ringSize    = isWide ? 320 : 250;
  const totalSecs   = parseInt(nav.params.plannedDuration ?? '45') * 60;
  const isPomo      = nav.params.pomodoro === 'true';
  const pomoWork    = parseInt(nav.params.pomodoroWork  ?? '25');
  const pomoBreak   = parseInt(nav.params.pomodoroBreak ?? '5');
  const blockedApps = (nav.params.blockedApps ?? '').split(',').filter(Boolean);
  const sessionName = nav.params.customName || 'Untitled';

  const FOCUS_SECS = isPomo ? pomoWork  * 60 : totalSecs;
  const BREAK_SECS = isPomo ? pomoBreak * 60 : 0;
  const maxRounds  = isPomo ? Math.max(Math.ceil(totalSecs / (pomoWork * 60)), 1) : 1;

  // Resuming a session that survived an app kill: App passes the existing
  // session id + original start so we adopt it instead of creating a new one.
  const resumeId        = nav.params.resumeId || null;
  const resumeStartedAt = resumeId && nav.params.resumeStartedAt
    ? new Date(nav.params.resumeStartedAt)
    : null;

  // Custom Breaks — Countdown only; Pomodoro never sends or reads a plan.
  const breakPlan = isPomo ? null : parseBreakPlanParam(nav.params.breakPlan);
  // A new session with a plan waits for the server to accept it before the
  // timer, shield and Live Activity start; a rejected plan means no session.
  const awaitsServer = !!breakPlan && !resumeId && !!nav.token;

  // Resuming a Custom Breaks session after an app kill: App passes the recorded
  // breaks. Read once at mount. `open` is a break still running; `expiredOpen`
  // one that was open but whose time ran out while the app was dead.
  const [resumeBreakInfo] = useState(() => {
    if (isPomo || !breakPlan || !resumeStartedAt) return null;
    let raw: any = null;
    try { raw = nav.params.resumeBreaks ? JSON.parse(nav.params.resumeBreaks) : null; } catch { /* ignore */ }
    const breaks: BreakRecord[] = Array.isArray(raw?.breaks) ? raw.breaks : [];
    const active: BreakRecord | null = raw?.activeBreak ?? breaks.find(b => b.endedAtISO === null) ?? null;
    const list = active && !breaks.some(b => b.startedAtISO === active.startedAtISO)
      ? [...breaks, active]
      : breaks;
    const nowMs     = Date.now();
    const openCapMs = active ? Date.parse(active.startedAtISO) + active.duration * 60_000 : 0;
    const isOpen    = !!active && nowMs < openCapMs;
    const closed    = isOpen ? list.filter(b => b.startedAtISO !== active!.startedAtISO) : list;
    return {
      list,
      breakMs:     recordedBreakMs(list, nowMs),     // all break time so far (open one up to now)
      closedMs:    recordedBreakMs(closed, nowMs),   // excluding a still-running break
      open:        isOpen ? active : null,
      openCapMs,
      expiredOpen: !!active && !isOpen,
    };
  });

  // Fast-forward the timer to where it would be had the app stayed alive:
  // walk the elapsed wall-clock time through the phase sequence (same scheme
  // as reconcilePomodoro below), banking focus time for finished phases.
  const initialState = (() => {
    if (!resumeStartedAt) {
      return { phase: 'focus' as const, round: 1, remaining: FOCUS_SECS, banked: 0 };
    }
    let over = (Date.now() - resumeStartedAt.getTime()) / 1000;
    if (!isPomo && resumeBreakInfo) {
      // Custom Breaks: focus done = time elapsed − time spent in breaks (pauses
      // are ignored, exactly like the plan-less recovery below).
      const focusDone = Math.min(totalSecs, Math.max(0, over - resumeBreakInfo.breakMs / 1000));
      return {
        phase:     'focus' as const,
        round:     1,
        remaining: Math.max(0, Math.round(totalSecs - focusDone)),
        banked:    focusDone,
      };
    }
    if (!isPomo) {
      return {
        phase:     'focus' as const,
        round:     1,
        remaining: Math.max(0, Math.round(totalSecs - over)),
        banked:    Math.min(totalSecs, over),
      };
    }
    let p: 'focus' | 'break' = 'focus';
    let r = 1;
    let banked = 0;
    for (;;) {
      const dur = p === 'focus' ? FOCUS_SECS : BREAK_SECS;
      if (over < dur) {
        if (p === 'focus') banked += over;
        return { phase: p, round: r, remaining: Math.max(1, Math.round(dur - over)), banked };
      }
      over -= dur;
      if (p === 'focus') {
        banked += FOCUS_SECS;
        p = 'break';
      } else {
        if (r + 1 > maxRounds) return { phase: p, round: r, remaining: 0, banked };
        r += 1;
        p = 'focus';
      }
    }
  })();

  const [phase,        setPhase]        = useState<'focus' | 'break'>(initialState.phase);
  const [round,        setRound]        = useState(initialState.round);
  const [remaining,    setRemaining]    = useState(initialState.remaining);
  const [running,      setRunning]      = useState(initialState.remaining > 0 && !awaitsServer);
  const [creating,     setCreating]     = useState(awaitsServer);  // waiting on POST /sessions
  // Break info as last returned by the server (or the mock). Countdown only;
  // a resumed session starts from the record App already loaded.
  const [breakState,   setBreakState]   = useState<SessionBreakState | null>(() => {
    if (isPomo || !resumeId) return null;
    const rec = nav.sessions.find(s => s.id === resumeId);
    return rec ? normalizeBreakState(rec) : null;
  });
  const [nfcModal,     setNfcModal]     = useState(false);
  const [nfcPhase,     setNfcPhase]     = useState<NfcModalPhase>('scanning');
  const [stCount,      setStCount]      = useState(0);   // # apps shielded by Screen Time

  const startedAt      = useRef(resumeStartedAt ?? new Date());
  const sessionIdRef   = useRef<string | null>(null);
  const shieldAppliedRef = useRef(false);

  // Wall-clock timer anchoring — so backgrounding can't freeze the countdown.
  const deadlineRef      = useRef(0);                   // ms timestamp the phase ends
  const focusAccumRef    = useRef(initialState.banked); // committed focus seconds
  const focusRunStartRef = useRef<number | null>(null); // start of the live focus run
  // Custom Breaks: a focus run never counts past this instant — the moment the
  // next planned break is due. Always Infinity for Pomodoro / plan-less sessions.
  const focusCapMsRef    = useRef(Infinity);

  // ── Custom Breaks (Countdown only) ──
  // A resumed session whose break is still running starts inside that break.
  const [customBreak,        setCustomBreak]        = useState<CustomBreak | null>(() => {
    const open = resumeBreakInfo?.open;
    if (!open || initialState.remaining <= 0) return null;
    return {
      type:           open.type,
      plannedIndex:   open.plannedIndex,
      duration:       open.duration,
      savedFocusSecs: initialState.remaining,
      startedAtMs:    Date.parse(open.startedAtISO),
      synced:         true,   // the server recorded it
    };
  });
  const [breakRemaining,     setBreakRemaining]     = useState(() =>   // seconds
    resumeBreakInfo?.open ? Math.max(1, Math.round((resumeBreakInfo.openCapMs - Date.now()) / 1000)) : 0);
  const [breakSheet,         setBreakSheet]         = useState(false);
  const [breakBusy,          setBreakBusy]          = useState(false);  // waiting on the server
  const [customPick,         setCustomPick]         = useState<number | null>(null);
  const [allowanceExhausted, setAllowanceExhausted] = useState(false);
  const customBreakRef   = useRef<CustomBreak | null>(customBreak);
  const breakDeadlineRef = useRef(0);
  const breakOpsRef      = useRef<Promise<unknown>>(Promise.resolve());
  // Local tally of breaks taken on this screen — the fallback for the summary
  // when the server's /end reply has no break totals.
  // A resumed session starts from its recorded breaks.
  const localBreaksRef   = useRef({
    count:    resumeBreakInfo?.list.length ?? 0,
    closedMs: resumeBreakInfo?.closedMs ?? 0,
  });
  // Planned breaks already taken (each happens once); seeded from a resumed record.
  const takenPlannedRef  = useRef<Set<number>>(new Set(
    [...(resumeBreakInfo?.list ?? []), ...(breakState?.breaks ?? [])]
      .filter(b => b.type === 'PLANNED' && b.plannedIndex != null)
      .map(b => b.plannedIndex as number),
  ));
  // The plan in force: the one passed in, else the one the server returned.
  const plan    = isPomo ? null : (breakPlan ?? breakState?.breakPlan ?? null);
  const planRef = useRef(plan);
  planRef.current = plan;
  // The focus countdown runs only when not paused and not on a Custom Break.
  // Pomodoro never has a customBreak, so for it this is exactly `running`.
  const focusRunning = running && !customBreak;
  // Apps unblock during a Custom Break only if the plan says so (never for Pomodoro).
  const breakUnlocks = !!customBreak && !!plan?.unlockAppsDuringBreak;
  // Bumped on foreground (plan sessions only) so the phase alert is rescheduled.
  const [alertNonce, setAlertNonce] = useState(0);
  // Shield calls run one at a time, so a quick block→unblock→block can't land out of order.
  const shieldOpsRef = useRef<Promise<void>>(Promise.resolve());
  const unmountedRef = useRef(false);

  const phaseRef = useRef(phase);
  const roundRef = useRef(round);
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  useEffect(() => { roundRef.current = round; }, [round]);

  // NFC pulse refs for the end-session modal
  const nfcPulse1   = useRef(new Animated.Value(1)).current;
  const nfcPulse2   = useRef(new Animated.Value(1)).current;
  const nfcOpacity1 = useRef(new Animated.Value(0.45)).current;
  const nfcOpacity2 = useRef(new Animated.Value(0.25)).current;

  const startNfcPulse = () => {
    const ring = (scale: Animated.Value, op: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.parallel([
            Animated.timing(scale, { toValue: 1.9, duration: 1500, easing: Easing.out(Easing.ease), useNativeDriver: true }),
            Animated.timing(op,    { toValue: 0,   duration: 1500, easing: Easing.out(Easing.ease), useNativeDriver: true }),
          ]),
          Animated.parallel([
            Animated.timing(scale, { toValue: 1, duration: 0, useNativeDriver: true }),
            Animated.timing(op,    { toValue: delay === 0 ? 0.45 : 0.25, duration: 0, useNativeDriver: true }),
          ]),
        ])
      );
    ring(nfcPulse1, nfcOpacity1, 0).start();
    ring(nfcPulse2, nfcOpacity2, 750).start();
  };

  const stopNfcPulse = () => {
    nfcPulse1.stopAnimation(); nfcPulse1.setValue(1); nfcOpacity1.setValue(0.45);
    nfcPulse2.stopAnimation(); nfcPulse2.setValue(1); nfcOpacity2.setValue(0.25);
  };

  useEffect(() => {
    // Resumed sessions already exist server-side — adopt the id, don't re-create.
    if (resumeId) {
      sessionIdRef.current = resumeId;
      // A break that ran out while the app was dead: close it (the server may
      // already have, hence NO_OPEN_BREAK is fine). Focus resumes meanwhile.
      if (resumeBreakInfo?.expiredOpen) {
        enqueueBreakOp(() => endBreak(resumeId, nav.token))
          .then(setBreakState)
          .catch(e => {
            if (!(e instanceof BreakError && e.code === 'NO_OPEN_BREAK')) {
              console.warn('[breaks] failed to close expired break on resume', e);
            }
          });
      }
      return;
    }
    if (!nav.token) return;
    const now = startedAt.current;
    const nfcTag = nav.params.nfcTag || null;
    apiFetch<{ id: string } & RawBreakState>('/sessions', nav.token, {
      method: 'POST',
      body: JSON.stringify({
        categoryId:   nav.params.categoryId || 'uncategorized',
        customName:   nav.params.customName || 'Untitled',
        timerMode:   isPomo ? 'POMODORO' : 'COUNTDOWN',
        // Planned focus time in seconds; the legacy minutes field is kept
        // so this build also works against a not-yet-upgraded backend.
        plannedDurationSec: parseInt(nav.params.plannedDuration ?? '45') * 60,
        timerConfig: {
          plannedDuration: parseInt(nav.params.plannedDuration ?? '45'),
          pomodoroWork:    pomoWork,
          pomodoroBreak:   pomoBreak,
        },
        blockedApps,
        // The server derives the session's day from startedAt in this zone;
        // dateStr is still sent for older backends.
        timezone:    Intl.DateTimeFormat().resolvedOptions().timeZone,
        dateStr:     toDateStr(now),
        startedAt:   now.toISOString(),
        nfcTagUid:   nfcTag,
        ...(breakPlan ? { breakPlan } : {}),
      }),
    })
      .then(data => {
        sessionIdRef.current = data.id;
        if (!isPomo) setBreakState(normalizeBreakState(data));
        if (awaitsServer) { setCreating(false); setRunning(true); }
      })
      .catch((err: any) => {
        console.error(err);
        if (!awaitsServer) return;   // unchanged: plan-less sessions carry on offline
        if (typeof err?.status === 'number') {
          // The server answered and refused (e.g. an invalid break plan): no
          // session exists, so don't start one. Leaving unmounts this screen.
          Alert.alert(
            "Couldn't start session",
            err.message || 'The server rejected this session’s break plan.',
            [{ text: 'OK', onPress: () => { nav.endLiveSession(); nav.navigate('CreateSession'); } }],
            { cancelable: false },
          );
        } else {
          // Network failure — same as today: run the session locally.
          setCreating(false);
          setRunning(true);
        }
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The shield follows the phase: apps blocked during focus, unblocked during
  // breaks. Pausing mid-focus keeps the block (a pause is not a break). Round
  // is a dep so a background catch-up that lands on the same phase value (e.g.
  // focus→break→focus) still re-asserts the shield on foreground.
  // Custom Breaks: apps stay blocked during a break unless the plan unlocks them
  // (breakUnlocks); they're blocked again as soon as focus resumes.
  useEffect(() => {
    if (!screenTimeSupported() || creating) return;   // nothing is blocked until the server accepts
    const block = phase === 'focus' && !breakUnlocks;
    shieldOpsRef.current = shieldOpsRef.current.then(async () => {
      if (unmountedRef.current) return;   // session over — never re-block after leaving
      try {
        if (block) {
          if (!shieldAppliedRef.current && await screenTimeHasSelection()) {
            await applyScreenTimeShield();
            shieldAppliedRef.current = true;
          }
        } else {
          // Unconditional: a resumed session runs in a fresh process whose ref
          // is false, but the previous process's shield persists system-wide.
          await clearScreenTimeShield();
          shieldAppliedRef.current = false;
        }
      } catch {
        // Authorization revoked or no selection — silently skip, session continues
      }
    });
  }, [phase, round, creating, breakUnlocks]);

  // How many apps the user has shielded (for the "N apps blocked" card).
  useEffect(() => {
    if (!screenTimeSupported()) return;
    getSelectionSummary().then(s => setStCount(summaryTotal(s))).catch(() => {});
  }, []);

  // Always lift the shield when the screen unmounts (session ended).
  // Queued behind any pending shield call, so an in-flight block can't outlive the session.
  useEffect(() => () => {
    unmountedRef.current = true;
    if (shieldAppliedRef.current) {
      clearScreenTimeShield().catch(() => {});
      shieldAppliedRef.current = false;
    }
    shieldOpsRef.current = shieldOpsRef.current.then(async () => {
      if (shieldAppliedRef.current) {
        await clearScreenTimeShield().catch(() => {});
        shieldAppliedRef.current = false;
      }
    });
  }, []);

  // Live Activity (Lock Screen / Dynamic Island timer): started once per mount
  // — which covers resumes too, since a resumed session re-mounts this screen —
  // and ended on unmount. The countdown ticks natively off endDateMs; the sync
  // effect below only sends updates at phase/round/pause transitions.
  // A session awaiting server acceptance starts it once `creating` clears.
  useEffect(() => {
    if (!liveActivitySupported() || initialState.remaining <= 0 || creating) return;
    // Resumed inside a Custom Break: start in the break phase, not focus.
    const inBreak = !!customBreakRef.current;
    startLiveActivity({
      sessionName,
      isPomo,
      maxRounds,
      phase:         inBreak ? 'break' : initialState.phase,
      round:         initialState.round,
      endDateMs:     Date.now() + (inBreak ? breakRemaining : initialState.remaining) * 1000,
      paused:        false,
      remainingSecs: inBreak ? breakRemaining : initialState.remaining,
    }).catch(() => {});
    return () => { endLiveActivity().catch(() => {}); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creating]);

  const tickAnim = useRef(new Animated.Value(1)).current;
  const pulseTick = () =>
    Animated.sequence([
      Animated.timing(tickAnim, { toValue: 1.024, duration: 70,  useNativeDriver: true }),
      Animated.timing(tickAnim, { toValue: 1,     duration: 180, useNativeDriver: true }),
    ]).start();

  // Total focus seconds = banked runs + the in-flight run (if currently focusing).
  // A live run never counts past its phase deadline: if the timer expired while
  // the app was backgrounded/locked, the overshoot until the user comes back is
  // idle time, not focus — without the cap a 45-min session left to ring would
  // be recorded with however long it took to return to the app.
  const liveRunSecs = () => {
    if (focusRunStartRef.current == null) return 0;
    const end = Math.min(Date.now(), deadlineRef.current, focusCapMsRef.current);
    return Math.max(0, (end - focusRunStartRef.current) / 1000);
  };
  const commitFocus = () => {
    focusAccumRef.current += liveRunSecs();
    focusRunStartRef.current = null;
  };
  const focusElapsedSecs = () => Math.round(focusAccumRef.current + liveRunSecs());

  // ─── Custom Breaks (Countdown only — every helper is a no-op for Pomodoro) ────
  // Server calls run one at a time, so an "end" can never overtake its "start".
  const enqueueBreakOp = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = breakOpsRef.current.then(fn, fn);
    breakOpsRef.current = run.catch(() => {});
    return run;
  };

  /** Index of the earliest planned break not yet taken, or null. */
  const nextPlannedIndex = (): number | null => {
    const list = planRef.current?.planned ?? [];
    let best: number | null = null;
    list.forEach((b, i) => {
      if (takenPlannedRef.current.has(i)) return;
      if (best === null || b.startAfter < list[best].startAfter) best = i;
    });
    return best;
  };

  /** Wall-clock instant the next planned break falls due, for a focus run starting now. */
  const plannedCapMs = (): number => {
    if (isPomo) return Infinity;
    const i = nextPlannedIndex();
    if (i === null) return Infinity;
    const thresholdSecs = planRef.current!.planned[i].startAfter * 60;
    return Date.now() + Math.max(0, thresholdSecs - focusAccumRef.current) * 1000;
  };

  /** Switch to a break: freeze the focus time left at exactly where it stands. */
  const beginBreak = (b: NewBreak): CustomBreak => {
    // Focus ends now — or at the planned break's due time if that passed while
    // the app was backgrounded (the gap counts as neither focus nor break).
    const endMs = Math.min(Date.now(), focusCapMsRef.current, deadlineRef.current);
    const saved = Math.max(0, Math.round((deadlineRef.current - endMs) / 1000));
    focusCapMsRef.current = endMs;   // the focus run is banked up to endMs exactly
    const cb: CustomBreak = { ...b, savedFocusSecs: saved, startedAtMs: Date.now() };
    if (cb.type === 'PLANNED' && cb.plannedIndex !== null) takenPlannedRef.current.add(cb.plannedIndex);
    localBreaksRef.current.count += 1;
    customBreakRef.current = cb;
    setCustomBreak(cb);
    setBreakRemaining(cb.duration * 60);
    setRemaining(saved);
    hLight();
    return cb;
  };

  /** Tell the server a planned break started; one retry, then carry on locally. */
  const syncPlannedStart = (cb: CustomBreak) => {
    const id = sessionIdRef.current;
    if (!id || cb.plannedIndex === null) return;
    enqueueBreakOp(async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          setBreakState(await startBreak(id, { type: 'PLANNED', plannedIndex: cb.plannedIndex! }, nav.token));
          cb.synced = true;   // read by syncEnd; not rendered
          return;
        } catch (e) {
          if (attempt === 2) console.warn('[breaks] server did not record planned break; continuing locally', e);
        }
      }
    });
  };

  /** Tell the server the break ended. It caps breaks itself, so NO_OPEN_BREAK is fine. */
  const syncEnd = (cb: CustomBreak) => {
    const id = sessionIdRef.current;
    if (!id) return;
    enqueueBreakOp(async () => {
      if (!cb.synced) return;   // the server never knew about this break
      try {
        setBreakState(await endBreak(id, nav.token));
      } catch (e) {
        if (!(e instanceof BreakError && e.code === 'NO_OPEN_BREAK')) {
          console.warn('[breaks] failed to end break on server', e);
        }
      }
    });
  };

  /** Start the next planned break if focus time has reached it. True if it did. */
  const startDuePlannedBreak = (): boolean => {
    if (isPomo || customBreakRef.current || focusRunStartRef.current == null) return false;
    if (Date.now() < focusCapMsRef.current) return false;
    const i = nextPlannedIndex();
    if (i === null) return false;
    const cb = beginBreak({
      type: 'PLANNED', plannedIndex: i, duration: planRef.current!.planned[i].duration, synced: false,
    });
    syncPlannedStart(cb);
    return true;
  };

  /** Time spent on a break so far — wall clock, capped at its length (as the server counts it). */
  const breakSpentMs = (cb: CustomBreak) =>
    Math.max(0, Math.min(Date.now() - cb.startedAtMs, cb.duration * 60_000));

  /** End the open break and resume focus with exactly the time that was left. */
  const finishBreak = () => {
    const cb = customBreakRef.current;
    if (!cb) return;
    customBreakRef.current = null;
    localBreaksRef.current.closedMs += breakSpentMs(cb);
    setCustomBreak(null);
    setBreakRemaining(0);
    setRemaining(cb.savedFocusSecs);
    hLight();
    syncEnd(cb);
    // The focus timer effect restarts now; a planned break already due fires on its first tick.
  };

  /** On-demand break: starts only once the server confirms it. */
  const takeOnDemandBreak = async (minutes: number) => {
    const id = sessionIdRef.current;
    if (!id) {
      Alert.alert("Can't take a break right now", "This session isn't connected to the server yet. Try again in a moment.");
      return;
    }
    setBreakBusy(true);
    try {
      const state = await enqueueBreakOp(() =>
        startBreak(id, { type: 'ON_DEMAND', duration: minutes }, nav.token));
      setBreakState(state);
      setBreakSheet(false);
      setCustomPick(null);
      const cb: NewBreak = { type: 'ON_DEMAND', plannedIndex: null, duration: minutes, synced: true };
      if (!customBreakRef.current && focusRunStartRef.current != null) {
        beginBreak(cb);
      } else {
        // Focus stopped while we waited (rare) — don't leave the server's break open.
        syncEnd({ ...cb, savedFocusSecs: 0, startedAtMs: Date.now() });
      }
    } catch (e) {
      const err = e instanceof BreakError ? e : new BreakError('UNKNOWN');
      if (err.code === 'ALLOWANCE_EXCEEDED') {
        setAllowanceExhausted(true);
        setBreakSheet(false);
        setCustomPick(null);
        Alert.alert('No breaks left', "You've used all your breaks for this session. You're doing great, keep going!");
      } else {
        Alert.alert("Couldn't start your break", err.message);
      }
    } finally {
      setBreakBusy(false);
    }
  };

  // Catch up the Pomodoro state when one or more phase deadlines passed while
  // backgrounded — a long absence can skip a whole focus+break (or more), not
  // just one phase. Walks forward through phases consuming the overflow, banking
  // focus time for the ended/skipped focus phases, and lands on the right
  // phase/round/remaining (or finishes). Returns true if it advanced the state.
  const reconcilePomodoro = () => {
    let over = (Date.now() - deadlineRef.current) / 1000;
    if (over <= 0) return false;                 // current phase still running

    // The current phase fully elapsed. If it was focus, bank it up to its end
    // (commitFocus caps the run at the deadline — the overflow belongs to later
    // phases) and close the run.
    if (phaseRef.current === 'focus') commitFocus();

    let p = phaseRef.current;
    let r = roundRef.current;
    for (;;) {
      if (p === 'focus') {
        p = 'break';                             // focus → break
        if (over < BREAK_SECS) break;
        over -= BREAK_SECS;                      // break fully skipped (not focus, not banked)
      } else {
        if (r + 1 > maxRounds) {                 // break → done
          setRunning(false);
          setRemaining(0);
          return true;
        }
        r += 1;
        p = 'focus';                             // break → next round's focus
        if (over < FOCUS_SECS) {
          focusAccumRef.current += over;         // landed mid-focus: bank elapsed part
          break;                                 // the live run (set by the timer effect) covers the rest
        }
        focusAccumRef.current += FOCUS_SECS;     // focus phase fully skipped → counts in full
        over -= FOCUS_SECS;
      }
    }

    const landedDur = p === 'focus' ? FOCUS_SECS : BREAK_SECS;
    setPhase(p);
    setRound(r);
    setRemaining(Math.max(1, Math.round(landedDur - over)));
    return true;
  };

  // Drive the countdown from a wall-clock deadline rather than counting ticks.
  // setInterval is suspended while the app is backgrounded, so tick-counting
  // would freeze and undercount. Anchoring to Date.now() means the timer
  // reflects real elapsed time the moment we recompute (next tick / foreground).
  // Custom Breaks: this runs only while `focusRunning` (not on a break); each
  // tick first checks whether a planned break is due (always false for Pomodoro).
  useEffect(() => {
    if (!focusRunning) return;
    deadlineRef.current = Date.now() + remaining * 1000;
    if (phase === 'focus') {
      focusRunStartRef.current = Date.now();
      focusCapMsRef.current    = plannedCapMs();
    }
    const id = setInterval(() => {
      if (startDuePlannedBreak()) { clearInterval(id); return; }
      const left = Math.max(0, Math.round((deadlineRef.current - Date.now()) / 1000));
      setRemaining(prev => {
        if (left < prev) pulseTick();
        return left;
      });
      if (left <= 0) clearInterval(id);
    }, 250);
    // Cleanup ends the active segment (pause / phase change / unmount): stop the
    // ticker and bank the focus time accrued during it.
    return () => { clearInterval(id); commitFocus(); };
  // `round` is included so a catch-up that lands on the same phase value (e.g.
  // focus→break→focus) still re-anchors the deadline for the new phase.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRunning, phase, round]);

  // Custom Break countdown — wall-clock anchored like the focus timer. Pausing
  // (running=false) stops it and keeps breakRemaining frozen; resuming re-anchors.
  useEffect(() => {
    if (!customBreak || !running) return;
    breakDeadlineRef.current = Date.now() + breakRemaining * 1000;
    const id = setInterval(() => {
      const left = Math.max(0, Math.round((breakDeadlineRef.current - Date.now()) / 1000));
      setBreakRemaining(left);
      if (left <= 0) { clearInterval(id); finishBreak(); }
    }, 250);
    return () => clearInterval(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customBreak, running]);

  // What the user should be told when the current phase's deadline arrives.
  const nextPhaseAlert = (): { title: string; body: string } | null => {
    if (!isPomo) {
      return phase === 'focus'
        ? { title: 'Session complete! 🎯', body: 'Great work — tap to see your results.' }
        : null;
    }
    if (phase === 'focus') {
      return { title: 'Time for a break 🌿', body: `Round ${round} done. Step away for ${pomoBreak} min.` };
    }
    return round < maxRounds
      ? { title: 'Break over — back to focus 💪', body: `Starting round ${round + 1} of ${maxRounds}.` }
      : { title: 'Session complete! 🎯', body: 'You finished all your rounds — tap to see your results.' };
  };

  // The single alert to hold right now. Pomodoro / plan-less: the phase-deadline
  // alert, exactly as before. Custom Breaks (Countdown): during focus, whichever
  // comes first of "Break starting" and session complete; during a break, a
  // heads-up 1 min before it ends (30 s for breaks of 2 min or less).
  const nextAlert = (): { date: Date; title: string; body: string } | null => {
    const cb = customBreakRef.current;
    if (cb) {
      const leadSecs = cb.duration <= 2 ? 30 : 60;
      return {
        date:  new Date(breakDeadlineRef.current - leadSecs * 1000),
        title: leadSecs === 60 ? 'Break ends in 1 minute ⏳' : 'Break ends in 30 seconds ⏳',
        body:  'Get ready to jump back into focus.',
      };
    }
    if (!isPomo && phase === 'focus' && focusCapMsRef.current < deadlineRef.current) {
      const i = nextPlannedIndex();
      if (i !== null) {
        const mins = planRef.current!.planned[i].duration;
        return {
          date:  new Date(focusCapMsRef.current),
          title: 'Break starting 🌿',
          body:  `Your ${mins}-min break starts now. Open Anchor to begin it.`,
        };
      }
    }
    const msg = nextPhaseAlert();
    return msg ? { date: new Date(deadlineRef.current), ...msg } : null;
  };

  // Schedule a local notification so a break / resume / completion still alerts
  // the user while the app is backgrounded. There's one slot, so it's replaced
  // at every change. The timer and break effects above re-anchor their deadlines
  // first (declared earlier, overlapping deps). For Pomodoro `focusRunning` is
  // `running`, customBreak stays null and alertNonce never changes, so it
  // fires exactly as before.
  useEffect(() => {
    if (running && (focusRunning || customBreak) && nav.user.notificationsEnabled) {
      const a = nextAlert();
      if (a) scheduleSessionAlert(a.date, a.title, a.body);
      else cancelSessionAlert();
    } else {
      cancelSessionAlert();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, focusRunning, phase, round, customBreak, alertNonce, nav.user.notificationsEnabled]);

  // Cancel any pending phase alert when leaving the screen (session ended/unmounted).
  useEffect(() => () => { cancelSessionAlert(); }, []);

  // Keep the Live Activity in sync at every phase/round/pause transition — the
  // same triggers that reschedule the local notification above. The timer
  // effect re-anchors deadlineRef first (declared earlier with the same deps),
  // so a running update always carries a fresh deadline. Pausing — and
  // completion, which lands here as running=false with remaining 0 — freezes
  // the widget on remainingSecs.
  // Custom Break: the widget shows the break phase counting down to the break's
  // end (frozen while paused), and switches back to focus when it ends. For
  // Pomodoro customBreak is always null and focusRunning === running.
  useEffect(() => {
    if (!liveActivitySupported() || creating) return;
    if (customBreak) {
      updateLiveActivity({
        phase:         'break',
        round,
        endDateMs:     running ? breakDeadlineRef.current : Date.now() + breakRemaining * 1000,
        paused:        !running,
        remainingSecs: breakRemaining,
      }).catch(() => {});
      return;
    }
    updateLiveActivity({
      phase,
      round,
      endDateMs:     focusRunning ? deadlineRef.current : Date.now() + remaining * 1000,
      paused:        !focusRunning,
      remainingSecs: remaining,
    }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, focusRunning, phase, round, customBreak]);

  // Report the timer to App for the floating "session in progress" pill, at the
  // same transitions as the Live Activity (the deadlines above are fresh by now).
  useEffect(() => {
    const frozen = (label: 'Paused' | 'Starting…' | 'Complete', secs: number) =>
      nav.reportSession({ name: sessionName, label, endsAtMs: null, frozenSecs: secs });
    if (creating)            frozen('Starting…', remaining);
    else if (remaining <= 0 && !customBreak) frozen('Complete', 0);
    else if (!running)       frozen('Paused', customBreak ? breakRemaining : remaining);
    else if (customBreak)    nav.reportSession({ name: sessionName, label: 'Break', endsAtMs: breakDeadlineRef.current, frozenSecs: 0 });
    else nav.reportSession({
      name: sessionName,
      label: phase === 'break' ? 'Break' : 'Focus',   // Pomodoro break phase too
      endsAtMs: deadlineRef.current,
      frozenSecs: 0,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, focusRunning, phase, round, customBreak, creating, remaining <= 0]);

  // Snap the timer to real elapsed time the instant we return to foreground
  // (don't wait for the next tick). For Pomodoro, reconcile any phases that
  // elapsed while away; otherwise just recompute remaining (0 → complete).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !running) return;
      // Plan sessions: reschedule the alert on return (batched with the updates below).
      if (planRef.current) setAlertNonce(n => n + 1);
      // Custom Break open: catch its countdown up (it may have run out while away).
      if (customBreakRef.current) {
        const left = Math.max(0, Math.round((breakDeadlineRef.current - Date.now()) / 1000));
        setBreakRemaining(left);
        if (left <= 0) finishBreak();
        return;
      }
      if (isPomo && reconcilePomodoro()) return;
      if (startDuePlannedBreak()) return;   // Countdown: a planned break fell due while away
      setRemaining(Math.max(0, Math.round((deadlineRef.current - Date.now()) / 1000)));
    });
    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  useEffect(() => {
    if (remaining !== 0) return;
    if (!isPomo) { setRunning(false); return; }
    const t = setTimeout(() => {
      if (phaseRef.current === 'focus') {
        setPhase('break');
        setRemaining(BREAK_SECS);
      } else {
        const next = roundRef.current + 1;
        if (next > maxRounds) { setRunning(false); return; }
        setPhase('focus');
        setRound(next);
        setRemaining(FOCUS_SECS);
      }
    }, 1200);
    return () => clearTimeout(t);
  }, [remaining]);

  // Core end logic — called after NFC scan (with uid) or directly (without).
  const doEnd = async (nfcTagUid: string | null) => {
    endLiveActivity().catch(() => {});
    if (shieldAppliedRef.current) {
      clearScreenTimeShield().catch(() => {});
      shieldAppliedRef.current = false;
    }
    const elapsed         = focusElapsedSecs();
    const actualMinutes   = Math.max(1, Math.round(elapsed / 60));
    const completionRatio = Math.min(1, elapsed / Math.max(1, totalSecs));
    // Distractions are counted server-side from APP_BLOCKED + DISTRACTION
    // focus-log events and returned by /end. This local score is only the
    // offline fallback, so it assumes none were recorded.
    let distractionsVal = 0;
    const pomoBon = isPomo ? 8 : 0;
    const score   = Math.min(
      99,
      Math.max(20, Math.round(completionRatio * 80) + pomoBon + 12),
    );
    const endedAt = new Date();
    const finalStatus = remaining === 0 ? 'COMPLETED' : 'ABANDONED';

    // Custom Breaks. Ending mid-break just ends the session — the server closes
    // the break itself, so no endBreak call. Clearing the ref stops the break
    // countdown / foreground handler from ending it during the request below.
    const openBreak = customBreakRef.current;
    customBreakRef.current = null;
    const local = localBreaksRef.current;
    let breaksTaken  = local.count;
    let breakMinutes = Math.round((local.closedMs + (openBreak ? breakSpentMs(openBreak) : 0)) / 60_000);

    let finalScore = score;
    let streak     = '0';

    if (nav.token && sessionIdRef.current) {
      try {
        const res = await apiFetch<{
          session: { focusScore: number | null; breakMinutes?: number; breaksTaken?: number };
          streak: number;
          distractionCount?: number;
        }>(
          `/sessions/${sessionIdRef.current}/end`, nav.token, {
            method: 'PATCH',
            body: JSON.stringify({
              status:            finalStatus,
              actualDurationSec: Math.round(elapsed),
              timerState:        { actualDuration: actualMinutes },   // legacy backends
              endedAt:           endedAt.toISOString(),
              nfcTagUid,
            }),
          },
        );
        finalScore      = res.session.focusScore ?? score;
        streak          = String(res.streak);
        distractionsVal = res.distractionCount ?? 0;
        // Server's break totals win; a server without break support omits them.
        if (typeof res.session.breaksTaken  === 'number') breaksTaken  = res.session.breaksTaken;
        if (typeof res.session.breakMinutes === 'number') breakMinutes = res.session.breakMinutes;
        nav.refreshSessions();
      } catch {
        // Network failure — continue with local values
      }
    }

    if (finalStatus === 'COMPLETED') {
      addSessionEvent({
        title:     sessionName,
        startDate: new Date(endedAt.getTime() - actualMinutes * 60_000),
        endDate:   endedAt,
        notes:     `Focus score: ${finalScore}/100`,
      }).catch(() => {});
    }

    finalStatus === 'COMPLETED' ? hSuccess() : hMedium();
    nav.endLiveSession();   // the session is over: App unmounts this screen as we leave
    nav.navigate('SessionComplete', {
      ...nav.params,
      actualMinutes: String(actualMinutes),
      focusScore:    String(finalScore),
      blockedCount:  String(stCount > 0 ? stCount : blockedApps.length),
      distractions:  String(distractionsVal),
      streak,
      // Always set (0 when none) so a previous session's values can't carry over
      // through the merged nav params. Pomodoro breaks aren't Custom Breaks.
      breaksTaken:   String(isPomo ? 0 : breaksTaken),
      breakMinutes:  String(isPomo ? 0 : breakMinutes),
    });
  };

  // End button: shows Alert, then ends without NFC.
  const confirmEnd = () => {
    const isComplete = remaining === 0;
    Alert.alert(
      isComplete ? 'Session Complete!' : 'End Session?',
      isComplete ? 'Ready to see your results?' : 'Your progress will be saved.',
      [
        { text: 'Keep Going', style: 'cancel' },
        {
          text:  isComplete ? 'View Summary' : 'End Session',
          style: isComplete ? 'default'      : 'destructive',
          onPress: () => doEnd(null),
        },
      ],
      { cancelable: true },
    );
  };

  // NFC row: scans first, then ends with the verified UID.
  const openNfcEndModal = async () => {
    setNfcModal(true);
    setNfcPhase('scanning');
    startNfcPulse();
    try {
      await initNFC();
      const uid = await readTag();
      stopNfcPulse();

      const match = nav.userTags.find(t => t.tagId.uid === uid);
      if (!match) {
        setNfcPhase('unregistered');
        return;
      }

      setNfcModal(false);
      doEnd(uid);
    } catch {
      // User cancelled the iOS sheet — dismiss modal silently
      stopNfcPulse();
      setNfcModal(false);
    }
  };

  const dismissNfcModal = () => {
    cancelScan();
    stopNfcPulse();
    setNfcModal(false);
  };

  const phaseDuration = phase === 'focus' ? FOCUS_SECS : BREAK_SECS;
  const progress      = customBreak
    ? breakRemaining / Math.max(1, customBreak.duration * 60)
    : phaseDuration > 0 ? remaining / phaseDuration : 0;

  // Top-right lock indicator: green while focus apps are shielded, otherwise
  // reflects the paused / break state. (A Custom Break counts as a break.)
  const locked    = focusRunning && phase === 'focus';
  const lockLabel = creating ? 'Starting…' : locked ? 'Locked' : !running ? 'Paused' : 'Break';
  const lockColor = locked ? colors.success : !running ? colors.mutedLight : colors.amber;

  // On-demand allowance. Values come from the server's last reply; before the
  // first reply the full allowance from the plan applies. null = no limit.
  const allowance     = plan?.allowance ?? null;
  const allowanceLeft = allowance
    ? (breakState?.allowanceRemaining ?? { breaks: allowance.maxBreaks, minutes: allowance.maxMinutes })
    : null;
  const odMinutesLeft = allowanceLeft ? Math.min(60, allowanceLeft.minutes ?? 60) : 0;   // one break ≤ 60
  const odBreaksLeft  = allowanceLeft ? (allowanceLeft.breaks ?? Infinity) : 0;
  const allowanceUsedUp = !!allowance && (allowanceExhausted || odBreaksLeft <= 0 || odMinutesLeft < 1);
  const showTakeBreak = !!allowance && !allowanceUsedUp && !customBreak
    && focusRunning && phase === 'focus' && remaining > 0 && !creating;
  const customValue = customPick ?? Math.min(5, odMinutesLeft);

  // Meta line under the session name, e.g. "Study · 45 min · Pomodoro 2/3".
  const categoryName = nav.user.categories?.find(c => c.id === nav.params.categoryId)?.name || 'Focus';
  const plannedMin   = parseInt(nav.params.plannedDuration ?? '45');
  const metaLine     = [
    categoryName,
    `${plannedMin} min`,
    isPomo ? `Pomodoro ${round}/${maxRounds}` : 'Countdown',
  ].join('  ·  ');

  const blockedCount = stCount > 0 ? stCount : blockedApps.length;
  // iPads have no NFC hardware, so they can never be gated on a tag to stop.
  const hasNfc       = nav.userTags.length > 0 && !isPadDevice;

  // Live distraction-risk read-out — grows with elapsed focus time, like the
  // server-side scoring heuristic.
  const riskLevel = !running
    ? 'PAUSED'
    : customBreak
    ? 'ON BREAK'
    : (() => {
        const d = Math.floor(focusElapsedSecs() / 60 / 20);
        return d <= 0 ? 'LOW' : d === 1 ? 'MEDIUM' : 'HIGH';
      })();

  return (
    <View style={styles.screen}>

      <View style={styles.topBar}>
        <View style={styles.topLeft}>
          {/* Minimise: browse the app while the session keeps running. */}
          <TouchableOpacity
            onPress={() => { hLight(); nav.navigate('Dashboard'); }}
            hitSlop={10}
            accessibilityLabel="Minimise session"
          >
            <Ionicons name="chevron-down" size={22} color="rgba(255,255,255,0.75)" />
          </TouchableOpacity>
          <Text style={styles.modeLabel}>FOCUS MODE</Text>
        </View>
        <View style={styles.lockWrap}>
          <View style={[styles.lockDot, { backgroundColor: lockColor }]} />
          <Text style={[styles.lockLabel, { color: lockColor }]}>{lockLabel}</Text>
        </View>
      </View>

      <View style={styles.center}>
        <CircularProgress
          progress={progress}
          size={ringSize}
          strokeWidth={4}
          color={RING_ARC}
          trackColor={RING_TRACK}
          style={styles.ring}
        >
          <Animated.Text style={[styles.timerText, { transform: [{ scale: tickAnim }] }]}>
            {fmt(customBreak ? breakRemaining : remaining)}
          </Animated.Text>
          <Text style={styles.timerSub}>
            {customBreak ? 'BREAK' : remaining === 0 ? 'COMPLETE' : phase === 'break' ? 'BREAK' : 'REMAINING'}
          </Text>
        </CircularProgress>

        <Text style={styles.sessionName} numberOfLines={2} ellipsizeMode="tail">{sessionName}</Text>
        <Text style={styles.metaLine}>{metaLine}</Text>
        {customBreak && (
          <Text style={styles.metaLine}>Focus resumes with {fmt(customBreak.savedFocusSecs)} left</Text>
        )}

        {isPomo && maxRounds > 1 && (
          <View style={styles.dotsRow}>
            {Array.from({ length: maxRounds }).map((_, i) => (
              <View key={i} style={[styles.dot, i < round ? styles.dotFilled : styles.dotEmpty]} />
            ))}
          </View>
        )}
      </View>

      <View style={styles.bottom}>
        <View style={styles.controlRow}>
          <TouchableOpacity
            style={styles.pausePill}
            onPress={() => { hLight(); setRunning(r => !r); }}
            activeOpacity={0.8}
            disabled={remaining === 0 || creating}
          >
            <Ionicons name={running ? 'pause' : 'play'} size={13} color={colors.white} />
            <Text style={styles.pausePillText}>{running ? 'Pause' : 'Resume'}</Text>
          </TouchableOpacity>

          {customBreak && (
            <TouchableOpacity
              style={styles.pausePill}
              onPress={finishBreak}
              activeOpacity={0.8}
            >
              <Ionicons name="play-skip-forward" size={13} color={colors.white} />
              <Text style={styles.pausePillText}>End break</Text>
            </TouchableOpacity>
          )}

          {showTakeBreak && (
            <TouchableOpacity
              style={styles.pausePill}
              onPress={() => { hLight(); setCustomPick(null); setBreakSheet(true); }}
              activeOpacity={0.8}
            >
              <Ionicons name="cafe-outline" size={13} color={colors.white} />
              <Text style={styles.pausePillText}>Take a break</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            style={styles.stopPill}
            onPress={() => { hMedium(); hasNfc ? openNfcEndModal() : confirmEnd(); }}
            activeOpacity={0.8}
            disabled={creating}
          >
            <Ionicons name="stop" size={13} color={colors.danger} />
            <Text style={styles.stopPillText}>Stop</Text>
          </TouchableOpacity>
        </View>

        {allowance && allowanceUsedUp && !customBreak && remaining > 0 && (
          <Text style={styles.breakNote}>You've used all your breaks for this session. Keep it up!</Text>
        )}

        <View style={styles.blockedCard}>
          <Ionicons name="lock-closed-outline" size={18} color={colors.mutedLight} style={styles.blockedIcon} />
          <View style={{ flex: 1 }}>
            <Text style={styles.blockedTitle}>
              {blockedCount > 0 ? `${blockedCount} apps blocked` : 'Screen Time shield'}
            </Text>
            <Text style={styles.blockedSub}>
              {hasNfc ? 'NFC tag required to stop' : 'Shielded during focus'}
            </Text>
          </View>
        </View>

        <View style={styles.riskRow}>
          <Text style={styles.riskLabel}>DISTRACTION RISK</Text>
          <Text style={styles.riskValue}>{riskLevel}</Text>
        </View>
      </View>

      {/* Take-a-break sheet (on-demand Custom Break) */}
      <Modal
        visible={breakSheet && visible}
        transparent
        animationType="fade"
        onRequestClose={() => { if (!breakBusy) setBreakSheet(false); }}
      >
        <View style={styles.sheetOverlay}>
          <View style={styles.sheetCard}>
            <Text style={styles.modalTitle}>Take a break</Text>
            <Text style={styles.modalSub}>
              {allowanceLeft?.minutes == null
                ? 'How long do you need?'
                : `${allowanceLeft.minutes} break minute${allowanceLeft.minutes === 1 ? '' : 's'} left`}
              {allowanceLeft?.breaks != null
                ? ` · ${allowanceLeft.breaks} break${allowanceLeft.breaks === 1 ? '' : 's'} left`
                : ''}
            </Text>

            <View style={styles.sheetOptions}>
              {ON_DEMAND_PRESETS.map(m => {
                const off = m > odMinutesLeft || breakBusy;
                return (
                  <TouchableOpacity
                    key={m}
                    style={[styles.sheetChip, off && styles.sheetChipDisabled]}
                    onPress={() => { hLight(); takeOnDemandBreak(m); }}
                    disabled={off}
                    activeOpacity={0.75}
                  >
                    <Text style={styles.sheetChipText}>{m} min</Text>
                  </TouchableOpacity>
                );
              })}
              <TouchableOpacity
                style={[
                  styles.sheetChip,
                  customPick !== null && styles.sheetChipActive,
                  breakBusy && styles.sheetChipDisabled,
                ]}
                onPress={() => { hLight(); setCustomPick(customPick === null ? customValue : null); }}
                disabled={breakBusy}
                activeOpacity={0.75}
              >
                <Text style={[styles.sheetChipText, customPick !== null && styles.sheetChipTextActive]}>Custom</Text>
              </TouchableOpacity>
            </View>

            {customPick !== null && (
              <View style={styles.sheetStepper}>
                <TouchableOpacity
                  style={[styles.sheetStepBtn, (customValue <= 1 || breakBusy) && styles.sheetChipDisabled]}
                  onPress={() => { hLight(); setCustomPick(Math.max(1, customValue - 1)); }}
                  disabled={customValue <= 1 || breakBusy}
                  hitSlop={6}
                  accessibilityLabel="Shorter break"
                >
                  <Ionicons name="remove" size={18} color={colors.ink} />
                </TouchableOpacity>
                <Text style={styles.sheetStepValue}>{customValue} min</Text>
                <TouchableOpacity
                  style={[styles.sheetStepBtn, (customValue >= odMinutesLeft || breakBusy) && styles.sheetChipDisabled]}
                  onPress={() => { hLight(); setCustomPick(Math.min(odMinutesLeft, customValue + 1)); }}
                  disabled={customValue >= odMinutesLeft || breakBusy}
                  hitSlop={6}
                  accessibilityLabel="Longer break"
                >
                  <Ionicons name="add" size={18} color={colors.ink} />
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancelBtn}
                onPress={() => { setBreakSheet(false); setCustomPick(null); }}
                disabled={breakBusy}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              {customPick !== null && (
                <TouchableOpacity
                  style={[styles.modalSkipBtn, (breakBusy || customValue < 1) && { opacity: 0.6 }]}
                  onPress={() => takeOnDemandBreak(customValue)}
                  disabled={breakBusy || customValue < 1}
                >
                  <Text style={styles.modalSkipText}>{breakBusy ? 'Starting…' : `Start ${customValue} min`}</Text>
                </TouchableOpacity>
              )}
            </View>
            {breakBusy && customPick === null && (
              <Text style={styles.sheetBusy}>Starting your break…</Text>
            )}
          </View>
        </View>
      </Modal>

      {/* NFC end-session modal */}
      <Modal visible={nfcModal && visible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            {nfcPhase === 'scanning' && (
              <>
                <View style={styles.nfcRingContainer}>
                  <Animated.View style={[styles.nfcRing, { transform: [{ scale: nfcPulse1 }], opacity: nfcOpacity1 }]} />
                  <Animated.View style={[styles.nfcRing, { transform: [{ scale: nfcPulse2 }], opacity: nfcOpacity2 }]} />
                  <View style={styles.nfcCenter}>
                    <Ionicons name="radio-outline" size={28} color="#fff" />
                  </View>
                </View>
                <Text style={styles.modalTitle}>Hold tag to end session</Text>
                <Text style={styles.modalSub}>Scan your registered NFC tag to end this session.</Text>
                <View style={styles.modalActions}>
                  <TouchableOpacity style={styles.modalCancelBtn} onPress={dismissNfcModal}>
                    <Text style={styles.modalCancelText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {nfcPhase === 'unregistered' && (
              <>
                <View style={styles.modalWarnIcon}>
                  <Ionicons name="alert-circle" size={48} color="#313852" />
                </View>
                <Text style={styles.modalTitle}>Unknown Tag</Text>
                <Text style={styles.modalSub}>
                  This tag isn't registered to your account.
                </Text>
                <View style={styles.modalActions}>
                  <TouchableOpacity style={styles.modalCancelBtn} onPress={dismissNfcModal}>
                    <Text style={styles.modalCancelText}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.modalSkipBtn} onPress={() => { setNfcPhase('scanning'); openNfcEndModal(); }}>
                    <Text style={styles.modalSkipText}>Try Again</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>

    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1, backgroundColor: SLATE,
    paddingTop: Platform.OS === 'ios' ? 60 : 44,
    paddingBottom: Platform.OS === 'ios' ? 40 : 28,
    paddingHorizontal: spacing.xl,
  },

  topBar:     { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  topLeft:    { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  modeLabel:  { fontSize: fontSize.xs, fontWeight: '600', color: 'rgba(255,255,255,0.55)', letterSpacing: 1.5 },
  lockWrap:   { flexDirection: 'row', alignItems: 'center', gap: 6 },
  lockDot:    { width: 7, height: 7, borderRadius: 4 },
  lockLabel:  { fontSize: fontSize.sm, fontWeight: '500' },

  center:     { flex: 1, alignItems: 'center', justifyContent: 'center' },
  ring:       { marginBottom: spacing.xxxl },
  timerText:  { fontSize: 52, fontWeight: '700', color: colors.white, letterSpacing: 1 },
  timerSub:   { fontSize: fontSize.xs, color: 'rgba(255,255,255,0.5)', letterSpacing: 2, marginTop: 6 },

  sessionName:{ fontSize: fontSize.xxl, fontWeight: '700', color: colors.white, marginTop: spacing.xs, textAlign: 'center', paddingHorizontal: spacing.md },
  metaLine:   { fontSize: fontSize.sm, color: 'rgba(255,255,255,0.55)', marginTop: spacing.sm },

  dotsRow:    { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.lg },
  dot:        { width: 9, height: 9, borderRadius: 5 },
  dotFilled:  { backgroundColor: colors.white },
  dotEmpty:   { borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.35)' },

  bottom:     { alignSelf: 'center', width: '100%', maxWidth: 460 },
  controlRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.md, marginBottom: spacing.xl },
  breakNote:  { fontSize: fontSize.sm, color: 'rgba(255,255,255,0.6)', textAlign: 'center', marginTop: -spacing.md, marginBottom: spacing.lg },
  pausePill:  {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 9, paddingHorizontal: spacing.xl,
    borderRadius: radii.full, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
  },
  pausePillText: { color: colors.white, fontSize: fontSize.sm, fontWeight: '600' },
  stopPill:  {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 9, paddingHorizontal: spacing.xl,
    borderRadius: radii.full, borderWidth: 1, borderColor: '#ff0000',
  },
  stopPillText: { color: "#ff0000", fontSize: fontSize.sm, fontWeight: '600' },

  blockedCard: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)', borderRadius: radii.lg,
    paddingVertical: spacing.lg, paddingHorizontal: spacing.lg,
  },
  blockedIcon:  { marginRight: spacing.md },
  blockedTitle: { fontSize: fontSize.md, fontWeight: '600', color: colors.white },
  blockedSub:   { fontSize: fontSize.sm, color: 'rgba(255,255,255,0.5)', marginTop: 3 },

  riskRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.xl },
  riskLabel: { fontSize: fontSize.xs, fontWeight: '600', color: 'rgba(255,255,255,0.45)', letterSpacing: 1.2 },
  riskValue: { fontSize: fontSize.xs, fontWeight: '700', color: 'rgba(255,255,255,0.7)', letterSpacing: 1.2 },

  // NFC end modal
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.65)',
    alignItems: 'center', justifyContent: 'center', padding: 32,
  },
  modalCard: {
    backgroundColor: colors.white, borderRadius: radii.xl,
    padding: 28, alignItems: 'center', width: '100%', maxWidth: 340,
  },
  nfcRingContainer: {
    width: 130, height: 130,
    alignItems: 'center', justifyContent: 'center', marginBottom: 20,
  },
  nfcRing: {
    position: 'absolute', width: 100, height: 100, borderRadius: 50,
    backgroundColor: colors.ink,
  },
  nfcCenter: {
    width: 66, height: 66, borderRadius: 33,
    backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center',
  },
  modalWarnIcon: { marginBottom: 12 },
  modalTitle:    { fontSize: fontSize.xl - 1, fontWeight: '700', color: colors.ink, marginBottom: 8, textAlign: 'center' },
  modalSub:      { fontSize: fontSize.sm, color: colors.muted, textAlign: 'center', lineHeight: 20, marginBottom: 20 },
  modalActions:  { flexDirection: 'row', gap: 12, width: '100%' },
  modalCancelBtn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: radii.md, backgroundColor: colors.border },
  modalCancelText: { fontSize: fontSize.md, fontWeight: '600', color: colors.inkSoft },
  modalSkipBtn:   { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: radii.md, backgroundColor: colors.ink },
  modalSkipText:  { fontSize: fontSize.md, fontWeight: '700', color: colors.white },

  // Take-a-break sheet — the end-session modal's card, docked to the bottom.
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.65)', justifyContent: 'flex-end' },
  sheetCard: {
    backgroundColor: colors.white,
    borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    padding: 28, paddingBottom: Platform.OS === 'ios' ? 44 : 28,
    alignItems: 'center', width: '100%', maxWidth: 520, alignSelf: 'center',
  },
  sheetOptions:      { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.sm + 2, marginBottom: spacing.lg },
  sheetChip:         { paddingVertical: spacing.sm, paddingHorizontal: 18, borderRadius: radii.full, backgroundColor: colors.border },
  sheetChipActive:   { backgroundColor: colors.ink },
  sheetChipDisabled: { opacity: 0.4 },
  sheetChipText:     { fontSize: fontSize.sm + 1, fontWeight: '600', color: colors.inkSoft },
  sheetChipTextActive: { color: colors.white },
  sheetStepper:      { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginBottom: spacing.lg },
  sheetStepBtn:      {
    width: 36, height: 36, borderRadius: radii.full, backgroundColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  sheetStepValue:    { minWidth: 72, textAlign: 'center', fontSize: fontSize.lg, fontWeight: '700', color: colors.ink },
  sheetBusy:         { fontSize: fontSize.sm, color: colors.muted, marginTop: spacing.md },
});
