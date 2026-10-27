import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGearSequence,
  formatShiftKey,
  gearGradeOffsetPercent,
  normalizeShiftKey,
  resistanceGradeWithOffset,
  resolveGearProfile,
  shiftGearIndex,
} from "../app/ride/gearing.mjs";
import { DEFAULT_VIRTUAL_SHIFT_PROFILE, VIRTUAL_SHIFT_PROFILES } from "../app/core/tuning.mjs";

const DI2 = {
  name: "Di2 2x12",
  chainrings: [52, 36],
  cassette: [11, 12, 13, 14, 15, 17, 19, 21, 24, 27, 30, 34],
  neutral_gear: [52, 17],
  default_gear: [52, 17],
};

test("the shipped default profile is the 11-34 Di2 2x12", () => {
  assert.equal(DEFAULT_VIRTUAL_SHIFT_PROFILE, "di2_2x12");
  const profile = VIRTUAL_SHIFT_PROFILES[DEFAULT_VIRTUAL_SHIFT_PROFILE];
  assert.deepEqual(profile.chainrings, [52, 36]);
  assert.deepEqual(
    profile.cassette,
    [11, 12, 13, 14, 15, 17, 19, 21, 24, 27, 30, 34],
  );
  assert.deepEqual(profile.neutral_gear, [52, 17]);
  assert.deepEqual(profile.default_gear, [52, 17]);
});

test("buildGearSequence keeps the virtual sequence monotonic and skips redundant cross-chain gears", () => {
  const sequence = buildGearSequence(DI2.chainrings, DI2.cassette);

  // 12 big-ring gears plus the four little-ring gears that are easier than
  // the big ring's easiest (52/34).
  assert.equal(sequence.length, 16);
  assert.deepEqual(
    sequence.slice(0, 5).map((gear) => [gear.chainring, gear.cog]),
    [[36, 34], [36, 30], [36, 27], [36, 24], [52, 34]],
  );

  for (let i = 1; i < sequence.length; i += 1) {
    assert.ok(sequence[i].ratio > sequence[i - 1].ratio, "gear ratios must increase");
  }
});

test("overlap tolerance collapses a cross-chain duplicate and keeps a strictly linear sequence", () => {
  const sequence = buildGearSequence(DI2.chainrings, DI2.cassette, { overlapTolerance: 0.02 });

  assert.equal(sequence.length, 15);
  for (let i = 1; i < sequence.length; i += 1) {
    assert.ok(
      sequence[i].ratio / sequence[i - 1].ratio >= 1.02,
      "every virtual gear must be at least 2% harder than the previous one",
    );
  }
  assert.ok(
    !sequence.some((gear) => gear.chainring === 36 && gear.cog === 24),
    "the tiny 36x24 / 52x34 crossover duplicate is dropped",
  );
  assert.ok(
    sequence.some((gear) => gear.chainring === 52 && gear.cog === 34),
    "the larger chainring is kept on a near-duplicate",
  );
});

test("the shipped default profile resolves to a linear 15-gear sequence", () => {
  const profile = resolveGearProfile(DI2, {
    id: "di2_2x12",
    wheelCircumferenceMeters: 2.136,
    gradeOffsetGain: 12,
    overlapTolerance: 0.02,
  });

  assert.equal(profile.gears.length, 15);
  assert.equal(profile.gears[profile.neutralIndex].chainring, 52);
  assert.equal(profile.gears[profile.neutralIndex].cog, 17);
  assert.equal(profile.defaultIndex, profile.neutralIndex);
});

test("a 1x profile uses every cassette cog", () => {
  const sequence = buildGearSequence([40], [10, 11, 12, 13, 14, 15, 17, 19, 22, 26, 32, 44]);
  assert.equal(sequence.length, 12);
  assert.equal(sequence[0].cog, 44);
  assert.equal(sequence.at(-1).cog, 10);
});

