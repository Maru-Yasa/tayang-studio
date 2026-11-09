import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatus, BillingStatus } from '@tayang/shared';

vi.mock('@/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing')>()),
  billingCheckout: vi.fn(),
  billingStatus: vi.fn(),
  billingOpen: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth')>()),
  authStart: vi.fn(),
  authCancel: vi.fn().mockResolvedValue(undefined),
  authStatus: vi.fn(),
  onAuthChanged: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock('@/lib/confetti', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/confetti')>()),
  fireConfetti: vi.fn(() => () => {}),
  prefersReducedMotion: vi.fn(() => false),
}));
vi.mock('@/lib/scheduler', () => ({ canNotify: vi.fn().mockResolvedValue(true), show: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));

import { openUrl } from '@tauri-apps/plugin-opener';
import { setUiLanguage } from '@/i18n';
import * as auth from '@/lib/auth';
import * as billing from '@/lib/billing';
import { POLL_MS, WHATSAPP_POLL_MS } from '@/lib/billing';
import { fireConfetti, prefersReducedMotion } from '@/lib/confetti';
import { show } from '@/lib/scheduler';
import { Plans, clock } from '@/screens/Plans';
import { useApp } from '@/state/app';
import { useAuth } from '@/state/auth';
import { useBilling } from '@/state/billing';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const free: BillingStatus = { plan: 'free', lastPlan: null, currentPeriodEnd: null, active: false, pending: null, lastPaidOrderId: null };
const creator: BillingStatus = { plan: 'creator', lastPlan: 'creator', currentPeriodEnd: '2026-12-04T12:00:00.000Z', active: true, pending: null, lastPaidOrderId: null };
const checkout = { kind: 'qris' as const, orderId: 'TYG-A', payUrl: 'https://studio.tayang.app/api/pay/TYG-A', paymentLinkUrl: 'https://pay.sumopod.com/p/1', expiresAt: '2026-11-04T13:00:00.000Z', amount: 50000 };
const signedIn: AuthStatus = {
  state: 'signed-in',
  signedIn: true,
  offline: false,
  apiUrl: 'http://localhost:8787/api',
  account: { id: 'acc_1', email: 'a@b.c', name: 'Ana', plan: 'free', features: [], credits: 0 },
};
const signedOut: AuthStatus = { state: 'signed-out', signedIn: false, offline: false, apiUrl: 'http://localhost:8787/api' };

const user = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  vi.clearAllMocks();
  vi.mocked(prefersReducedMotion).mockReturnValue(false);
  useBilling.getState().reset();
  useAuth.setState({ ...useAuth.getInitialState(), status: signedIn, listening: true });
  useApp.setState({ route: { name: 'plans', from: 'settings' }, leaveGuard: null });
  vi.mocked(auth.authStatus).mockResolvedValue(signedIn);
  vi.mocked(billing.billingStatus).mockResolvedValue(free);
  vi.mocked(billing.billingCheckout).mockResolvedValue(checkout);
});
afterEach(() => {
  vi.useRealTimers();
});

