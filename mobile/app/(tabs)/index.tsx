import type { SduiAction } from '@procurepilot/sdk';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { EmptyState, Loading, Notice } from '../../src/components/ui';
import { useOutbox, useOutboxDelivered } from '../../src/outbox';
import { SduiRenderer } from '../../src/sdui/registry';
import { useSession } from '../../src/session';
import { colors, formatTime } from '../../src/theme';
import { useCachedQuery } from '../../src/useCachedQuery';

export default function HomeScreen() {
  const { client } = useSession();
  const { entries, flush } = useOutbox();
  const home = useCachedQuery('home', () => client.home(), { maxAgeMs: 60_000 });
  const firstFocus = useRef(true);
  useOutboxDelivered(() => void home.refresh());

  useFocusEffect(
    useCallback(() => {
      if (firstFocus.current) {
        firstFocus.current = false;
        return;
      }
      void home.refresh();
    }, [home.refresh]),
  );

  const onAction = (action: SduiAction) => {
    if (action.type === 'navigate') router.push(action.href as never);
    else router.push({ pathname: '/assistant', params: { prompt: action.text } });
  };

  const pending = entries.filter((e) => e.status !== 'failed').length;
  const data = home.data;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.navy }} edges={['top']}>
      <ScrollView
        style={{ backgroundColor: colors.bg }}
        contentContainerStyle={{ paddingBottom: 24 }}
        refreshControl={<RefreshControl refreshing={home.loading && data !== undefined} onRefresh={() => void home.refresh()} />}
        testID="home-screen"
      >
        {pending > 0 ? (
          <Notice
            tone="info"
            text={`${pending} order${pending === 1 ? ' is' : 's are'} saved on this device and will be sent automatically.`}
            action={{ label: 'Retry now', onPress: () => void flush() }}
          />
        ) : null}
        {data && home.error ? <Notice tone="warning" text={`You're offline. Showing what was saved at ${formatTime(home.storedAt)}.`} /> : null}
        {!data && home.loading ? <Loading /> : null}
        {!data && !home.loading && home.error ? (
          <EmptyState
            icon="📡"
            title="Can't reach ProcurePilot"
            body="Check your connection. Your cart and any queued orders are safe on this device."
            action={{ label: 'Try again', onPress: () => void home.refresh() }}
          />
        ) : null}
        {data ? <SduiRenderer sections={data.sections} onAction={onAction} /> : null}
        {data && data.degraded.length > 0 ? (
          <View style={{ padding: 16 }}>
            <Text style={{ color: colors.muted, fontSize: 12 }}>Some sections are temporarily unavailable.</Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
