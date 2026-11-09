import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingStatus } from '@tayang/shared';

vi.mock('@/lib/billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing')>()),
  billingCheckout: vi.fn(),
  billingStatus: vi.fn(),
}));

import * as billing from '@/lib/billing';
import { POLL_LIMIT_MS, POLL_MS, WHATSAPP_POLL_MS } from '@/lib/billing';
import { useAuth } from '@/state/auth';
import { useBilling } from '@/state/billing';

const NOW = new Date('2026-11-04T12:00:00.000Z');
const free: BillingStatus = { plan: 'free', lastPlan: null, currentPeriodEnd: null, active: false, pending: null, lastPaidOrderId: null };
const creator: BillingStatus = { plan: 'creator', lastPlan: 'creator', currentPeriodEnd: '2026-12-04T12:00:00.000Z', active: true, pending: null, lastPaidOrderId: null };
const checkout = { kind: 'qris' as const, orderId: 'TYG-A', payUrl: 'https://studio.tayang.app/api/pay/TYG-A', paymentLinkUrl: 'https://pay.sumopod.com/p/1', expiresAt: '2026-11-04T13:00:00.000Z', amount: 50000 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.resetAllMocks();
  useBilling.getState().reset();
  vi.mocked(billing.billingStatus).mockResolvedValue(free);
  vi.mocked(billing.billingCheckout).mockResolvedValue(checkout);
});
afterEach(() => {
  useBilling.getState().close();
  vi.useRealTimers();
});

describe('buying over WhatsApp while payments are off', () => {
  const wa = { kind: 'whatsapp' as const, url: 'https://studio.tayang.app/api/buy/whatsapp?plan=creator' };

  it('shows the WhatsApp step, and moves to done once the owner activates the plan', async () => {
    vi.mocked(billing.billingCheckout).mockResolvedValue(wa);
    await useBilling.getState().pay('creator');
    expect(useBilling.getState().flow).toEqual({ phase: 'whatsapp', plan: 'creator', url: wa.url, endBefore: null });
    vi.mocked(billing.billingStatus).mockClear();
    await vi.advanceTimersByTimeAsync(WHATSAPP_POLL_MS * 2);
    expect(billing.billingStatus).toHaveBeenCalledTimes(2);
    expect(useBilling.getState().flow.phase).toBe('whatsapp');
    vi.mocked(billing.billingStatus).mockResolvedValue(creator);
    await vi.advanceTimersByTimeAsync(WHATSAPP_POLL_MS);
    expect(useBilling.getState().flow).toEqual({ phase: 'done', plan: 'creator', currentPeriodEnd: creator.currentPeriodEnd });
  });

  it('a renewal waits for the end to move, and asking stops after the limit (the step stays)', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue(creator);
    vi.mocked(billing.billingCheckout).mockResolvedValue(wa);
    await useBilling.getState().pay('creator');
    await vi.advanceTimersByTimeAsync(WHATSAPP_POLL_MS * 3);
    expect(useBilling.getState().flow.phase).toBe('whatsapp');
    vi.mocked(billing.billingStatus).mockClear();
    await vi.advanceTimersByTimeAsync(POLL_LIMIT_MS);
    const asked = vi.mocked(billing.billingStatus).mock.calls.length;
    await vi.advanceTimersByTimeAsync(WHATSAPP_POLL_MS * 4);
    expect(vi.mocked(billing.billingStatus).mock.calls.length).toBe(asked);
    expect(useBilling.getState().flow.phase).toBe('whatsapp');
  });

  it('closing stops asking', async () => {
    vi.mocked(billing.billingCheckout).mockResolvedValue(wa);
    await useBilling.getState().pay('lite');
    useBilling.getState().close();
    vi.mocked(billing.billingStatus).mockClear();
    await vi.advanceTimersByTimeAsync(WHATSAPP_POLL_MS * 3);
    expect(billing.billingStatus).not.toHaveBeenCalled();
  });
});

