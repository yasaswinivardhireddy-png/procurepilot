import { readFileSync } from 'node:fs';
import type { Budget, Category, HomeScreen, OrderSummary, ProductSummary, Role, SduiSection, User } from '../../../sdk/src/types.ts';
import { fnv1a } from '../shared/ids.ts';

export type FlagRule = { enabled: boolean; rolloutPercent: number; roles?: Role[] };
export type Flags = Record<string, FlagRule>;

export type HomeLayoutConfig = {
  schemaVersion: number;
  ttlSeconds: number;
  layouts: Record<string, string[]>;
  roleLayouts: Record<Role, string>;
};

export type HomeData = {
  budgets: Budget[];
  approvals: { total: number };
  buyAgain: (ProductSummary & { suggestedQty: number })[];
  deals: ProductSummary[];
  categories: Category[];
  recentOrders: OrderSummary[];
};

export type HomeFetchers = { [K in keyof HomeData]: () => Promise<HomeData[K]> };

type SectionDef = {
  type: string;
  version: number;
  needs: (keyof HomeData)[];
  flag?: string;
  build(user: User, data: Partial<HomeData>, now: Date): Record<string, unknown> | null;
};

// Percentage rollouts: a user always lands in the same bucket for a given flag.
export function isFlagEnabled(flags: Flags, name: string, user: Pick<User, 'id' | 'role'>): boolean {
  const rule = flags[name];
  if (!rule || !rule.enabled) return false;
  if (rule.roles && !rule.roles.includes(user.role)) return false;
  return fnv1a(`${name}:${user.id}`) % 100 < rule.rolloutPercent;
}

function partOfDayIst(now: Date): string {
  const minutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
  const hour = Math.floor(minutes / 60);
  return hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
}

function promptsFor(role: Role): string[] {
  if (role === 'REQUESTER') {
    return ['Order 20 reams of A4 paper and 10 packs of gel pens with GST invoice', 'Reorder my last order', 'What is my remaining budget?'];
  }
  return ['What is my remaining budget?', 'Show my recent orders', 'Find ergonomic chairs under ₹10,000'];
}

const SECTIONS: Record<string, SectionDef> = {
  greeting: {
    type: 'greeting',
    version: 1,
    needs: [],
    build: (user, _data, now) => ({ title: `Good ${partOfDayIst(now)}, ${user.name.split(' ')[0]}`, subtitle: `${user.title} · Acme Corp` }),
  },
  pendingApprovals: {
    type: 'banner',
    version: 1,
    needs: ['approvals'],
    build: (_user, data) => {
      const n = data.approvals!.total;
      if (n === 0) return null;
      return {
        tone: 'warning',
        title: `${n} order${n === 1 ? '' : 's'} waiting for your approval`,
        body: 'Review the details and approve or reject in a tap.',
        cta: { label: 'Review', action: { type: 'navigate', href: '/approvals' } },
      };
    },
  },
  budgetSummary: {
    type: 'budgetSummary',
    version: 1,
    needs: ['budgets'],
    build: (_user, data) => (data.budgets!.length > 0 ? { title: 'Budgets this month', items: data.budgets } : null),
  },
  buyAgain: {
    type: 'productCarousel',
    version: 1,
    needs: ['buyAgain'],
    build: (_user, data) => (data.buyAgain!.length > 0 ? { title: 'Buy again', subtitle: 'Supplies your team orders often', items: data.buyAgain } : null),
  },
  assistantPrompts: {
    type: 'promptChips',
    version: 1,
    needs: [],
    flag: 'assistantPrompts',
    build: (user) => ({ title: 'Ask the purchasing assistant', prompts: promptsFor(user.role) }),
  },
  deals: {
    type: 'productCarousel',
    version: 1,
    needs: ['deals'],
    flag: 'businessDeals',
    build: (_user, data) => (data.deals!.length > 0 ? { title: 'Bulk-buy savings', subtitle: 'Volume pricing for business buyers', items: data.deals } : null),
  },
  categories: {
    type: 'categoryGrid',
    version: 1,
    needs: ['categories'],
    build: (_user, data) => ({ title: 'Shop by category', items: data.categories }),
  },
  recentOrders: {
    type: 'orderList',
    version: 1,
    needs: ['recentOrders'],
    build: (_user, data) => (data.recentOrders!.length > 0 ? { title: 'Recent orders', items: data.recentOrders } : null),
  },
};

