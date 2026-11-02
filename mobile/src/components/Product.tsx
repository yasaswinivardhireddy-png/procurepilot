import { formatInr, formatPercentBps, type OrderSummary, type ProductSummary } from '@procurepilot/sdk';
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ROLE_LABELS, STATUS_STYLES, categoryIcon, colors, formatDate, radius } from '../theme';
import { Badge, Button } from './ui';

export function ProductCard({ product, suggestedQty }: { product: ProductSummary; suggestedQty?: number }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${product.title}, ${formatInr(product.unitPrice)} per ${product.unit}`}
      onPress={() => router.push(`/product/${encodeURIComponent(product.sku)}`)}
      style={styles.card}
      testID={`product-card-${product.sku}`}
    >
      <View style={styles.thumb}>
        <Text style={styles.thumbIcon}>{categoryIcon(product.category)}</Text>
      </View>
      <Text style={styles.cardTitle} numberOfLines={2}>
        {product.title}
      </Text>
      <Text style={styles.cardPrice}>
        {formatInr(product.unitPrice)}
        <Text style={styles.unit}> /{product.unit}</Text>
      </Text>
      {suggestedQty ? <Text style={styles.hint}>Last time: {suggestedQty}</Text> : null}
      {!suggestedQty && product.bestTierDiscountBps > 0 ? <Text style={styles.save}>Save up to {formatPercentBps(product.bestTierDiscountBps)}</Text> : null}
    </Pressable>
  );
}

export function ProductRow({ product, onAdd, adding }: { product: ProductSummary; onAdd: () => void; adding?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/product/${encodeURIComponent(product.sku)}`)}
      style={styles.row}
      testID={`product-row-${product.sku}`}
    >
      <View style={styles.rowThumb}>
        <Text style={styles.rowIcon}>{categoryIcon(product.category)}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {product.title}
        </Text>
        <Text style={styles.meta}>
          {product.brand} · ★ {product.rating.toFixed(1)} · Delivery in {product.deliveryDays} day{product.deliveryDays === 1 ? '' : 's'}
        </Text>
        <View style={styles.rowBottom}>
          <Text style={styles.rowPrice}>
            {formatInr(product.unitPrice)}
            <Text style={styles.unit}> /{product.unit}</Text>
          </Text>
          {product.gstInvoice ? <Badge label="GST invoice" fg={colors.success} bg={colors.successBg} icon="🧾" /> : null}
        </View>
        {product.bestTierDiscountBps > 0 ? <Text style={styles.save}>Bulk pricing: save up to {formatPercentBps(product.bestTierDiscountBps)}</Text> : null}
      </View>
      <Button title="Add" small variant="secondary" onPress={onAdd} loading={adding} accessibilityLabel={`Add ${product.title} to cart`} testID={`add-${product.sku}`} />
    </Pressable>
  );
}

export function StatusBadge({ status }: { status: OrderSummary['status'] }) {
  const s = STATUS_STYLES[status];
  return <Badge label={s.label} icon={s.icon} fg={s.fg} bg={s.bg} />;
}

export function OrderRow({ order, showRequester }: { order: OrderSummary; showRequester?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.push(`/order/${encodeURIComponent(order.id)}`)}
      style={styles.orderRow}
      testID={`order-row-${order.number}`}
    >
      <View style={{ flex: 1 }}>
        <Text style={styles.orderTitle}>Order #{order.number}</Text>
        <Text style={styles.meta}>
          {formatDate(order.createdAt)} · {order.itemCount} item{order.itemCount === 1 ? '' : 's'} · {order.costCenterName}
          {showRequester ? ` · ${order.requesterName}` : ''}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <StatusBadge status={order.status} />
          {order.currentApproverRole ? <Text style={styles.meta}>Waiting for {ROLE_LABELS[order.currentApproverRole]}</Text> : null}
        </View>
      </View>
      <Text style={styles.orderTotal}>{formatInr(order.total)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 150,
    marginRight: 12,
    backgroundColor: colors.card,
    borderRadius: radius,
    padding: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  thumb: { height: 72, borderRadius: 10, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  thumbIcon: { fontSize: 34 },
  cardTitle: { fontSize: 13, fontWeight: '600', color: colors.text, minHeight: 34 },
  cardPrice: { fontSize: 15, fontWeight: '700', color: colors.text, marginTop: 6 },
  unit: { fontSize: 12, fontWeight: '400', color: colors.muted },
  hint: { fontSize: 12, color: colors.muted, marginTop: 2 },
  save: { fontSize: 12, color: colors.success, marginTop: 4, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.card,
    marginHorizontal: 16,
    marginTop: 10,
    padding: 12,
    borderRadius: radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  rowThumb: { width: 56, height: 56, borderRadius: 10, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  rowIcon: { fontSize: 28 },
  rowTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  meta: { fontSize: 12, color: colors.muted, marginTop: 3 },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' },
  rowPrice: { fontSize: 16, fontWeight: '700', color: colors.text },
  orderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.card,
    marginHorizontal: 16,
    marginTop: 10,
    padding: 14,
    borderRadius: radius,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  orderTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  orderTotal: { fontSize: 16, fontWeight: '700', color: colors.text, marginLeft: 8 },
});
