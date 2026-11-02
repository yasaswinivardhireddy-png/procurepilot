import Constants from 'expo-constants';
import { Platform } from 'react-native';

// Where the gateway runs. Override with EXPO_PUBLIC_API_URL or on the sign-in screen.
export function defaultBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_API_URL;
  if (configured) return configured.replace(/\/+$/, '');
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    // The gateway serves the web build itself; the Expo dev server runs on 8081.
    const { protocol, hostname, port, origin } = window.location;
    return port === '8081' ? `${protocol}//${hostname}:8080` : origin;
  }
  // On a phone or emulator, reach the gateway on the machine that serves the JavaScript bundle.
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  if (host) return `http://${host}:8080`;
  return Platform.OS === 'android' ? 'http://10.0.2.2:8080' : 'http://localhost:8080';
}
