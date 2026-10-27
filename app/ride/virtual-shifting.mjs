// Virtual shifting: the app-side shifter. It resolves the selected gear
// profile, owns the current virtual gear, handles the shifter keys and
// on-screen shift buttons, and turns the selected gear into a grade offset
// added to the route grade. The pure tooth-count/development/offset math lives
// in gearing.mjs; the BLE writes stay in trainer.mjs.

import { clamp } from "../core/geo.mjs";
import { registerHudComponent } from "../hud/screen-manager.mjs";
import { gradeAt } from "../route/route.mjs";
import { saveSettings } from "../storage/persistence.mjs";
import { queueTrainerGradeSample } from "../trainer/trainer.mjs";
import { els, state } from "../core/state.mjs";
import {
  DEFAULT_VIRTUAL_SHIFT_DOWNSHIFT_KEY,
  DEFAULT_VIRTUAL_SHIFT_PROFILE,
  DEFAULT_VIRTUAL_SHIFT_UPSHIFT_KEY,
  GRADE_MAX_PERCENT,
  GRADE_MIN_PERCENT,
  VIRTUAL_SHIFT_GEAR_OVERLAP_TOLERANCE,
  VIRTUAL_SHIFT_GRADE_OFFSET_GAIN,
  VIRTUAL_SHIFT_PROFILES,
  VIRTUAL_SHIFT_WHEEL_CIRCUMFERENCE_METERS,
} from "../core/tuning.mjs";
import {
  formatShiftKey,
  normalizeShiftKey,
  resistanceGradeWithOffset,
  resolveGearProfile,
  shiftGearIndex,
} from "./gearing.mjs";

const NON_CAPTURABLE_KEYS = new Set([
  "shift",
  "control",
  "alt",
  "meta",
  "capslock",
  "tab",
  "enter",
  "unidentified",
]);

// Register the compact gear readout in the left HUD column (below the clock,
// above the training meters). The element is always registered; the `hidden`
// attribute collapses its slot while virtual shifting is off.
export function registerVirtualShiftHud() {
  registerHudComponent({ id: "virtual-shift", region: "left", weight: 15, element: els.virtualShiftHud });
}

// Boot-time setup: build the profile picker and resolve the default gear.
// restoreSettings() runs afterwards and re-applies any saved profile/gear.
export function initializeVirtualShifting() {
  populateProfileSelect();
  applyVirtualShiftProfile({ resetGear: false });
  syncVirtualShiftUi();
}

// Re-apply the current state after persistence has restored it.
export function applyVirtualShiftingState() {
  // A corrupt or legacy saved pair must never leave both shifters on one key.
  if (state.virtualShiftDownshiftKey === state.virtualShiftUpshiftKey) {
    state.virtualShiftUpshiftKey = state.virtualShiftDownshiftKey === DEFAULT_VIRTUAL_SHIFT_UPSHIFT_KEY
      ? DEFAULT_VIRTUAL_SHIFT_DOWNSHIFT_KEY
      : DEFAULT_VIRTUAL_SHIFT_UPSHIFT_KEY;
  }
  applyVirtualShiftProfile({ resetGear: false });
  syncVirtualShiftUi();
}

export function setVirtualShiftingEnabled(enabled) {
  const next = Boolean(enabled);
  if (next === state.virtualShiftingEnabled) return;
  state.virtualShiftingEnabled = next;
  if (next) applyVirtualShiftProfile({ resetGear: false });
  syncVirtualShiftUi();
  refreshTrainerResistance();
}

export function setVirtualGearProfile(profileId) {
  if (profileId === state.virtualGearProfileId) return;
  applyVirtualShiftProfile({ resetGear: true, profileId });
  syncVirtualShiftUi();
  refreshTrainerResistance();
}

export function shiftVirtualGearDown() {
  return shiftVirtualGear(-1);
}

export function shiftVirtualGearUp() {
  return shiftVirtualGear(1);
}

export function shiftVirtualGear(delta) {
  const profile = state.virtualGearProfile;
  if (!state.virtualShiftingEnabled || !profile?.gears.length) return false;
  const next = shiftGearIndex(state.virtualGearIndex, delta, profile.gears.length);
  if (next === state.virtualGearIndex) return false;
  state.virtualGearIndex = next;
  syncVirtualShiftUi();
  saveSettings();
  refreshTrainerResistance();
  return true;
}