test("resolveGearProfile assigns developments and a zero offset at the neutral gear", () => {
  const profile = resolveGearProfile(DI2, {
    id: "di2_2x12",
    wheelCircumferenceMeters: 2,
    gradeOffsetGain: 10,
  });

  assert.equal(profile.id, "di2_2x12");
  assert.equal(profile.name, "Di2 2x12");
  assert.equal(profile.neutralIndex, 10);
  assert.equal(profile.defaultIndex, 10);
  assert.equal(profile.wheelCircumferenceMeters, 2);

  const neutral = profile.gears[profile.neutralIndex];
  assert.deepEqual([neutral.chainring, neutral.cog], [52, 17]);
  assert.equal(neutral.developmentMeters, (52 / 17) * 2);
  assert.equal(neutral.gradeOffsetPercent, 0);

  assert.ok(profile.gears[0].gradeOffsetPercent < 0, "easiest gear lowers resistance");
  assert.ok(profile.gears.at(-1).gradeOffsetPercent > 0, "hardest gear raises resistance");
});

test("a profile-level wheel circumference overrides the global default", () => {
  const profile = resolveGearProfile(
    { chainrings: [40], cassette: [10, 44], wheel_circumference_meters: 2.215 },
    { wheelCircumferenceMeters: 2 },
  );
  assert.equal(profile.wheelCircumferenceMeters, 2.215);
  assert.equal(profile.gears[0].developmentMeters, (40 / 44) * 2.215);
});

test("a neutral gear outside the generated sequence falls back to the closest ratio", () => {
  const profile = resolveGearProfile(
    { chainrings: [52, 36], cassette: [11, 30], neutral_gear: [36, 19] },
    { wheelCircumferenceMeters: 2, gradeOffsetGain: 10 },
  );
  // 36/19 is harder than 52/30 but softer than any other big-ring gear; the
  // closest generated gear is 52/30.
  assert.deepEqual(
    [profile.gears[profile.neutralIndex].chainring, profile.gears[profile.neutralIndex].cog],
    [52, 30],
  );
});

test("resolveGearProfile returns null for a profile with no usable teeth", () => {
  assert.equal(resolveGearProfile(null), null);
  assert.equal(resolveGearProfile({ chainrings: [], cassette: [11, 12] }), null);
  assert.equal(resolveGearProfile({ chainrings: [52], cassette: [] }), null);
});

test("gearGradeOffsetPercent is zero at neutral and scales with development", () => {
  assert.equal(gearGradeOffsetPercent(6, 6, 12), 0);
  assert.equal(gearGradeOffsetPercent(9, 6, 12), 6);
  assert.equal(gearGradeOffsetPercent(3, 6, 12), -6);
  assert.equal(gearGradeOffsetPercent(0, 6, 12), 0);
  assert.equal(gearGradeOffsetPercent(9, 0, 12), 0);
});

test("resistanceGradeWithOffset adds the gear offset and clamps to the trainer range", () => {
  assert.equal(resistanceGradeWithOffset(4, 1.5), 5.5);
  assert.equal(resistanceGradeWithOffset(4, 1.5, { minPercent: -15, maxPercent: 20 }), 5.5);
  assert.equal(resistanceGradeWithOffset(19, 6, { minPercent: -15, maxPercent: 20 }), 20);
  assert.equal(resistanceGradeWithOffset(-14, -6, { minPercent: -15, maxPercent: 20 }), -15);
  assert.equal(resistanceGradeWithOffset(NaN, NaN), 0);
});

test("shiftGearIndex moves one gear and clamps at both ends", () => {
  assert.equal(shiftGearIndex(5, 1, 10), 6);
  assert.equal(shiftGearIndex(5, -1, 10), 4);
  assert.equal(shiftGearIndex(0, -1, 10), 0);
  assert.equal(shiftGearIndex(9, 1, 10), 9);
  assert.equal(shiftGearIndex(4, 5, 10), 5);
  assert.equal(shiftGearIndex(null, 1, 10), 1);
  assert.equal(shiftGearIndex(3, 1, 0), 0);
});

test("shift keys normalize case and keep special keys readable", () => {
  assert.equal(normalizeShiftKey("J"), "j");
  assert.equal(normalizeShiftKey("l"), "l");
  assert.equal(normalizeShiftKey(" ", "j"), " ");
  assert.equal(normalizeShiftKey("", "j"), "j");
  assert.equal(normalizeShiftKey(null, "l"), "l");
  assert.equal(normalizeShiftKey("ArrowUp", "j"), "arrowup");

  assert.equal(formatShiftKey("j"), "J");
  assert.equal(formatShiftKey(" "), "Space");
  assert.equal(formatShiftKey("arrowup"), "Arrow up");
  assert.equal(formatShiftKey(""), "--");
});
