import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  Switch, StyleSheet, Platform, Animated,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { NavProps } from '../App';
import Card from '../components/Card';
import SectionLabel from '../components/SectionLabel';
import { ColorPalette, spacing, radii, fontSize } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';

const SESSION_TYPES = ['Study', 'Work', 'Custom'] as const;

// ─── Wheel picker constants ────────────────────────────────────────────────
const ITEM_H  = 46;
const VISIBLE = 7;                          // odd — centre slot = selected
const PAD     = Math.floor(VISIBLE / 2);   // 3 padding rows top & bottom
const HOURS   = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINS    = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

// Pseudo-gradient fade strips
function FadeBar({ top }: { top: boolean }) {
  const { colors } = useTheme();
  const wp = useMemo(() => makeWp(colors), [colors]);
  const alphas = top ? [0.95, 0.7, 0.35, 0.08] : [0.08, 0.35, 0.7, 0.95];
  // Use colors.bg so the fade matches the screen background in both themes
  const rgb = colors.bg === '#0e0e0e' ? '14,14,14' : '245,245,245';
  return (
    <View style={[wp.fadeBar, top ? { top: 0 } : { bottom: 0 }]} pointerEvents="none">
      {alphas.map((a, i) => (
        <View key={i} style={{ flex: 1, backgroundColor: `rgba(${rgb},${a})` }} />
      ))}
    </View>
  );
}

function WheelPicker({
  items, selectedIndex, onChange, label,
}: {
  items: string[]; selectedIndex: number;
  onChange: (i: number) => void; label: string;
}) {
  const { colors } = useTheme();
  const wp = useMemo(() => makeWp(colors), [colors]);
  const scrollY   = useRef(new Animated.Value(selectedIndex * ITEM_H)).current;
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      scrollRef.current?.scrollTo({ y: selectedIndex * ITEM_H, animated: false });
      scrollY.setValue(selectedIndex * ITEM_H);
    }, 80);
    return () => clearTimeout(t);
  }, []);

  const snap = (e: any) => {
    const offset = e.nativeEvent.contentOffset.y;
    const idx = Math.max(0, Math.min(items.length - 1, Math.round(offset / ITEM_H)));
    onChange(idx);
  };

  return (
    <View style={wp.col}>
      <View style={wp.drum}>
        {/* iOS-style selection lines */}
        <View style={[wp.selLine, { top: ITEM_H * PAD }]}           pointerEvents="none" />
        <View style={[wp.selLine, { top: ITEM_H * (PAD + 1) - StyleSheet.hairlineWidth }]} pointerEvents="none" />

        <Animated.ScrollView
          ref={scrollRef as any}
          snapToInterval={ITEM_H}
          decelerationRate="fast"
          showsVerticalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={Animated.event(
            [{ nativeEvent: { contentOffset: { y: scrollY } } }],
            { useNativeDriver: true },
          )}
          onMomentumScrollEnd={snap}
          onScrollEndDrag={snap}
          contentContainerStyle={{ paddingVertical: ITEM_H * PAD }}
        >
          {items.map((item, i) => {
            const center     = i * ITEM_H;
            const inputRange = [center - ITEM_H * 2, center - ITEM_H, center, center + ITEM_H, center + ITEM_H * 2];
            const opacity = scrollY.interpolate({ inputRange, outputRange: [0.12, 0.4, 1, 0.4, 0.12], extrapolate: 'clamp' });
            const scale   = scrollY.interpolate({ inputRange, outputRange: [0.72, 0.86, 1, 0.86, 0.72], extrapolate: 'clamp' });
            return (
              <Animated.View key={i} style={[wp.item, { opacity, transform: [{ scale }] }]}>
                <Text style={wp.num}>{item}</Text>
              </Animated.View>
            );
          })}
        </Animated.ScrollView>

        <FadeBar top />
        <FadeBar top={false} />
      </View>
      <Text style={wp.label}>{label}</Text>
    </View>
  );
}
const APPS = ['Instagram', 'Twitter', 'TikTok', 'YouTube', 'Reddit', 'Snapchat', 'Discord', 'Games'];

const POMO_PRESETS = [
  { label: '25 / 5',  work: 25, brk: 5  },
  { label: '50 / 10', work: 50, brk: 10 },
  { label: '30 / 10', work: 30, brk: 10 },
  { label: '15 / 3',  work: 15, brk: 3  },
] as const;

type PomoPreset = typeof POMO_PRESETS[number];

