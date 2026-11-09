import { create } from 'zustand';
import { useAuth } from '@/state/auth';
import { findPlan, isLowerPlan, type BillingStatus, type CheckoutResponse, type PaidPlanId } from '@tayang/shared';
import { POLL_LIMIT_MS, POLL_MS, WHATSAPP_POLL_MS, billingCheckout, billingErrorCode, billingStatus, type BillingErrorCode } from '@/lib/billing';
import { track } from '@/lib/analytics';

/** The plans screen: 1 pick, 2 review and pay (starting / waiting / expired / failed), 3 done.
 * `failed` holds an error code, or the raw message of an unexpected failure. */
export type PayFlow =
  | { phase: 'closed' }
  | { phase: 'picking' }
  | { phase: 'review'; plan: PaidPlanId }
  | { phase: 'starting'; plan: PaidPlanId }
  | { phase: 'waiting'; plan: PaidPlanId; checkout: CheckoutResponse; endBefore: string | null; startedAt: number }
  | { phase: 'expired'; plan: PaidPlanId; checkout: CheckoutResponse; endBefore: string | null }
  /** Payments are off: the buyer continues in WhatsApp, and the owner activates the plan by hand. */
  | { phase: 'whatsapp'; plan: PaidPlanId; url: string; endBefore: string | null }
  | { phase: 'done'; plan: PaidPlanId; currentPeriodEnd: string | null }
  | { phase: 'failed'; plan: PaidPlanId; error: BillingErrorCode | { message: string } };

/** Which of the three steps a phase belongs to (0 when closed). */
export function stepOf(flow: PayFlow): 0 | 1 | 2 | 3 {
  if (flow.phase === 'closed') return 0;
  if (flow.phase === 'picking') return 1;
  return flow.phase === 'done' ? 3 : 2;
}

interface BillingStore {
  /** What the API last said; null until it has (or when signed out). */
  status: BillingStatus | null;
  /** When `status` was read (ms), 0 if never. */
  loadedAt: number;
  /** The last read failed (other than signed out): the plan is unknown, not free. */
  failed: boolean;
  flow: PayFlow;
  /** Bumped by every pay, close and reopen, so a late answer or poll from an old one is dropped. */
  attempt: number;
  /** Reads the plan state. Resolves to it, or null when it couldn't. */
  refresh(): Promise<BillingStatus | null>;
  /** Step 1. */
  open(): void;
  /** Entering the plans screen: a pending payment goes straight to waiting, else step 1. */
  enter(): Promise<void>;
  /** Step 1 → 2 with this plan. */
  choose(plan: PaidPlanId): void;
  /** Step 2 → 1 ("Change plan"). */
  back(): void;
  /** Leaves the flow; a started payment is left to expire. */
  close(): void;
  /** Starts (or picks up) paying for `plan`: Rust opens the browser, then this polls until it's paid. */
  pay(plan: PaidPlanId): Promise<void>;
  /** Forget everything (signed out). */
  reset(): void;
}

let pollTimer: ReturnType<typeof setTimeout> | undefined;
const stopPolling = () => {
  if (pollTimer !== undefined) clearTimeout(pollTimer);
  pollTimer = undefined;
};

/** *This* checkout's payment went through: the API names its order as the last paid one, and the
 * period end moved past the one seen before paying (a renewal, an upgrade, or a lower plan that
 * became days on the current one all move it). */
const paid = (s: BillingStatus, orderId: string, endBefore: string | null) =>
  s.lastPaidOrderId === orderId &&
  !!s.currentPeriodEnd &&
  (endBefore === null || Date.parse(s.currentPeriodEnd) > Date.parse(endBefore));

