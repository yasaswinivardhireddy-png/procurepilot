import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { OutboxProvider } from '../src/outbox';
import { SessionProvider } from '../src/session';
import { colors } from '../src/theme';

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <OutboxProvider>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.navy },
              headerTintColor: '#FFFFFF',
              headerTitleStyle: { fontWeight: '600' },
              contentStyle: { backgroundColor: colors.bg },
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="login" options={{ headerShown: false }} />
            <Stack.Screen name="product/[sku]" options={{ title: 'Product' }} />
            <Stack.Screen name="order/[id]" options={{ title: 'Order' }} />
          </Stack>
        </OutboxProvider>
      </SessionProvider>
    </SafeAreaProvider>
  );
}
