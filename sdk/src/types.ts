// API contract shared by the server, the SDK and the mobile app.
// Money is always an integer number of paise (₹1 = 100 paise).

export type Role = 'REQUESTER' | 'MANAGER' | 'IT_ADMIN' | 'FINANCE';

export type User = {
  id: string;
  name: string;
  title: string;
  role: Role;
  costCenterIds: string[];
};

export type DemoUser = Pick<User, 'id' | 'name' | 'title' | 'role'>;

export type Session = { token: string; user: User };

export type PriceTier = { minQty: number; discountBps: number; unitPrice: number };

export type ProductSummary = {
  sku: string;
  title: string;
  brand: string;
  category: string;
  unit: string;
  unitPrice: number;
  gstRateBps: number;
  gstInvoice: boolean;
  deliveryDays: number;
  rating: number;
  inStock: boolean;
  bestTierDiscountBps: number;
};

export type Product = ProductSummary & {
  description: string;
  seller: string;
  stock: number;
  tiers: PriceTier[];
};

export type ProductSort = 'relevance' | 'price_asc' | 'price_desc' | 'delivery' | 'rating';

export type SearchParams = {
  q?: string;
  category?: string;
  gstInvoice?: boolean;
  maxUnitPrice?: number;
  sort?: ProductSort;
  limit?: number;
  cursor?: string;
  skus?: string[];
};

export type SearchResult = { items: ProductSummary[]; total: number; nextCursor: string | null };

export type Category = { name: string; count: number };

export type CartItemInput = { sku: string; qty: number };

export type QuoteLine = {
  sku: string;
  title: string;
  category: string;
  unit: string;
  qty: number;
  listUnitPrice: number;
  unitPrice: number;
  discountBps: number;
  lineSubtotal: number;
  gstRateBps: number;
  gst: number;
  lineTotal: number;
  stock: number;
  available: boolean;
};

export type Quote = {
  lines: QuoteLine[];
  subtotal: number;
  gst: number;
  total: number;
  savings: number;
  unknownSkus: string[];
};

export type Cart = Quote & { itemCount: number };

export type OrderStatus = 'PENDING_APPROVAL' | 'PLACED' | 'REJECTED' | 'CANCELLED';

export type ApprovalStepStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SKIPPED';

export type ApprovalStep = {
  step: number;
  role: Role;
  ruleId: string;
  reason: string;
  status: ApprovalStepStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  comment: string | null;
};

export type RequiredApproval = { role: Role; ruleId: string; reason: string };

export type OrderEvent = { type: string; actor: string; detail: string | null; at: string };

export type OrderLine = {
  sku: string;
  title: string;
  category: string;
  qty: number;
  unitPrice: number;
  lineSubtotal: number;
  gst: number;
};

export type OrderSummary = {
  id: string;
  number: number;
  status: OrderStatus;
  requesterId: string;
  requesterName: string;
  costCenterId: string;
  costCenterName: string;
  total: number;
  itemCount: number;
  currentApproverRole: Role | null;
  version: number;
  createdAt: string;
};

export type Order = OrderSummary & {
  poNumber: string | null;
  note: string | null;
  subtotal: number;
  gst: number;
  policyVersion: number;
  lines: OrderLine[];
  approvals: ApprovalStep[];
  events: OrderEvent[];
};

export type OrderListParams = { status?: OrderStatus; scope?: 'mine' | 'team'; limit?: number; offset?: number };

export type Budget = {
  costCenterId: string;
  name: string;
  budget: number;
  committed: number;
  reserved: number;
  available: number;
};

export type Me = User & { budgets: Budget[] };

export type CheckoutRequest = {
  costCenterId: string;
  poNumber?: string;
  note?: string;
  // The cart the buyer reviewed. If the server-side cart differs, checkout fails with cart_changed.
  expectedItems?: CartItemInput[];
  // The total (paise, incl. GST) the buyer saw. If prices moved, checkout fails with price_changed.
  expectedTotal?: number;
  // The approval-policy version the buyer saw. If it changed, checkout fails with policy_changed.
  expectedPolicyVersion?: number;
};

export type OrderPreview = {
  quote: Quote;
  costCenterId: string;
  available: number;
  requiredApprovals: RequiredApproval[];
  policyVersion: number;
};

export type ApprovalDecision = { version: number; comment?: string };

export type Paged<T> = { items: T[]; total: number };

export type BuyAgainItem = { sku: string; timesOrdered: number; lastQty: number };

// Server-driven UI: the gateway decides which sections the home screen shows and in what order.
export type SduiAction = { type: 'navigate'; href: string } | { type: 'prompt'; text: string };

export type SduiSection = {
  id: string;
  type: string;
  version: number;
  props: Record<string, unknown>;
};

export type HomeScreen = {
  schemaVersion: number;
  ttlSeconds: number;
  generatedAt: string;
  sections: SduiSection[];
  degraded: string[];
  skipped: string[];
};

export type AgentStepStatus = 'ok' | 'error' | 'awaiting_confirmation';

export type AgentStep = {
  tool: string;
  args: Record<string, unknown>;
  status: AgentStepStatus;
  summary: string;
};

export type PendingActionStatus = 'PENDING' | 'EXECUTING' | 'EXECUTED' | 'CANCELLED' | 'EXPIRED' | 'FAILED';

export type PendingAction = {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  status: PendingActionStatus;
  expiresAt: string;
  result: unknown;
};

export type AssistantTurn = {
  conversationId: string;
  reply: string;
  steps: AgentStep[];
  actions: PendingAction[];
  provider: string;
};

export type ErrorBody = {
  error: { code: string; message: string; details?: unknown; requestId?: string };
};
