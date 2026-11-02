import type { AgentStep, PendingAction } from '@procurepilot/sdk';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button, Muted } from '../../src/components/ui';
import { useSession } from '../../src/session';
import { colors, radius } from '../../src/theme';

type Message =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; text: string; steps: AgentStep[]; actions: PendingAction[]; provider: string }
  | { id: string; role: 'error'; text: string };

const SUGGESTIONS = ['Order 20 reams of A4 paper and 10 packs of gel pens with GST invoice', 'What is my remaining budget?', 'Reorder my last order', 'Place the order on Marketing'];

const STEP_ICONS: Record<string, string> = {
  search_products: '🔎',
  get_quote: '🧮',
  get_budgets: '💰',
  view_cart: '🛒',
  list_orders: '📦',
  add_to_cart: '➕',
  reorder: '🔁',
  place_order: '🧾',
};

export default function AssistantScreen() {
  const { client } = useSession();
  const params = useLocalSearchParams<{ prompt?: string }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const lastPrompt = useRef<string | undefined>(undefined);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || sending) return;
    setInput('');
    setSending(true);
    setMessages((m) => [...m, { id: `u${Date.now()}`, role: 'user', text: message }]);
    try {
      const turn = await client.askAssistant(message, conversationId);
      setConversationId(turn.conversationId);
      setMessages((m) => [...m, { id: `a${Date.now()}`, role: 'assistant', text: turn.reply, steps: turn.steps, actions: turn.actions, provider: turn.provider }]);
    } catch (e) {
      setMessages((m) => [...m, { id: `e${Date.now()}`, role: 'error', text: `Sorry, that failed: ${(e as Error).message}` }]);
    } finally {
      setSending(false);
    }
  };

  // Auto-send a prompt passed from the home screen (once per distinct prompt).
  useEffect(() => {
    if (params.prompt && params.prompt !== lastPrompt.current) {
      lastPrompt.current = params.prompt;
      void send(params.prompt);
    }
  }, [params.prompt]);

  const decide = async (action: PendingAction, confirm: boolean) => {
    setActionBusy(action.id);
    try {
      const updated = confirm ? await client.confirmAction(action.id) : await client.cancelAction(action.id);
      setMessages((all) =>
        all.map((m) => (m.role === 'assistant' ? { ...m, actions: m.actions.map((a) => (a.id === updated.id ? updated : a)) } : m)),
      );
    } catch (e) {
      setMessages((m) => [...m, { id: `e${Date.now()}`, role: 'error', text: (e as Error).message }]);
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <ScrollView
        ref={scroll}
        contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
        keyboardShouldPersistTaps="handled"
        testID="assistant-screen"
      >
        {messages.length === 0 ? (
          <View>
            <Text style={styles.intro}>Ask me to find supplies, compare bulk prices, check budgets or place orders. Nothing changes until you confirm.</Text>
            {SUGGESTIONS.map((s) => (
              <Pressable key={s} accessibilityRole="button" onPress={() => void send(s)} style={styles.suggestion}>
                <Text style={styles.suggestionText}>✨ {s}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {messages.map((m) =>
          m.role === 'user' ? (
            <View key={m.id} style={[styles.bubble, styles.user]}>
              <Text style={styles.userText}>{m.text}</Text>
            </View>
          ) : m.role === 'error' ? (
            <View key={m.id} style={[styles.bubble, styles.error]}>
              <Text style={{ color: colors.danger }}>{m.text}</Text>
            </View>
          ) : (
            <View key={m.id} style={[styles.bubble, styles.assistant]}>
              {m.steps.length > 0 ? (
                <View style={styles.steps}>
                  {m.steps.map((s, i) => (
                    <Text key={i} style={styles.step}>
                      {STEP_ICONS[s.tool] ?? '•'} {s.summary}
                      {s.status === 'error' ? ' (failed)' : ''}
                    </Text>
                  ))}
                </View>
              ) : null}
              <Text style={styles.assistantText}>{m.text}</Text>
              {m.actions.map((a) => (
                <View key={a.id} style={styles.action} testID={`action-${a.tool}`}>
                  <Text style={styles.actionText}>{a.summary}</Text>
                  {a.status === 'PENDING' ? (
                    <View style={styles.actionButtons}>
                      <Button title="Cancel" small variant="secondary" onPress={() => void decide(a, false)} style={{ flex: 1 }} />
                      <Button title="Confirm" small loading={actionBusy === a.id} onPress={() => void decide(a, true)} style={{ flex: 1 }} testID={`confirm-${a.tool}`} />
                    </View>
                  ) : a.status === 'EXECUTING' ? (
                    // The outcome is unknown (for example the connection dropped); retrying is safe.
                    <View style={styles.actionButtons}>
                      <Button title="Still working… Retry" small loading={actionBusy === a.id} onPress={() => void decide(a, true)} style={{ flex: 1 }} />
                    </View>
                  ) : (
                    <View style={styles.actionDone}>
                      <Text style={{ color: a.status === 'EXECUTED' ? colors.success : colors.muted, fontWeight: '700' }}>
                        {a.status === 'EXECUTED' ? '✓ Done' : a.status === 'CANCELLED' ? 'Cancelled' : a.status.toLowerCase()}
                      </Text>
                      {a.status === 'EXECUTED' ? (
                        <Pressable accessibilityRole="button" onPress={() => router.push(a.tool === 'place_order' ? '/orders' : '/cart')}>
                          <Text style={styles.link}>{a.tool === 'place_order' ? 'View orders' : 'View cart'}</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  )}
                </View>
              ))}
              <Muted style={{ marginTop: 6, fontSize: 11 }}>via {m.provider}</Muted>
            </View>
          ),
        )}
        {sending ? <Muted style={{ marginTop: 8 }}>Thinking…</Muted> : null}
      </ScrollView>
      <View style={styles.composer}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Ask for supplies, budgets or orders…"
          placeholderTextColor={colors.muted}
          style={styles.input}
          onSubmitEditing={() => void send(input)}
          returnKeyType="send"
          accessibilityLabel="Message the purchasing assistant"
          testID="assistant-input"
        />
        <Button title="Send" onPress={() => void send(input)} disabled={!input.trim()} loading={sending} small testID="assistant-send" />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  intro: { fontSize: 15, color: colors.text, lineHeight: 22, marginBottom: 12 },
  suggestion: { backgroundColor: colors.card, padding: 12, borderRadius: radius, marginBottom: 8, borderWidth: 1, borderColor: colors.primarySoft },
  suggestionText: { color: colors.primaryDark, fontSize: 14, fontWeight: '500' },
  bubble: { borderRadius: 14, padding: 12, marginBottom: 10, maxWidth: '92%' },
  user: { alignSelf: 'flex-end', backgroundColor: colors.primary },
  userText: { color: '#FFFFFF', fontSize: 15, lineHeight: 21 },
  assistant: { alignSelf: 'flex-start', backgroundColor: colors.card, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  assistantText: { color: colors.text, fontSize: 15, lineHeight: 21 },
  error: { alignSelf: 'flex-start', backgroundColor: colors.dangerBg },
  steps: { borderLeftWidth: 2, borderLeftColor: colors.primarySoft, paddingLeft: 8, marginBottom: 8 },
  step: { fontSize: 12, color: colors.muted, marginBottom: 2 },
  action: { marginTop: 10, padding: 10, borderRadius: 10, backgroundColor: '#F8FAFC', borderWidth: 1, borderColor: colors.border },
  actionText: { fontSize: 14, color: colors.text, fontWeight: '500', lineHeight: 20 },
  actionButtons: { flexDirection: 'row', gap: 8, marginTop: 8 },
  actionDone: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
  link: { color: colors.primaryDark, fontWeight: '700', textDecorationLine: 'underline' },
  composer: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, backgroundColor: colors.card, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  input: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: colors.text },
});
