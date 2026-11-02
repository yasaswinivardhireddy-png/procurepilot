import { formatInr, formatPercentBps } from '@procurepilot/sdk';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Badge, Button, Card, EmptyState, Loading, Muted, Notice, Stepper } from '../../src/components/ui';
import { linePreview, nextTier } from '../../src/pricing';
import { useSession } from '../../src/session';
import { categoryIcon, colors } from '../../src/theme';
import { useCachedQuery } from '../../src/useCachedQuery';

export default function ProductScreen() {
  const { sku } = useLocalSearchParams<{ sku: string }>();
  const { client } = useSession();
  const product = useCachedQuery(`product:${sku}`, () => client.getProduct(sku), { maxAgeMs: 300_000 });
  const [qty, setQty] = useState(1);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const p = product.data;
  if (!p) {
    return product.loading ? (
      <Loading />
    ) : (
      <EmptyState icon="📦" title="Product unavailable" body="It may have been removed, or you may be offline." action={{ label: 'Retry', onPress: () => void product.refresh() }} />
    );
  }

  const preview = linePreview(p.tiers, qty, p.gstRateBps);
  const next = nextTier(p.tiers, qty);

  const add = async () => {
    setAdding(true);
    setMessage(null);
    try {
      await client.addToCart(p.sku, qty);
      setMessage({ tone: 'success', text: `Added ${qty} × ${p.title} to your cart.` });
    } catch (e) {
      setMessage({ tone: 'danger', text: (e as Error).message });
    } finally {
      setAdding(false);
    }
  };

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 32 }} testID="product-screen">
      <Stack.Screen options={{ title: p.brand }} />
      <View style={styles.hero}>
        <Text style={styles.heroIcon}>{categoryIcon(p.category)}</Text>
      </View>
      <Card>
        <Muted>{p.category}</Muted>
        <Text style={styles.title}>{p.title}</Text>
        <Muted style={{ marginTop: 4 }}>
          ★ {p.rating.toFixed(1)} · Sold by {p.seller} · Delivery in {p.deliveryDays} day{p.deliveryDays === 1 ? '' : 's'}
        </Muted>
        <View style={styles.badges}>
          {p.gstInvoice ? <Badge label="GST invoice for input tax credit" icon="🧾" fg={colors.success} bg={colors.successBg} /> : <Badge label="No GST invoice" icon="ℹ️" fg={colors.muted} bg="#F1F5F9" />}
          <Badge label={`${formatPercentBps(p.gstRateBps)} GST`} fg={colors.info} bg={colors.infoBg} />
          <Badge label={p.stock > 0 ? `${p.stock} in stock` : 'Out of stock'} fg={p.stock > 0 ? colors.success : colors.danger} bg={p.stock > 0 ? colors.successBg : colors.dangerBg} />
        </View>
      </Card>

      <Card testID="volume-pricing">
        <Text style={styles.cardTitle}>Business volume pricing</Text>
        {p.tiers.map((t) => {
          const active = preview.unitPrice === t.unitPrice && qty >= t.minQty;
          return (
            <View key={t.minQty} style={[styles.tier, active && styles.tierActive]} accessible accessibilityLabel={`${t.minQty} or more: ${formatInr(t.unitPrice)} each`}>
              <Text style={[styles.tierQty, active && styles.tierTextActive]}>{t.minQty === 1 ? '1+' : `${t.minQty}+`} units</Text>
              <Text style={[styles.tierPrice, active && styles.tierTextActive]}>
                {formatInr(t.unitPrice)} /{p.unit}
              </Text>
              <Text style={[styles.tierSave, active && styles.tierTextActive]}>{t.discountBps > 0 ? `save ${formatPercentBps(t.discountBps)}` : 'list price'}</Text>
            </View>
          );
        })}
      </Card>

      <Card>
        <View style={styles.qtyRow}>
          <Text style={styles.cardTitle}>Quantity</Text>
          <Stepper value={qty} min={1} max={Math.max(1, p.stock)} onChange={setQty} testID="product-qty" />
        </View>
        <View style={styles.qtyPresets}>
          {[10, 25, 50].map((n) => (
            <Button key={n} title={`${n}`} small variant={qty === n ? 'primary' : 'secondary'} onPress={() => setQty(Math.min(n, p.stock))} />
          ))}
        </View>
        <View style={styles.summary}>
          <Text style={styles.summaryLine}>
            {qty} × {formatInr(preview.unitPrice)} = {formatInr(preview.subtotal)}
          </Text>
          <Text style={styles.summaryLine}>+ GST {formatInr(preview.gst)}</Text>
          <Text style={styles.total}>{formatInr(preview.total)}</Text>
        </View>
        {next ? (
          <Text style={styles.nudge}>
            Buy {next.minQty - qty} more to pay {formatInr(next.unitPrice)} each (save {formatPercentBps(next.discountBps)}).
          </Text>
        ) : null}
        <Button title={`Add ${qty} to cart`} onPress={() => void add()} loading={adding} disabled={p.stock === 0} style={{ marginTop: 14 }} testID="add-to-cart" />
      </Card>
      {message ? <Notice tone={message.tone} text={message.text} action={message.tone === 'success' ? { label: 'View cart', onPress: () => router.push('/cart') } : undefined} /> : null}

      <Card>
        <Text style={styles.cardTitle}>About this item</Text>
        <Text style={styles.body}>{p.description}</Text>
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  hero: { height: 150, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  heroIcon: { fontSize: 72 },
  title: { fontSize: 20, fontWeight: '700', color: colors.text, marginTop: 4 },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  tier: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 10, borderRadius: 8, marginTop: 6 },
  tierActive: { backgroundColor: colors.primary },
  tierQty: { flex: 1, fontSize: 15, color: colors.text },
  tierPrice: { flex: 1.4, fontSize: 15, fontWeight: '700', color: colors.text },
  tierSave: { fontSize: 13, color: colors.success, fontWeight: '600' },
  tierTextActive: { color: '#FFFFFF' },
  qtyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  qtyPresets: { flexDirection: 'row', gap: 8, marginTop: 12 },
  summary: { marginTop: 14, alignItems: 'flex-end' },
  summaryLine: { fontSize: 14, color: colors.muted },
  total: { fontSize: 22, fontWeight: '800', color: colors.text, marginTop: 4 },
  nudge: { marginTop: 10, fontSize: 14, color: colors.success, fontWeight: '600' },
  body: { fontSize: 15, color: colors.text, marginTop: 6, lineHeight: 22 },
});
