import { ApiError, formatInr, type ApprovalStep, type Order } from '@procurepilot/sdk';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBadge } from '../../src/components/Product';
import { Button, Card, EmptyState, Field, Loading, Muted, Notice, type NoticeTone } from '../../src/components/ui';
import { useSession } from '../../src/session';
import { ROLE_LABELS, colors, formatDate } from '../../src/theme';
import { useCachedQuery } from '../../src/useCachedQuery';

const STEP_ICONS: Record<ApprovalStep['status'], { icon: string; label: string; color: string }> = {
  PENDING: { icon: '⏳', label: 'Waiting', color: colors.warning },
  APPROVED: { icon: '✓', label: 'Approved', color: colors.success },
  REJECTED: { icon: '✕', label: 'Rejected', color: colors.danger },
  SKIPPED: { icon: '–', label: 'Not needed', color: colors.muted },
};

export default function OrderScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { client, user } = useSession();
  const order = useCachedQuery(`order:${id}`, () => client.getOrder(id), { maxAgeMs: 0 });
  const [rejecting, setRejecting] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: NoticeTone; text: string } | null>(null);

  const o = order.data;
  if (!o) {
    return order.loading ? <Loading /> : <EmptyState icon="📦" title="Order unavailable" action={{ label: 'Retry', onPress: () => void order.refresh() }} />;
  }

  const myStep = o.status === 'PENDING_APPROVAL' && user && o.currentApproverRole === user.role && o.requesterId !== user.id;
  const isOwner = user?.id === o.requesterId;

  const run = async (name: string, action: () => Promise<Order | unknown>, success: string) => {
    setBusy(name);
    setMessage(null);
    try {
      const result = await action();
      if (result && typeof result === 'object' && 'status' in result && 'approvals' in result) await order.mutate(result as Order);
      setMessage({ tone: 'success', text: success });
      setRejecting(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'version_conflict') {
        setMessage({ tone: 'warning', text: 'Someone else updated this order. Showing the latest version.' });
        void order.refresh();
      } else {
        setMessage({ tone: 'danger', text: (e as Error).message });
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView style={{ backgroundColor: colors.bg }} contentContainerStyle={{ paddingBottom: 32 }} keyboardShouldPersistTaps="handled" testID="order-screen">
      <Stack.Screen options={{ title: `Order #${o.number}` }} />
      {message ? <Notice tone={message.tone} text={message.text} /> : null}
      <Card>
        <View style={styles.header}>
          <StatusBadge status={o.status} />
          <Text style={styles.total}>{formatInr(o.total)}</Text>
        </View>
        <Muted style={{ marginTop: 8 }}>
          Requested by {o.requesterName} on {formatDate(o.createdAt)} · {o.costCenterName}
          {o.poNumber ? ` · ${o.poNumber}` : ''}
        </Muted>
        {o.note ? <Text style={styles.note}>“{o.note}”</Text> : null}
      </Card>

      {o.approvals.length > 0 ? (
        <Card testID="approval-timeline">
          <Text style={styles.cardTitle}>Approvals</Text>
          {o.approvals.map((step) => {
            const s = STEP_ICONS[step.status];
            return (
              <View key={step.step} style={styles.step}>
                <Text style={[styles.stepIcon, { color: s.color }]}>{s.icon}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.stepTitle}>
                    {ROLE_LABELS[step.role]} · <Text style={{ color: s.color }}>{s.label}</Text>
                  </Text>
                  <Muted>{step.reason}</Muted>
                  {step.decidedBy ? (
                    <Muted>
                      {step.decidedBy}
                      {step.comment ? `: “${step.comment}”` : ''}
                    </Muted>
                  ) : null}
                </View>
              </View>
            );
          })}
        </Card>
      ) : null}

      {myStep ? (
        <Card>
          <Text style={styles.cardTitle}>Your decision</Text>
          {rejecting ? (
            <>
              <Field label="Reason for rejecting" value={comment} onChangeText={setComment} placeholder="For example: use the existing stock" testID="reject-reason" />
              <View style={styles.actions}>
                <Button title="Back" variant="secondary" onPress={() => setRejecting(false)} style={{ flex: 1 }} />
                <Button
                  title="Reject order"
                  variant="danger"
                  loading={busy === 'reject'}
                  disabled={comment.trim().length < 3}
                  onPress={() => void run('reject', () => client.rejectOrder(o.id, { version: o.version, comment }), `Order #${o.number} rejected.`)}
                  style={{ flex: 1 }}
                />
              </View>
            </>
          ) : (
            <View style={styles.actions}>
              <Button title="Reject" variant="danger" onPress={() => setRejecting(true)} style={{ flex: 1 }} />
              <Button
                title="Approve"
                loading={busy === 'approve'}
                onPress={() => void run('approve', () => client.approveOrder(o.id, { version: o.version }), `Order #${o.number} approved.`)}
                style={{ flex: 1 }}
                testID="approve-order"
              />
            </View>
          )}
        </Card>
      ) : null}

      <Card>
        <Text style={styles.cardTitle}>Items</Text>
        {o.lines.map((l) => (
          <View key={l.sku} style={styles.line}>
            <Text style={styles.lineTitle} numberOfLines={2}>
              {l.qty} × {l.title}
            </Text>
            <Text style={styles.lineTotal}>{formatInr(l.lineSubtotal + l.gst)}</Text>
          </View>
        ))}
        <View style={styles.line}>
          <Muted>Subtotal {formatInr(o.subtotal)} + GST {formatInr(o.gst)}</Muted>
        </View>
      </Card>

      <Card>
        <Text style={styles.cardTitle}>History</Text>
        {o.events.map((e, i) => (
          <View key={i} style={styles.event}>
            <Text style={styles.eventType}>{e.type.replace(/_/g, ' ').toLowerCase()}</Text>
            <Muted>
              {e.actor}
              {e.detail ? ` · ${e.detail}` : ''}
            </Muted>
          </View>
        ))}
        <Muted style={{ marginTop: 8 }}>Evaluated under approval policy v{o.policyVersion}</Muted>
      </Card>

      <View style={{ marginHorizontal: 16, marginTop: 16, gap: 10 }}>
        {isOwner && o.status === 'PENDING_APPROVAL' ? (
          <Button
            title="Cancel order"
            variant="danger"
            loading={busy === 'cancel'}
            onPress={() => void run('cancel', () => client.cancelOrder(o.id, o.version), `Order #${o.number} cancelled.`)}
          />
        ) : null}
        {isOwner && o.status === 'PLACED' ? (
          <Button
            title="Buy again"
            variant="secondary"
            loading={busy === 'reorder'}
            onPress={() =>
              void run(
                'reorder',
                async () => {
                  await client.reorder(o.id);
                  router.push('/cart');
                },
                'Items added to your cart.',
              )
            }
          />
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  total: { fontSize: 22, fontWeight: '800', color: colors.text },
  note: { marginTop: 8, fontSize: 14, color: colors.text, fontStyle: 'italic' },
  cardTitle: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 4 },
  step: { flexDirection: 'row', gap: 10, marginTop: 10 },
  stepIcon: { fontSize: 18, width: 22, textAlign: 'center', fontWeight: '700' },
  stepTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, marginTop: 10 },
  lineTitle: { flex: 1, fontSize: 15, color: colors.text },
  lineTotal: { fontSize: 15, fontWeight: '600', color: colors.text },
  event: { marginTop: 8 },
  eventType: { fontSize: 14, fontWeight: '600', color: colors.text, textTransform: 'capitalize' },
});
