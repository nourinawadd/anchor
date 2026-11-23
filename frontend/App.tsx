// frontend/App.tsx
// Root component. Owns all global state: auth token, sessions, user profile.
// When the token changes, sessions and user settings are re-fetched from the API.
import { useState, useRef, useCallback, useEffect } from 'react';
import { SessionRecord, RawSessionRecord, normalizeBreakFields, recordedBreakMs } from './store/sessions';
import { UserProfile, DEFAULT_USER, UserTag, SessionCategory } from './store/user';
import { View, Animated, PanResponder, StyleSheet, Alert } from 'react-native';
import SessionPill, { type LiveSessionInfo } from './components/SessionPill';
import { StatusBar } from 'expo-status-bar';
import { hLight } from './utils/haptics';
import SignUpScreen from './screens/SignUpScreen';
import LoginScreen from './screens/LoginScreen';
import VerifyEmailScreen from './screens/VerifyEmailScreen';
import ForgotPasswordScreen from './screens/ForgotPasswordScreen';
import ChangePasswordScreen from './screens/ChangePasswordScreen';
import OnboardingScreen, { INTRO_ONBOARDING_KEY } from './screens/OnboardingScreen';
import OnboardingScreenTimeScreen from './screens/OnboardingScreenTimeScreen';
import OnboardingCalendarScreen from './screens/OnboardingCalendarScreen';
import DashboardScreen from './screens/DashboardScreen';
import ProfileScreen from './screens/ProfileScreen';
import SettingsScreen from './screens/SettingsScreen';
import CreateSessionScreen from './screens/CreateSessionScreen';
import NFCScreen from './screens/NFCScreen';
import ActiveSessionScreen from './screens/ActiveSessionScreen';
import SessionCompleteScreen from './screens/SessionCompleteScreen';
import HistoryScreen from './screens/HistoryScreen';
import AnalyticsScreen from './screens/AnalyticsScreen';
import AIInsightsScreen from './screens/AIInsightsScreen';
import ComingSoonScreen from './screens/ComingSoonScreen';
import NFCSetupScreen from './screens/NFCSetupScreen';
import Drawer from './components/Drawer';
import { apiFetch, loadTokens, logout as clearAuth, setOnAuthExpired } from './api/client';
import { registerForPush, unregisterPush, cancelLegacyDailyNudge } from './notifications';
import {
  isSupported as screenTimeSupported,
  clearShield as clearScreenTimeShield,
} from 'anchor-screen-time';
import { nextOnboardingStep } from './utils/onboarding';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

export type ScreenName =
  | 'Onboarding' | 'SignUp' | 'Login' | 'VerifyEmail' | 'ForgotPassword'
  | 'OnboardingScreenTime' | 'OnboardingCalendar'
  | 'Dashboard' | 'Profile' | 'Settings' | 'ChangePassword'
  | 'CreateSession' | 'NFCScan' | 'ActiveSession' | 'SessionComplete'
  | 'History' | 'Analytics' | 'AIInsights' | 'NFCSetup';

export type NavParams = Record<string, string>;
export type NavProps = {
  navigate:         (screen: ScreenName, params?: NavParams) => void;
  replace:          (screen: ScreenName, params?: NavParams) => void;
  params:           NavParams;
  openDrawer:       () => void;
  sessions:         SessionRecord[];
  addSession:       (s: SessionRecord) => void;
  deleteSession:    (id: string) => void;
  refreshSessions:  () => void;
  user:             UserProfile;
  updateUser:       (updates: Partial<UserProfile>) => void;
  userTags:         UserTag[];
  refreshTags:      () => void;
  token:            string | null;
  setToken:         (t: string) => void;
  /** Signs out unconditionally (auth expired, account deleted) — ends a live session. */
  signOut:          () => void;
  /** User-initiated sign out: refused while a session is running. */
  requestSignOut:   () => void;

  // A session keeps running (hidden) while the user moves around the app.
  hasLiveSession:   boolean;
  /** Call right before navigating away from a session that has ended. */
  endLiveSession:   () => void;
  /** The live session reports its timer for the floating pill (on changes only). */
  reportSession:    (info: LiveSessionInfo | null) => void;
};

