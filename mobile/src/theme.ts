import type { OrderStatus, Role } from '@procurepilot/sdk';

export const colors = {
  bg: '#F3F5F7',
  card: '#FFFFFF',
  text: '#0F172A',
  muted: '#64748B',
  border: '#E2E8F0',
  navy: '#0B2545',
  primary: '#0E7490',
  primaryDark: '#155E75',
  primarySoft: '#E0F2F7',
  accent: '#F59E0B',
  success: '#166534',
  successBg: '#DCFCE7',
  warning: '#92400E',
  warningBg: '#FEF3C7',
  danger: '#B91C1C',
  dangerBg: '#FEE2E2',
  info: '#1E40AF',
  infoBg: '#DBEAFE',
};

export const radius = 12;

const CATEGORY_ICONS: Record<string, string> = {
  'Office Supplies': '📎',
  'IT & Electronics': '💻',
  'Cleaning & Janitorial': '🧽',
  'Pantry & Breakroom': '☕',
  'Safety & PPE': '🦺',
  Furniture: '🪑',
};

export const categoryIcon = (category: string): string => CATEGORY_ICONS[category] ?? '📦';

// Every status has a text label and an icon, so it never relies on colour alone.
export const STATUS_STYLES: Record<OrderStatus, { label: string; icon: string; fg: string; bg: string }> = {
  PENDING_APPROVAL: { label: 'Pending approval', icon: '⏳', fg: colors.warning, bg: colors.warningBg },
  PLACED: { label: 'Placed', icon: '✓', fg: colors.success, bg: colors.successBg },
  REJECTED: { label: 'Rejected', icon: '✕', fg: colors.danger, bg: colors.dangerBg },
  CANCELLED: { label: 'Cancelled', icon: '–', fg: colors.muted, bg: '#F1F5F9' },
};

export const ROLE_LABELS: Record<Role, string> = {
  REQUESTER: 'Requester',
  MANAGER: 'Manager',
  IT_ADMIN: 'IT admin',
  FINANCE: 'Finance',
};

export const isApprover = (role: Role): boolean => role !== 'REQUESTER';

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatTime(epochMs: number | null): string {
  if (!epochMs) return '';
  return new Date(epochMs).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
}
