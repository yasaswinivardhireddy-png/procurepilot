import type { DemoUser } from '@procurepilot/sdk';
import { Redirect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Button, Field, Loading, Muted, Notice } from '../src/components/ui';
import { useSession } from '../src/session';
import { ROLE_LABELS, colors, radius } from '../src/theme';

export default function LoginScreen() {
  const { ready, user, client, baseUrl, signIn, setBaseUrl } = useSession();
  const [users, setUsers] = useState<DemoUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const [editingServer, setEditingServer] = useState(false);
  const [server, setServer] = useState(baseUrl);

  const load = useCallback(() => {
    setError(null);
    client
      .listDemoUsers()
      .then((r) => setUsers(r.items))
      .catch(() => setError(`Cannot reach the server at ${baseUrl}. Start it with "npm start" in the project folder.`));
  }, [client, baseUrl]);

  useEffect(load, [load]);

  if (!ready) return <Loading />;
  if (user) return <Redirect href="/" />;

  const choose = async (id: string) => {
    setSigningIn(id);
    try {
      await signIn(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSigningIn(null);
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
        <View style={styles.hero}>
          <Text style={styles.logo}>🛒 ProcurePilot</Text>
          <Text style={styles.tagline}>Business purchasing for Acme Corp: bulk pricing, GST invoices, approvals and an AI purchasing assistant.</Text>
        </View>
        <Text style={styles.heading}>Sign in as a demo user</Text>
        {error ? <Notice tone="danger" text={error} action={{ label: 'Retry', onPress: load }} /> : null}
        {!users && !error ? <Loading /> : null}
        {users?.map((u) => (
          <Pressable
            key={u.id}
            accessibilityRole="button"
            accessibilityLabel={`Sign in as ${u.name}, ${ROLE_LABELS[u.role]}`}
            onPress={() => void choose(u.id)}
            style={styles.user}
            testID={`login-${u.id}`}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{u.name.split(' ').map((p) => p[0]).join('')}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.userName}>{u.name}</Text>
              <Muted>{u.title}</Muted>
            </View>
            <Text style={styles.role}>{signingIn === u.id ? 'Signing in…' : ROLE_LABELS[u.role]}</Text>
          </Pressable>
        ))}
        <View style={{ marginHorizontal: 16, marginTop: 24 }}>
          {editingServer ? (
            <>
              <Field label="Gateway URL" value={server} onChangeText={setServer} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
              <Button
                title="Save"
                style={{ marginTop: 12 }}
                onPress={() => {
                  setEditingServer(false);
                  void setBaseUrl(server);
                }}
              />
            </>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => setEditingServer(true)}>
              <Muted>Server: {baseUrl} (tap to change)</Muted>
            </Pressable>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  hero: { backgroundColor: colors.navy, padding: 24, paddingTop: 36 },
  logo: { color: '#FFFFFF', fontSize: 30, fontWeight: '800' },
  tagline: { color: '#CBD5E1', fontSize: 15, marginTop: 8, lineHeight: 21 },
  heading: { fontSize: 16, fontWeight: '700', color: colors.text, marginHorizontal: 16, marginTop: 20, marginBottom: 4 },
  user: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.card,
    marginHorizontal: 16,
    marginTop: 10,
    padding: 14,
    borderRadius: radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  avatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: colors.primaryDark, fontWeight: '700' },
  userName: { fontSize: 16, fontWeight: '600', color: colors.text },
  role: { fontSize: 13, fontWeight: '600', color: colors.primaryDark },
});
