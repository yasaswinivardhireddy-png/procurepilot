import { formatInr } from '@procurepilot/sdk';
import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { colors, radius } from '../theme';

export function Card({ children, style, testID }: { children: ReactNode; style?: StyleProp<ViewStyle>; testID?: string }) {
  return (
    <View style={[styles.card, style]} testID={testID}>
      {children}
    </View>
  );
}

type ButtonProps = {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  loading?: boolean;
  disabled?: boolean;
  small?: boolean;
  testID?: string;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
};

export function Button({ title, onPress, variant = 'primary', loading, disabled, small, testID, accessibilityLabel, style }: ButtonProps) {
  const inactive = disabled || loading;
  const palette = BUTTON_COLORS[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: palette.bg, borderColor: palette.border },
        pressed && { opacity: 0.85 },
        inactive && { opacity: 0.5 },
        style,
      ]}
    >
      {loading ? <ActivityIndicator color={palette.fg} /> : <Text style={[styles.buttonText, small && styles.buttonTextSmall, { color: palette.fg }]}>{title}</Text>}
    </Pressable>
  );
}

const BUTTON_COLORS = {
  primary: { bg: colors.primary, fg: '#FFFFFF', border: colors.primary },
  secondary: { bg: '#FFFFFF', fg: colors.primaryDark, border: colors.border },
  danger: { bg: '#FFFFFF', fg: colors.danger, border: '#FCA5A5' },
  ghost: { bg: 'transparent', fg: colors.primaryDark, border: 'transparent' },
};

export function Chip({ label, selected, onPress, testID }: { label: string; selected?: boolean; onPress?: () => void; testID?: string }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      testID={testID}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>
        {selected ? '✓ ' : ''}
        {label}
      </Text>
    </Pressable>
  );
}

export function Badge({ label, fg, bg, icon }: { label: string; fg: string; bg: string; icon?: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.badgeText, { color: fg }]}>
        {icon ? `${icon} ` : ''}
        {label}
      </Text>
    </View>
  );
}

export function Price({ paise, style, suffix }: { paise: number; style?: StyleProp<TextStyle>; suffix?: string }) {
  return (
    <Text style={[styles.price, style]}>
      {formatInr(paise)}
      {suffix ? <Text style={styles.priceSuffix}>{suffix}</Text> : null}
    </Text>
  );
}

export function Stepper({
  value,
  onChange,
  min = 0,
  max = 10_000,
  busy,
  testID,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  busy?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.stepper} testID={testID}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Decrease quantity"
        disabled={busy || value <= min}
        onPress={() => onChange(Math.max(min, value - 1))}
        style={styles.stepperButton}
      >
        <Text style={styles.stepperSymbol}>−</Text>
      </Pressable>
      <View style={styles.stepperValue}>{busy ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={styles.stepperText}>{value}</Text>}</View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Increase quantity"
        disabled={busy || value >= max}
        onPress={() => onChange(Math.min(max, value + 1))}
        style={styles.stepperButton}
      >
        <Text style={styles.stepperSymbol}>+</Text>
      </Pressable>
    </View>
  );
}

const NOTICE_COLORS = {
  info: { fg: colors.info, bg: colors.infoBg, icon: 'ℹ️' },
  success: { fg: colors.success, bg: colors.successBg, icon: '✅' },
  warning: { fg: colors.warning, bg: colors.warningBg, icon: '⚠️' },
  danger: { fg: colors.danger, bg: colors.dangerBg, icon: '⛔' },
};

export type NoticeTone = keyof typeof NOTICE_COLORS;

export function Notice({ tone, text, action, testID }: { tone: NoticeTone; text: string; action?: { label: string; onPress: () => void }; testID?: string }) {
  const palette = NOTICE_COLORS[tone];
  return (
    <View style={[styles.notice, { backgroundColor: palette.bg }]} accessibilityRole="alert" testID={testID}>
      <Text style={[styles.noticeText, { color: palette.fg }]}>
        {palette.icon} {text}
      </Text>
      {action ? (
        <Pressable accessibilityRole="button" onPress={action.onPress}>
          <Text style={[styles.noticeAction, { color: palette.fg }]}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: string; title: string; body?: string; action?: { label: string; onPress: () => void } }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyIcon}>{icon}</Text>
      <Text style={styles.emptyTitle}>{title}</Text>
      {body ? <Text style={styles.emptyBody}>{body}</Text> : null}
      {action ? <Button title={action.label} onPress={action.onPress} style={{ marginTop: 16, alignSelf: 'center' }} /> : null}
    </View>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ marginTop: 12 }}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput placeholderTextColor={colors.muted} accessibilityLabel={label} {...props} style={[styles.input, props.style]} />
    </View>
  );
}

export function SectionTitle({ title, subtitle, right }: { title: string; subtitle?: string; right?: ReactNode }) {
  return (
    <View style={styles.sectionTitleRow}>
      <View style={{ flex: 1 }}>
        <Text style={styles.sectionTitle} accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? <Text style={styles.sectionSubtitle}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

export function Muted({ children, style }: { children: ReactNode; style?: StyleProp<TextStyle> }) {
  return <Text style={[styles.muted, style]}>{children}</Text>;
}

export function Loading() {
  return (
    <View style={styles.loading}>
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radius,
    padding: 16,
    marginHorizontal: 16,
    marginTop: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    shadowColor: '#0F172A',
    shadowOpacity: 0.05,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  button: { borderRadius: 10, paddingVertical: 13, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', borderWidth: 1 },
  buttonSmall: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 8 },
  buttonText: { fontSize: 16, fontWeight: '600' },
  buttonTextSmall: { fontSize: 14 },
  chip: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 18, borderWidth: 1, borderColor: colors.border, backgroundColor: '#FFFFFF', marginRight: 8, marginBottom: 8 },
  chipSelected: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  chipText: { fontSize: 14, color: colors.text },
  chipTextSelected: { color: colors.primaryDark, fontWeight: '600' },
  badge: { alignSelf: 'flex-start', paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6 },
  badgeText: { fontSize: 12, fontWeight: '600' },
  price: { fontSize: 16, fontWeight: '700', color: colors.text },
  priceSuffix: { fontSize: 13, fontWeight: '400', color: colors.muted },
  stepper: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: 10, overflow: 'hidden' },
  stepperButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F8FAFC' },
  stepperSymbol: { fontSize: 20, color: colors.primaryDark, fontWeight: '600' },
  stepperValue: { minWidth: 44, alignItems: 'center' },
  stepperText: { fontSize: 16, fontWeight: '600', color: colors.text },
  notice: { marginHorizontal: 16, marginTop: 12, borderRadius: 10, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  noticeText: { flex: 1, fontSize: 14, lineHeight: 20 },
  noticeAction: { fontSize: 14, fontWeight: '700', textDecorationLine: 'underline' },
  empty: { alignItems: 'center', padding: 32 },
  emptyIcon: { fontSize: 44 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginTop: 12, textAlign: 'center' },
  emptyBody: { fontSize: 15, color: colors.muted, marginTop: 6, textAlign: 'center', lineHeight: 21 },
  fieldLabel: { fontSize: 13, color: colors.muted, marginBottom: 6, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: colors.text, backgroundColor: '#FFFFFF' },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'flex-end', marginHorizontal: 16, marginTop: 20, marginBottom: 2 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: colors.text },
  sectionSubtitle: { fontSize: 13, color: colors.muted, marginTop: 2 },
  muted: { fontSize: 13, color: colors.muted },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
});
