// frontend/screens/SettingsScreen.tsx
// User preferences. Every change is immediately synced to PATCH /user/settings.
import React, { useMemo } from 'react';
import { View, Text, Switch, TouchableOpacity, StyleSheet, ScrollView, Platform } from 'react-native';
import { NavProps, UserProfile } from '../App';
import { DAILY_GOAL_OPTIONS, WEEKLY_GOAL_OPTIONS } from '../store/user';
import { ColorPalette, fontSize, spacing, radii } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';
import { apiFetch } from '../api/client';

const DURATION_OPTIONS = [15, 25, 30, 45, 60, 90];

function ChipRow<T extends string | number>({
  options, active, onSelect, labelOf, s,
}: {
  options: T[];
  active: T;
  onSelect: (v: T) => void;
  labelOf?: (v: T) => string;
  s: ReturnType<typeof makeStyles>;
}) {
  return (
    <View style={s.chipsRow}>
      {options.map(opt => {
        const on = opt === active;
        return (
          <TouchableOpacity
            key={String(opt)}
            style={[s.chip, on && s.chipOn]}
            onPress={() => onSelect(opt)}
            activeOpacity={0.75}
          >
            <Text style={[s.chipTxt, on && s.chipTxtOn]}>
              {labelOf ? labelOf(opt) : String(opt)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function ToggleRow({ label, desc, value, onChange, s, colors }: {
  label: string; desc: string; value: boolean; onChange: (v: boolean) => void;
  s: ReturnType<typeof makeStyles>; colors: ColorPalette;
}) {
  return (
    <View style={s.toggleRow}>
      <View style={s.rowInfo}>
        <Text style={s.rowLabel}>{label}</Text>
        <Text style={s.rowDesc}>{desc}</Text>
      </View>
      <Switch value={value} onValueChange={onChange}
        trackColor={{ false: colors.border, true: colors.ink }} thumbColor={colors.white} />
    </View>
  );
}

export default function SettingsScreen({ nav }: { nav: NavProps }) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { user, token } = nav;
  const initial = user.name.charAt(0).toUpperCase();

  // Updates local state instantly and fires a background sync to the backend.
  const updateAndSync = async (updates: Partial<UserProfile>) => {
    nav.updateUser(updates);
    if (!token) return;

    const backendUpdates: Record<string, unknown> = {};
    if (updates.dailyGoalMinutes    !== undefined) backendUpdates.dailyGoalMinutes    = updates.dailyGoalMinutes;
    if (updates.weeklyGoalMinutes   !== undefined) backendUpdates.weeklyGoalMinutes   = updates.weeklyGoalMinutes;
    if (updates.preferredDuration   !== undefined) backendUpdates.defaultDuration     = updates.preferredDuration;
    if (updates.pomodoroEnabled     !== undefined) backendUpdates.defaultTimerMode    = updates.pomodoroEnabled ? 'POMODORO' : 'COUNTDOWN';
    if (updates.notificationsEnabled !== undefined) backendUpdates.notificationsEnabled = updates.notificationsEnabled;

    try {
      await apiFetch('/user/settings', token, {
        method: 'PATCH',
        body: JSON.stringify(backendUpdates),
      });
    } catch {
      // Local state is already updated; silently ignore transient network failures.
    }
  };

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.container} showsVerticalScrollIndicator={false}>

      <View style={s.header}>
        <TouchableOpacity style={s.menuBtn} onPress={nav.openDrawer}>
          <View style={s.menuLine} /><View style={s.menuLine} /><View style={s.menuLine} />
        </TouchableOpacity>
        <Text style={s.title}>Settings</Text>
        <View style={s.menuBtn} />
      </View>

      <Text style={s.sectionLabel}>PROFILE</Text>
      <View style={s.card}>
        <View style={s.profileRow}>
          <View style={s.avatar}><Text style={s.avatarTxt}>{initial}</Text></View>
          <View style={s.profileInfo}>
            <Text style={s.profileName}>{user.name}</Text>
            {!!user.email && <Text style={s.profileEmail}>{user.email}</Text>}
          </View>
        </View>
      </View>

      <Text style={s.sectionLabel}>FOCUS GOALS</Text>
      <View style={s.selectCard}>
        <Text style={s.rowLabel}>Daily Goal</Text>
        <Text style={s.rowDesc}>Target focus time per day — drives Dashboard progress</Text>
        <ChipRow
          options={DAILY_GOAL_OPTIONS.map(o => o.minutes)}
          active={user.dailyGoalMinutes}
          onSelect={v => updateAndSync({ dailyGoalMinutes: v })}
          labelOf={v => DAILY_GOAL_OPTIONS.find(o => o.minutes === v)?.label ?? `${v}m`}
          s={s}
        />
      </View>
      <View style={s.selectCard}>
        <Text style={s.rowLabel}>Weekly Goal</Text>
        <Text style={s.rowDesc}>Weekly target — used in Analytics health score</Text>
        <ChipRow
          options={WEEKLY_GOAL_OPTIONS.map(o => o.minutes)}
          active={user.weeklyGoalMinutes}
          onSelect={v => updateAndSync({ weeklyGoalMinutes: v })}
          labelOf={v => WEEKLY_GOAL_OPTIONS.find(o => o.minutes === v)?.label ?? `${v}m`}
          s={s}
        />
      </View>

      <Text style={s.sectionLabel}>SESSION DEFAULTS</Text>
      <View style={s.selectCard}>
        <Text style={s.rowLabel}>Preferred Duration</Text>
        <Text style={s.rowDesc}>Pre-selected when you open Create Session</Text>
        <ChipRow
          options={DURATION_OPTIONS}
          active={user.preferredDuration}
          onSelect={v => updateAndSync({ preferredDuration: v })}
          labelOf={v => `${v} min`}
          s={s}
        />
      </View>
      <View style={s.card}>
        <ToggleRow
          label="Pomodoro Mode"
          desc="Enable 25 min focus / 5 min break by default"
          value={user.pomodoroEnabled}
          onChange={v => updateAndSync({ pomodoroEnabled: v })}
          s={s} colors={colors}
        />
      </View>

      <Text style={s.sectionLabel}>PREFERENCES</Text>
      <View style={s.card}>
        <ToggleRow
          label="Dark Mode"
          desc="Invert the app's colour scheme"
          value={user.darkMode}
          onChange={v => nav.updateUser({ darkMode: v })}
          s={s} colors={colors}
        />
        <View style={s.dividerLine} />
        <ToggleRow
          label="Notifications"
          desc="Session reminders and completion alerts"
          value={user.notificationsEnabled}
          onChange={v => updateAndSync({ notificationsEnabled: v })}
          s={s} colors={colors}
        />
      </View>

      <View style={{ height: 48 }} />
    </ScrollView>
  );
}

const makeStyles = (c: ColorPalette) => StyleSheet.create({
  screen:       { flex: 1, backgroundColor: c.bg },
  container:    { paddingHorizontal: spacing.xl, paddingTop: Platform.OS === 'ios' ? 60 : 44, paddingBottom: 48 },
  header:       { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 },
  menuBtn:      { width: 40, height: 40, justifyContent: 'center' },
  menuLine:     { width: 22, height: 2.5, backgroundColor: c.ink, borderRadius: 2, marginBottom: 5 },
  title:        { fontSize: fontSize.xl, fontWeight: '700', color: c.ink },
  sectionLabel: { fontSize: 11, fontWeight: '700', color: c.muted, letterSpacing: 1.2, marginBottom: 10, marginTop: 4 },
  card:         { backgroundColor: c.card, borderRadius: radii.lg, marginBottom: spacing.lg, overflow: 'hidden', shadowColor: c.black, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2 },
  selectCard:   { backgroundColor: c.card, borderRadius: radii.lg, padding: spacing.lg, marginBottom: spacing.md, shadowColor: c.black, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 4, elevation: 2 },
  profileRow:   { flexDirection: 'row', alignItems: 'center', padding: spacing.lg, gap: spacing.md },
  avatar:       { width: 48, height: 48, borderRadius: 24, backgroundColor: c.ink, justifyContent: 'center', alignItems: 'center' },
  avatarTxt:    { color: c.bg, fontWeight: '700', fontSize: fontSize.lg },
  profileInfo:  { flex: 1 },
  profileName:  { fontSize: fontSize.lg, fontWeight: '700', color: c.ink, marginBottom: 2 },
  profileEmail: { fontSize: fontSize.sm, color: c.muted },
  toggleRow:    { flexDirection: 'row', alignItems: 'center', padding: spacing.lg },
  rowInfo:      { flex: 1, marginRight: spacing.md },
  rowLabel:     { fontSize: fontSize.md, fontWeight: '600', color: c.ink, marginBottom: 2 },
  rowDesc:      { fontSize: fontSize.xs + 1, color: c.muted },
  chipsRow:     { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  chip:         { paddingHorizontal: spacing.md + 2, paddingVertical: spacing.sm, borderRadius: radii.full, borderWidth: 1.5, borderColor: c.border },
  chipOn:       { backgroundColor: c.ink, borderColor: c.ink },
  chipTxt:      { fontSize: fontSize.sm, color: c.muted, fontWeight: '500' },
  chipTxtOn:    { color: c.bg, fontWeight: '600' },
  dividerLine:  { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginHorizontal: spacing.lg },
});