export function validateHomeLayout(input: unknown): string[] {
  const config = input as Partial<HomeLayoutConfig> | null;
  const errors: string[] = [];
  if (!config || typeof config !== 'object') return ['home layout must be an object'];
  if (!Number.isInteger(config.schemaVersion)) errors.push('schemaVersion must be an integer');
  if (!Number.isInteger(config.ttlSeconds)) errors.push('ttlSeconds must be an integer');
  for (const [name, ids] of Object.entries(config.layouts ?? {})) {
    for (const id of ids) if (!SECTIONS[id]) errors.push(`layout ${name} references unknown section ${id}`);
  }
  for (const [role, layout] of Object.entries(config.roleLayouts ?? {})) {
    if (!config.layouts?.[layout]) errors.push(`role ${role} uses unknown layout ${layout}`);
  }
  return errors;
}

export function loadHomeConfig(layoutPath: string, flagsPath: string): { layout: HomeLayoutConfig; flags: Flags } {
  const layout = JSON.parse(readFileSync(layoutPath, 'utf8')) as HomeLayoutConfig;
  const errors = validateHomeLayout(layout);
  if (errors.length > 0) throw new Error(`Invalid home layout ${layoutPath}: ${errors.join('; ')}`);
  const flags = JSON.parse(readFileSync(flagsPath, 'utf8')) as Flags;
  return { layout, flags };
}

// The app sends the section types it can render, e.g. "greeting@1,banner@1". Older app versions
// never receive sections they cannot draw.
export function parseCapabilities(header: string | undefined): Map<string, number> | null {
  if (!header) return null;
  const capabilities = new Map<string, number>();
  for (const part of header.split(',')) {
    const [type, version] = part.trim().split('@');
    const v = Number(version ?? 1);
    if (type && Number.isInteger(v) && v > 0) capabilities.set(type, Math.max(v, capabilities.get(type) ?? 0));
  }
  return capabilities;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Builds the home screen: picks the layout for the user's role, applies flags and client
// capabilities, fetches only the data those sections need (in parallel, each with a deadline),
// and drops sections whose data failed instead of failing the whole screen.
export async function composeHome(input: {
  user: User;
  layout: HomeLayoutConfig;
  flags: Flags;
  fetchers: HomeFetchers;
  capabilities: Map<string, number> | null;
  timeoutMs: number;
  now?: Date;
}): Promise<HomeScreen> {
  const now = input.now ?? new Date();
  const layoutName = input.layout.roleLayouts[input.user.role] ?? Object.keys(input.layout.layouts)[0]!;
  const skipped: string[] = [];
  const planned = (input.layout.layouts[layoutName] ?? []).filter((id) => {
    const def = SECTIONS[id];
    if (!def) return false;
    if (def.flag && !isFlagEnabled(input.flags, def.flag, input.user)) return false;
    if (input.capabilities) {
      const supported = input.capabilities.get(def.type);
      if (!supported || supported < def.version) {
        skipped.push(id);
        return false;
      }
    }
    return true;
  });

  const needed = [...new Set(planned.flatMap((id) => SECTIONS[id]!.needs))];
  const settled = await Promise.allSettled(needed.map((key) => withTimeout<unknown>(input.fetchers[key](), input.timeoutMs)));
  const data: Partial<HomeData> = {};
  const failed = new Set<keyof HomeData>();
  needed.forEach((key, i) => {
    const result = settled[i]!;
    if (result.status === 'fulfilled') Object.assign(data, { [key]: result.value });
    else failed.add(key);
  });

  const sections: SduiSection[] = [];
  const degraded: string[] = [];
  for (const id of planned) {
    const def = SECTIONS[id]!;
    if (def.needs.some((key) => failed.has(key))) {
      degraded.push(id);
      continue;
    }
    const props = def.build(input.user, data, now);
    if (props) sections.push({ id, type: def.type, version: def.version, props });
  }
  return { schemaVersion: input.layout.schemaVersion, ttlSeconds: input.layout.ttlSeconds, generatedAt: now.toISOString(), sections, degraded, skipped };
}
