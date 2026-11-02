import AsyncStorage from '@react-native-async-storage/async-storage';
import type { KeyValueStorage } from '@procurepilot/sdk';

// AsyncStorage on iOS and Android, localStorage on the web.
export const deviceStorage: KeyValueStorage = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
};
