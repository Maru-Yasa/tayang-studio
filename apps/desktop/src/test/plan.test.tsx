import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingStatus } from '@tayang/shared';

vi.mock('@/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing')>()),
  billingCheckout: vi.fn(),
  billingStatus: vi.fn(),
}));

import { PlanCard } from '@/components/Plan';
import { setUiLanguage } from '@/i18n';
import * as billing from '@/lib/billing';
import { useApp } from '@/state/app';
import { useAuth } from '@/state/auth';
import { useBilling } from '@/state/billing';

const free: BillingStatus = { plan: 'free', lastPlan: null, currentPeriodEnd: null, active: false, pending: null, lastPaidOrderId: null };
const creator: BillingStatus = { plan: 'creator', lastPlan: 'creator', currentPeriodEnd: '2026-12-04T12:00:00.000Z', active: true, pending: null, lastPaidOrderId: null };
/** The row the owner paid for in Sandbox: Lite until 4 Dec 2026, 15:09 UTC. */
const lite: BillingStatus = { plan: 'lite', lastPlan: 'lite', currentPeriodEnd: '2026-12-04T15:09:15.000Z', active: true, pending: null, lastPaidOrderId: null };

beforeEach(() => {
  vi.resetAllMocks();
  useBilling.getState().reset();
  useApp.setState({ route: { name: 'settings' }, leaveGuard: null });
  vi.mocked(billing.billingStatus).mockResolvedValue(free);
});

describe('plan card', () => {
  it('free: says so, and Upgrade opens the plans screen', async () => {
    render(<PlanCard />);
    expect(await screen.findByText('Free')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(useApp.getState().route).toEqual({ name: 'plans', from: 'settings', plan: undefined });
  });

  it('a paid Lite shows Lite and until when, with Renew and Upgrade (B2 bug, B3)', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue(lite);
    render(<PlanCard />);
    expect(await screen.findByText('Lite')).toBeInTheDocument();
    expect(screen.getByText('Active until Dec 4, 2026')).toBeInTheDocument();
    expect(screen.queryByText('Free')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Renew' }));
    expect(useApp.getState().route).toEqual({ name: 'plans', from: 'settings', plan: 'lite' });
    // B3: no lower or equal plan while one runs, so "Change plan" became Upgrade.
    expect(screen.queryByRole('button', { name: 'Change plan' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(useApp.getState().route).toEqual({ name: 'plans', from: 'settings', plan: undefined });
  });

  it('on Pro there is nothing to upgrade to: Renew only (B3)', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, plan: 'pro', lastPlan: 'pro' });
    render(<PlanCard />);
    expect(await screen.findByText('Pro')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Renew' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upgrade' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change plan' })).not.toBeInTheDocument();
  });

  it('a running plan shows its AI credits and how far they go (B4)', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue(creator);
    render(<PlanCard />);
    expect(await screen.findByText('165 AI credits a month')).toBeInTheDocument();
    expect(screen.getByText('Enough to generate up to 165 images, or up to 23 minutes of AI voice')).toBeInTheDocument();
  });

  it('a hand-granted Pro (no end) has nothing to renew or upgrade (review2 n3)', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, plan: 'pro', lastPlan: null, currentPeriodEnd: null });
    render(<PlanCard />);
    expect(await screen.findByText('Pro')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Renew' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upgrade' })).toBeNull();
  });

  it('ended: the lapsed plan, Ended, and Renew', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, plan: 'free', active: false });
    render(<PlanCard />);
    expect(await screen.findByText('Ended on Dec 4, 2026')).toBeInTheDocument();
    expect(screen.getByText('Creator')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Renew' })).toBeInTheDocument();
  });

  it('in Indonesian', async () => {
    setUiLanguage('id');
    vi.mocked(billing.billingStatus).mockResolvedValue(lite);
    render(<PlanCard />);
    expect(await screen.findByText('Aktif sampai 4 Des 2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Perpanjang' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeInTheDocument();
  });

  it('a payment still waiting: Continue payment opens the plans screen (which resumes it)', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue({
      ...free,
      pending: { orderId: 'TYG-A', plan: 'pro', payUrl: 'https://studio.tayang.app/api/pay/TYG-A', paymentLinkUrl: 'https://pay.sumopod.com/p/1', expiresAt: '2026-11-04T13:00:00.000Z' },
    });
    render(<PlanCard />);
    await userEvent.click(await screen.findByRole('button', { name: 'Continue payment' }));
    expect(useApp.getState().route).toEqual({ name: 'plans', from: 'settings', plan: 'pro' });
    expect(billing.billingCheckout).not.toHaveBeenCalled();
  });
});

describe("plan card when the plan state can't be read", () => {
  const withAccount = (plan: string) =>
    useAuth.setState({
      status: { state: 'signed-in', signedIn: true, offline: false, apiUrl: 'x', account: { id: 'a', email: 'a@b.c', name: 'A', plan: plan as 'lite', features: [], credits: 0 } },
    });

  it('never says Free when the read failed: it shows the signed-in plan and offers to try again', async () => {
    withAccount('lite');
    vi.mocked(billing.billingStatus).mockRejectedValue(new Error('Command billing_status not found'));
    render(<PlanCard />);
    expect(await screen.findByText('Lite')).toBeInTheDocument();
    expect(screen.queryByText('Free')).not.toBeInTheDocument();
    expect(screen.getByText("Couldn't check your plan just now")).toBeInTheDocument();
    vi.mocked(billing.billingStatus).mockResolvedValue(lite);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Active until Dec 4, 2026')).toBeInTheDocument();
  });

  it('a signed-out read while the app says signed in shows unknown, never Free + Upgrade (review2)', async () => {
    withAccount('lite');
    vi.mocked(billing.billingStatus).mockRejectedValue('billing:signed-out');
    render(<PlanCard />);
    expect(await screen.findByText("Couldn't check your plan just now")).toBeInTheDocument();
    expect(screen.queryByText('Free')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upgrade' })).not.toBeInTheDocument();
  });

  it('says it is checking before the first answer, not Free', async () => {
    withAccount('free');
    vi.mocked(billing.billingStatus).mockReturnValue(new Promise(() => {}));
    render(<PlanCard />);
    expect(await screen.findByText('Checking your plan…')).toBeInTheDocument();
    expect(screen.queryByText('Free')).not.toBeInTheDocument();
  });
});
