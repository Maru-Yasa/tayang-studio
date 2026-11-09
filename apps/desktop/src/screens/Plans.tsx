import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, MessageCircle, QrCode } from 'lucide-react';
import { Spinner } from '@/components/Loading';
import { PLANS, findPlan, isLowerPlan, nextPeriod, type PaidPlanId, type Plan } from '@tayang/shared';
import logo from '@/assets/brand/tayang-horizontal-reversed-color.svg';
import { SignInDialog } from '@/components/Account';
import { Button } from '@/components/Button';
import { Oyen } from '@/components/Oyen';
import { BILLING_ERROR_KEYS, Quotas } from '@/components/Plan';
import { StepBar } from '@/components/StepBar';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { uiLanguage } from '@/i18n';
import { billingOpen, formatDay, formatIdr } from '@/lib/billing';
import { fireConfetti, prefersReducedMotion, CONFETTI_COLORS } from '@/lib/confetti';
import { canNotify, show } from '@/lib/scheduler';
import { cn } from '@/lib/utils';
import { useApp, type Route } from '@/state/app';
import { useAuth } from '@/state/auth';
import { useBilling, stepOf, type PayFlow } from '@/state/billing';
import { track } from '@/lib/analytics';

const POPULAR: PaidPlanId = 'creator';
/** Confetti waiting for the window to come back is dropped after this long. */
const CONFETTI_WAIT_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
/** How long a payment link stays open (the API's CHECKOUT_TTL_HOURS). */
const LINK_HOURS = 1;

/** "4:05" / "1:02:03". */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Ticks every second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [on]);
  return now;
}

/** Shown instead of confetti when the system asks for less motion. */
function StaticCelebration() {
  const dots = [
    [12, 18, 0],
    [30, 6, 1],
    [52, 14, 2],
    [74, 4, 3],
    [92, 20, 0],
    [20, 34, 2],
    [84, 36, 1],
  ] as const;
  return (
    <svg aria-hidden="true" data-static-celebration viewBox="0 0 104 44" width="208" height="88">
      {dots.map(([x, y, c], i) => (
        // An SVG transform, not words. i18n-ignore
        <rect key={i} x={x} y={y} width="7" height="4" rx="1" fill={CONFETTI_COLORS[c]} transform={`rotate(${(i * 37) % 90 - 45} ${x} ${y})`} />
      ))}
    </svg>
  );
}

function PlanCards({ chosen, onChoose, current }: { chosen: PaidPlanId; onChoose(p: PaidPlanId): void; current: PaidPlanId | null }) {
  // While a plan runs, a lower one can't be bought (the API refuses it too).
  const locked = (p: PaidPlanId) => !!current && isLowerPlan(p, current);
  const { t } = useTranslation();
  const lang = uiLanguage();
  return (
    <RadioGroup
      value={chosen}
      onValueChange={(v) => onChoose(v as PaidPlanId)}
      aria-label={t('plans.pick.plans')}
      className="grid gap-3 md:grid-cols-3"
    >
      {PLANS.map((p) => (
        <label
          key={p.id}
          htmlFor={`plans-${p.id}`}
          className={cn(
            'relative flex flex-col gap-4 rounded-xl border bg-card p-5 transition-colors',
            locked(p.id) ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
            chosen === p.id ? 'border-primary bg-tint' : p.id === POPULAR ? 'border-deep-orange' : 'border-border hover:border-hairline',
          )}
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem value={p.id} id={`plans-${p.id}`} aria-labelledby={`plans-${p.id}-name`} disabled={locked(p.id)} />
            <span id={`plans-${p.id}-name`} className="text-base font-semibold">
              {p.name}
            </span>
            {p.id === POPULAR && (
              <span className="ml-auto rounded-full bg-primary px-2 py-0.5 text-[11px] font-semibold text-primary-foreground">
                {t('plans.pick.popular')}
              </span>
            )}
          </div>
          {current === p.id && <span className="-mt-2 text-xs text-orange-light">{t('plans.pick.yours')}</span>}
          <div className="flex items-baseline gap-1">
            <span className="font-mono text-[28px] font-medium tracking-[-0.02em]">{formatIdr(p.price, lang)}</span>
            <span className="text-[13px] text-text-3">{t('plans.pick.perMonth')}</span>
          </div>
          {locked(p.id) && current && (
            <span className="-mt-2 text-xs text-text-3">{t('plans.pick.lockedNote', { current: findPlan(current)?.name ?? '' })}</span>
          )}
          <span className="text-[13px] leading-normal text-text-2">{t(`plans.pick.for.${p.id}`)}</span>
          <Quotas plan={p} />
        </label>
      ))}
    </RadioGroup>
  );
}

