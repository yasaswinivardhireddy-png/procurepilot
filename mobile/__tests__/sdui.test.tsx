import { fireEvent, render, screen } from '@testing-library/react-native';
import { SDUI_CAPABILITIES } from '../src/sdui/capabilities';
import { SduiRenderer, canRender } from '../src/sdui/registry';

jest.mock('expo-router', () => ({ router: { push: jest.fn() } }));

const approvalsBanner = {
  id: 'pendingApprovals',
  type: 'banner',
  version: 1,
  props: { tone: 'warning', title: '2 orders waiting for your approval', cta: { label: 'Review', action: { type: 'navigate', href: '/approvals' } } },
};

describe('server-driven home screen renderer', () => {
  it('renders known sections and skips unknown or newer ones', async () => {
    await render(
      <SduiRenderer
        onAction={jest.fn()}
        sections={[
          { id: 'greeting', type: 'greeting', version: 1, props: { title: 'Good morning, Asha', subtitle: 'Marketing Executive · Acme Corp' } },
          { id: 'hero', type: 'videoHero', version: 1, props: { url: 'https://example.com/v.mp4' } },
          { id: 'future', type: 'banner', version: 2, props: { title: 'A banner from a newer app version' } },
          approvalsBanner,
        ]}
      />,
    );
    expect(screen.getByText('Good morning, Asha')).toBeTruthy();
    expect(screen.getByText(/2 orders waiting for your approval/)).toBeTruthy();
    expect(screen.queryByText(/newer app version/)).toBeNull();
  });

  it('keeps rendering when one section has bad data', async () => {
    const spies = [jest.spyOn(console, 'error').mockImplementation(() => {}), jest.spyOn(console, 'warn').mockImplementation(() => {})];
    await render(
      <SduiRenderer
        onAction={jest.fn()}
        sections={[
          { id: 'budgets', type: 'budgetSummary', version: 1, props: { title: 'Budgets this month' } },
          { id: 'greeting', type: 'greeting', version: 1, props: { title: 'Still here' } },
        ]}
      />,
    );
    expect(screen.getByText('Still here')).toBeTruthy();
    spies.forEach((s) => s.mockRestore());
  });

  it('sends the section action when the call to action is pressed', async () => {
    const onAction = jest.fn();
    await render(<SduiRenderer onAction={onAction} sections={[approvalsBanner]} />);
    await fireEvent.press(screen.getByText('Review'));
    expect(onAction).toHaveBeenCalledWith({ type: 'navigate', href: '/approvals' });
  });

  it('advertises exactly the section types it can render', async () => {
    expect(SDUI_CAPABILITIES).toEqual(['greeting@1', 'banner@1', 'budgetSummary@1', 'productCarousel@1', 'promptChips@1', 'categoryGrid@1', 'orderList@1']);
    expect(canRender({ type: 'greeting', version: 1 })).toBe(true);
    expect(canRender({ type: 'greeting', version: 2 })).toBe(false);
    expect(canRender({ type: 'unknown', version: 1 })).toBe(false);
  });
});
