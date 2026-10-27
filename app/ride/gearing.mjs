// Virtual drivetrain math: turns a chainring/cassette profile into a strictly
// linear sequence of virtual gears and maps each gear to the grade offset the
// trainer should add on top of the route grade. Pure — no DOM, no app state, no
// trainer IO, so every rule here is unit-testable.

import { clamp } from "../core/geo.mjs";

const FALLBACK_WHEEL_CIRCUMFERENCE_METERS = 2.136;

// Build the ordered virtual sequence for a profile's tooth counts.
//
// Every cog on the largest chainring is available; a smaller ring only
// contributes the cogs that are easier than the next larger ring's easiest
// gear. This mirrors how riders actually use a 2x/3x drivetrain (the little
// ring for the easy end, the big ring for everything else) and keeps the
// sequence free of redundant cross-chain combinations, so every "shift" is
// monotonic.
export function buildGearSequence(chainrings, cassette, { overlapTolerance = 0 } = {}) {
  const rings = positiveNumbers(chainrings).sort((a, b) => b - a);
  const cogs = positiveNumbers(cassette).sort((a, b) => a - b);
  if (!rings.length || !cogs.length) return [];

  const sequence = [];
  for (let i = 0; i < rings.length; i += 1) {
    // The previous (larger) ring's easiest ratio: this ring only fills in the
    // gears below it, never duplicates what the larger ring already covers.
    const upperLimit = i === 0 ? Infinity : rings[i - 1] / cogs.at(-1);
    for (const cog of cogs) {
      const ratio = rings[i] / cog;
      if (i === 0 || ratio < upperLimit) {
        sequence.push({ chainring: rings[i], cog, ratio });
      }
    }
  }

  const sorted = sequence.sort((a, b) => a.ratio - b.ratio);
  if (!(overlapTolerance > 0)) return sorted;

  // Collapse near-identical ratios (the tiny crossover step a 2x/3x profile
  // can produce) so the up/down sequence is strictly linear. On a duplicate,
  // keep the larger chainring — the gear a rider would actually be in.
  const linear = [];
  for (const gear of sorted) {
    const previous = linear.at(-1);
    if (previous && gear.ratio / previous.ratio < 1 + overlapTolerance) {
      if (gear.chainring > previous.chainring) linear[linear.length - 1] = gear;
      continue;
    }
    linear.push(gear);
  }
  return linear;
}

// Resolve a raw profile object from tuning.yaml into a gear list with
// developments and grade offsets. Returns null when the profile has no usable
// tooth counts.
export function resolveGearProfile(profile, {
  id = null,
  wheelCircumferenceMeters = FALLBACK_WHEEL_CIRCUMFERENCE_METERS,
  gradeOffsetGain = 0,
  overlapTolerance = 0,
} = {}) {
  if (!profile || typeof profile !== "object") return null;

  const configuredWheel = Number(profile.wheel_circumference_meters ?? wheelCircumferenceMeters);
  const wheel = Number.isFinite(configuredWheel) && configuredWheel > 0
    ? configuredWheel
    : FALLBACK_WHEEL_CIRCUMFERENCE_METERS;
  const sequence = buildGearSequence(profile.chainrings, profile.cassette, { overlapTolerance });
  if (!sequence.length) return null;

  const gears = sequence.map(({ chainring, cog, ratio }) => ({
    chainring,
    cog,
    developmentMeters: ratio * wheel,
  }));

  const neutralIndex = resolveNeutralIndex(gears, profile.neutral_gear);
  const neutralDevelopment = gears[neutralIndex].developmentMeters;
  for (const gear of gears) {
    gear.gradeOffsetPercent = gearGradeOffsetPercent(
      gear.developmentMeters,
      neutralDevelopment,
      gradeOffsetGain,
    );
  }

  const configuredDefault = findGearIndex(gears, profile.default_gear);
  return {
    id,
    name: typeof profile.name === "string" && profile.name ? profile.name : id || "Gear profile",
    gears,
    neutralIndex,
    defaultIndex: configuredDefault ?? neutralIndex,
    wheelCircumferenceMeters: wheel,
  };
}