/** Step 2's summary: what is being paid for and until when it will run, by the API's own rules
 * (the shared `nextPeriod`), from the status as last read. */
function Summary({ plan, expiresAt }: { plan: Plan; expiresAt?: string }) {
  const { t } = useTranslation();
  const lang = uiLanguage();
  const status = useBilling((s) => s.status);
  const running = status?.active && status.plan !== 'free' && status.currentPeriodEnd ? { plan: status.plan, end: status.currentPeriodEnd } : null;
  const now = new Date();
  const next = nextPeriod(running, plan.id, now);
  // The server applies the rules when the payment arrives, at the latest when the link expires
  // (before there is a link: an hour from now). "≈" only when the credit or the date can still change by then.
  const last = expiresAt ? new Date(Math.max(now.getTime(), Date.parse(expiresAt))) : new Date(now.getTime() + LINK_HOURS * 3_600_000);
  const atLast = nextPeriod(running, plan.id, last);
  const approx =
    next.kind === 'upgrade' && (atLast.extraDays !== next.extraDays || formatDay(atLast.end, lang) !== formatDay(next.end, lang)) ? '≈ ' : '';
  const current = running ? (findPlan(running.plan)?.name ?? '') : '';
  // Days left as the credit counts them (fractional), cut to one decimal so it never overstates.
  const daysLeft = running
    ? new Intl.NumberFormat(lang === 'id' ? 'id-ID' : 'en-US', { maximumFractionDigits: 1 }).format(
        Math.floor(((Date.parse(running.end) - now.getTime()) / DAY_MS) * 10) / 10,
      )
    : '';
  const line =
    next.kind === 'renew'
      ? t('plans.pay.renewUntil', { date: formatDay(next.end, lang) })
      : next.kind === 'upgrade'
        ? approx + t('plans.pay.upgradeCredit', { days: daysLeft, old: current, extra: next.extraDays, plan: plan.name, date: formatDay(next.end, lang) })
        : next.kind === 'converted'
          ? t('plans.pay.convertedDays', { extra: next.extraDays, current, date: formatDay(next.end, lang) })
          : null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-col gap-1">
        <span className="text-base font-semibold">{t('plans.pay.summary', { plan: plan.name })}</span>
        {next.kind === 'new' && <span className="text-[13px] text-text-2">{t('plans.pay.activeFor')}</span>}
        {line && <span className="text-[13px] text-orange-light">{line}</span>}
      </div>
      <div className="flex items-baseline gap-1">
        <span className="font-mono text-2xl font-medium">{formatIdr(plan.price, lang)}</span>
        <span className="text-[13px] text-text-3">{t('plans.pick.perMonth')}</span>
      </div>
    </div>
  );
}