describe('the plans flow', () => {
  it('pick → review → pay: waits, polls every 5 s, and succeeds when the plan runs', async () => {
    useBilling.getState().open();
    expect(useBilling.getState().flow).toEqual({ phase: 'picking' });
    useBilling.getState().choose('creator');
    expect(useBilling.getState().flow).toEqual({ phase: 'review', plan: 'creator' });
    await useBilling.getState().pay('creator');
    expect(billing.billingCheckout).toHaveBeenCalledWith('creator');
    expect(useBilling.getState().flow).toMatchObject({ phase: 'waiting', plan: 'creator', checkout, startedAt: NOW.getTime() });
    vi.mocked(billing.billingStatus).mockClear();
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(billing.billingStatus).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(billing.billingStatus).toHaveBeenCalledTimes(1);
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, lastPaidOrderId: 'TYG-A' });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(useBilling.getState().flow).toEqual({ phase: 'done', plan: 'creator', currentPeriodEnd: creator.currentPeriodEnd });
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(billing.billingStatus).toHaveBeenCalledTimes(2);
  });

  it('back from review goes to picking', () => {
    useBilling.getState().open();
    useBilling.getState().choose('pro');
    useBilling.getState().back();
    expect(useBilling.getState().flow).toEqual({ phase: 'picking' });
  });

  it('a renewal succeeds only once the end moves', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue(creator);
    await useBilling.getState().refresh();
    await useBilling.getState().pay('creator');
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(useBilling.getState().flow.phase).toBe('waiting');
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, currentPeriodEnd: '2027-01-03T12:00:00.000Z', lastPaidOrderId: 'TYG-A' });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(useBilling.getState().flow).toMatchObject({ phase: 'done', currentPeriodEnd: '2027-01-03T12:00:00.000Z' });
  });

  it('stops polling when the link expires, and a new link starts over', async () => {
    await useBilling.getState().pay('lite');
    await vi.advanceTimersByTimeAsync(60 * 60_000 + POLL_MS);
    expect(useBilling.getState().flow).toMatchObject({ phase: 'expired', plan: 'lite', checkout });
    const calls = vi.mocked(billing.billingStatus).mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(billing.billingStatus).toHaveBeenCalledTimes(calls);
    vi.mocked(billing.billingCheckout).mockResolvedValueOnce({ ...checkout, orderId: 'TYG-B', expiresAt: '2026-11-04T14:30:00.000Z' });
    await useBilling.getState().pay('lite');
    expect(useBilling.getState().flow).toMatchObject({ phase: 'waiting', checkout: { orderId: 'TYG-B' } });
  });

  it('resumes a pending payment straight into waiting, without a new checkout', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue({
      ...free,
      pending: { orderId: 'TYG-P', plan: 'pro', payUrl: 'https://studio.tayang.app/api/pay/TYG-P', paymentLinkUrl: checkout.paymentLinkUrl, expiresAt: checkout.expiresAt },
    });
    await useBilling.getState().enter();
    expect(useBilling.getState().flow).toMatchObject({
      phase: 'waiting',
      plan: 'pro',
      checkout: { orderId: 'TYG-P', payUrl: 'https://studio.tayang.app/api/pay/TYG-P', paymentLinkUrl: checkout.paymentLinkUrl, expiresAt: checkout.expiresAt, amount: 90000 },
    });
    expect(billing.billingCheckout).not.toHaveBeenCalled();
  });

  it('never resumes a pending link for a plan below the one running (review3 I-2)', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue({
      ...creator,
      pending: { orderId: 'TYG-L', plan: 'lite', payUrl: 'https://studio.tayang.app/api/pay/TYG-L', paymentLinkUrl: checkout.paymentLinkUrl, expiresAt: checkout.expiresAt },
    });
    await useBilling.getState().enter();
    expect(useBilling.getState().flow).toEqual({ phase: 'picking' });
  });

  it('done names the plan in effect and the end as read back, not the plan paid for (review3 I-2)', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue(creator);
    await useBilling.getState().pay('lite');
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, currentPeriodEnd: '2026-12-13T12:00:00.000Z', lastPaidOrderId: 'TYG-A' });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(useBilling.getState().flow).toEqual({ phase: 'done', plan: 'creator', currentPeriodEnd: '2026-12-13T12:00:00.000Z' });
  });

  it('entering with nothing pending starts at picking', async () => {
    await useBilling.getState().enter();
    expect(useBilling.getState().flow).toEqual({ phase: 'picking' });
  });

  it('closing stops polling', async () => {
    await useBilling.getState().pay('lite');
    useBilling.getState().close();
    vi.mocked(billing.billingStatus).mockClear();
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(billing.billingStatus).not.toHaveBeenCalled();
    expect(useBilling.getState().flow.phase).toBe('closed');
  });

  it('keeps polling through a failed status read', async () => {
    await useBilling.getState().pay('lite');
    vi.mocked(billing.billingStatus).mockRejectedValueOnce('billing:network');
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(useBilling.getState().flow.phase).toBe('waiting');
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, plan: 'lite', lastPlan: 'lite', lastPaidOrderId: 'TYG-A' });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(useBilling.getState().flow.phase).toBe('done');
  });

  it('a failed checkout shows its code, or the raw message', async () => {
    vi.mocked(billing.billingCheckout).mockRejectedValueOnce('billing:payment-provider');
    await useBilling.getState().pay('pro');
    expect(useBilling.getState().flow).toEqual({ phase: 'failed', plan: 'pro', error: 'payment-provider' });
    vi.mocked(billing.billingCheckout).mockRejectedValueOnce(new Error('boom'));
    await useBilling.getState().pay('pro');
    expect(useBilling.getState().flow).toEqual({ phase: 'failed', plan: 'pro', error: { message: 'boom' } });
  });

  it('a checkout answered after closing is dropped', async () => {
    await useBilling.getState().refresh();
    let answer!: (c: typeof checkout) => void;
    vi.mocked(billing.billingCheckout).mockReturnValueOnce(new Promise((r) => (answer = r)));
    const p = useBilling.getState().pay('lite');
    useBilling.getState().close();
    answer(checkout);
    await p;
    expect(useBilling.getState().flow.phase).toBe('closed');
  });

  it('a checkout without a pay link fails as bad_link and is never waited on (M5)', async () => {
    vi.mocked(billing.billingCheckout).mockResolvedValueOnce({ ...checkout, payUrl: '' });
    await useBilling.getState().pay('lite');
    expect(useBilling.getState().flow).toEqual({ phase: 'failed', plan: 'lite', error: 'bad_link' });
  });

  it('reads the status before paying, so a renewal is not seen as paid at once (M8)', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue(creator);
    await useBilling.getState().pay('creator');
    expect(billing.billingStatus).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(useBilling.getState().flow.phase).toBe('waiting');
  });

  it("success needs this checkout's order AND a later end: another payment, or an unchanged end, is not it (review2 I-A)", async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue(creator);
    await useBilling.getState().pay('creator');
    // Someone else's payment moved the end.
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, currentPeriodEnd: '2027-01-03T12:00:00.000Z', lastPaidOrderId: 'TYG-OTHER' });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(useBilling.getState().flow.phase).toBe('waiting');
    // Our order, but the end didn't move.
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, lastPaidOrderId: 'TYG-A' });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(useBilling.getState().flow.phase).toBe('waiting');
  });

  it('a late lower-plan payment that became days on the current plan still counts as done (B3)', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, plan: 'pro', lastPlan: 'pro' });
    await useBilling.getState().refresh();
    useBilling.setState({ flow: { phase: 'review', plan: 'pro' } });
    await useBilling.getState().pay('pro');
    vi.mocked(billing.billingStatus).mockResolvedValue({ ...creator, plan: 'pro', lastPlan: 'pro', currentPeriodEnd: '2027-01-03T12:00:00.000Z', lastPaidOrderId: 'TYG-A' });
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(useBilling.getState().flow.phase).toBe('done');
  });

  it("pay always reads the status first, and never checks out when it can't (review2 I-A)", async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue(free);
    await useBilling.getState().refresh();
    vi.mocked(billing.billingStatus).mockClear();
    vi.mocked(billing.billingStatus).mockRejectedValueOnce('billing:network');
    await useBilling.getState().pay('creator');
    expect(billing.billingStatus).toHaveBeenCalledTimes(1);
    expect(billing.billingCheckout).not.toHaveBeenCalled();
    expect(useBilling.getState().flow).toEqual({ phase: 'failed', plan: 'creator', error: 'network' });
  });

  it('a signed-out read while the app is signed in is "unknown", never free (review2 Gratis)', async () => {
    useAuth.setState({ status: { state: 'signed-in', signedIn: true, offline: false, apiUrl: 'x' } });
    vi.mocked(billing.billingStatus).mockRejectedValue('billing:signed-out');
    expect(await useBilling.getState().refresh()).toBeNull();
    expect(useBilling.getState().failed).toBe(true);
    useAuth.setState({ status: null });
  });

  it('signed out clears the status', async () => {
    vi.mocked(billing.billingStatus).mockResolvedValue(creator);
    await useBilling.getState().refresh();
    vi.mocked(billing.billingStatus).mockRejectedValue('billing:signed-out');
    expect(await useBilling.getState().refresh()).toBeNull();
    expect(useBilling.getState().status).toBeNull();
  });
});
