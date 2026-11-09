import { describe, expect, it } from 'vitest';
import type { BillingStatus } from '@tayang/shared';
import { isPaymentLink } from '@tayang/shared';
import { billingErrorCode, billingReminderDue, formatDay, formatIdr, planCard } from '@/lib/billing';

const status = (over: Partial<BillingStatus> = {}): BillingStatus => ({
  plan: 'creator',
  lastPlan: 'creator',
  currentPeriodEnd: '2026-12-04T12:00:00.000Z',
  active: true,
  pending: null,
  lastPaidOrderId: null,
  ...over,
});

describe('formatIdr', () => {
  it('writes rupiah the way each language does', () => {
    expect(formatIdr(15000, 'id')).toBe('Rp15.000');
    expect(formatIdr(90000, 'id')).toBe('Rp90.000');
    expect(formatIdr(15000, 'en')).toBe('Rp15,000');
    expect(formatIdr(1250000, 'en')).toBe('Rp1,250,000');
  });
});

describe('formatDay', () => {
  it('writes the day in each language', () => {
    expect(formatDay('2026-12-04T12:00:00.000Z', 'id')).toBe('4 Des 2026');
    expect(formatDay('2026-12-04T12:00:00.000Z', 'en')).toBe('Dec 4, 2026');
  });
});

describe('billingErrorCode', () => {
  it('reads billing:<code> rejections only', () => {
    expect(billingErrorCode('billing:signed-out')).toBe('signed-out');
    expect(billingErrorCode(new Error('billing:payment-provider'))).toBe('payment-provider');
    expect(billingErrorCode('billing:unavailable')).toBe('unavailable');
    expect(billingErrorCode('billing:rate-limited')).toBe('rate-limited');
    expect(billingErrorCode('billing:bad_link')).toBe('bad_link');
    expect(billingErrorCode('billing:whatever')).toBeNull();
    expect(billingErrorCode('auth:network')).toBeNull();
  });
});

describe('planCard', () => {
  it('free, active, ended and a plan with no end', () => {
    expect(planCard(status({ plan: 'free', lastPlan: null, currentPeriodEnd: null, active: false }))).toBe('free');
    expect(planCard(null)).toBe('free');
    expect(planCard(status())).toBe('active');
    expect(planCard(status({ plan: 'free', active: false }))).toBe('ended');
    expect(planCard(status({ plan: 'pro', currentPeriodEnd: null, active: true }))).toBe('active');
  });
});

describe('billingReminderDue', () => {
  const end = Date.parse('2026-12-04T12:00:00.000Z');
  const at = (msBeforeEnd: number) => new Date(end - msBeforeEnd);
  const DAY = 86_400_000;

  it('from 3 days before the end, once per period', () => {
    expect(billingReminderDue(status(), at(3 * DAY + 60_000), null)).toBe(false);
    expect(billingReminderDue(status(), at(3 * DAY), null)).toBe(true);
    expect(billingReminderDue(status(), at(DAY), null)).toBe(true);
    expect(billingReminderDue(status(), at(DAY), '2026-12-04T12:00:00.000Z')).toBe(false);
    // Renewed: a new end is a new period, so it reminds again later.
    expect(billingReminderDue(status(), at(DAY), '2026-11-04T12:00:00.000Z')).toBe(true);
  });

  it('never for free, ended, or a plan without an end', () => {
    expect(billingReminderDue(status({ plan: 'free', currentPeriodEnd: null, active: false }), at(DAY), null)).toBe(false);
    expect(billingReminderDue(status({ active: false }), at(-DAY), null)).toBe(false);
    expect(billingReminderDue(status({ currentPeriodEnd: null }), at(DAY), null)).toBe(false);
    expect(billingReminderDue(null, at(DAY), null)).toBe(false);
  });
});

describe('isPaymentLink', () => {
  it('only SumoPod payment pages over https', () => {
    for (const ok of ['https://pay.sumopod.com/p/1', 'https://sumopod.com/pay/1', 'https://checkout.pymnt.global/x']) expect(isPaymentLink(ok)).toBe(true);
    for (const bad of [
      'http://pay.sumopod.com/p/1',
      'https://pay.example/p/1',
      'https://evil-sumopod.com/p',
      'https://sumopod.com.evil.net/p',
      'https://pymnt.global/p',
      'javascript:alert(1)',
      'not a url',
    ])
      expect(isPaymentLink(bad)).toBe(false);
  });
});
