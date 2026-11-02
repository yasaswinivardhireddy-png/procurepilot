import type { ProductSort, ProductSummary } from '@procurepilot/sdk';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { ProductRow } from '../../src/components/Product';
import { Chip, EmptyState, Loading, Muted, Notice } from '../../src/components/ui';
import { useSession } from '../../src/session';
import { colors } from '../../src/theme';
import { useCachedQuery } from '../../src/useCachedQuery';

const SORTS: { value: ProductSort; label: string }[] = [
  { value: 'relevance', label: 'Best match' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'delivery', label: 'Fastest delivery' },
];

export default function ShopScreen() {
  const { client } = useSession();
  const params = useLocalSearchParams<{ category?: string; q?: string }>();
  const [query, setQuery] = useState(params.q ?? '');
  const [debounced, setDebounced] = useState(query.trim());
  const [category, setCategory] = useState<string | undefined>(params.category);
  const [gstOnly, setGstOnly] = useState(false);
  const [sort, setSort] = useState<ProductSort>('relevance');
  const [more, setMore] = useState<{ items: ProductSummary[]; cursor: string | null; loading: boolean }>({ items: [], cursor: null, loading: false });
  const [adding, setAdding] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => setCategory(params.category), [params.category]);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const categories = useCachedQuery('categories', () => client.listCategories(), { maxAgeMs: 3_600_000 });
  const key = `search:${debounced}|${category ?? ''}|${gstOnly}|${sort}`;
  const results = useCachedQuery(key, () => client.searchProducts({ q: debounced || undefined, category, gstInvoice: gstOnly || undefined, sort, limit: 20 }), {
    persist: false,
  });

  useEffect(() => setMore({ items: [], cursor: null, loading: false }), [key]);
  const cursor = more.cursor ?? results.data?.nextCursor ?? null;
  const items = [...(results.data?.items ?? []), ...more.items];

  const loadMore = async () => {
    if (!cursor || more.loading) return;
    setMore((m) => ({ ...m, loading: true }));
    try {
      const page = await client.searchProducts({ q: debounced || undefined, category, gstInvoice: gstOnly || undefined, sort, limit: 20, cursor });
      setMore((m) => ({ items: [...m.items, ...page.items], cursor: page.nextCursor, loading: false }));
    } catch {
      setMore((m) => ({ ...m, loading: false }));
    }
  };

  const add = async (product: ProductSummary) => {
    setAdding(product.sku);
    try {
      await client.addToCart(product.sku, 1);
      setToast(`Added 1 × ${product.title}`);
    } catch (e) {
      setToast(`Could not add: ${(e as Error).message}`);
    } finally {
      setAdding(null);
      setTimeout(() => setToast(null), 2500);
    }
  };

  const header = (
    <View>
      <View style={styles.searchBox}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search paper, laptops, cleaning supplies…"
          placeholderTextColor={colors.muted}
          style={styles.search}
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel="Search products"
          testID="search-input"
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        <Chip label="GST invoice" selected={gstOnly} onPress={() => setGstOnly((v) => !v)} testID="filter-gst" />
        {SORTS.map((s) => (
          <Chip key={s.value} label={s.label} selected={sort === s.value} onPress={() => setSort(s.value)} />
        ))}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chips, { paddingTop: 0 }]}>
        <Chip label="All categories" selected={!category} onPress={() => setCategory(undefined)} />
        {categories.data?.items.map((c) => (
          <Chip key={c.name} label={c.name} selected={category === c.name} onPress={() => setCategory(c.name)} />
        ))}
      </ScrollView>
      {results.data ? (
        <Muted style={{ marginHorizontal: 16 }}>
          {results.data.total} result{results.data.total === 1 ? '' : 's'}
        </Muted>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <FlatList
        data={items}
        keyExtractor={(p) => p.sku}
        renderItem={({ item }) => <ProductRow product={item} onAdd={() => void add(item)} adding={adding === item.sku} />}
        ListHeaderComponent={header}
        ListEmptyComponent={
          results.loading ? (
            <Loading />
          ) : results.error ? (
            <EmptyState icon="📡" title="Search is unavailable" body="Check your connection and try again." action={{ label: 'Retry', onPress: () => void results.refresh() }} />
          ) : (
            <EmptyState icon="🔍" title="No products found" body="Try a different word or remove a filter." />
          )
        }
        ListFooterComponent={more.loading ? <Loading /> : <View style={{ height: 24 }} />}
        onEndReached={() => void loadMore()}
        onEndReachedThreshold={0.4}
        keyboardShouldPersistTaps="handled"
        testID="search-results"
      />
      {toast ? (
        <View style={styles.toast} pointerEvents="none">
          <Notice tone="success" text={toast} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  searchBox: { paddingHorizontal: 16, paddingTop: 12 },
  search: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.text,
  },
  chips: { paddingHorizontal: 16, paddingTop: 12 },
  toast: { position: 'absolute', left: 0, right: 0, bottom: 12 },
});
