import type { MotionSettings } from './types.ts';

/**
 * Sensitivity is the human dial; threshold/percentThreshold are the machine
 * knobs. Explicit knobs always win. Otherwise sensitivity interpolates between
 * strict (1 → threshold 60, 5% of active cells) and permissive (100 → 8, 0.2%).
 */
export interface EffectiveMotionThresholds {
  threshold: number;
  percentThreshold: number;
  sensitivity: number;
  derivedFromSensitivity: boolean;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const round2 = (value: number): number => Math.round(value * 100) / 100;

export function resolveMotionThresholds(settings: MotionSettings | undefined): EffectiveMotionThresholds {
  const sensitivity = clamp(settings?.sensitivity ?? 50, 1, 100);
  const ratio = (sensitivity - 1) / 99;

  return {
    sensitivity,
    threshold: settings?.threshold ?? Math.round(60 - 52 * ratio),
    percentThreshold: settings?.percentThreshold ?? round2(5 - 4.8 * ratio),
    derivedFromSensitivity: settings?.threshold === undefined || settings?.percentThreshold === undefined,
  };
}
