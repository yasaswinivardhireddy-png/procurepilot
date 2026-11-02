import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { OrderRow } from '../../src/components/Product';
import { Chip, EmptyState, Loading, Notice } from '../../src/components/ui';
import { useOutbox, useOutboxDelivered } from '../../src/outbox';
import { useSession } from '../../src/session';
import { colors, isApprover } from '../../src/theme';
import { useCachedQuery } from '../../src/useCachedQuery';

export default function OrdersScreen() {
  const { client, user } = useSession();
  const { entries } = useOutbox();
  const [scope, setScope] = useState<'mine' | 'team'>('mine');
  const orders = useCachedQuery(`orders:${scope}`, () => client.listOrders({ scope, limit: 30 }), { maxAgeMs: 15_000 });
  const firstFocus = useRef(true);
  useOutboxDelivered(() => void orders.refresh());

  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void orders.refresh();
    }, [orders.refresh]),
  );

  const queued = entries.filter((e) => e.status !== 'failed');

  return (
    <ScrollView
      style={{ backgroundColor: colors.bg }}
      contentContainerStyle={{ paddingBottom: 24 }}
      refreshControl={<RefreshControl refreshing={orders.loading && orders.data !== undefined} onRefresh={() => void orders.refresh()} />}
      testID="orders-screen"
    >
      {user && isApprover(user.role) ? (
        <View style={{ flexDirection: 'row', paddingHorizontal: 16, paddingTop: 12 }}>
          <Chip label="My orders" selected={scope === 'mine'} onPress={() => setScope('mine')} />
          <Chip label="Team orders" selected={scope === 'team'} onPress={() => setScope('team')} />
        </View>
      ) : null}
      {queued.map((e) => (
        <Notice key={e.id} tone="info" text={`Order saved on this device, waiting to be sent${e.attempts > 0 ? ` (attempt ${e.attempts})` : ''}.`} />
      ))}
      {orders.error && orders.data ? <Notice tone="warning" text="You're offline. Showing saved orders." /> : null}
      {!orders.data && orders.loading ? <Loading /> : null}
      {orders.data?.items.map((o) => (
        <OrderRow key={o.id} order={o} showRequester={scope === 'team'} />
      ))}
      {orders.data && orders.data.items.length === 0 ? <EmptyState icon="📦" title="No orders yet" body="Orders you place or submit for approval appear here." /> : null}
    </ScrollView>
  );
}