export default function CreateSessionScreen({ nav }: { nav: NavProps }) {
  const { colors } = useTheme();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const [sessionType, setSessionType] = useState<string>('Study');

  // Wheel picker state — derive from user preferred duration
  const prefH = Math.min(23, Math.floor(nav.user.preferredDuration / 60));
  const prefM = Math.min(59, nav.user.preferredDuration % 60);
  const [hourIdx,   setHourIdx]   = useState(prefH);
  const [minuteIdx, setMinuteIdx] = useState(prefM > 0 ? prefM : 5); // default 5 min
  // hourIdx & minuteIdx map directly to their values (HOURS[i] = padded i, MINS[i] = padded i)
  const duration = Math.max(1, hourIdx * 60 + minuteIdx);
  const [pomodoro,   setPomodoro]   = useState(() => nav.user.pomodoroEnabled);
  const [pomoPreset, setPomoPreset] = useState<PomoPreset>(POMO_PRESETS[0]);
  const [pomoRounds, setPomoRounds] = useState(2);
  const [blockedApps, setBlockedApps] = useState<string[]>(['Instagram', 'Twitter', 'TikTok', 'YouTube', 'Reddit']);
  const [showAllApps, setShowAllApps] = useState(false);

  const pomoDuration = pomoPreset.work * pomoRounds;

  const toggleApp = (app: string) =>
    setBlockedApps(prev => prev.includes(app) ? prev.filter(a => a !== app) : [...prev, app]);

  const visibleApps = showAllApps ? APPS : APPS.slice(0, 5);

  const startParams = {
    type:          sessionType,
    duration:      String(pomodoro ? pomoDuration : duration),
    pomodoro:      String(pomodoro),
    pomodoroWork:  String(pomoPreset.work),
    pomodoroBreak: String(pomoPreset.brk),
    blockedApps:   blockedApps.join(','),
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => nav.navigate('Dashboard')}>
          <Ionicons name="arrow-back" size={24} color={colors.ink} />
        </TouchableOpacity>
        <Text style={styles.title}>New Session</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>

        {/* Session Type */}
        <SectionLabel noTopMargin>Session Type</SectionLabel>
        <View style={styles.typeRow}>
          {SESSION_TYPES.map(t => (
            <TouchableOpacity
              key={t}
              style={[styles.typePill, sessionType === t && styles.typePillActive]}
              onPress={() => setSessionType(t)}
              activeOpacity={0.75}
            >
              <Text style={[styles.typePillText, sessionType === t && styles.typePillTextActive]}>{t}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Duration (non-Pomodoro) OR Preset + Total Duration (Pomodoro) */}
        {!pomodoro ? (
          <>
            <SectionLabel>Duration</SectionLabel>
            {/* iOS-style drum-roll picker */}
            <View style={styles.wheelRow}>
              <WheelPicker items={HOURS} selectedIndex={hourIdx} onChange={setHourIdx} label="hours" />
              <Text style={styles.wheelColon}>:</Text>
              <WheelPicker items={MINS}  selectedIndex={minuteIdx} onChange={setMinuteIdx} label="min" />
            </View>
            <Text style={styles.durationSummary}>
              {parseInt(HOURS[hourIdx]) > 0
                ? `${HOURS[hourIdx]}h ${MINS[minuteIdx]}min`
                : `${MINS[minuteIdx]} min`}
            </Text>
          </>
        ) : (
          <>
            <SectionLabel>Pomodoro Preset</SectionLabel>
            <View style={styles.durationRow}>
              {POMO_PRESETS.map(p => (
                <TouchableOpacity
                  key={p.label}
                  style={[styles.durationChip, pomoPreset.label === p.label && styles.durationChipActive]}
                  onPress={() => setPomoPreset(p)}
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
                  onPress={() => setPomoRounds(r)}
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
          <Switch value={pomodoro} onValueChange={setPomodoro} trackColor={{ true: colors.ink }} thumbColor={colors.white} />
        </Card>

        {/* Block Apps */}
        <SectionLabel>Block Apps</SectionLabel>
        <View style={styles.appsWrap}>
          {visibleApps.map(app => (
            <TouchableOpacity
              key={app}
              style={[styles.appChip, blockedApps.includes(app) && styles.appChipActive]}
              onPress={() => toggleApp(app)}
              activeOpacity={0.75}
            >
              <Text style={[styles.appChipText, blockedApps.includes(app) && styles.appChipTextActive]}>{app}</Text>
            </TouchableOpacity>
          ))}
          {!showAllApps && (
            <TouchableOpacity style={styles.appChip} onPress={() => setShowAllApps(true)}>
              <Text style={styles.appChipText}>+{APPS.length - 5} more</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Actions */}
        <TouchableOpacity style={styles.nfcBtn} onPress={() => nav.navigate('NFCScan', startParams)} activeOpacity={0.8}>
          <Text style={styles.nfcBtnText}>Tap NFC Tag to Start</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.skipBtn} onPress={() => nav.navigate('ActiveSession', startParams)} activeOpacity={0.7}>
          <Text style={styles.skipBtnText}>Start Without NFC</Text>
        </TouchableOpacity>
        <View style={{ height: 40 }} />
      </ScrollView>
    </View>
  );
}

const makeStyles = (c: ColorPalette) => StyleSheet.create({
  screen:  { flex: 1, backgroundColor: c.bg },
  header:  {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: Platform.OS === 'ios' ? 60 : 44,
    paddingBottom: spacing.md, backgroundColor: c.bg,
  },
  backBtn:      { width: 40, height: 40, justifyContent: 'center' },
  title:        { fontSize: fontSize.xl, fontWeight: '700', color: c.ink },
  headerSpacer: { width: 40 },
  body:         { paddingHorizontal: spacing.xl, paddingTop: spacing.sm },

  typeRow:            { flexDirection: 'row', gap: spacing.sm + 2 },
  typePill:           { paddingVertical: 10, paddingHorizontal: 22, borderRadius: radii.full, backgroundColor: c.border },
  typePillActive:     { backgroundColor: c.ink },
  typePillText:       { fontSize: fontSize.sm + 1, fontWeight: '600', color: c.inkSoft },
  typePillTextActive: { color: c.bg },

  wheelRow:        { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.lg, marginVertical: spacing.sm },
  wheelColon:      { fontSize: 32, fontWeight: '300', color: c.muted, marginTop: 18 },
  durationSummary: { textAlign: 'center', fontSize: fontSize.sm + 1, color: c.muted, marginBottom: spacing.sm },
  durationChip:           { paddingVertical: spacing.sm, paddingHorizontal: 18, borderRadius: radii.full, backgroundColor: c.border },
  durationChipActive:     { backgroundColor: c.ink },
  durationChipText:       { fontSize: fontSize.sm + 1, fontWeight: '600', color: c.inkSoft },
  durationChipTextActive: { color: c.bg },

  toggleCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.sm },
  toggleInfo: { flex: 1 },
  toggleTitle: { fontSize: fontSize.lg - 1, fontWeight: '600', color: c.ink },
  toggleSub:   { fontSize: fontSize.sm, color: c.muted, marginTop: 2 },

  appsWrap:         { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm + 2 },
  appChip:          { paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: radii.full, backgroundColor: c.border },
  appChipActive:    { backgroundColor: c.ink },
  appChipText:      { fontSize: fontSize.sm, fontWeight: '500', color: c.inkSoft },
  appChipTextActive: { color: c.bg },

  nfcBtn:      { backgroundColor: c.ink, borderRadius: radii.lg, paddingVertical: 16, alignItems: 'center', marginTop: 28 },
  nfcBtnText:  { color: c.bg, fontSize: fontSize.lg - 1, fontWeight: '700' },
  skipBtn:     { alignItems: 'center', paddingVertical: 14, marginTop: spacing.sm + 2 },
  skipBtnText: { fontSize: fontSize.md, color: c.muted, fontWeight: '500' },
});

// ─── Wheel picker styles ───────────────────────────────────────────────────
const makeWp = (c: ColorPalette) => StyleSheet.create({
  col:     { alignItems: 'center', gap: 6 },
  label:   { fontSize: fontSize.xs + 1, fontWeight: '600', color: c.muted, letterSpacing: 0.8, textTransform: 'uppercase' },
  drum:    { width: 100, height: ITEM_H * VISIBLE, overflow: 'hidden' },
  selLine: { position: 'absolute', left: 4, right: 4, height: StyleSheet.hairlineWidth, backgroundColor: c.border, zIndex: 10 },
  item:    { height: ITEM_H, justifyContent: 'center', alignItems: 'center' },
  num:     { fontSize: 28, fontWeight: '300', color: c.ink, fontVariant: ['tabular-nums'] as any },
  fadeBar: { position: 'absolute', left: 0, right: 0, height: ITEM_H * PAD, zIndex: 5, flexDirection: 'column' },
});