export const useBilling = create<BillingStore>((set, get) => {
  /** Asks every POLL_MS until paid, the flow closes or another attempt starts, until the link expires. */
  const poll = (attempt: number, plan: PaidPlanId, endBefore: string | null, checkout: CheckoutResponse) => {
    stopPolling();
    const expires = Date.parse(checkout.expiresAt);
    const until = Number.isNaN(expires) ? Date.now() + POLL_LIMIT_MS : expires;
    const step = async () => {
      if (get().attempt !== attempt) return;
      const s = await get().refresh();
      if (get().attempt !== attempt) return;
      if (s && paid(s, checkout.orderId, endBefore)) {
        // What is in effect now, as read back: a late lower-plan payment only added days to the current plan.
        set({ flow: { phase: 'done', plan: s.plan !== 'free' ? s.plan : plan, currentPeriodEnd: s.currentPeriodEnd } });
        return;
      }
      if (Date.now() >= until) {
        set({ flow: { phase: 'expired', plan, checkout, endBefore } });
        return;
      }
      pollTimer = setTimeout(() => void step(), POLL_MS);
    };
    pollTimer = setTimeout(() => void step(), POLL_MS);
  };

  /** Payments are off: asks every WHATSAPP_POLL_MS until the owner has activated a plan (the period
   * end moved past the one seen before), the flow closes, or POLL_LIMIT_MS passes (the screen stays). */
  const pollActivation = (attempt: number, plan: PaidPlanId, endBefore: string | null) => {
    stopPolling();
    const until = Date.now() + POLL_LIMIT_MS;
    const step = async () => {
      if (get().attempt !== attempt) return;
      const s = await get().refresh();
      if (get().attempt !== attempt) return;
      const end = s?.active ? s.currentPeriodEnd : null;
      if (s && end && (endBefore === null || Date.parse(end) > Date.parse(endBefore))) {
        set({ flow: { phase: 'done', plan: s.plan !== 'free' ? s.plan : plan, currentPeriodEnd: end } });
        return;
      }
      if (Date.now() < until) pollTimer = setTimeout(() => void step(), WHATSAPP_POLL_MS);
    };
    pollTimer = setTimeout(() => void step(), WHATSAPP_POLL_MS);
  };

  /** Starts waiting on `checkout`. */
  const wait = (attempt: number, plan: PaidPlanId, endBefore: string | null, checkout: CheckoutResponse) => {
    set({ flow: { phase: 'waiting', plan, checkout, endBefore, startedAt: Date.now() } });
    poll(attempt, plan, endBefore, checkout);
  };

  return {
    status: null,
    loadedAt: 0,
    failed: false,
    flow: { phase: 'closed' },
    attempt: 0,

    async refresh() {
      try {
        const s = await billingStatus();
        set({ status: s, loadedAt: Date.now(), failed: false });
        return s;
      } catch (e) {
        // Signed out per Rust while the app shows signed in (the keychain couldn't be read, say) is
        // "unknown", never "free"; the auth refresh Rust starts settles which it is.
        if (billingErrorCode(e) === 'signed-out' && !useAuth.getState().status?.signedIn) {
          set({ status: null, loadedAt: Date.now(), failed: false });
        } else set({ failed: true });
        return null;
      }
    },

    open() {
      stopPolling();
      set((s) => ({ attempt: s.attempt + 1, flow: { phase: 'picking' } }));
      void get().refresh();
    },

    async enter() {
      stopPolling();
      const attempt = get().attempt + 1;
      set({ attempt, flow: { phase: 'picking' } });
      const s = await get().refresh();
      const p = s?.pending;
      // Rust keeps a pending payment only with a pay link on this API.
      if (get().attempt !== attempt || !p?.payUrl) return;
      const plan = findPlan(p.plan);
      if (!plan) return;
      // The API doesn't offer a link below the running plan; don't resume one either.
      if (s?.active && isLowerPlan(plan.id, s.plan)) return;
      const checkout = { orderId: p.orderId, payUrl: p.payUrl, paymentLinkUrl: p.paymentLinkUrl, expiresAt: p.expiresAt, amount: plan.price };
      wait(attempt, plan.id, s?.currentPeriodEnd ?? null, checkout);
    },

    choose(plan) {
      stopPolling();
      set((s) => ({ attempt: s.attempt + 1, flow: { phase: 'review', plan } }));
    },

    back() {
      get().open();
    },

    close() {
      stopPolling();
      set((s) => ({ attempt: s.attempt + 1, flow: { phase: 'closed' } }));
    },

    async pay(plan) {
      stopPolling();
      const attempt = get().attempt + 1;
      set({ attempt, flow: { phase: 'starting', plan } });
      // The end before paying is what "paid" is measured against: always read it fresh, and don't
      // start a payment when it can't be read.
      const before = await get().refresh();
      if (get().attempt !== attempt) return;
      if (!before) {
        set({ flow: { phase: 'failed', plan, error: get().failed ? 'network' : 'signed-out' } });
        return;
      }
      const endBefore = before.currentPeriodEnd;
      try {
        const checkout = await billingCheckout(plan);
        if (get().attempt !== attempt) return;
        if (checkout.kind === 'whatsapp') {
          track('plan whatsapp opened', { plan });
          set({ flow: { phase: 'whatsapp', plan, url: checkout.url, endBefore } });
          pollActivation(attempt, plan, endBefore);
          return;
        }
        track('plan checkout started', { plan });
        // Rust only answers with a pay link on this API; nothing else is opened.
        if (!checkout.payUrl) {
          set({ flow: { phase: 'failed', plan, error: 'bad_link' } });
          return;
        }
        wait(attempt, plan, endBefore, checkout);
      } catch (e) {
        if (get().attempt !== attempt) return;
        set({ flow: { phase: 'failed', plan, error: billingErrorCode(e) ?? { message: e instanceof Error ? e.message : String(e) } } });
      }
    },

    reset() {
      stopPolling();
      set((s) => ({ status: null, loadedAt: 0, failed: false, attempt: s.attempt + 1, flow: { phase: 'closed' } }));
    },
  };
});
