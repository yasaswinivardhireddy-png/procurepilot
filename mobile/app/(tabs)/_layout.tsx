import { Redirect } from 'expo-router';
import { Tabs } from 'expo-router/js-tabs';
import { Pressable, Text } from 'react-native';
import { Loading } from '../../src/components/ui';
import { useOutbox } from '../../src/outbox';
import { useSession } from '../../src/session';
import { colors, isApprover } from '../../src/theme';

const icon =
  (glyph: string) =>
  ({ focused }: { focused: boolean }) => <Text style={{ fontSize: 20, opacity: focused ? 1 : 0.55 }}>{glyph}</Text>;

export default function TabsLayout() {
  const { ready, user, signOut } = useSession();
  const { entries } = useOutbox();
  if (!ready) return <Loading />;
  if (!user) return <Redirect href="/login" />;
  const pending = entries.filter((e) => e.status !== 'failed').length;

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.navy },
        headerTintColor: '#FFFFFF',
        tabBarActiveTintColor: colors.primary,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        headerRight: () => (
          <Pressable accessibilityRole="button" accessibilityLabel="Sign out" onPress={() => void signOut()} style={{ paddingHorizontal: 16 }} testID="sign-out">
            <Text style={{ color: '#CBD5E1', fontSize: 14 }}>{user.name.split(' ')[0]} · Sign out</Text>
          </Pressable>
        ),
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home', headerShown: false, tabBarIcon: icon('🏠') }} />
      <Tabs.Screen name="shop" options={{ title: 'Shop', tabBarIcon: icon('🔎') }} />
      <Tabs.Screen name="cart" options={{ title: 'Cart', tabBarIcon: icon('🛒'), tabBarBadge: pending > 0 ? pending : undefined }} />
      <Tabs.Screen name="orders" options={{ title: 'Orders', tabBarIcon: icon('📦') }} />
      <Tabs.Screen name="approvals" options={{ title: 'Approvals', tabBarIcon: icon('✅'), href: isApprover(user.role) ? undefined : null }} />
      <Tabs.Screen name="assistant" options={{ title: 'Assistant', tabBarIcon: icon('✨') }} />
    </Tabs>
  );
}