async function toPayStep(u = user()) {
  render(<Plans from="settings" />);
  await u.click(await screen.findByRole('radio', { name: 'Creator' }));
  await u.click(screen.getByRole('button', { name: 'Continue to payment' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Payment' })).toHaveFocus();
  return u;
}

describe('plans screen: choose', () => {
  it('three plans with prices, Creator marked most popular and picked first, always-free strip, QRIS note', async () => {
    render(<Plans from="settings" />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Let Tayang do the posting' })).toBeInTheDocument();
    const group = screen.getByRole('radiogroup', { name: 'Plans' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(within(group).getByRole('radio', { name: 'Creator' })).toBeChecked();
    expect(screen.getByText('Most popular')).toBeInTheDocument();
    expect(screen.getByText('Rp15,000')).toBeInTheDocument();
    expect(screen.getByText('Rp50,000')).toBeInTheDocument();
    expect(screen.getByText('Rp90,000')).toBeInTheDocument();
    expect(screen.getByText('For posting regularly every day')).toBeInTheDocument();
    expect(screen.getByText('150 auto-posts a month')).toBeInTheDocument();
    expect(screen.getByText('Always free')).toBeInTheDocument();
  });

  it('AI credits are one number per plan, with how far they go, and Lite says it has none (B4)', async () => {
    render(<Plans from="settings" />);
    expect(await screen.findByText('165 AI credits a month')).toBeInTheDocument();
    expect(screen.getByText('Enough to generate up to 165 images, or up to 23 minutes of AI voice')).toBeInTheDocument();
    expect(screen.getByText('310 AI credits a month')).toBeInTheDocument();
    expect(screen.getByText('Enough to generate up to 310 images, or up to 44 minutes of AI voice')).toBeInTheDocument();
    expect(screen.getByText('No AI credits')).toBeInTheDocument();
    expect(screen.queryByText(/AI images a month|minutes of AI voice a month/)).toBeNull();
  });

  it('"What are credits?" explains them, without picking the card (B4)', async () => {
    const u = user();
    render(<Plans from="settings" />);
    const info = (await screen.findAllByRole('button', { name: 'What are credits?' }))[1]!;
    await u.click(info);
    expect(await screen.findByText(/1 credit = 1 AI image\. 7 credits = 1 minute of AI voice\./)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Creator' })).toBeChecked();
    expect(screen.getByText(/Nothing is charged automatically/)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Plan steps' })).toBeInTheDocument();
  });

  it('arrow keys move between the plan cards', async () => {
    const u = user();
    render(<Plans from="settings" />);
    const creatorRadio = await screen.findByRole('radio', { name: 'Creator' });
    await u.click(creatorRadio);
    await u.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Pro' })).toHaveFocus();
    await u.keyboard(' ');
    expect(screen.getByRole('radio', { name: 'Pro' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Continue to payment' })).toBeInTheDocument();
  });

  it('marks your plan and its button reads Renew', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue(creator);
    render(<Plans from="settings" />);
    expect(await screen.findByText('Your plan')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Renew' })).toBeInTheDocument();
  });

  it('while a plan runs, lower plans are disabled with a note, and arrow keys skip them (B3)', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue(creator);
    const u = user();
    render(<Plans from="settings" />);
    await screen.findByText('Your plan');
    const lite = screen.getByRole('radio', { name: 'Lite' });
    expect(lite).toBeDisabled();
    expect(screen.getByText('Available after your Creator plan ends')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Creator' })).toBeChecked();
    await u.click(lite);
    expect(screen.getByRole('radio', { name: 'Creator' })).toBeChecked();
    screen.getByRole('radio', { name: 'Pro' }).focus();
    await u.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Creator' })).toHaveFocus();
    await u.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Pro' })).toHaveFocus();
    await u.keyboard(' ');
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeInTheDocument();
  });

  it('a lower plan asked for from outside starts on the current one', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue(creator);
    render(<Plans from="settings" plan="lite" />);
    await screen.findByText('Your plan');
    expect(screen.getByRole('radio', { name: 'Creator' })).toBeChecked();
  });

  it('an existing subscriber signing in at the gate renews, and an unchanged plan is not a success (review2 I-A)', async () => {
    useAuth.setState({ status: signedOut });
    vi.mocked(billing.billingStatus).mockRejectedValue('billing:signed-out');
    vi.mocked(auth.authStart).mockReturnValue(new Promise(() => {}));
    const u = user();
    render(<Plans from="settings" />);
    await u.click(await screen.findByRole('button', { name: 'Sign in with Google first' }));
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, lastPaidOrderId: 'TYG-OLD' });
    act(() => useAuth.getState().apply(signedIn));
    expect(await screen.findByRole('heading', { level: 1, name: 'Payment' })).toBeInTheDocument();
    expect(screen.getByText('Extended until Jan 3, 2027')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Pay now' }));
    await screen.findByText(/this page changes by itself/);
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS * 2));
    expect(screen.getByText(/this page changes by itself/)).toBeInTheDocument();
    expect(fireConfetti).not.toHaveBeenCalled();
  });

  it('the API refusing a downgrade shows the same note (B3)', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue(creator);
    vi.mocked(billing.billingCheckout).mockRejectedValueOnce('billing:downgrade_not_allowed');
    const u = user();
    render(<Plans from="settings" />);
    await screen.findByText('Your plan');
    await u.click(screen.getByRole('button', { name: 'Renew' }));
    await u.click(await screen.findByRole('button', { name: 'Pay now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Available after your Creator plan ends');
  });

  it('Indonesian notes for a running plan', async () => {
    setUiLanguage('id');
    vi.mocked(billing.billingStatus).mockResolvedValue(creator);
    render(<Plans from="settings" />);
    expect(await screen.findByText('Bisa dipilih setelah paket Creator berakhir')).toBeInTheDocument();
    expect(screen.getByText('Paket kamu')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Perpanjang' })).toBeInTheDocument();
  });

  it('while payments are off: continues in WhatsApp, Open WhatsApp again asks again, and the plan shows once activated', async () => {
    const wa = { kind: 'whatsapp' as const, url: 'https://studio.tayang.app/api/buy/whatsapp?plan=creator' };
    vi.mocked(billing.billingCheckout).mockResolvedValue(wa);
    const u = user();
    await toPayStep(u);
    await u.click(screen.getByRole('button', { name: 'Pay now' }));
    expect(await screen.findByText('Continue in WhatsApp')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/over WhatsApp/);
    await u.click(screen.getByRole('button', { name: 'Open WhatsApp again' }));
    expect(billing.billingCheckout).toHaveBeenCalledTimes(2);
    vi.mocked(billing.billingStatus).mockResolvedValue(creator);
    await act(() => vi.advanceTimersByTimeAsync(WHATSAPP_POLL_MS));
    expect(await screen.findByRole('heading', { level: 1, name: 'Creator plan active' })).toBeInTheDocument();
  });

  it('in Indonesian', async () => {
    setUiLanguage('id');
    render(<Plans from="settings" />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Biar Tayang yang tayangin' })).toBeInTheDocument();
    expect(screen.getByText('Paling populer')).toBeInTheDocument();
    expect(screen.getByText('Rp50.000')).toBeInTheDocument();
    expect(screen.getAllByText('/bulan').length).toBe(3);
    expect(screen.getByRole('button', { name: 'Lanjut bayar' })).toBeInTheDocument();
    expect(screen.getByText(/Tidak ada tagihan otomatis/)).toBeInTheDocument();
    expect(screen.getByText('165 kredit AI per bulan')).toBeInTheDocument();
    expect(screen.getByText('Cukup untuk generate sampai 165 gambar, atau sampai 23 menit suara AI')).toBeInTheDocument();
    expect(screen.getByText('Tanpa kredit AI')).toBeInTheDocument();
    expect(screen.getByText('90 posting otomatis per bulan')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Apa itu kredit?' }).length).toBe(2);
  });

  it('signed out: signs in with Google first, then carries on to paying', async () => {
    useAuth.setState({ status: signedOut });
    vi.mocked(auth.authStart).mockReturnValue(new Promise(() => {}));
    const u = user();
    render(<Plans from="settings" />);
    await u.click(await screen.findByRole('button', { name: 'Sign in with Google first' }));
    expect(auth.authStart).toHaveBeenCalled();
    // The sign-in dialog is over the screen, which is still on step 1.
    expect(screen.getByRole('heading', { level: 1, name: 'Let Tayang do the posting', hidden: true })).toBeInTheDocument();
    act(() => useAuth.getState().apply(signedIn));
    expect(await screen.findByRole('heading', { level: 1, name: 'Payment' })).toBeInTheDocument();
    expect(billing.billingCheckout).not.toHaveBeenCalled();
  });
});

describe('plans screen: pay', () => {
  it('summary, then Pay now checks out, waits with a countdown, and Open again reopens it', async () => {
    const u = await toPayStep();
    expect(screen.getByText('Creator plan')).toBeInTheDocument();
    expect(screen.getByText('Active for 30 days from when the payment arrives')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Pay now' }));
    expect(billing.billingCheckout).toHaveBeenCalledWith('creator');
    expect(await screen.findByText(/this page changes by itself/)).toBeInTheDocument();
    expect(screen.getByText(/^Link expires in (1:00:00|59:5\d)$/)).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText('Waiting for 0:02')).toBeInTheDocument();
    await u.click(screen.getByRole('button', { name: 'Open again' }));
    expect(billing.billingOpen).toHaveBeenCalledWith(checkout.payUrl);
  });

  it('renewing previews the new end date', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue(creator);
    const u = user();
    render(<Plans from="settings" />);
    await screen.findByText('Your plan');
    await u.click(screen.getByRole('button', { name: 'Renew' }));
    expect(await screen.findByText('Extended until Jan 3, 2027')).toBeInTheDocument();
    // The 30 days go on top of the current end, so "30 days from the payment" would contradict it (review3 m-3).
    expect(screen.queryByText('Active for 30 days from when the payment arrives')).toBeNull();
  });

  it('a lower-plan link being paid is described as the days it becomes (review3 I-2)', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue(creator);
    render(<Plans from="settings" />);
    await screen.findByText('Your plan');
    act(() =>
      useBilling.setState({ flow: { phase: 'waiting', plan: 'lite', checkout: { ...checkout, amount: 15000 }, endBefore: creator.currentPeriodEnd, startedAt: Date.now() } }),
    );
    // floor(30 × 15000 / 50000) = 9 days on Creator.
    expect(await screen.findByText('This payment becomes +9 days on Creator, active until Dec 13, 2026')).toBeInTheDocument();
  });

  it('upgrading shows the credit for the days left, as the API computes it (B3)', async () => {
    // 10.5 days of Lite left → Creator: floor(10.5 × 15000 / 50000) = 3 extra days (still 3 in an hour), so 33 days from now.
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, plan: 'lite', lastPlan: 'lite', currentPeriodEnd: '2026-11-15T00:00:00.000Z' });
    const u = user();
    render(<Plans from="settings" />);
    await screen.findByText('Your plan');
    await u.click(screen.getByRole('radio', { name: 'Creator' }));
    await u.click(screen.getByRole('button', { name: 'Upgrade' }));
    // (The test clock creeps a little, so 10.5 may already read 10.4.)
    expect(await screen.findByText(/^10\.[45] days left of Lite become \+3 days on Creator\. Active until Dec 7, 2026\.$/)).toBeInTheDocument();
  });

  it('marks the upgrade summary ≈ when an hour of waiting could change the credit', async () => {
    // 10 days and 10 minutes of Lite → Creator: 3.002 extra days now, 2.99 an hour later: the credit may be a day less.
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, plan: 'lite', lastPlan: 'lite', currentPeriodEnd: '2026-11-14T12:10:00.000Z' });
    const u = user();
    render(<Plans from="settings" />);
    await screen.findByText('Your plan');
    await u.click(screen.getByRole('radio', { name: 'Creator' }));
    await u.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(await screen.findByText(/^≈ 10 days left of Lite become \+3 days on Creator/)).toBeInTheDocument();
  });

  it('no ≈ when the credit and the date are the same however long the link stays open', async () => {
    // 10.5 days of Lite → Creator: 3.15 now, 3.14 at the link's expiry; the date doesn't move either (before midnight).
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, plan: 'lite', lastPlan: 'lite', currentPeriodEnd: '2026-11-15T00:00:00.000Z' });
    const u = user();
    render(<Plans from="settings" />);
    await screen.findByText('Your plan');
    await u.click(screen.getByRole('radio', { name: 'Creator' }));
    await u.click(screen.getByRole('button', { name: 'Upgrade' }));
    expect(await screen.findByText(/^10\.[45] days left/)).toBeInTheDocument();
  });

  it('Change plan goes back to step 1', async () => {
    const u = await toPayStep();
    await u.click(screen.getByRole('button', { name: 'Change plan' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Let Tayang do the posting' })).toHaveFocus();
  });

  it('when the link expires: Link expired, and Make a new link checks out again', async () => {
    const u = await toPayStep();
    await u.click(screen.getByRole('button', { name: 'Pay now' }));
    await screen.findByText(/this page changes by itself/);
    await act(() => vi.advanceTimersByTimeAsync(60 * 60_000 + POLL_MS));
    expect(await screen.findByText('Link expired')).toBeInTheDocument();
    vi.mocked(billing.billingCheckout).mockResolvedValueOnce({ ...checkout, orderId: 'TYG-B', expiresAt: '2026-11-04T14:30:00.000Z' });
    await u.click(screen.getByRole('button', { name: 'Make a new link' }));
    expect(billing.billingCheckout).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/this page changes by itself/)).toBeInTheDocument();
  });

  it('entering with a pending payment goes straight to waiting on it', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue({
      ...free,
      pending: { orderId: 'TYG-P', plan: 'pro', payUrl: 'https://studio.tayang.app/api/pay/TYG-P', paymentLinkUrl: checkout.paymentLinkUrl, expiresAt: checkout.expiresAt },
    });
    render(<Plans from="settings" />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Payment' })).toBeInTheDocument();
    expect(screen.getByText('Pro plan')).toBeInTheDocument();
    expect(screen.getByText(/this page changes by itself/)).toBeInTheDocument();
    expect(billing.billingCheckout).not.toHaveBeenCalled();
  });

  it('shows why a checkout failed, e.g. payments not open yet', async () => {
    vi.mocked(billing.billingCheckout).mockRejectedValueOnce('billing:unavailable');
    const u = await toPayStep();
    await u.click(screen.getByRole('button', { name: 'Pay now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Payments aren't available yet");
  });
});

describe('plans screen: leaving', () => {
  it('Back returns to where you came from', async () => {
    const u = user();
    render(<Plans from="autopilot" />);
    await u.click(await screen.findByRole('button', { name: 'Back' }));
    expect(useApp.getState().route).toEqual({ name: 'autopilot' });
  });

  it('Esc leaves at once, but asks first while a payment is waiting', async () => {
    const u = await toPayStep();
    await u.click(screen.getByRole('button', { name: 'Pay now' }));
    await screen.findByText(/this page changes by itself/);
    await u.keyboard('{Escape}');
    const confirm = await screen.findByRole('dialog');
    expect(within(confirm).getByText('Leave this payment?')).toBeInTheDocument();
    await u.click(within(confirm).getByRole('button', { name: 'Stay' }));
    expect(useApp.getState().route).toEqual({ name: 'plans', from: 'settings' });
    await u.keyboard('{Escape}');
    await u.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Leave' }));
    expect(useApp.getState().route).toEqual({ name: 'settings' });
  });

  it('Cancel leaves without asking the API anything', async () => {
    const u = await toPayStep();
    await u.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useApp.getState().route).toEqual({ name: 'settings' });
    expect(billing.billingCheckout).not.toHaveBeenCalled();
  });
});

describe('plans screen: done', () => {
  async function payAndSucceed() {
    const u = await toPayStep();
    await u.click(screen.getByRole('button', { name: 'Pay now' }));
    await screen.findByText(/this page changes by itself/);
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, lastPaidOrderId: 'TYG-A' });
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    return u;
  }

  it('the paid plan, until when, what it unlocks, confetti, and the way on', async () => {
    const u = await payAndSucceed();
    expect(await screen.findByRole('heading', { level: 1, name: 'Creator plan active' })).toHaveFocus();
    expect(screen.getByText('Until Dec 4, 2026')).toBeInTheDocument();
    expect(screen.getByText('165 AI credits a month')).toBeInTheDocument();
    expect(screen.getByText('Enough to generate up to 165 images, or up to 23 minutes of AI voice')).toBeInTheDocument();
    expect(fireConfetti).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-static-celebration]')).toBeNull();
    await u.click(screen.getByRole('button', { name: 'Start making a video' }));
    expect(useApp.getState().route).toEqual({ name: 'chat-new' });
  });

  it('no confetti under reduced motion: a still picture instead', async () => {
    vi.mocked(prefersReducedMotion).mockReturnValue(true);
    await payAndSucceed();
    expect(await screen.findByRole('heading', { level: 1, name: 'Creator plan active' })).toBeInTheDocument();
    expect(fireConfetti).not.toHaveBeenCalled();
    expect(document.querySelector('[data-static-celebration]')).not.toBeNull();
  });

  it('notifies when the window is not in front', async () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    try {
      await payAndSucceed();
      await screen.findByRole('heading', { level: 1, name: 'Creator plan active' });
      await vi.waitFor(() => expect(show).toHaveBeenCalledWith('Creator plan active'));
    } finally {
      focus.mockRestore();
    }
  });

  it('confetti waits until the window is in front again, fires once, and is dropped after 10 minutes (review2 I-B)', async () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    try {
      await payAndSucceed();
      await screen.findByRole('heading', { level: 1, name: 'Creator plan active', hidden: true });
      expect(fireConfetti).not.toHaveBeenCalled();
      focus.mockReturnValue(true);
      act(() => void window.dispatchEvent(new Event('focus')));
      expect(fireConfetti).toHaveBeenCalledTimes(1);
      act(() => void window.dispatchEvent(new Event('focus')));
      act(() => void document.dispatchEvent(new Event('visibilitychange')));
      expect(fireConfetti).toHaveBeenCalledTimes(1);
    } finally {
      focus.mockRestore();
    }
  });

  it('a queued confetti is dropped when the window comes back after 10 minutes', async () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    try {
      await payAndSucceed();
      await screen.findByRole('heading', { level: 1, name: 'Creator plan active', hidden: true });
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
      focus.mockReturnValue(true);
      act(() => void window.dispatchEvent(new Event('focus')));
      expect(fireConfetti).not.toHaveBeenCalled();
    } finally {
      focus.mockRestore();
    }
  });

  it('opening the screen with a plan already active never celebrates', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, lastPaidOrderId: 'TYG-OLD' });
    render(<Plans from="settings" />);
    await screen.findByText('Your plan');
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS * 2));
    expect(fireConfetti).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1, name: 'Let Tayang do the posting' })).toBeInTheDocument();
  });

  it('in Indonesian', async () => {
    setUiLanguage('id');
    vi.mocked(billing.billingStatus).mockResolvedValue(free);
    const u = user();
    render(<Plans from="settings" />);
    await u.click(await screen.findByRole('radio', { name: 'Creator' }));
    await u.click(screen.getByRole('button', { name: 'Lanjut bayar' }));
    await u.click(await screen.findByRole('button', { name: 'Bayar sekarang' }));
    expect(await screen.findByText(/halaman ini berubah sendiri begitu pembayaranmu masuk/)).toBeInTheDocument();
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, lastPaidOrderId: 'TYG-A' });
    await act(() => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(await screen.findByRole('heading', { level: 1, name: 'Paket Creator aktif' })).toBeInTheDocument();
    expect(screen.getByText('Sampai 4 Des 2026')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mulai bikin video' })).toBeInTheDocument();
  });
});

describe('clock', () => {
  it('minutes and seconds, hours when needed', () => {
    expect(clock(0)).toBe('0:00');
    expect(clock(65_000)).toBe('1:05');
    expect(clock(3_723_000)).toBe('1:02:03');
    expect(clock(-5)).toBe('0:00');
  });
});
