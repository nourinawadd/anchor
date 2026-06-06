import React from 'react';
import { View, ViewStyle, StyleSheet } from 'react-native';
import { radii } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';

type Props = {
  children: React.ReactNode;
  /** Force the dark card surface (regardless of global theme) */
  dark?: boolean;
  style?: ViewStyle;
  padding?: number;
};

export default function Card({ children, dark = false, style, padding = 16 }: Props) {
  const { colors, dark: isDark } = useTheme();
  const bg = dark ? colors.darkCard : isDark ? colors.card : colors.card;
  return (
    <View style={[styles.base, { backgroundColor: bg, padding }, style]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: radii.lg },
});
