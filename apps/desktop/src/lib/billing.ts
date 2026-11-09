import { invoke } from '@tauri-apps/api/core';
import type { BillingStatus, CheckoutResponse, PaidPlanId, UiLanguage } from '@tayang/shared';

// Paid plans. Rust calls the API with the stored sign-in token; the webview only ever sees the
// payment link and the plan state.

/**
 * What starting a payment did: a QRIS page, or, while payments are off and the owner sells over
 * WhatsApp, the API's buy link (`/buy/whatsapp`, which goes on to the chat). Rust checks either link
 * before opening it.
 */
export type CheckoutStart = ({ kind: 'qris' } & CheckoutResponse) | { kind: 'whatsapp'; url: string };

/** Starts (or reuses) a payment and opens it in the browser. Rejects with `billing:<code>`. */
export const billingCheckout = (plan: PaidPlanId) => invoke<CheckoutStart>('billing_checkout', { plan });
/** The signed-in account's plan and any payment in progress. Rejects with `billing:<code>`. */
export const billingStatus = () => invoke<BillingStatus>('billing_status');

export type BillingErrorCode =
  | 'signed-out'
  | 'invalid-plan'
  | 'network'
  | 'server'
  | 'payment-provider'
  | 'unavailable'
  | 'rate-limited'
  | 'bad_link'
  | 'downgrade_not_allowed';
const CODES: readonly string[] = [
  'signed-out',
  'invalid-plan',
  'network',
  'server',
  'payment-provider',
  'unavailable',
  'rate-limited',
  'bad_link',
  'downgrade_not_allowed',
];

/** The code in a `billing:<code>` rejection, or null for anything else. */
export function billingErrorCode(e: unknown): BillingErrorCode | null {
  const m = /^billing:([a-z_-]+)$/.exec(e instanceof Error ? e.message : String(e));
  const code = m?.[1];
  return code && CODES.includes(code) ? (code as BillingErrorCode) : null;
}

const LOCALES: Record<UiLanguage, string> = { en: 'en-US', id: 'id-ID' };

/** 15000 → "Rp15.000" (id) / "Rp15,000" (en). */
export const formatIdr = (amount: number, lang: UiLanguage) =>
  `Rp${new Intl.NumberFormat(LOCALES[lang], { maximumFractionDigits: 0 }).format(amount)}`;

/** "4 Des 2026" (id) / "Dec 4, 2026" (en), in this computer's time zone. */
export const formatDay = (iso: string, lang: UiLanguage) =>
  new Intl.DateTimeFormat(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));

/** What the plan card shows. */
export type PlanCardState = 'free' | 'active' | 'ended';

export function planCard(s: BillingStatus | null): PlanCardState {
  if (s?.active && s.plan !== 'free') return 'active';
  return s?.lastPlan ? 'ended' : 'free';
}

/** The plan-ends-soon notification shows this long before the end. */
export const REMINDER_LEAD_MS = 3 * 86_400_000;
/** While a WhatsApp purchase waits for the owner to activate it, status is asked this often… */
export const WHATSAPP_POLL_MS = 15_000;
/** While the payment dialog waits, status is asked this often… */
export const POLL_MS = 5_000;
/** …for at most this long. */
export const POLL_LIMIT_MS = 30 * 60_000;

/** Whether to remind now: a running plan with an end within 3 days, not reminded for this end yet. */
export function billingReminderDue(s: BillingStatus | null, now: Date, remindedFor: string | null): boolean {
  if (!s || s.plan === 'free' || !s.active || !s.currentPeriodEnd) return false;
  const end = Date.parse(s.currentPeriodEnd);
  if (Number.isNaN(end) || now.getTime() >= end) return false;
  return end - now.getTime() <= REMINDER_LEAD_MS && remindedFor !== s.currentPeriodEnd;
}

/** "Open again": Rust opens a pay link only if it is on this API (`<api>/pay/…`). Rejects with `billing:bad_link`. */
export const billingOpen = (url: string) => invoke<void>('billing_open', { url });
