import React from 'react';
import { Text, TextStyle } from 'react-native';
import { fontSize, spacing } from '../constants/theme';
import { useTheme } from '../context/ThemeContext';

type Props = {
  children: string;
  style?: TextStyle;
  /** Remove default top margin (useful when label is not the first element) */
  noTopMargin?: boolean;
};

export default function SectionLabel({ children, style, noTopMargin = false }: Props) {
  const { colors } = useTheme();
  return (
    <Text
      style={[
        {
          fontSize:      fontSize.xs,
          fontWeight:    '600',
          color:         colors.muted,
          letterSpacing: 0.8,
          marginTop:     noTopMargin ? 0 : spacing.xl,
          marginBottom:  spacing.sm + 2,
        },
        style,
      ]}
    >
      {children.toUpperCase()}
    </Text>
  );
}