function PayStep({ flow, onLeave }: { flow: Exclude<PayFlow, { phase: 'closed' | 'picking' | 'done' }>; onLeave(): void }) {
  const { t } = useTranslation();
  const pay = useBilling((s) => s.pay);
  const back = useBilling((s) => s.back);
  const status = useBilling((s) => s.status);
  const [linkError, setLinkError] = useState(false);
  const plan = findPlan(flow.plan)!;
  const now = useNow(flow.phase === 'waiting');
  const error =
    linkError
      ? t(BILLING_ERROR_KEYS.bad_link)
      : flow.phase === 'failed'
        ? flow.error === 'downgrade_not_allowed'
          ? t('plans.pick.lockedNote', { current: findPlan(status?.plan)?.name ?? '' })
          : typeof flow.error === 'string'
          ? t(BILLING_ERROR_KEYS[flow.error])
          : t('billing.errors.unexpected', { message: flow.error.message })
        : null;
  const openAgain = (url: string) => {
    // Rust opens it, only if it is a pay link on this API.
    billingOpen(url).catch(() => setLinkError(true));
  };

  return (
    <div className="flex flex-col gap-5">
      <Summary plan={plan} expiresAt={flow.phase === 'waiting' || flow.phase === 'expired' ? flow.checkout.expiresAt : undefined} />
      {flow.phase === 'waiting' && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-background px-6 py-8 text-center">
          <span aria-hidden="true" className="relative flex size-16 items-center justify-center rounded-xl bg-raised">
            <QrCode size={32} strokeWidth={1.5} className="text-foreground" />
            <span className="absolute inset-0 rounded-xl border border-primary motion-safe:animate-pulse" />
          </span>
          <p role="status" className="m-0 max-w-[420px] text-sm leading-normal text-text-2">
            {t('plans.pay.waiting')}
          </p>
          <p className="m-0 flex flex-wrap justify-center gap-x-4 font-mono text-xs text-text-3">
            <span>{t('plans.pay.elapsed', { time: clock(now - flow.startedAt) })}</span>
            <span>{t('plans.pay.expiresIn', { time: clock(Date.parse(flow.checkout.expiresAt) - now) })}</span>
          </p>
        </div>
      )}
      {flow.phase === 'whatsapp' && (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-background px-6 py-8 text-center">
          <span aria-hidden="true" className="relative flex size-16 items-center justify-center rounded-xl bg-raised">
            <MessageCircle size={32} strokeWidth={1.5} className="text-foreground" />
            <span className="absolute inset-0 rounded-xl border border-primary motion-safe:animate-pulse" />
          </span>
          <span className="text-sm font-medium">{t('plans.pay.whatsappTitle')}</span>
          <p role="status" className="m-0 max-w-[420px] text-sm leading-normal text-text-2">
            {t('plans.pay.whatsappBody')}
          </p>
        </div>
      )}
      {flow.phase === 'starting' && (
        <p role="status" className="m-0 flex items-center gap-2 text-[13px] text-text-2">
          <Spinner size={16} />
          {t('plans.pay.starting')}
        </p>
      )}
      {flow.phase === 'expired' && (
        <div className="flex flex-col gap-1 rounded-xl border border-border bg-card p-5">
          <span className="text-sm font-medium">{t('plans.pay.expiredTitle')}</span>
          <span className="text-[13px] leading-normal text-text-2">{t('plans.pay.expiredBody')}</span>
        </div>
      )}
      {error && (
        <p role="alert" className="m-0 text-[13px] leading-normal text-orange-light">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {(flow.phase === 'review' || flow.phase === 'starting' || flow.phase === 'failed') && (
          <Button disabled={flow.phase === 'starting'} onClick={() => void pay(plan.id)}>
            {flow.phase === 'failed' ? t('common.tryAgain') : t('plans.pay.open')}
          </Button>
        )}
        {flow.phase === 'waiting' && (
          <Button variant="secondary" onClick={() => openAgain(flow.checkout.payUrl)}>
            {t('plans.pay.openAgain')}
          </Button>
        )}
        {flow.phase === 'expired' && <Button onClick={() => void pay(plan.id)}>{t('plans.pay.newLink')}</Button>}
        {flow.phase === 'whatsapp' && (
          // Asks the API again: Rust checks the link and opens it.
          <Button variant="secondary" onClick={() => void pay(plan.id)}>
            {t('plans.pay.whatsappAgain')}
          </Button>
        )}
        <Button variant="ghost" onClick={back}>
          {t('plans.pay.changePlan')}
        </Button>
        <Button variant="ghost" onClick={onLeave}>
          {t('plans.pay.cancel')}
        </Button>
      </div>
    </div>
  );
}

function DoneStep({ plan, end }: { plan: Plan; end: string | null }) {
  const { t } = useTranslation();
  useEffect(() => track('plan purchased', { plan: plan.id }), [plan.id]);
  const lang = uiLanguage();
  const navigate = useApp((s) => s.navigate);
  const [still] = useState(prefersReducedMotion);
  useEffect(() => {
    // Under reduced motion there is no confetti at all; a still picture stands in.
    if (still) return;
    const seen = () => !document.hidden && document.hasFocus();
    let stop: (() => void) | undefined;
    if (seen()) {
      stop = fireConfetti();
      return () => stop?.();
    }
    // The payment usually lands while the browser is in front: keep the confetti for when the
    // window is back (once, within 10 minutes), so someone actually sees it.
    const since = Date.now();
    const off = () => {
      window.removeEventListener('focus', back);
      document.removeEventListener('visibilitychange', back);
    };
    const back = () => {
      if (!seen()) return;
      off();
      if (Date.now() - since <= CONFETTI_WAIT_MS) stop = fireConfetti();
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => {
      off();
      stop?.();
    };
  }, [still]);
  return (
    <div className="flex flex-col items-center gap-5 text-center">
      {still && <StaticCelebration />}
      <Oyen mood="happy" size={112} />
      {end && <p className="m-0 text-base text-text-2">{t('plans.done.until', { date: formatDay(end, lang) })}</p>}
      <div className="flex w-full max-w-[360px] flex-col gap-2 rounded-xl border border-border bg-card p-5 text-left">
        <span className="text-[13px] font-medium text-text-2">{t('plans.done.unlocked')}</span>
        <Quotas plan={plan} />
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={() => navigate({ name: 'chat-new' })}>{t('plans.done.start')}</Button>
        <Button variant="secondary" onClick={() => navigate({ name: 'settings' })}>
          {t('plans.done.toSettings')}
        </Button>
      </div>
    </div>
  );
}

/** Choose a plan → pay with QRIS → done, full window like onboarding. */
export function Plans({ from, plan: initialPlan }: { from?: 'settings' | 'autopilot'; plan?: PaidPlanId }) {
  const { t } = useTranslation();
  const navigate = useApp((s) => s.navigate);
  const flow = useBilling((s) => s.flow);
  const status = useBilling((s) => s.status);
  const auth = useAuth((s) => s.status);
  const signInFlow = useAuth((s) => s.flow);
  const settingsApi = useApp((s) => s.settings?.apiUrl);
  const current = status?.active && status.plan !== 'free' ? status.plan : null;
  const [chosen, setChosen] = useState<PaidPlanId>(initialPlan ?? POPULAR);
  const [wantPay, setWantPay] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const step = Math.max(1, stepOf(flow)) as 1 | 2 | 3;
  const signedIn = !!auth?.signedIn;

  useEffect(() => {
    void useAuth.getState().init();
    void useBilling.getState().enter();
    return () => useBilling.getState().close();
  }, []);
  // The current plan is picked first, unless the way in picked one.
  useEffect(() => {
    if (current && (!initialPlan || isLowerPlan(initialPlan, current))) setChosen(current);
  }, [initialPlan, current]);
  // Focus follows the step, so a screen reader hears where it is.
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  // Signed in from the gate: read this account's plan first (and pick up a payment it left
  // waiting), then carry on to paying, never for a plan lower than the one it has.
  useEffect(() => {
    if (!wantPay || !signedIn) return;
    setWantPay(false);
    void (async () => {
      await useBilling.getState().enter();
      const b = useBilling.getState();
      if (b.flow.phase !== 'picking') return;
      const cur = b.status?.active && b.status.plan !== 'free' ? b.status.plan : null;
      b.choose(cur && isLowerPlan(chosen, cur) ? cur : chosen);
    })();
  }, [wantPay, signedIn, chosen]);

  const done = flow.phase === 'done' ? flow : null;
  // A system notification too, when the window isn't in front.
  useEffect(() => {
    if (!done || (!document.hidden && document.hasFocus())) return;
    const name = findPlan(done.plan)?.name ?? '';
    void canNotify()
      .then(async (ok) => {
        if (ok) await show(t('plans.done.title', { plan: name }));
      })
      .catch(() => {});
  }, [done, t]);

  const goBack = () => {
    useBilling.getState().close();
    const to: Route = from === 'autopilot' ? { name: 'autopilot' } : { name: 'settings' };
    navigate(to);
  };
  const leave = () => (flow.phase === 'waiting' ? setConfirmLeave(true) : goBack());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !confirmLeave && signInFlow.phase === 'closed') leave();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const next = () => {
    if (!signedIn) {
      setWantPay(true);
      void useAuth.getState().signIn();
      return;
    }
    useBilling.getState().choose(chosen);
  };

  const donePlan = done ? findPlan(done.plan) : null;
  const title =
    step === 1 ? t('plans.pick.title') : step === 2 ? t('plans.pay.title') : t('plans.done.title', { plan: donePlan?.name ?? '' });

  return (
    <div className="flex min-h-full flex-col items-center bg-background px-6 pt-10 pb-12 text-foreground">
      <div className="flex w-full max-w-[960px] flex-col gap-8">
        <div data-tauri-drag-region className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" className="gap-2 px-2" onClick={leave}>
              <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
              {t('plans.back')}
            </Button>
            <img src={logo} alt="Tayang" className="block h-7 w-auto" />
          </div>
          <StepBar
            steps={[t('plans.steps.pick'), t('plans.steps.pay'), t('plans.steps.done')]}
            current={step - 1}
            label={t('plans.steps.label')}
          />
        </div>

        <div data-tauri-drag-region className={cn('flex gap-4', step === 3 ? 'flex-col items-center text-center' : 'items-center')}>
          {step === 1 && <Oyen mood="happy" size={56} />}
          <div className="flex flex-col gap-2">
            <h1 ref={heading} tabIndex={-1} className="m-0 text-4xl font-semibold tracking-[-0.02em] outline-none">
              {title}
            </h1>
            {step === 1 && <p className="m-0 text-base leading-[1.6] text-text-2">{t('plans.pick.intro')}</p>}
          </div>
        </div>

        {step === 1 && (
          <>
            <PlanCards chosen={chosen} onChoose={setChosen} current={current} />
            <div className="flex flex-col gap-1 rounded-xl border border-dashed border-hairline px-5 py-4">
              <span className="text-sm font-medium">{t('plans.pick.freeTitle')}</span>
              <span className="text-[13px] text-text-2">{t('plans.pick.freeBody')}</span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <p className="m-0 flex max-w-[560px] items-start gap-3 text-[13px] leading-normal text-text-3">
                {/* A plain text mark; no third-party logo file. i18n-ignore */}
                <span className="shrink-0 rounded border border-hairline px-1.5 py-0.5 font-mono text-[11px] font-semibold text-text-2">QRIS</span>
                {t('plans.pick.footer')}
              </p>
              <div className="flex flex-col items-end gap-1">
                <Button onClick={next}>
                  {!signedIn
                    ? t('plans.pick.signInFirst')
                    : chosen === current
                      ? t('plans.pick.renew')
                      : current
                        ? t('plans.pick.upgrade')
                        : t('plans.pick.continue')}
                </Button>
                {!signedIn && <span className="text-xs text-text-3">{t('plans.pick.signInNote')}</span>}
              </div>
            </div>
          </>
        )}
        {step === 2 && flow.phase !== 'closed' && flow.phase !== 'picking' && flow.phase !== 'done' && (
          <PayStep flow={flow} onLeave={goBack} />
        )}
        {step === 3 && donePlan && <DoneStep plan={donePlan} end={done?.currentPeriodEnd ?? null} />}
      </div>

      <SignInDialog flow={signInFlow} apiUrl={auth?.apiUrl || settingsApi || ''} />
      <Dialog open={confirmLeave} onOpenChange={(o) => !o && setConfirmLeave(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('plans.leave.title')}</DialogTitle>
            <DialogDescription>{t('plans.leave.body')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirmLeave(false)}>
              {t('plans.leave.stay')}
            </Button>
            <Button
              onClick={() => {
                setConfirmLeave(false);
                goBack();
              }}
            >
              {t('plans.leave.leave')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
