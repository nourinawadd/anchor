import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  Switch, StyleSheet, Platform, Alert, TextInput,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { NavProps } from '../App';
import Card from '../components/Card';
import SectionLabel from '../components/SectionLabel';
import WheelPicker from '../components/WheelPicker';
import { colors, spacing, radii, fontSize } from '../constants/theme';
import { apiFetch } from '../api/client';
import { hSelection, hLight, hMedium } from '../utils/haptics';
import { isPadDevice, useResponsive } from '../utils/responsive';
import { SessionCategory } from '../store/user';
import type { BreakPlan } from '../store/sessions';
import {
  isSupported as screenTimeSupported,
  isNativeReady as screenTimeNativeReady,
  getLoadError as screenTimeLoadError,
  getAuthorizationStatus,
  requestAuthorization,
  presentPicker,
  getSelectionSummary,
  formatSummary,
  summaryTotal,
  type ScreenTimeSelectionSummary,
  type ScreenTimeAuthStatus,
} from 'anchor-screen-time';

const DURATIONS = [15, 25, 30, 45, 60, 90];
const HOURS   = Array.from({ length: 9 },  (_, i) => i);   // 0–8 hours
const MINUTES = Array.from({ length: 60 }, (_, i) => i);   // 0–59 min

// Remember the last duration dialed on the wheels (like the iOS Clock timer).
const LAST_DURATION_KEY = '@anchor:lastDuration';

const POMO_PRESETS = [
  { label: '25 / 5',  work: 25, brk: 5  },
  { label: '50 / 10', work: 50, brk: 10 },
  { label: '30 / 10', work: 30, brk: 10 },
  { label: '15 / 3',  work: 15, brk: 3  },
] as const;

type PomoPreset = typeof POMO_PRESETS[number];
type ScreenState = 'category-select' | 'session-create';

// ─── Custom Breaks (Countdown only) ────────────────────────────────────────────
type PlannedBreak = BreakPlan['planned'][number];

const MAX_PLANNED_BREAKS   = 10;
const BREAK_LEN_MIN        = 1;
const BREAK_LEN_MAX        = 60;
const OD_MAX_BREAKS_LIMIT  = 10;
const OD_MAX_MINUTES_LIMIT = 180;

/** First problem with the planned breaks for a session of `sessionMin`, or null. */
function plannedBreaksIssue(list: PlannedBreak[], sessionMin: number): string | null {
  if (list.length > MAX_PLANNED_BREAKS) return `You can plan at most ${MAX_PLANNED_BREAKS} breaks.`;
  const seen = new Set<number>();
  for (const b of list) {
    if (b.startAfter < 1 || b.startAfter >= sessionMin) {
      return `A break at ${b.startAfter} min starts after the session ends (${sessionMin} min). Remove it or make the session longer.`;
    }
    if (b.duration < BREAK_LEN_MIN || b.duration > BREAK_LEN_MAX) {
      return `Breaks must be ${BREAK_LEN_MIN}–${BREAK_LEN_MAX} minutes long.`;
    }
    if (seen.has(b.startAfter)) return `Two breaks start at ${b.startAfter} min.`;
    seen.add(b.startAfter);
  }
  return null;
}