// The grade actually sent to the trainer: the road grade plus the selected
// gear's offset. When virtual shifting is off this is simply the road grade.
export function trainerResistanceGrade(routeGradePercent) {
  if (!state.virtualShiftingEnabled) return routeGradePercent;
  const gear = currentGear();
  if (!gear) return routeGradePercent;
  return resistanceGradeWithOffset(routeGradePercent, gear.gradeOffsetPercent, {
    minPercent: GRADE_MIN_PERCENT,
    maxPercent: GRADE_MAX_PERCENT,
  });
}

// Push the current resistance right away (a shift while parked, or a settings
// change) instead of waiting for the next slow-UI tick.
export function refreshTrainerResistance() {
  if (state.demoModeActive || !state.route.length) return;
  const grade = gradeAt(state.route, state.progressMeters);
  queueTrainerGradeSample(trainerResistanceGrade(grade), {
    force: true,
    reset: true,
    intervalSeconds: state.gradeUpdateIntervalSeconds,
  });
}

// Document-level shifter. Registered before the app's global keydown handler
// so a key captured in Settings can stop that handler from also acting on it.
export function handleVirtualShiftKeydown(event) {
  // The capture buttons live in the Settings dialog; if it closed while one
  // was armed, a later keystroke must not silently become a shifter key.
  if (state.virtualShiftKeyCapture && !els.settingsDialog?.open) {
    cancelVirtualShiftKeyCapture();
  }
  if (state.virtualShiftKeyCapture) {
    handleKeyCapture(event);
    return;
  }
  if (!state.virtualShiftingEnabled) return;
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  if (isEditableTarget(event.target)) return;
  if (els.settingsDialog?.open || els.galleryDialog?.open) return;

  const key = normalizeShiftKey(event.key);
  const downKey = normalizeShiftKey(state.virtualShiftDownshiftKey);
  const upKey = normalizeShiftKey(state.virtualShiftUpshiftKey);
  if (key !== downKey && key !== upKey) return;

  event.preventDefault();
  if (event.repeat) return;
  if (key === downKey) shiftVirtualGear(-1);
  else shiftVirtualGear(1);
}

export function captureDownshiftKey() {
  beginKeyCapture("down");
}

export function captureUpshiftKey() {
  beginKeyCapture("up");
}

export function cancelVirtualShiftKeyCapture() {
  if (!state.virtualShiftKeyCapture) return;
  state.virtualShiftKeyCapture = null;
  syncVirtualShiftUi();
}

function beginKeyCapture(action) {
  const next = state.virtualShiftKeyCapture === action ? null : action;
  state.virtualShiftKeyCapture = next;
  syncVirtualShiftUi();
}

function handleKeyCapture(event) {
  if (event.repeat) return;

  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    state.virtualShiftKeyCapture = null;
    syncVirtualShiftUi();
    return;
  }

  const key = normalizeShiftKey(event.key);
  if (!key || NON_CAPTURABLE_KEYS.has(key)) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  assignShiftKey(state.virtualShiftKeyCapture, key);
  state.virtualShiftKeyCapture = null;
  syncVirtualShiftUi();
  saveSettings();
}

// Assign a captured key, swapping the other shifter if it already used it —
// both controls must always stay distinct.
function assignShiftKey(action, key) {
  const isDown = action === "down";
  const targetField = isDown ? "virtualShiftDownshiftKey" : "virtualShiftUpshiftKey";
  const otherField = isDown ? "virtualShiftUpshiftKey" : "virtualShiftDownshiftKey";
  const previous = state[targetField];
  if (state[otherField] === key) state[otherField] = previous;
  state[targetField] = key;
}

function applyVirtualShiftProfile({ resetGear = false, profileId = state.virtualGearProfileId } = {}) {
  const id = VIRTUAL_SHIFT_PROFILES?.[profileId] ? profileId : DEFAULT_VIRTUAL_SHIFT_PROFILE;
  const resolved = resolveGearProfile(VIRTUAL_SHIFT_PROFILES?.[id], {
    id,
    wheelCircumferenceMeters: VIRTUAL_SHIFT_WHEEL_CIRCUMFERENCE_METERS,
    gradeOffsetGain: VIRTUAL_SHIFT_GRADE_OFFSET_GAIN,
    overlapTolerance: VIRTUAL_SHIFT_GEAR_OVERLAP_TOLERANCE,
  });

  state.virtualGearProfileId = id;
  state.virtualGearProfile = resolved;
  state.virtualGearIndex = resolved
    ? resetGear || !Number.isFinite(state.virtualGearIndex)
      ? resolved.defaultIndex
      : clamp(Math.round(state.virtualGearIndex), 0, resolved.gears.length - 1)
    : 0;
  return resolved;
}

