import type { SduiAction, SduiSection } from '@procurepilot/sdk';
import { Component, type ComponentType, type ReactNode } from 'react';
import { SDUI_VERSIONS, type SectionType } from './capabilities';
import { Banner, BudgetSummary, CategoryGrid, Greeting, OrderList, ProductCarousel, PromptChips, type SectionComponentProps } from './sections';

// Section props are validated by each section's own component; the registry only routes by type.
const REGISTRY: Record<SectionType, ComponentType<SectionComponentProps<any>>> = {
  greeting: Greeting,
  banner: Banner,
  budgetSummary: BudgetSummary,
  productCarousel: ProductCarousel,
  promptChips: PromptChips,
  categoryGrid: CategoryGrid,
  orderList: OrderList,
};

// One malformed section must never take down the whole screen.
class SectionBoundary extends Component<{ id: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn(`SDUI section ${this.props.id} failed to render`, error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function canRender(section: Pick<SduiSection, 'type' | 'version'>): boolean {
  const supported = SDUI_VERSIONS[section.type as SectionType];
  return supported !== undefined && section.version <= supported;
}

export function SduiRenderer({ sections, onAction }: { sections: SduiSection[]; onAction: (action: SduiAction) => void }) {
  return (
    <>
      {sections.filter(canRender).map((section) => {
        const Section = REGISTRY[section.type as SectionType];
        return (
          <SectionBoundary key={section.id} id={section.id}>
            <Section props={section.props} onAction={onAction} />
          </SectionBoundary>
        );
      })}
    </>
  );
}