// Percent-grade offset for a gear relative to the neutral gear. Zero at the
// neutral gear, negative for easier gears, positive for harder ones.
export function gearGradeOffsetPercent(developmentMeters, neutralDevelopmentMeters, gain) {
  const development = Number(developmentMeters);
  const neutral = Number(neutralDevelopmentMeters);
  const scale = Number(gain);
  if (!(development > 0) || !(neutral > 0) || !Number.isFinite(scale)) return 0;
  return (development / neutral - 1) * scale;
}

// Route grade plus the virtual gear's offset, clamped to the same limits the
// trainer command uses.
export function resistanceGradeWithOffset(gradePercent, offsetPercent, {
  minPercent = -Infinity,
  maxPercent = Infinity,
} = {}) {
  const grade = Number.isFinite(gradePercent) ? gradePercent : 0;
  const offset = Number.isFinite(offsetPercent) ? offsetPercent : 0;
  return clamp(grade + offset, minPercent, maxPercent);
}

// Move one gear up or down, clamped at the easiest/hardest end.
export function shiftGearIndex(index, delta, gearCount) {
  const count = Math.max(0, Math.round(Number(gearCount) || 0));
  if (!count) return 0;
  const current = Number.isFinite(index) ? Math.round(index) : 0;
  const step = Math.sign(Number(delta) || 0);
  return clamp(current + step, 0, count - 1);
}

// Index of a [chainring, cog] combination, or null when it is not part of the
// generated sequence.
export function findGearIndex(gears, gear) {
  if (!Array.isArray(gear) || gear.length < 2 || !Array.isArray(gears)) return null;
  const chainring = Number(gear[0]);
  const cog = Number(gear[1]);
  if (!Number.isFinite(chainring) || !Number.isFinite(cog)) return null;
  const index = gears.findIndex((candidate) => (
    candidate.chainring === chainring && candidate.cog === cog
  ));
  return index >= 0 ? index : null;
}

// Normalize a KeyboardEvent.key value into a stable setting value (lowercase,
// with a literal space kept as a space). A non-string falls back to the
// supplied default so a corrupt saved setting cannot break the shifter.
export function normalizeShiftKey(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (trimmed) return trimmed.toLowerCase();
  return value === " " ? " " : fallback;
}

// Human-readable label for a normalized shifter key, used by the settings
// capture buttons and the on-map hint.
export function formatShiftKey(value) {
  const key = normalizeShiftKey(value);
  if (!key) return "--";
  const known = {
    " ": "Space",
    arrowup: "Arrow up",
    arrowdown: "Arrow down",
    arrowleft: "Arrow left",
    arrowright: "Arrow right",
  };
  if (known[key]) return known[key];
  return key.length === 1 ? key.toUpperCase() : `${key[0].toUpperCase()}${key.slice(1)}`;
}

function resolveNeutralIndex(gears, neutralGear) {
  const configured = findGearIndex(gears, neutralGear);
  if (configured !== null) return configured;

  // A neutral gear that is not in the trimmed sequence (e.g. a cross-chain
  // combination) still describes a useful target ratio: use the generated
  // gear closest to it.
  if (Array.isArray(neutralGear) && neutralGear.length >= 2) {
    const ratio = Number(neutralGear[0]) / Number(neutralGear[1]);
    if (Number.isFinite(ratio) && ratio > 0) return closestRatioIndex(gears, ratio);
  }

  const middle = (gears[0].developmentMeters + gears.at(-1).developmentMeters) / 2;
  return closestDevelopmentIndex(gears, middle);
}

function closestRatioIndex(gears, targetRatio) {
  let bestIndex = 0;
  let bestDelta = Infinity;
  gears.forEach((gear, index) => {
    const delta = Math.abs(gear.chainring / gear.cog - targetRatio);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function closestDevelopmentIndex(gears, targetDevelopmentMeters) {
  let bestIndex = 0;
  let bestDelta = Infinity;
  gears.forEach((gear, index) => {
    const delta = Math.abs(gear.developmentMeters - targetDevelopmentMeters);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function positiveNumbers(values) {
  return (Array.isArray(values) ? values : [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
}