function currentGear() {
  const profile = state.virtualGearProfile;
  if (!profile?.gears.length) return null;
  const index = clamp(
    Number.isFinite(state.virtualGearIndex) ? Math.round(state.virtualGearIndex) : profile.defaultIndex,
    0,
    profile.gears.length - 1,
  );
  return profile.gears[index] ?? null;
}

function populateProfileSelect() {
  if (!els.virtualShiftProfileSelect) return;
  const options = Object.entries(VIRTUAL_SHIFT_PROFILES || {}).map(([id, profile]) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = typeof profile?.name === "string" && profile.name ? profile.name : id;
    return option;
  });
  els.virtualShiftProfileSelect.replaceChildren(...options);
  const selected = VIRTUAL_SHIFT_PROFILES?.[state.virtualGearProfileId]
    ? state.virtualGearProfileId
    : DEFAULT_VIRTUAL_SHIFT_PROFILE;
  els.virtualShiftProfileSelect.value = selected;
}

function syncVirtualShiftUi() {
  if (els.virtualShiftingInput) els.virtualShiftingInput.checked = state.virtualShiftingEnabled;
  if (els.virtualShiftProfileSelect) {
    els.virtualShiftProfileSelect.value = state.virtualGearProfileId;
    els.virtualShiftProfileSelect.title = state.virtualGearProfile?.name || "";
  }
  syncShiftKeyButtons();

  const profile = state.virtualGearProfile;
  const gear = currentGear();
  const visible = state.virtualShiftingEnabled && Boolean(profile && gear);
  if (els.virtualShiftPanel) els.virtualShiftPanel.hidden = !visible;
  if (els.virtualShiftHud) els.virtualShiftHud.hidden = !visible;
  if (!visible) return;

  const index = clamp(Math.round(state.virtualGearIndex), 0, profile.gears.length - 1);
  const gearLabel = `${gear.chainring}×${gear.cog}`;
  const offset = gear.gradeOffsetPercent;
  const offsetLabel = `${offset >= 0 ? "+" : ""}${offset.toFixed(1)}%`;
  const detail = `Gear ${index + 1}/${profile.gears.length} · ${offsetLabel} resistance`;
  const shortDetail = `GEAR ${index + 1}/${profile.gears.length} · ${offsetLabel}`;

  if (els.virtualShiftGear) els.virtualShiftGear.textContent = gearLabel;
  if (els.virtualShiftDetail) els.virtualShiftDetail.textContent = detail;
  if (els.virtualShiftHint) {
    els.virtualShiftHint.textContent =
      `${formatShiftKey(state.virtualShiftDownshiftKey)} down · ${formatShiftKey(state.virtualShiftUpshiftKey)} up`;
  }
  if (els.virtualShiftDownBtn) els.virtualShiftDownBtn.disabled = index <= 0;
  if (els.virtualShiftUpBtn) els.virtualShiftUpBtn.disabled = index >= profile.gears.length - 1;
  if (els.virtualShiftHudGear) els.virtualShiftHudGear.textContent = gearLabel;
  if (els.virtualShiftHudDetail) els.virtualShiftHudDetail.textContent = shortDetail;
}

function syncShiftKeyButtons() {
  const downLabel = state.virtualShiftKeyCapture === "down"
    ? "Press a key…"
    : `${formatShiftKey(state.virtualShiftDownshiftKey)} down`;
  const upLabel = state.virtualShiftKeyCapture === "up"
    ? "Press a key…"
    : `${formatShiftKey(state.virtualShiftUpshiftKey)} up`;
  if (els.virtualShiftDownKeyBtn) {
    els.virtualShiftDownKeyBtn.textContent = downLabel;
    els.virtualShiftDownKeyBtn.classList.toggle("capturing", state.virtualShiftKeyCapture === "down");
  }
  if (els.virtualShiftUpKeyBtn) {
    els.virtualShiftUpKeyBtn.textContent = upLabel;
    els.virtualShiftUpKeyBtn.classList.toggle("capturing", state.virtualShiftKeyCapture === "up");
  }
}

function isEditableTarget(target) {
  if (target?.isContentEditable) return true;
  const tag = target?.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  // A focused range/checkbox/button is not text entry: letting the shifter
  // work after the rider nudges the speed slider or a HUD switch is worth
  // more than reserving every input element.
  const type = String(target.type || "text").toLowerCase();
  return !["range", "checkbox", "radio", "button", "submit", "reset", "color"].includes(type);
}
