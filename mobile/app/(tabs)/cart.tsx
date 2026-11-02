import { formatInr, type Cart, type OrderPreview } from '@procurepilot/sdk';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Card, Chip, EmptyState, Field, Loading, Muted, Notice, Stepper, type NoticeTone } from '../../src/components/ui';
import { useOutbox } from '../../src/outbox';
import { useSession } from '../../src/session';
import { ROLE_LABELS, categoryIcon, colors } from '../../src/theme';
import { useCachedQuery } from '../../src/useCachedQuery';

const EMPTY_CART: Cart = { lines: [], subtotal: 0, gst: 0, total: 0, savings: 0, unknownSkus: [], itemCount: 0 };

export default function CartScreen() {
  const { client, user } = useSession();
  const { submitCheckout, entries, flush } = useOutbox();
  const cart = useCachedQuery('cart', () => client.getCart(), { maxAgeMs: 0 });
  const me = useCachedQuery('me', () => client.me(), { maxAgeMs: 60_000 });
  const [costCenterId, setCostCenterId] = useState<string | null>(null);
  const [poNumber, setPoNumber] = useState('');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState<OrderPreview | null>(null);
  const [busySku, setBusySku] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [message, setMessage] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const firstFocus = useRef(true);

  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void cart.refresh();
    }, [cart.refresh]),
  );

  const budgets = (me.data?.budgets ?? []).filter((b) => user?.costCenterIds.includes(b.costCenterId));
  useEffect(() => {
    if (!costCenterId && budgets.length > 0) setCostCenterId(budgets[0]!.costCenterId);
  }, [budgets, costCenterId]);

  const lines = cart.data?.lines ?? [];
  const cartSignature = lines.map((l) => `${l.sku}:${l.qty}`).join(',');
  // Shows who must approve before the buyer submits, using the same policy engine as checkout.
  useEffect(() => {
    if (!costCenterId || cartSignature === '') {
      setPreview(null);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      client
        .previewOrder(costCenterId)
        .then((p) => active && setPreview(p))
        .catch(() => active && setPreview(null));
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, costCenterId, cartSignature]);

  const changeQty = async (sku: string, qty: number) => {
    setBusySku(sku);
    setMessage(null);
    try {
      await cart.mutate(await client.setCartItem(sku, qty));
    } catch (e) {
      setMessage({ tone: 'danger', text: (e as Error).message });
    } finally {
      setBusySku(null);
    }
  };

  const placeOrder = async () => {
    if (!costCenterId || !cart.data) return;
    setPlacing(true);
    setMessage(null);
    const result = await submitCheckout({
      costCenterId,
      poNumber: poNumber.trim() || undefined,
      note: note.trim() || undefined,
      expectedItems: cart.data.lines.map((l) => ({ sku: l.sku, qty: l.qty })),
      expectedTotal: cart.data.total,
    });
    setPlacing(false);
    if (result.status === 'sent') {
      await cart.mutate(EMPTY_CART);
      setPoNumber('');
      setNote('');
      router.push(`/order/${encodeURIComponent(result.order.id)}`);
    } else if (result.status === 'queued') {
      setMessage({ tone: 'info', text: 'No connection right now. Your order is saved on this device and will be sent automatically; it can never be placed twice.' });
    } else {
      setMessage({ tone: 'danger', text: result.message });
      if (result.code && ['cart_changed', 'items_unavailable', 'price_changed', 'policy_changed'].includes(result.code)) void cart.refresh();
    }
  };

  const queued = entries.filter((e) => e.status !== 'failed').length;

  if (!cart.data && cart.loading) return <Loading />;

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 32 }} keyboardShouldPersistTaps="handled" testID="cart-screen">
      {queued > 0 ? <Notice tone="info" text={`${queued} order${queued === 1 ? '' : 's'} waiting to be sent.`} action={{ label: 'Retry now', onPress: () => void flush() }} /> : null}
      {cart.error && cart.data ? <Notice tone="warning" text="You're offline. Showing your last saved cart." /> : null}
      {message ? <Notice tone={message.tone} text={message.text} testID="cart-message" /> : null}
      {lines.length === 0 ? (
        <EmptyState icon="🛒" title="Your cart is empty" body="Find supplies with business pricing, or ask the assistant to build your order." action={{ label: 'Browse supplies', onPress: () => router.push('/shop') }} />
      ) : (
        <>
          <Card>
            {lines.map((line, i) => (
              <View key={line.sku} style={[styles.line, i > 0 && styles.lineBorder]}>
                <Text style={styles.lineIcon}>{categoryIcon(line.category)}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.lineTitle} numberOfLines={2}>
                    {line.title}
                  </Text>
                  <Muted>
                    {formatInr(line.unitPrice)} /{line.unit}
                    {line.discountBps > 0 ? `  ·  ${line.discountBps / 100}% volume discount` : ''}
                  </Muted>
                  {!line.available ? <Text style={styles.warn}>Only {line.stock} in stock</Text> : null}
                  <View style={styles.lineBottom}>
                    <Stepper value={line.qty} onChange={(q) => void changeQty(line.sku, q)} busy={busySku === line.sku} testID={`qty-${line.sku}`} />
                    <Text style={styles.lineTotal}>{formatInr(line.lineTotal)}</Text>
                  </View>
                </View>
              </View>
            ))}
          </Card>

          <Card testID="cart-summary">
            <Row label="Subtotal" value={formatInr(cart.data!.subtotal)} />
            <Row label="GST" value={formatInr(cart.data!.gst)} />
            <Row label="Total" value={formatInr(cart.data!.total)} strong />
            {cart.data!.savings > 0 ? <Text style={styles.savings}>You save {formatInr(cart.data!.savings)} with volume pricing</Text> : null}
          </Card>

          <Card>
            <Text style={styles.cardTitle}>Charge to cost center</Text>
            <View style={styles.chips}>
              {budgets.map((b) => (
                <Chip key={b.costCenterId} label={`${b.name} · ${formatInr(b.available)} left`} selected={costCenterId === b.costCenterId} onPress={() => setCostCenterId(b.costCenterId)} />
              ))}
            </View>
            <Field label="PO number (optional)" value={poNumber} onChangeText={setPoNumber} placeholder="PO-2026-0450" autoCapitalize="characters" testID="po-number" />
            <Field label="Note for approvers (optional)" value={note} onChangeText={setNote} placeholder="Why is this needed?" multiline />
          </Card>

          {preview ? (
            preview.requiredApprovals.length === 0 ? (
              <Notice tone="success" text="Within your company's policy: this order will be placed immediately." testID="approval-preview" />
            ) : (
              <Card testID="approval-preview">
                <Text style={styles.cardTitle}>Approval needed</Text>
                {preview.requiredApprovals.map((a, i) => (
                  <View key={a.role} style={styles.step}>
                    <Text style={styles.stepNumber}>{i + 1}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.stepRole}>{ROLE_LABELS[a.role]}</Text>
                      <Muted>{a.reason}</Muted>
                    </View>
                  </View>
                ))}
                <Muted style={{ marginTop: 8 }}>The amount is held against the budget until approvers decide.</Muted>
              </Card>
            )
          ) : null}

          <View style={{ marginHorizontal: 16, marginTop: 16 }}>
            <Button
              title={preview && preview.requiredApprovals.length > 0 ? 'Submit for approval' : 'Place order'}
              onPress={() => void placeOrder()}
              loading={placing}
              disabled={!costCenterId || lines.some((l) => !l.available)}
              testID="place-order"
            />
          </View>
        </>
      )}
    </ScrollView>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, strong && styles.strong]}>{label}</Text>
      <Text style={[styles.rowValue, strong && styles.strong]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', gap: 12, paddingVertical: 10 },
  lineBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  lineIcon: { fontSize: 28, marginTop: 2 },
  lineTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  lineBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  lineTotal: { fontSize: 16, fontWeight: '700', color: colors.text },
  warn: { color: colors.danger, fontSize: 13, marginTop: 2 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 },
  rowLabel: { fontSize: 15, color: colors.muted },
  rowValue: { fontSize: 15, color: colors.text },
  strong: { fontSize: 18, fontWeight: '800', color: colors.text },
  savings: { marginTop: 6, color: colors.success, fontWeight: '600', fontSize: 14 },
  cardTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 10 },
  step: { flexDirection: 'row', gap: 10, marginTop: 10 },
  stepNumber: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.warningBg,
    color: colors.warning,
    textAlign: 'center',
    lineHeight: 24,
    fontWeight: '700',
    overflow: 'hidden',
  },
  stepRole: { fontSize: 15, fontWeight: '600', color: colors.text },
});