/** −/+ stepper styled like the screen's chips. */
function Stepper({ label, value, min, max, step = 1, unit, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; unit?: string;
  onChange: (v: number) => void;
}) {
  const atMin = value <= min;
  const atMax = value >= max;
  return (
    <View style={styles.stepperRow}>
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepperControls}>
        <TouchableOpacity
          style={[styles.stepperBtn, atMin && styles.stepperBtnDisabled]}
          onPress={() => { hSelection(); onChange(Math.max(min, value - step)); }}
          disabled={atMin}
          hitSlop={6}
          accessibilityLabel={`Decrease ${label}`}
        >
          <Ionicons name="remove" size={18} color={colors.ink} />
        </TouchableOpacity>
        <Text style={styles.stepperValue}>{value}{unit ? ` ${unit}` : ''}</Text>
        <TouchableOpacity
          style={[styles.stepperBtn, atMax && styles.stepperBtnDisabled]}
          onPress={() => { hSelection(); onChange(Math.min(max, value + step)); }}
          disabled={atMax}
          hitSlop={6}
          accessibilityLabel={`Increase ${label}`}
        >
          <Ionicons name="add" size={18} color={colors.ink} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

export default function CreateSessionScreen({ nav }: { nav: NavProps }) {
  const { sidePadding } = useResponsive();
  const [screenState, setScreenState] = useState<ScreenState>('category-select');
  const [categories, setCategories] = useState<SessionCategory[]>(nav.user.categories || []);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<SessionCategory | null>(null);
  const [sessionName, setSessionName] = useState('');

  const [duration, setDuration] = useState(() =>
    DURATIONS.includes(nav.user.preferredDuration) ? nav.user.preferredDuration : 25,
  );
  // Disables the page scroll while a duration wheel is being dragged, so the
  // gesture stays in the wheel instead of moving the whole screen.
  // Freeze the page while a wheel is grabbed. Done imperatively via
  // setNativeProps (no React re-render) so touching a wheel can't trigger a
  // full-screen re-render mid-gesture — that re-render was the scroll hitch,
  // and the async state update let the page start scrolling before the freeze
  // landed. setNativeProps applies on the native thread, instantly.
  const bodyScrollRef = useRef<ScrollView>(null);
  const freezeBody = useCallback(
    (frozen: boolean) => bodyScrollRef.current?.setNativeProps({ scrollEnabled: !frozen }),
    [],
  );
  const durationHydrated = useRef(false);
  const [pomodoro,   setPomodoro]   = useState(() => nav.user.pomodoroEnabled);
  const [pomoPreset, setPomoPreset] = useState<PomoPreset>(POMO_PRESETS[0]);
  const [pomoRounds, setPomoRounds] = useState(2);
  const [stSummary, setStSummary]   = useState<ScreenTimeSelectionSummary | null>(null);
  const [stStatus,  setStStatus]    = useState<ScreenTimeAuthStatus>('notDetermined');
  const [stBusy,    setStBusy]      = useState(false);
  const [isCreatingCategory, setIsCreatingCategory] = useState(false);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editCategoryName, setEditCategoryName] = useState('');
  const [isSavingCategory, setIsSavingCategory] = useState(false);
  const [deletingCategoryId, setDeletingCategoryId] = useState<string | null>(null);

  // Custom Breaks (Countdown only)
  const [plannedBreaks, setPlannedBreaks] = useState<PlannedBreak[]>([]);
  const [draftAfter,    setDraftAfter]    = useState(25);
  const [draftLength,   setDraftLength]   = useState(5);
  const [odMaxBreaks,   setOdMaxBreaks]   = useState(0);
  const [odMaxMinutes,  setOdMaxMinutes]  = useState(0);
  const [unlockApps,    setUnlockApps]    = useState(false);

  // Load categories on mount
  useEffect(() => {
    refreshCategories();
  }, []);

  // Restore the last duration dialed on the wheels, then persist any change.
  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(LAST_DURATION_KEY);
        const n = saved ? parseInt(saved, 10) : NaN;
        if (Number.isFinite(n) && n > 0) setDuration(n);
      } catch {
        // ignore — fall back to the default duration
      }
      durationHydrated.current = true;
    })();
  }, []);

  useEffect(() => {
    if (!durationHydrated.current) return;
    AsyncStorage.setItem(LAST_DURATION_KEY, String(duration)).catch(() => {});
  }, [duration]);

  useEffect(() => {
    if (!screenTimeNativeReady()) return;
    let alive = true;
    (async () => {
      try {
        const [status, summary] = await Promise.all([getAuthorizationStatus(), getSelectionSummary()]);
        if (!alive) return;
        setStStatus(status);
        setStSummary(summary);
      } catch {
        // ignore
      }
    })();
    return () => { alive = false; };
  }, []);

  const refreshCategories = useCallback(async () => {
    try {
      const cats = await apiFetch<SessionCategory[]>('/user/categories', nav.token);
      setCategories(cats);
      nav.updateUser({ categories: cats });
    } catch (err) {
      console.error('Failed to load categories:', err);
    }
  }, [nav.token]);

  const createNewCategory = async () => {
    if (!newCategoryName.trim()) {
      Alert.alert('Error', 'Please enter a category name');
      return;
    }
    if (categories.length >= 3) {
      Alert.alert('Limit reached', 'You can only have up to 3 categories.');
      return;
    }

    setIsCreatingCategory(true);
    try {
      const newCat = await apiFetch<SessionCategory>('/user/categories', nav.token, {
        method: 'POST',
        body: JSON.stringify({ name: newCategoryName.trim() }),
      });
      const updatedCategories = [...categories, newCat];
      setCategories(updatedCategories);
      nav.updateUser({ categories: updatedCategories });
      setNewCategoryName('');
      setSelectedCategory(newCat);
      setScreenState('session-create');
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to create category');
    } finally {
      setIsCreatingCategory(false);
    }
  };

  const selectCategory = (cat: SessionCategory) => {
    hSelection();
    setSelectedCategory(cat);
    setScreenState('session-create');
    setSessionName('');
  };

  const startEditCategory = (cat: SessionCategory) => {
    setEditingCategoryId(cat.id);
    setEditCategoryName(cat.name);
  };

  const cancelEditCategory = () => {
    setEditingCategoryId(null);
    setEditCategoryName('');
  };

  const saveEditCategory = async (cat: SessionCategory) => {
    const trimmed = editCategoryName.trim();
    if (!trimmed) {
      Alert.alert('Error', 'Please enter a category name');
      return;
    }
    if (trimmed === cat.name) {
      cancelEditCategory();
      return;
    }

    setIsSavingCategory(true);
    try {
      const updated = await apiFetch<SessionCategory>(`/user/categories/${cat.id}`, nav.token, {
        method: 'PATCH',
        body: JSON.stringify({ name: trimmed }),
      });
      const updatedCategories = categories.map(c => c.id === cat.id ? updated : c);
      setCategories(updatedCategories);
      nav.updateUser({ categories: updatedCategories });
      if (selectedCategory?.id === cat.id) setSelectedCategory(updated);
      cancelEditCategory();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Failed to rename category');
    } finally {
      setIsSavingCategory(false);
    }
  };

  const deleteCategory = (cat: SessionCategory) => {
    Alert.alert(
      'Delete category',
      `Delete "${cat.name}"? Past sessions will keep this category.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeletingCategoryId(cat.id);
            try {
              await apiFetch(`/user/categories/${cat.id}`, nav.token, { method: 'DELETE' });
              const updatedCategories = categories.filter(c => c.id !== cat.id);
              setCategories(updatedCategories);
              nav.updateUser({ categories: updatedCategories });
              if (selectedCategory?.id === cat.id) {
                setSelectedCategory(null);
                setScreenState('category-select');
              }
              if (editingCategoryId === cat.id) cancelEditCategory();
            } catch (err: any) {
              Alert.alert('Error', err?.message || 'Failed to delete category');
            } finally {
              setDeletingCategoryId(null);
            }
          },
        },
      ],
    );
  };

  const configureScreenTime = async () => {
    if (!screenTimeSupported()) return;
    if (!screenTimeNativeReady()) {
      Alert.alert(
        'Screen Time module not loaded',
        `The native module failed to load:\n\n${screenTimeLoadError()?.message ?? 'unknown'}\n\nThis usually means the build didn't include the module. Try rebuilding.`,
      );
      return;
    }
    setStBusy(true);
    try {
      let status = stStatus;
      if (status !== 'approved') {
        status = await requestAuthorization();
        setStStatus(status);
      }
      if (status !== 'approved') {
        Alert.alert(
          'Screen Time access needed',
          'Anchor needs Screen Time access to shield distracting apps during your sessions. You can enable it later in Settings.',
        );
        return;
      }
      const summary = await presentPicker();
      if (summary !== null) setStSummary(summary);
    } catch (err: any) {
      Alert.alert('Screen Time error', err?.message ?? 'Could not open the app picker.');
    } finally {
      setStBusy(false);
    }
  };

  const pomoDuration = pomoPreset.work * pomoRounds;

  // ── Custom Breaks ──
  // A planned break must start before the session ends: startAfter ≤ duration − 1.
  const maxBreakStart  = Math.max(1, duration - 1);
  const draftAfterShown = Math.min(Math.max(1, draftAfter), maxBreakStart);
  const draftTaken     = plannedBreaks.some(b => b.startAfter === draftAfterShown);
  const canAddBreak    = duration >= 2 && plannedBreaks.length < MAX_PLANNED_BREAKS && !draftTaken;
  const odEnabled      = odMaxBreaks > 0 && odMaxMinutes > 0;   // either at 0 → off

  const addPlannedBreak = () => {
    if (!canAddBreak) return;
    hLight();
    const next = [...plannedBreaks, { startAfter: draftAfterShown, duration: draftLength }]
      .sort((a, b) => a.startAfter - b.startAfter);
    setPlannedBreaks(next);
    // Suggest the next slot 25 min later (the stepper clamps it to the session).
    setDraftAfter(draftAfterShown + 25);
  };

  const removePlannedBreak = (startAfter: number) => {
    hLight();
    setPlannedBreaks(prev => prev.filter(b => b.startAfter !== startAfter));
  };

  // Only Countdown sessions with something set up get a plan; otherwise nothing
  // is passed and the session behaves exactly as before.
  const breakPlan: BreakPlan | null =
    !pomodoro && (plannedBreaks.length > 0 || odEnabled)
      ? {
          planned:               plannedBreaks,
          allowance:             odEnabled ? { maxBreaks: odMaxBreaks, maxMinutes: odMaxMinutes } : null,
          unlockAppsDuringBreak: unlockApps,
        }
      : null;
  const breakIssue = !pomodoro ? plannedBreaksIssue(plannedBreaks, duration) : null;

  const startParams = selectedCategory ? {
    categoryId:    selectedCategory.id,
    customName:    sessionName || 'Untitled',
    timerMode:     'COUNTDOWN',
    plannedDuration: String(pomodoro ? pomoDuration : duration),
    pomodoro:      String(pomodoro),
    pomodoroWork:  String(pomoPreset.work),
    pomodoroBreak: String(pomoPreset.brk),
    blockedApps:   '',
    ...(breakPlan ? { breakPlan: JSON.stringify(breakPlan) } : {}),
  } : null;

  // Blocks Start while a planned break no longer fits (e.g. the session was shortened).
  const startTo = (screen: 'ActiveSession' | 'NFCScan') => {
    if (!startParams) return;
    if (breakIssue) {
      Alert.alert('Check your breaks', breakIssue);
      return;
    }
    hMedium();
    nav.navigate(screen, startParams);
  };

  if (screenState === 'category-select') {
    return (
      <View style={styles.screen}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backBtn} onPress={nav.openDrawer}>
            <Ionicons name="arrow-back" size={24} color={colors.ink} />
          </TouchableOpacity>
          <Text style={styles.title}>Session Categories</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView contentContainerStyle={[styles.body, { paddingHorizontal: spacing.xl + sidePadding }]} showsVerticalScrollIndicator={false}>
          <SectionLabel noTopMargin>Your Categories</SectionLabel>
          
          {categories.length === 0 ? (
            <Text style={styles.emptyText}>No categories yet. Create one to get started!</Text>
          ) : (
            <View style={styles.categoryGrid}>
              {categories.map(cat => (
                <View key={cat.id} style={styles.categoryCard}>
                  {editingCategoryId === cat.id ? (
                    <View style={styles.categoryEditWrap}>
                      <TextInput
                        style={styles.categoryEditInput}
                        value={editCategoryName}
                        onChangeText={setEditCategoryName}
                        autoFocus
                        maxLength={100}
                        editable={!isSavingCategory}
                      />
                      <View style={styles.categoryEditActions}>
                        <TouchableOpacity
                          style={styles.categoryEditBtn}
                          onPress={() => saveEditCategory(cat)}
                          disabled={isSavingCategory}
                          hitSlop={8}
                        >
                          <Ionicons name="checkmark" size={20} color={colors.success} />
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.categoryEditBtn}
                          onPress={cancelEditCategory}
                          disabled={isSavingCategory}
                          hitSlop={8}
                        >
                          <Ionicons name="close" size={20} color={colors.muted} />
                        </TouchableOpacity>
                      </View>
                    </View>
                  ) : (
                    <>
                      <TouchableOpacity
                        style={styles.categoryCardBody}
                        onPress={() => selectCategory(cat)}
                        activeOpacity={0.75}
                      >
                        <Ionicons name="folder" size={32} color={colors.ink} />
                        <Text style={styles.categoryName}>{cat.name}</Text>
                      </TouchableOpacity>
                      <View style={styles.categoryCardActions}>
                        <TouchableOpacity
                          style={styles.categoryActionBtn}
                          onPress={() => startEditCategory(cat)}
                          activeOpacity={0.7}
                        >
                          <Text style={styles.categoryActionBtnText}>Rename</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          style={styles.categoryActionBtn}
                          onPress={() => deleteCategory(cat)}
                          disabled={deletingCategoryId === cat.id}
                          activeOpacity={0.7}
                        >
                          <Text style={[styles.categoryActionBtnText, styles.categoryActionBtnTextDanger]}>Delete</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </View>
              ))}
            </View>
          )}

          <SectionLabel>Create New Category</SectionLabel>
          {categories.length >= 3 ? (
            <Text style={styles.emptyText}>You've reached the maximum of 3 categories.</Text>
          ) : (
            <Card style={styles.createCard} padding={spacing.md}>
              <TextInput
                style={styles.input}
                placeholder="Category name (e.g., Work, Fitness, Learning)"
                placeholderTextColor={colors.muted}
                value={newCategoryName}
                onChangeText={setNewCategoryName}
                editable={!isCreatingCategory}
                maxLength={100}
              />
              <TouchableOpacity
                style={[styles.createBtn, isCreatingCategory && styles.createBtnDisabled]}
                onPress={createNewCategory}
                disabled={isCreatingCategory}
                activeOpacity={0.8}
              >
                <Text style={styles.createBtnText}>
                  {isCreatingCategory ? 'Creating...' : 'Create Category'}
                </Text>
              </TouchableOpacity>
            </Card>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>
      </View>
    );
  }

  if (!selectedCategory) return null;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => setScreenState('category-select')}>
          <Ionicons name="arrow-back" size={24} color={colors.ink} />
        </TouchableOpacity>
        <Text style={styles.title}>New Session</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView
        ref={bodyScrollRef}
        contentContainerStyle={[styles.body, { paddingHorizontal: spacing.xl + sidePadding }]}
        showsVerticalScrollIndicator={false}
      >

        {/* Category badge */}
        <Card style={styles.categoryBadge} padding={spacing.md}>
          <Ionicons name="folder" size={20} color={colors.ink} />
          <Text style={styles.categoryBadgeText}>{selectedCategory.name}</Text>
        </Card>

        {/* Session name input */}
        <SectionLabel>Session Name</SectionLabel>
        <TextInput
          style={styles.sessionNameInput}
          placeholder="e.g., Morning Work Session"
          placeholderTextColor={colors.muted}
          value={sessionName}
          onChangeText={setSessionName}
          maxLength={100}
        />

        {/* Duration (non-Pomodoro) OR Preset + Total Duration (Pomodoro) */}
        {!pomodoro ? (
          <>
            <SectionLabel>Duration</SectionLabel>
            <View style={styles.wheelRow}>
              <WheelPicker
                values={HOURS}
                selectedValue={Math.floor(duration / 60)}
                unit="hours"
                width={150}
                onChange={h => setDuration(h * 60 + (duration % 60))}
                onInteractionStart={() => freezeBody(true)}
                onInteractionEnd={() => freezeBody(false)}
              />
              <WheelPicker
                values={MINUTES}
                selectedValue={duration % 60}
                unit="min"
                width={150}
                onChange={m => setDuration(Math.floor(duration / 60) * 60 + m)}
                onInteractionStart={() => freezeBody(true)}
                onInteractionEnd={() => freezeBody(false)}
              />
            </View>
          </>
        ) : (
          <>
            <SectionLabel>Pomodoro Preset</SectionLabel>
            <View style={styles.durationRow}>
              {POMO_PRESETS.map(p => (
                <TouchableOpacity
                  key={p.label}
                  style={[styles.durationChip, pomoPreset.label === p.label && styles.durationChipActive]}
                  onPress={() => { hSelection(); setPomoPreset(p); }}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.durationChipText, pomoPreset.label === p.label && styles.durationChipTextActive]}>
                    {p.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <SectionLabel>Total Duration</SectionLabel>
            <Text style={styles.durationBig}>
              {pomoDuration} <Text style={styles.durationUnit}>min</Text>
            </Text>
            <View style={styles.durationRow}>
              {[1, 2, 3, 4].map(r => (
                <TouchableOpacity
                  key={r}
                  style={[styles.durationChip, pomoRounds === r && styles.durationChipActive]}
                  onPress={() => { hSelection(); setPomoRounds(r); }}
                  activeOpacity={0.75}
                >
                  <Text style={[styles.durationChipText, pomoRounds === r && styles.durationChipTextActive]}>
                    {pomoPreset.work * r}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}

        {/* Pomodoro toggle */}
        <Card style={styles.toggleCard} padding={spacing.lg}>
          <View style={styles.toggleInfo}>
            <Text style={styles.toggleTitle}>Pomodoro Mode</Text>
            <Text style={styles.toggleSub}>
              {pomodoro
                ? `${pomoPreset.work} min focus · ${pomoPreset.brk} min break`
                : '25 min focus · 5 min break'}
            </Text>
          </View>
          <Switch value={pomodoro} onValueChange={v => { hLight(); setPomodoro(v); }} trackColor={{ true: colors.ink }} thumbColor={colors.white} />
        </Card>

        {/* Custom Breaks — Countdown sessions only */}
        {!pomodoro && (
          <>
            <SectionLabel>Breaks</SectionLabel>

            <Card style={styles.breakCard} padding={spacing.lg}>
              <Text style={styles.toggleTitle}>Planned breaks</Text>
              <Text style={styles.toggleSub}>Start times count minutes of focus.</Text>

              {plannedBreaks.length === 0 ? (
                <Text style={styles.breakEmpty}>No planned breaks</Text>
              ) : (
                <View style={styles.breakList}>
                  {plannedBreaks.map((b, i) => {
                    const pastEnd = b.startAfter >= duration;
                    return (
                      <View key={b.startAfter} style={styles.breakRow}>
                        <View style={styles.breakIndex}>
                          <Text style={styles.breakIndexText}>{i + 1}</Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.breakRowText}>
                            After {b.startAfter} min, {b.duration} min long
                          </Text>
                          {pastEnd && (
                            <Text style={styles.breakRowError}>Starts after the session ends</Text>
                          )}
                        </View>
                        <TouchableOpacity
                          onPress={() => removePlannedBreak(b.startAfter)}
                          hitSlop={8}
                          accessibilityLabel={`Remove break after ${b.startAfter} minutes`}
                        >
                          <Ionicons name="close-circle" size={22} color={colors.muted} />
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
              )}

              {plannedBreaks.length < MAX_PLANNED_BREAKS ? (
                <View style={styles.breakDraft}>
                  <Stepper
                    label="Start after"
                    value={draftAfterShown}
                    min={1}
                    max={maxBreakStart}
                    step={5}
                    unit="min"
                    onChange={setDraftAfter}
                  />
                  <Stepper
                    label="Length"
                    value={draftLength}
                    min={BREAK_LEN_MIN}
                    max={BREAK_LEN_MAX}
                    unit="min"
                    onChange={setDraftLength}
                  />
                  {draftTaken && (
                    <Text style={styles.breakRowError}>A break already starts at {draftAfterShown} min.</Text>
                  )}
                  {duration < 2 && (
                    <Text style={styles.breakRowError}>Make the session at least 2 min to add breaks.</Text>
                  )}
                  <TouchableOpacity
                    style={[styles.createBtn, styles.breakAddBtn, !canAddBreak && styles.createBtnDisabled]}
                    onPress={addPlannedBreak}
                    disabled={!canAddBreak}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.createBtnText}>Add break</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <Text style={styles.breakEmpty}>Maximum of {MAX_PLANNED_BREAKS} planned breaks reached.</Text>
              )}
            </Card>

            <Card style={styles.breakCard} padding={spacing.lg}>
              <Text style={styles.toggleTitle}>On-demand breaks</Text>
              <Text style={styles.toggleSub}>
                {odEnabled
                  ? `Up to ${odMaxBreaks} break${odMaxBreaks === 1 ? '' : 's'}, ${odMaxMinutes} min in total`
                  : 'Off — set both to more than 0 to allow them'}
              </Text>
              <View style={styles.breakDraft}>
                <Stepper
                  label="Max breaks"
                  value={odMaxBreaks}
                  min={0}
                  max={OD_MAX_BREAKS_LIMIT}
                  onChange={setOdMaxBreaks}
                />
                <Stepper
                  label="Max total"
                  value={odMaxMinutes}
                  min={0}
                  max={OD_MAX_MINUTES_LIMIT}
                  step={5}
                  unit="min"
                  onChange={setOdMaxMinutes}
                />
              </View>
            </Card>

            <Card style={styles.toggleCard} padding={spacing.lg}>
              <View style={styles.toggleInfo}>
                <Text style={styles.toggleTitle}>Unlock blocked apps during breaks</Text>
                <Text style={styles.toggleSub}>
                  {unlockApps ? 'Blocked apps open up while you’re on a break' : 'Apps stay blocked during breaks'}
                </Text>
              </View>
              <Switch value={unlockApps} onValueChange={v => { hLight(); setUnlockApps(v); }} trackColor={{ true: colors.ink }} thumbColor={colors.white} />
            </Card>
          </>
        )}

        {/* Screen Time real blocking (iOS only) */}
        {screenTimeSupported() && (
          <>
            <SectionLabel>Screen Time Shield</SectionLabel>
            <TouchableOpacity
              style={styles.stCard}
              onPress={configureScreenTime}
              activeOpacity={0.85}
              disabled={stBusy}
            >
              <View style={styles.stIconWrap}>
                <Ionicons name="shield-checkmark-outline" size={22} color={colors.ink} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.stTitle}>
                  {summaryTotal(stSummary) > 0 ? 'Apps blocked by iOS' : 'Configure blocked apps'}
                </Text>
                <Text style={styles.stSub} numberOfLines={1}>
                  {stStatus !== 'approved'
                    ? 'Tap to grant Screen Time access'
                    : formatSummary(stSummary)}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.muted} />
            </TouchableOpacity>
          </>
        )}

        {/* Actions — with a registered tag, NFC is required to start (and end);
            without one, the session starts and ends with no taps. iPads have no
            NFC hardware, so they always take the no-tap path. */}
        {nav.userTags.length > 0 && !isPadDevice ? (
          <TouchableOpacity
            style={styles.nfcBtn}
            onPress={() => startTo('NFCScan')}
            activeOpacity={0.8}
          >
            <Text style={styles.nfcBtnText}>Start with NFC</Text>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity
              style={styles.nfcBtn}
              onPress={() => startTo('ActiveSession')}
              activeOpacity={0.8}
            >
              <Text style={styles.nfcBtnText}>Start</Text>
            </TouchableOpacity>
            {!isPadDevice && (
              <TouchableOpacity style={styles.skipBtn} onPress={() => nav.navigate('NFCSetup', { from: 'CreateSession' })} activeOpacity={0.7}>
                <Text style={styles.skipBtnText}>Add an NFC tag</Text>
              </TouchableOpacity>
            )}
          </>
        )}
        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen:  { flex: 1, backgroundColor: colors.bg },
  header:  {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: Platform.OS === 'ios' ? 60 : 44,
    paddingBottom: spacing.md, backgroundColor: colors.bg,
  },
  backBtn:      { width: 40, height: 40, justifyContent: 'center' },
  title:        { fontSize: fontSize.xl, fontWeight: '700', color: colors.ink },
  headerSpacer: { width: 40 },
  body:         { paddingHorizontal: spacing.xl, paddingTop: spacing.sm },

  emptyText: { fontSize: fontSize.md, color: colors.muted, textAlign: 'center', marginTop: spacing.lg },
  categoryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginBottom: spacing.lg },
  categoryCard: {
    flex: 0.45,
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.border,
    borderRadius: radii.lg,
  },
  categoryCardActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  categoryActionBtn: {
    paddingVertical: spacing.xxs,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.full,
    backgroundColor: colors.card,
  },
  categoryActionBtnText: { fontSize: fontSize.xs, fontWeight: '600', color: colors.inkSoft },
  categoryActionBtnTextDanger: { color: colors.danger },
  categoryCardBody: { alignItems: 'center', justifyContent: 'center' },
  categoryName: { fontSize: fontSize.md, fontWeight: '600', color: colors.ink, marginTop: spacing.sm },

  categoryEditWrap: { alignItems: 'center' },
  categoryEditInput: {
    width: '100%',
    borderWidth: 1,
    borderColor: colors.ink,
    borderRadius: radii.md,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    fontSize: fontSize.md,
    color: colors.ink,
    backgroundColor: colors.card,
    textAlign: 'center',
  },
  categoryEditActions: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.sm },
  categoryEditBtn: { padding: spacing.xs },

  createCard: { marginBottom: spacing.lg },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    fontSize: fontSize.md,
    color: colors.ink,
    marginBottom: spacing.md,
  },
  createBtn: {
    backgroundColor: colors.ink,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  createBtnDisabled: { opacity: 0.6 },
  createBtnText: { color: colors.white, fontSize: fontSize.md, fontWeight: '600' },

  categoryBadge: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.lg },
  categoryBadgeText: { fontSize: fontSize.lg - 1, fontWeight: '600', color: colors.ink },

  sessionNameInput: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    fontSize: fontSize.md,
    color: colors.ink,
    marginBottom: spacing.md,
  },

  durationBig:  { fontSize: 60, fontWeight: '700', color: colors.ink, textAlign: 'center', marginVertical: 6 },
  durationUnit: { fontSize: 22, fontWeight: '400', color: colors.muted },
  wheelRow:     { flexDirection: 'row', justifyContent: 'center', marginVertical: spacing.sm },
  durationRow:  { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm + 2, justifyContent: 'center', marginBottom: spacing.xs },
  durationChip:           { paddingVertical: spacing.sm, paddingHorizontal: 18, borderRadius: radii.full, backgroundColor: colors.border },
  durationChipActive:     { backgroundColor: colors.ink },
  durationChipText:       { fontSize: fontSize.sm + 1, fontWeight: '600', color: colors.inkSoft },
  durationChipTextActive: { color: colors.white },

  toggleCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  toggleInfo: { flex: 1 },
  toggleTitle: { fontSize: fontSize.lg - 1, fontWeight: '600', color: colors.ink },
  toggleSub:   { fontSize: fontSize.sm, color: colors.muted, marginTop: 2 },

  // Custom Breaks
  breakCard:      { marginBottom: spacing.sm },
  breakEmpty:     { fontSize: fontSize.sm, color: colors.muted, marginTop: spacing.md },
  breakList:      { marginTop: spacing.md, gap: spacing.sm },
  breakRow:       {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    backgroundColor: colors.border, borderRadius: radii.md,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
  },
  breakIndex:     {
    width: 24, height: 24, borderRadius: 12, backgroundColor: colors.ink,
    alignItems: 'center', justifyContent: 'center',
  },
  breakIndexText: { fontSize: fontSize.xs, fontWeight: '700', color: colors.white },
  breakRowText:   { fontSize: fontSize.md, fontWeight: '600', color: colors.ink },
  breakRowError:  { fontSize: fontSize.sm, color: colors.danger, marginTop: 2 },
  breakDraft:     { marginTop: spacing.md, gap: spacing.sm },
  breakAddBtn:    { marginTop: spacing.xs },

  stepperRow:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepperLabel:    { fontSize: fontSize.md, color: colors.inkSoft },
  stepperControls: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stepperBtn:      {
    width: 34, height: 34, borderRadius: radii.full, backgroundColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  stepperBtnDisabled: { opacity: 0.4 },
  stepperValue:    { minWidth: 64, textAlign: 'center', fontSize: fontSize.md, fontWeight: '700', color: colors.ink },

  stCard:    {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.border, borderRadius: radii.lg,
    paddingVertical: spacing.md, paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  stIconWrap: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: colors.white,
    alignItems: 'center', justifyContent: 'center',
  },
  stTitle:   { fontSize: fontSize.md, fontWeight: '600', color: colors.ink },
  stSub:     { fontSize: fontSize.sm, color: colors.muted, marginTop: 2 },

  nfcBtn:      { backgroundColor: colors.ink, borderRadius: radii.lg, paddingVertical: 16, alignItems: 'center', marginTop: 28 },
  nfcBtnText:  { color: colors.white, fontSize: fontSize.lg - 1, fontWeight: '700' },
  skipBtn:     { alignItems: 'center', paddingVertical: 14, marginTop: spacing.sm + 2 },
  skipBtnText: { fontSize: fontSize.md, color: colors.muted, fontWeight: '500' },
});
