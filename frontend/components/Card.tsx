import React from 'react';
import { StyleProp, ViewStyle, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView, isGlassEffectAPIAvailable } from 'expo-glass-effect';
import { colors, radii } from '../constants/theme';

type Props = {
  children: React.ReactNode;
  /** Use the dark (Twilight Indigo) surface instead of white */
  dark?: boolean;
  style?: StyleProp<ViewStyle>;
  padding?: number;
};

export default function Card({ children, dark = false, style, padding = 16 }: Props) {
  // Hairline frosted rim that reads on both light and dark glass.
  const border: ViewStyle = {
    borderWidth: 1,
    borderColor: dark ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.7)',
  };

  // iOS 26+: real Liquid Glass. Light cards stay untinted; dark cards get the
  // Twilight Indigo tint. Never drop opacity below 1 on the GlassView itself.
  if (isGlassEffectAPIAvailable()) {
    return (
      <GlassView
        glassEffectStyle="regular"
        tintColor={dark ? colors.darkCard : undefined}
        style={[styles.base, border, { padding }, style]}
      >
        {children}
      </GlassView>
    );
  }

  // Android / older iOS fallback: blur with a translucent fill behind it.
  return (
    <BlurView
      intensity={40}
      tint={dark ? 'dark' : 'light'}
      experimentalBlurMethod="dimezisBlurView"
      style={[
        styles.base,
        border,
        { backgroundColor: dark ? 'rgba(49,56,82,0.84)' : 'rgba(255,255,255,0.5)', padding },
        style,
      ]}
    >
      {children}
    </BlurView>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radii.lg,
    overflow: 'hidden',
  },
});
