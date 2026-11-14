import posthog, { type CaptureResult } from 'posthog-js';

/**
 * Product analytics through PostHog, only while the user shares anonymous stats (Settings › Account).
 * What it sends: which features are used (a video rendered, a post made), the app version and
 * system. Never chat text, prompts, file names or videos; no autocapture, no session replay, no
 * remote scripts. Without VITE_POSTHOG_KEY (forks, tests) it is a no-op.
 */

// Never under Vitest: tests must not send anything, whatever env files exist.
const KEY = import.meta.env.VITEST ? '' : import.meta.env.VITE_POSTHOG_KEY?.trim() || '';
const HOST = import.meta.env.VITE_POSTHOG_HOST?.trim() || 'https://us.i.posthog.com';

let started = false;
let enabled = false;

/** `/Users/name/...`, `/home/name/...`, `C:\Users\name\...` → `~/...`: home paths say who the user is. */
const HOME = /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^/\\\s"']+/g;
const scrub = (v: unknown): unknown =>
  typeof v === 'string' ? v.replace(HOME, '~') : Array.isArray(v) ? v.map(scrub) : v && typeof v === 'object' ? scrubObject(v as Record<string, unknown>) : v;
function scrubObject(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = scrub(v);
  return out;
}

/** The last guard before anything leaves: home paths out of every property (error messages too). */
export function beforeSend(e: CaptureResult | null): CaptureResult | null {
  if (!e) return e;
  return { ...e, properties: scrubObject(e.properties ?? {}) };
}

export interface AnalyticsContext {
  /** The user shares anonymous stats (Settings › Account). */
  share: boolean;
  /** The install's random id, also used by the daily install ping. */
  installId: string;
  appVersion?: string;
  os?: string;
  uiLanguage?: string | null;
}

/**
 * Starts PostHog once, opted in or out by `share`; later calls only switch it on or off and update
 * who this install is. Safe to call on every settings change.
 */
export function startAnalytics(ctx: AnalyticsContext): void {
  if (!KEY) {
    if (import.meta.env.DEV && !import.meta.env.VITEST) {
      console.error(
        'VITE_POSTHOG_KEY variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once VITE_POSTHOG_KEY is configured',
      );
    }
    return;
  }
  if (!started) {
    posthog.init(KEY, {
      api_host: HOST,
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      disable_surveys: true,
      disable_external_dependency_loading: true,
      capture_exceptions: false,
      persistence: 'localStorage',
      person_profiles: 'identified_only',
      opt_out_capturing_by_default: !ctx.share,
      before_send: beforeSend,
      ...(ctx.installId ? { bootstrap: { distinctID: ctx.installId } } : {}),
    });
    started = true;
  }
  posthog.register({
    build: import.meta.env.DEV ? 'dev' : 'release',
    ...(ctx.installId ? { install_id: ctx.installId } : {}),
    ...(ctx.appVersion ? { app_version: ctx.appVersion } : {}),
    ...(ctx.os ? { os_family: ctx.os } : {}),
    ...(ctx.uiLanguage ? { ui_language: ctx.uiLanguage } : {}),
  });
  // Opting in once is remembered; no $opt_in event on every launch.
  if (ctx.share && !posthog.has_opted_in_capturing()) posthog.opt_in_capturing({ captureEventName: null });
  if (!ctx.share && (enabled || !posthog.has_opted_out_capturing())) posthog.opt_out_capturing();
  enabled = ctx.share;
  // Once per launch, for daily active installs.
  if (enabled && !opened) {
    opened = true;
    posthog.capture('app opened');
  }
}

let opened = false;

/** One product event: a name in "noun verb" form and plain properties (never user text). */
export function track(event: string, properties?: Record<string, string | number | boolean | null | undefined>): void {
  if (!started || !enabled) return;
  posthog.capture(event, properties);
}

/** A Tayang account signed in: its id (never the email) and plan. */
export function identifyAccount(accountId: string, plan: string): void {
  if (!started || !enabled) return;
  // Already this account (a later launch): only the plan may have changed.
  if (posthog.get_distinct_id() === accountId) {
    posthog.setPersonProperties({ plan });
    return;
  }
  posthog.identify(accountId, { plan });
}

/** Signed out: later events are this install's again, not the account's. */
export function forgetAccount(installId: string): void {
  if (!started) return;
  posthog.reset();
  if (installId) {
    posthog.identify(installId);
    posthog.register({ install_id: installId });
  }
}

/** An error in a flow that matters (rendering, posting, a style study), with where it happened. */
export function trackError(error: unknown, where: string, extra?: Record<string, string>): void {
  if (!started || !enabled) return;
  posthog.captureException(error instanceof Error ? error : new Error(String(error)), { where, ...extra });
}
