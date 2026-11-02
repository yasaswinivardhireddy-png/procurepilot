// Section types (and versions) this app build can render. Sent to the gateway on every home
// request, so the server never sends a section an installed app cannot draw.
export const SDUI_VERSIONS = {
  greeting: 1,
  banner: 1,
  budgetSummary: 1,
  productCarousel: 1,
  promptChips: 1,
  categoryGrid: 1,
  orderList: 1,
} as const;

export type SectionType = keyof typeof SDUI_VERSIONS;

export const SDUI_CAPABILITIES: string[] = Object.entries(SDUI_VERSIONS).map(([type, version]) => `${type}@${version}`);
