import { formatInr, type Budget, type Category, type OrderSummary, type ProductSummary, type SduiAction } from '@procurepilot/sdk';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { OrderRow, ProductCard } from '../components/Product';
import { Button, SectionTitle } from '../components/ui';
import { categoryIcon, colors, radius } from '../theme';

export type SectionComponentProps<P> = { props: P; onAction: (action: SduiAction) => void };

export function Greeting({ props }: SectionComponentProps<{ title: string; subtitle?: string }>) {
  return (
    <View style={styles.greeting}>
      <Text style={styles.greetingTitle} accessibilityRole="header">
        {props.title}
      </Text>
      {props.subtitle ? <Text style={styles.greetingSubtitle}>{props.subtitle}</Text> : null}
    </View>
  );
}

const BANNER_TONES = {
  warning: { bg: colors.warningBg, fg: colors.warning, icon: '⏳' },
  info: { bg: colors.infoBg, fg: colors.info, icon: 'ℹ️' },
  success: { bg: colors.successBg, fg: colors.success, icon: '✅' },
};

export function Banner({
  props,
  onAction,
}: SectionComponentProps<{ tone?: keyof typeof BANNER_TONES; title: string; body?: string; cta?: { label: string; action: SduiAction } }>) {
  const tone = BANNER_TONES[props.tone ?? 'info'] ?? BANNER_TONES.info;
  return (
    <View style={[styles.banner, { backgroundColor: tone.bg }]} testID="sdui-banner">
      <View style={{ flex: 1 }}>
        <Text style={[styles.bannerTitle, { color: tone.fg }]}>
          {tone.icon} {props.title}
        </Text>
        {props.body ? <Text style={[styles.bannerBody, { color: tone.fg }]}>{props.body}</Text> : null}
      </View>
      {props.cta ? <Button title={props.cta.label} small onPress={() => onAction(props.cta!.action)} testID="sdui-banner-cta" /> : null}
    </View>
  );
}

export function BudgetSummary({ props }: SectionComponentProps<{ title: string; items: Budget[] }>) {
  return (
    <View>
      <SectionTitle title={props.title} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hScroll}>
        {props.items.map((b) => {
          const used = b.budget > 0 ? Math.min(1, (b.committed + b.reserved) / b.budget) : 1;
          const low = b.available < b.budget * 0.15;
          return (
            <View key={b.costCenterId} style={styles.budget} accessible accessibilityLabel={`${b.name}: ${formatInr(b.available)} available`}>
              <Text style={styles.budgetName}>{b.name}</Text>
              <Text style={[styles.budgetAvailable, low && { color: colors.danger }]}>{formatInr(b.available)}</Text>
              <Text style={styles.budgetCaption}>available of {formatInr(b.budget)}</Text>
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${Math.round(used * 100)}%`, backgroundColor: low ? colors.danger : colors.primary }]} />
              </View>
              {b.reserved > 0 ? <Text style={styles.budgetCaption}>{formatInr(b.reserved)} held for pending approvals</Text> : null}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function ProductCarousel({ props }: SectionComponentProps<{ title: string; subtitle?: string; items: (ProductSummary & { suggestedQty?: number })[] }>) {
  return (
    <View>
      <SectionTitle title={props.title} subtitle={props.subtitle} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hScroll}>
        {props.items.map((p) => (
          <ProductCard key={p.sku} product={p} suggestedQty={p.suggestedQty} />
        ))}
      </ScrollView>
    </View>
  );
}

export function PromptChips({ props, onAction }: SectionComponentProps<{ title: string; prompts: string[] }>) {
  return (
    <View>
      <SectionTitle title={props.title} subtitle="Shop, reorder and check budgets by just asking" />
      <View style={styles.prompts}>
        {props.prompts.map((text) => (
          <Pressable key={text} accessibilityRole="button" onPress={() => onAction({ type: 'prompt', text })} style={styles.prompt}>
            <Text style={styles.promptText}>✨ {text}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function CategoryGrid({ props, onAction }: SectionComponentProps<{ title: string; items: Category[] }>) {
  return (
    <View>
      <SectionTitle title={props.title} />
      <View style={styles.grid}>
        {props.items.map((c) => (
          <Pressable
            key={c.name}
            accessibilityRole="button"
            onPress={() => onAction({ type: 'navigate', href: `/shop?category=${encodeURIComponent(c.name)}` })}
            style={styles.tile}
          >
            <Text style={styles.tileIcon}>{categoryIcon(c.name)}</Text>
            <Text style={styles.tileName} numberOfLines={2}>
              {c.name}
            </Text>
            <Text style={styles.budgetCaption}>{c.count} products</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function OrderList({ props }: SectionComponentProps<{ title: string; items: OrderSummary[] }>) {
  return (
    <View>
      <SectionTitle title={props.title} />
      {props.items.map((o) => (
        <OrderRow key={o.id} order={o} showRequester />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  greeting: { backgroundColor: colors.navy, paddingHorizontal: 16, paddingTop: 18, paddingBottom: 22 },
  greetingTitle: { color: '#FFFFFF', fontSize: 24, fontWeight: '700' },
  greetingSubtitle: { color: '#CBD5E1', fontSize: 14, marginTop: 4 },
  banner: { marginHorizontal: 16, marginTop: 14, borderRadius: radius, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  bannerTitle: { fontSize: 15, fontWeight: '700' },
  bannerBody: { fontSize: 13, marginTop: 3 },
  hScroll: { paddingHorizontal: 16, paddingVertical: 10 },
  budget: { width: 210, marginRight: 12, backgroundColor: colors.card, borderRadius: radius, padding: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  budgetName: { fontSize: 14, fontWeight: '600', color: colors.muted },
  budgetAvailable: { fontSize: 20, fontWeight: '700', color: colors.text, marginTop: 4 },
  budgetCaption: { fontSize: 12, color: colors.muted, marginTop: 2 },
  track: { height: 6, borderRadius: 3, backgroundColor: '#E2E8F0', marginTop: 10, marginBottom: 4, overflow: 'hidden' },
  fill: { height: 6, borderRadius: 3 },
  prompts: { paddingHorizontal: 16, paddingTop: 8 },
  prompt: { backgroundColor: colors.card, borderRadius: radius, padding: 12, marginBottom: 8, borderWidth: 1, borderColor: colors.primarySoft },
  promptText: { fontSize: 14, color: colors.primaryDark, fontWeight: '500' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 10, paddingTop: 6 },
  tile: { width: '46%', margin: '2%', backgroundColor: colors.card, borderRadius: radius, padding: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  tileIcon: { fontSize: 26 },
  tileName: { fontSize: 14, fontWeight: '600', color: colors.text, marginTop: 6 },
});
