import type { PlanId } from './billing';
import type { OsKind, Style } from './types';

export type Feature = 'voiceover' | 'cloud-render' | 'premium-styles' | 'autopilot';

export interface HealthResponse {
  ok: true;
  version: string;
}

export interface Entitlements {
  plan: PlanId;
  features: Feature[];
  /** AI credits a month that come with the plan (one pool for images and voice). */
  credits: number;
}

/** GET /v1/styles */
export interface StylesResponse {
  styles: Style[];
}

/** A niche an autopilot can start from: `prompt` tells the agent what its videos are about. */
export interface Niche {
  id: string;
  title: string;
  prompt: string;
}

/** GET /v1/niches */
export interface NichesResponse {
  niches: Niche[];
}

/** A voice-over voice; `id` is what POST /v1/ai/voice takes as `voice`. */
export interface Voice {
  id: string;
  name: string;
  description: string;
  previewUrl: string | null;
}

/** GET /v1/voices */
export interface VoicesResponse {
  voices: Voice[];
}

/** `tayang.json` at the root of a style template zip. */
export interface TemplateManifest {
  engine: 'remotion' | 'hyperframes';
  /** argv; "{output}" is replaced with the output mp4 path. */
  render: string[];
  install?: string[];
  readme: 'STYLE.md';
}

/** POST /v1/telemetry/ping (public, no auth). Nothing here identifies a person: no IP, name or path is stored. */
export interface TelemetryPing {
  /** Random uuid v4, generated once on the computer. */
  installId: string;
  platform: OsKind;
  osVersion: string;
  arch: string;
  appVersion: string;
}

/** GET /v1/stats (Bearer ADMIN_TOKEN). */
export interface InstallStats {
  total: number;
  byPlatform: Record<OsKind, number>;
  byArch: Record<string, number>;
  byAppVersion: Record<string, number>;
  active7d: number;
  active30d: number;
  newLast7d: number;
}
