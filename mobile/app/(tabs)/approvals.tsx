import { formatInr, type OrderSummary } from '@procurepilot/sdk';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Card, EmptyState, Loading, Muted, Notice, type NoticeTone } from '../../src/components/ui';
import { useSession } from '../../src/session';
import { ROLE_LABELS, colors, formatDate } from '../../src/theme';
import { useCachedQuery } from '../../src/useCachedQuery';

export default function ApprovalsScreen() {
  const { client } = useSession();
  const approvals = useCachedQuery('approvals', () => client.listApprovals(), { maxAgeMs: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: NoticeTone; text: string } | null>(null);
  const firstFocus = useRef(true);

  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void approvals.refresh();
    }, [approvals.refresh]),
  );

  const approve = async (order: OrderSummary) => {
    setBusy(order.id);
    setMessage(null);
    try {
      const updated = await client.approveOrder(order.id, { version: order.version });
      setMessage({
        tone: 'success',
        text: updated.status === 'PLACED' ? `Order #${order.number} approved and placed.` : `Order #${order.number} approved; now with ${ROLE_LABELS[updated.currentApproverRole!]}.`,
      });
    } catch (e) {
      setMessage({ tone: 'danger', text: (e as Error).message });
    } finally {
      setBusy(null);
      void approvals.refresh();
    }
  };

  const items = approvals.data?.items ?? [];

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingBottom: 24 }}
      refreshControl={<RefreshControl refreshing={approvals.loading && approvals.data !== undefined} onRefresh={() => void approvals.refresh()} />}
      testID="approvals-screen"
    >
      {message ? <Notice tone={message.tone} text={message.text} /> : null}
      {!approvals.data && approvals.loading ? <Loading /> : null}
      {approvals.data && items.length === 0 ? <EmptyState icon="🎉" title="You're all caught up" body="Orders that need your approval will appear here." /> : null}
      {items.map((o) => (
        <Card key={o.id} testID={`approval-${o.number}`}>
          <View style={styles.header}>
            <Text style={styles.title}>Order #{o.number}</Text>
            <Text style={styles.total}>{formatInr(o.total)}</Text>
          </View>
          <Muted>
            {o.requesterName} · {o.costCenterName} · {o.itemCount} item{o.itemCount === 1 ? '' : 's'} · {formatDate(o.createdAt)}
          </Muted>
          <Text style={styles.step}>Your step: {ROLE_LABELS[o.currentApproverRole ?? 'MANAGER']} approval</Text>
          <View style={styles.actions}>
            <Button title="Review" variant="secondary" small onPress={() => router.push(`/order/${encodeURIComponent(o.id)}`)} style={{ flex: 1 }} />
            <Button title="Approve" small onPress={() => void approve(o)} loading={busy === o.id} style={{ flex: 1 }} testID={`approve-${o.number}`} />
          </View>
        </Card>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  title: { fontSize: 17, fontWeight: '700', color: colors.text },
  total: { fontSize: 17, fontWeight: '800', color: colors.text },
  step: { marginTop: 8, color: colors.warning, fontWeight: '600', fontSize: 14 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
});