type LiveSession = { key: number; params: NavParams };

export type { SessionRecord, UserProfile, UserTag };

const COMING_SOON: ScreenName[] = [];
const NO_DRAWER:   ScreenName[] = ['Onboarding', 'SignUp', 'Login', 'VerifyEmail', 'ForgotPassword', 'ChangePassword', 'OnboardingScreenTime', 'OnboardingCalendar', 'NFCScan', 'ActiveSession', 'SessionComplete'];
const DARK_STATUS: ScreenName[] = ['Onboarding', 'ActiveSession'];

// TEMP — set to true to always open on the intro onboarding while developing.
// Resets the "seen" flag and ignores the saved session. Flip back to false
// (or leave it; it's a no-op) before shipping.
const FORCE_ONBOARDING = false;

export default function App() {
  const [current,    setCurrent]    = useState<ScreenName>('SignUp');
  const [params,     setParams]     = useState<NavParams>({});
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sessions,   setSessions]   = useState<SessionRecord[]>([]);
  const [user,       setUser]       = useState<UserProfile>(DEFAULT_USER);
  const [userTags,   setUserTags]   = useState<UserTag[]>([]);
  const [token,      setTokenState] = useState<string | null>(null);
  const [hydrated,   setHydrated]   = useState(false);

  // The running session. ActiveSessionScreen stays mounted (hidden when another
  // screen is showing) for as long as this is set, so its timer, breaks, app
  // blocking, notifications and Live Activity keep running. `params` is a
  // frozen copy taken when the session started, so later navigation can't
  // change what the session reads.
  const [liveSession, setLiveSession] = useState<LiveSession | null>(null);
  const [liveInfo,    setLiveInfo]    = useState<LiveSessionInfo | null>(null);
  const liveSessionRef = useRef<LiveSession | null>(null);
  const endingRef      = useRef(false);   // set by endLiveSession, applied on the next navigate
  const paramsRef      = useRef<NavParams>({});

  // Swipe-from-left-edge to open the drawer. The thin strip on the left claims
  // the gesture only once it's a clear rightward drag (so vertical scrolls and
  // taps pass straight through to the screen underneath).
  const edgeSwipe = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_e, g) =>
        g.dx > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
      onPanResponderRelease: (_e, g) => {
        if (g.dx > 45 && g.vx >= 0) { hLight(); setDrawerOpen(true); }
      },
      onPanResponderTerminationRequest: () => true,
    }),
  ).current;

  // Token persistence lives in api/client (it owns the access+refresh pair and
  // the rotation logic). App only mirrors the access token into state to gate
  // screens and re-trigger data fetches.
  const setToken = useCallback((t: string) => {
    setTokenState(t);
  }, []);

  // Restore persisted tokens on app launch. A logged-out, first-time install
  // sees the intro onboarding before sign-up; everyone else lands as before.
  useEffect(() => {
    (async () => {
      try {
        if (FORCE_ONBOARDING) {
          await AsyncStorage.removeItem(INTRO_ONBOARDING_KEY).catch(() => {});
          setCurrent('Onboarding');
          return;
        }
        const { accessToken } = await loadTokens();
        if (accessToken) {
          setTokenState(accessToken);
          setCurrent('Dashboard');
        } else {
          const seen = await AsyncStorage.getItem(INTRO_ONBOARDING_KEY);
          if (!seen) setCurrent('Onboarding');
        }
      } catch (e) {
        console.error(e);
      } finally {
        setHydrated(true);
      }
    })();
  }, []);

  const addSession = useCallback(
    (s: SessionRecord) => setSessions(prev => [s, ...prev]),
    [],
  );
  const deleteSession = useCallback(
    (id: string) => setSessions(prev => prev.filter(s => s.id !== id)),
    [],
  );
  const updateUser = useCallback(
    (updates: Partial<UserProfile>) => setUser(prev => ({ ...prev, ...updates })),
    [],
  );

  const fadeAnim = useRef(new Animated.Value(1)).current;

  const navigate = useCallback((screen: ScreenName, p?: NavParams) => {
    Animated.timing(fadeAnim, { toValue: 0, duration: 110, useNativeDriver: true }).start(() => {
      // Params merge across navigations, so stale resume keys from an earlier
      // resumed session would make a brand-new session adopt the old session
      // id. Drop them on every ActiveSession entry unless explicitly passed.
      // Same for breakPlan: a plan from an earlier session must never carry
      // into a new session that has no breaks. It's cleared when setting up a
      // session and when entering it (CreateSession / NFCScan pass it again).
      const prev = paramsRef.current;
      let base = prev;
      if (screen === 'ActiveSession') {
        const { resumeId, resumeStartedAt, resumeBreaks, breakPlan, ...rest } = prev;
        base = rest;
      } else if (screen === 'CreateSession') {
        const { breakPlan, ...rest } = prev;
        base = rest;
      }
      const next = p ? { ...base, ...p } : base;
      paramsRef.current = next;
      setParams(next);

      // An ended session is dropped as we leave it — that unmounts its screen,
      // which runs its usual cleanup (shield, alert, Live Activity).
      if (endingRef.current && screen !== 'ActiveSession') {
        endingRef.current      = false;
        liveSessionRef.current = null;
        setLiveSession(null);
        setLiveInfo(null);
      }
      // Entering ActiveSession with no session running starts one with a frozen
      // copy of the params; with one running, it just brings it back on screen.
      if (screen === 'ActiveSession' && !liveSessionRef.current) {
        const ls = { key: Date.now(), params: next };
        liveSessionRef.current = ls;
        setLiveSession(ls);
      }
      setCurrent(screen);
      setDrawerOpen(false);
      Animated.timing(fadeAnim, { toValue: 1, duration: 180, useNativeDriver: true }).start();
    });
  }, [fadeAnim]);

  const signOut = useCallback(() => {
    unregisterPush().catch(console.error);   // drop this device's push token (uses current token)
    clearAuth().catch(console.error);   // revoke refresh token server-side + clear local
    setTokenState(null);
    setSessions([]);
    setUser(DEFAULT_USER);
    setUserTags([]);
    setParams({});
    paramsRef.current = {};
    // Forced sign-out ends any running session (unmounting it clears the shield).
    endingRef.current      = false;
    liveSessionRef.current = null;
    setLiveSession(null);
    setLiveInfo(null);
    setDrawerOpen(false);
    navigate('Login');
  }, [navigate]);

  // From the Sign Out buttons: never sign out from under a running session,
  // which would leave apps blocked.
  const requestSignOut = useCallback(() => {
    if (liveSessionRef.current) {
      Alert.alert('Session in progress', 'Stop your session before signing out.');
      return;
    }
    signOut();
  }, [signOut]);

  // When a refresh fails mid-session, the client gives up and calls this.
  useEffect(() => {
    setOnAuthExpired(signOut);
    return () => setOnAuthExpired(null);
  }, [signOut]);

  // Once authenticated, register this device for push (prompts for permission
  // on first grant, silent thereafter) and hand the token to the backend.
  // Also clear the legacy on-device daily nudge: it used to be a local
  // repeating notification, but it now comes from the backend cron (which can
  // check whether a session already exists that day).
  useEffect(() => {
    if (!token) return;
    registerForPush().catch(console.error);
    cancelLegacyDailyNudge().catch(() => {});
  }, [token]);

  // Handle taps on push notifications — navigate to Dashboard for any type,
  // but while a session is running, go back to it (in-session alerts are about it).
  const currentRef = useRef(current);
  useEffect(() => { currentRef.current = current; }, [current]);
  useEffect(() => {
    const addNotificationResponseListener =
      (Notifications as any).addNotificationResponseReceivedListener ??
      (Notifications as any).addNotificationResponseListener;

    const sub = addNotificationResponseListener?.(() => {
      if (liveSessionRef.current) {
        if (currentRef.current !== 'ActiveSession') navigate('ActiveSession');
        return;
      }
      navigate('Dashboard');
    });
    return () => sub?.remove?.();
  }, [navigate]);

  const refreshSessions = useCallback(() => {
    if (!token) return;
    apiFetch<RawSessionRecord[]>('/sessions', token)
      .then(list => setSessions(list.map(normalizeBreakFields)))
      .catch((e: any) => { if (e?.status === 401) signOut(); });
  }, [token, signOut]);

  // A session is orphaned when the app is killed mid-session: only
  // ActiveSessionScreen ever calls /end, so the session stays ACTIVE in the DB
  // forever ("Incomplete" in History). On launch, finalize any orphan whose
  // full timer window has passed — COMPLETED, since the timer ran its course
  // unattended — and drop back into the live screen for one still mid-window.
  const reconcileOrphans = useCallback(async (list: SessionRecord[]) => {
    if (!token) return;

    // Wall-clock length of the whole session: Pomodoro alternates focus/break
    // phases (mirrors maxRounds in ActiveSessionScreen), countdown is planned.
    // Custom Breaks (Countdown with a plan): allow time for every planned break
    // plus the whole on-demand allowance, so a live session isn't closed early.
    const breakPlanOf = (s: SessionRecord) => (s.timerMode !== 'POMODORO' ? s.breakPlan : null);
    const wallMsOf = (s: SessionRecord) => {
      const planned = s.plannedDuration ?? s.duration;
      if (s.timerMode === 'POMODORO') {
        const work   = s.pomodoroWork  ?? 25;
        const brk    = s.pomodoroBreak ?? 5;
        const rounds = Math.max(Math.ceil(planned / work), 1);
        return rounds * (work + brk) * 60_000;
      }
      const plan = breakPlanOf(s);
      if (plan) {
        const plannedBreakMin = plan.planned.reduce((acc, b) => acc + b.duration, 0);
        const allowanceMin    = plan.allowance?.maxMinutes ?? 0;
        return (planned + plannedBreakMin + allowanceMin) * 60_000;
      }
      return planned * 60_000;
    };

    const orphans = list.filter(s => s.status === 'ACTIVE' && s.startedAtISO);
    let ended = false;
    let live: SessionRecord | null = null;

    for (const s of orphans) {
      const startMs = new Date(s.startedAtISO!).getTime();
      const wallMs  = wallMsOf(s);
      if (Date.now() >= startMs + wallMs) {
        // Break-plan sessions end when the focus would have, counting only the
        // breaks actually recorded; everything else ends at the window, as before.
        const endMs = breakPlanOf(s)
          ? startMs + (s.plannedDuration ?? s.duration) * 60_000 + recordedBreakMs(s.breaks, Date.now())
          : startMs + wallMs;
        try {
          await apiFetch(`/sessions/${s.id}/end`, token, {
            method: 'PATCH',
            body: JSON.stringify({
              status:            'COMPLETED',
              actualDurationSec: s.plannedDurationSec ?? (s.plannedDuration ?? s.duration) * 60,
              timerState:        { actualDuration: s.plannedDuration ?? s.duration },  // legacy backends
              endedAt:           new Date(endMs).toISOString(),
            }),
          });
          ended = true;
        } catch (e) {
          console.warn('[sessions] failed to finalize orphaned session', e);
        }
      } else if (!live || s.startedAtISO! > live.startedAtISO!) {
        live = s;
      }
    }

    if (ended) refreshSessions();

    // The Screen Time shield persists across app kills (ManagedSettingsStore is
    // system-level). If no session is being resumed, any shield left behind by
    // a killed session would block apps forever — lift it.
    if (!live && screenTimeSupported()) {
      clearScreenTimeShield().catch(() => {});
    }

    if (live) {
      const plan = breakPlanOf(live);
      navigate('ActiveSession', {
        resumeId:        live.id,
        resumeStartedAt: live.startedAtISO!,
        // ActiveSession reads plannedDuration; `duration` alone made every
        // resumed session (Countdown and Pomodoro) run as the 45-min default.
        plannedDuration: String(live.plannedDuration ?? live.duration),
        duration:        String(live.plannedDuration ?? live.duration),
        ...(plan ? {
          breakPlan:    JSON.stringify(plan),
          resumeBreaks: JSON.stringify({ breaks: live.breaks, activeBreak: live.activeBreak }),
        } : {}),
        pomodoro:        live.timerMode === 'POMODORO' ? 'true' : 'false',
        pomodoroWork:    String(live.pomodoroWork  ?? 25),
        pomodoroBreak:   String(live.pomodoroBreak ?? 5),
        categoryId:      live.categoryId,
        customName:      live.title,
        blockedApps:     (live.blockedApps ?? []).join(','),
        nfcTag:          '',
      });
    }
  }, [token, refreshSessions, navigate]);

  const refreshTags = useCallback(() => {
    if (!token) return;
    apiFetch<UserTag[]>('/user/nfc-tags', token)
      .then(setUserTags)
      .catch(console.error);
  }, [token]);

  // Re-fetch sessions and user profile from the API whenever the token changes.
  // On 401 (expired/invalid token), clear stored auth and bounce to Login.
  useEffect(() => {
    if (!token) {
      setSessions([]);
      return;
    }

    apiFetch<RawSessionRecord[]>('/sessions', token)
      .then(raw => {
        const list = raw.map(normalizeBreakFields);
        setSessions(list);
        return reconcileOrphans(list);
      })
      .catch((e: any) => {
        if (e?.status === 401) signOut();
        else setSessions([]);
      });

    // Permission-priming onboarding chain (Screen Time → Calendar), each shown
    // at most once per device. nextOnboardingStep skips steps that don't apply /
    // were already handled and marks them seen, so this can never nag. A
    // live-session resume wins over it.
    (async () => {
      const step = await nextOnboardingStep();
      // Re-check at navigate time: don't interrupt a session resumed mid-await.
      if (step && currentRef.current !== 'ActiveSession') navigate(step);
    })().catch(console.error);

    apiFetch<UserTag[]>('/user/nfc-tags', token)
      .then(setUserTags)
      .catch(console.error);

    // Load categories up front so any screen (History, Dashboard) can resolve a
    // session's categoryId → name without waiting for the Create screen to mount.
    apiFetch<SessionCategory[]>('/user/categories', token)
      .then(categories => updateUser({ categories }))
      .catch(console.error);

    apiFetch<{ name: string; email: string; createdAt?: string; hasPassword?: boolean; settings: Record<string, any> }>('/user/me', token)
      .then(me => {
        updateUser({
          name:                 me.name,
          email:                me.email,
          createdAt:            me.createdAt,
          hasPassword:          me.hasPassword,
          dailyGoalMinutes:     me.settings?.dailyGoalMinutes     ?? 120,
          weeklyGoalMinutes:    me.settings?.weeklyGoalMinutes     ?? 600,
          preferredDuration:    me.settings?.defaultDuration       ?? 25,
          pomodoroEnabled:      me.settings?.defaultTimerMode === 'POMODORO',
          notificationsEnabled: me.settings?.notificationsEnabled  ?? true,
          reminderHour:         me.settings?.reminderHour          ?? 20,
          nudgeHour:            me.settings?.nudgeHour             ?? 9,
          notify: {
            dailyNudge:      me.settings?.notify?.dailyNudge      ?? true,
            inSessionAlerts: me.settings?.notify?.inSessionAlerts ?? true,
            dailySummary:    me.settings?.notify?.dailySummary    ?? true,
            streakAlert:     me.settings?.notify?.streakAlert     ?? true,
            goalNudge:       me.settings?.notify?.goalNudge       ?? true,
            goalAchieved:    me.settings?.notify?.goalAchieved    ?? true,
          },
        });

        // Keep the backend's "today" boundary aligned with this device's local
        // calendar day (used to compute session dateStr) so analytics date-range
        // queries don't silently exclude sessions logged near midnight.
        const deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        if (deviceTz && me.settings?.timezone !== deviceTz) {
          apiFetch('/user/settings', token, {
            method: 'PATCH',
            body: JSON.stringify({ timezone: deviceTz }),
          }).catch(console.error);
        }
      })
      .catch((e: any) => {
        if (e?.status === 401) signOut();
        else console.error(e);
      });
  }, [token, updateUser, signOut, reconcileOrphans]);

  const nav: NavProps = {
    navigate,
    replace:          navigate,
    params,
    openDrawer:       () => setDrawerOpen(true),
    sessions,
    addSession,
    deleteSession,
    refreshSessions,
    user,
    updateUser,
    userTags,
    refreshTags,
    token,
    setToken,
    signOut,
    requestSignOut,
    hasLiveSession:   !!liveSession,
    endLiveSession:   () => { endingRef.current = true; },
    reportSession:    setLiveInfo,
  };

  if (!hydrated) return <View style={{ flex: 1, backgroundColor: '#F6F7F1' }} />;

  return (
    <View style={{ flex: 1 }}>
      <StatusBar style={DARK_STATUS.includes(current) ? 'light' : 'dark'} />

      <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
        {current === 'Onboarding'      && <OnboardingScreen nav={nav} />}
        {current === 'SignUp'          && <SignUpScreen nav={nav} />}
        {current === 'Login'           && <LoginScreen nav={nav} />}
        {current === 'VerifyEmail'     && <VerifyEmailScreen nav={nav} />}
        {current === 'ForgotPassword'  && <ForgotPasswordScreen nav={nav} />}
        {current === 'ChangePassword'  && <ChangePasswordScreen nav={nav} />}
        {current === 'OnboardingScreenTime'    && <OnboardingScreenTimeScreen nav={nav} />}
        {current === 'OnboardingCalendar'      && <OnboardingCalendarScreen nav={nav} />}
        {current === 'Dashboard'       && <DashboardScreen nav={nav} />}
        {current === 'Profile'         && <ProfileScreen nav={nav} />}
        {current === 'Settings'        && <SettingsScreen nav={nav} />}
        {current === 'CreateSession'   && <CreateSessionScreen nav={nav} />}
        {current === 'NFCScan'         && <NFCScreen nav={nav} />}
        {/* Mounted for the whole session; hidden (still running) on other screens. */}
        {liveSession && (
          <View style={[StyleSheet.absoluteFill, { display: current === 'ActiveSession' ? 'flex' : 'none' }]}>
            <ActiveSessionScreen
              key={liveSession.key}
              nav={{ ...nav, params: liveSession.params }}
              visible={current === 'ActiveSession'}
            />
          </View>
        )}
        {current === 'SessionComplete' && <SessionCompleteScreen nav={nav} />}
        {current === 'History'         && <HistoryScreen nav={nav} />}
        {current === 'Analytics'       && <AnalyticsScreen nav={nav} />}
        {current === 'AIInsights'      && <AIInsightsScreen nav={nav} />}
        {current === 'NFCSetup'        && <NFCSetupScreen nav={nav} />}
        {COMING_SOON.includes(current) && <ComingSoonScreen nav={nav} screen={current} />}
      </Animated.View>

      {!NO_DRAWER.includes(current) && !drawerOpen && (
        <View
          {...edgeSwipe.panHandlers}
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 24 }}
        />
      )}

      {/* Way back to a session running in the background (under the drawer). */}
      {liveSession && current !== 'ActiveSession' && (
        <SessionPill info={liveInfo} onPress={() => { hLight(); navigate('ActiveSession'); }} />
      )}

      {!NO_DRAWER.includes(current) && (
        <Drawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          currentScreen={current}
          nav={nav}
          onSignOut={requestSignOut}
        />
      )}
    </View>
  );
}

