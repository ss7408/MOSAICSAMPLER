// musicTheory.js
// Harmonic intelligence for Mosaic Sampler.
// Pure functions only: no audio, no UI state, no side effects.

export const NOTE_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

// Producer-friendly display names.
const PRETTY = {
  "C#": "C#",
  "D#": "Eb",
  "F#": "F#",
  "G#": "Ab",
  "A#": "Bb",
};

export const MODES = {
  MAJOR: "maj",
  MINOR: "min",
};

export const COMPATIBILITY_SCORES = {
  UNKNOWN: 50,
  SAME_KEY: 100,
  RELATIVE_MAJOR_MINOR: 88,
  ADJACENT_SAME_MODE: 84,
  ADJACENT_DIAGONAL: 70,
  TWO_AWAY_SAME_MODE: 58,
  TWO_AWAY_DIAGONAL: 48,
  DISTANT_BASE: 46,
  DISTANT_STEP_PENALTY: 7,
  DISTANT_MINIMUM: 8,
};

// Pitch-shift modes.
// Normal should preserve audio quality better.
// Aggressive is useful for creative/sample-flipping modes.
export const PITCH_SHIFT_RANGES = {
  normal: { min: -3, max: 3 },
  aggressive: { min: -7, max: 7 },
};

export function normalizePitchClass(pitchClass) {
  return ((pitchClass % 12) + 12) % 12;
}

export function isValidKey(key) {
  return (
    key &&
    Number.isInteger(key.tonic) &&
    key.tonic >= 0 &&
    key.tonic <= 11 &&
    (key.mode === MODES.MAJOR || key.mode === MODES.MINOR)
  );
}

export function noteName(pitchClass) {
  if (!Number.isFinite(pitchClass)) return "—";

  const raw = NOTE_NAMES[normalizePitchClass(pitchClass)];
  return PRETTY[raw] || raw;
}

// A key is { tonic: 0-11, mode: "maj" | "min" }.
export function keyLabel(key) {
  if (!isValidKey(key)) return "—";

  return `${noteName(key.tonic)} ${key.mode === MODES.MINOR ? "min" : "maj"}`;
}

export function keyShort(key) {
  if (!isValidKey(key)) return "—";

  return `${noteName(key.tonic)}${key.mode === MODES.MINOR ? "m" : ""}`;
}

// --- Camelot wheel -------------------------------------------------------
// DJ-standard harmonic mixing wheel.
// A = minor, B = major.
// Built from the canonical wheel: 8B = C major, 8A = A minor.

const CAMELOT = (() => {
  const map = {};

  // Major keys around the wheel starting at 8B = C major.
  // Moving by fifths advances the Camelot number.
  const majorOrder = [
    0,  // C
    7,  // G
    2,  // D
    9,  // A
    4,  // E
    11, // B
    6,  // F#
    1,  // C#
    8,  // G#
    3,  // D#
    10, // A#
    5,  // F
  ];

  majorOrder.forEach((tonic, i) => {
    const num = ((8 + i - 1) % 12) + 1;

    map[`${tonic}-${MODES.MAJOR}`] = {
      num,
      letter: "B",
    };

    // Relative minor shares the same Camelot number.
    const relativeMinorTonic = normalizePitchClass(tonic - 3);

    map[`${relativeMinorTonic}-${MODES.MINOR}`] = {
      num,
      letter: "A",
    };
  });

  return map;
})();

export function camelot(key) {
  if (!isValidKey(key)) return null;

  return CAMELOT[`${key.tonic}-${key.mode}`] || null;
}

export function camelotLabel(key) {
  const c = camelot(key);

  return c ? `${c.num}${c.letter}` : "—";
}

function wheelDistance(a, b) {
  const d = Math.abs(a - b) % 12;

  return Math.min(d, 12 - d);
}

// --- Compatibility scoring ----------------------------------------------
// Returns 0-100.
// 100 = same key.
// Unknown/percussive material returns neutral compatibility.

export function compatibilityScore(keyA, keyB) {
  if (!isValidKey(keyA) || !isValidKey(keyB)) {
    return COMPATIBILITY_SCORES.UNKNOWN;
  }

  const ca = camelot(keyA);
  const cb = camelot(keyB);

  if (!ca || !cb) {
    return COMPATIBILITY_SCORES.UNKNOWN;
  }

  const sameNumber = ca.num === cb.num;
  const sameLetter = ca.letter === cb.letter;

  if (sameNumber && sameLetter) {
    return COMPATIBILITY_SCORES.SAME_KEY;
  }

  // Relative major/minor.
  // Example: C major and A minor.
  if (sameNumber) {
    return COMPATIBILITY_SCORES.RELATIVE_MAJOR_MINOR;
  }

  const dist = wheelDistance(ca.num, cb.num);

  if (dist === 1 && sameLetter) {
    return COMPATIBILITY_SCORES.ADJACENT_SAME_MODE;
  }

  if (dist === 1) {
    return COMPATIBILITY_SCORES.ADJACENT_DIAGONAL;
  }

  if (dist === 2 && sameLetter) {
    return COMPATIBILITY_SCORES.TWO_AWAY_SAME_MODE;
  }

  if (dist === 2) {
    return COMPATIBILITY_SCORES.TWO_AWAY_DIAGONAL;
  }

  return Math.max(
    COMPATIBILITY_SCORES.DISTANT_MINIMUM,
    COMPATIBILITY_SCORES.DISTANT_BASE -
      dist * COMPATIBILITY_SCORES.DISTANT_STEP_PENALTY
  );
}

export function compatibilityTier(score) {
  if (score >= 86) {
    return { tier: "perfect", label: "Locks in" };
  }

  if (score >= 70) {
    return { tier: "good", label: "Plays nice" };
  }

  if (score >= 50) {
    return { tier: "ok", label: "Workable" };
  }

  return { tier: "clash", label: "Clashes" };
}

// Transpose a key by N semitones.
export function transposeKey(key, semitones) {
  if (!isValidKey(key) || !Number.isFinite(semitones)) return null;

  return {
    tonic: normalizePitchClass(key.tonic + semitones),
    mode: key.mode,
  };
}

// --- Pitch suggestion ----------------------------------------------------
// Finds the best pitch shift for a sample against the project key.
//
// Important distinction:
// This does not turn minor into major or major into minor.
// It only transposes the sample while preserving its mode.
//
// Options:
// - mode: "normal" | "aggressive"
// - pitchPenalty: subtracts points for large pitch moves
//
// Example:
// suggestPitchShift(sampleKey, projectKey, { mode: "normal", pitchPenalty: 4 })

export function suggestPitchShift(
  sampleKey,
  projectKey,
  options = {}
) {
  if (!isValidKey(sampleKey) || !isValidKey(projectKey)) {
    return {
      shift: 0,
      score: COMPATIBILITY_SCORES.UNKNOWN,
      rawScore: COMPATIBILITY_SCORES.UNKNOWN,
      adjustedScore: COMPATIBILITY_SCORES.UNKNOWN,
      resultingKey: isValidKey(sampleKey) ? sampleKey : null,
    };
  }

  const {
    mode = "normal",
    pitchPenalty = 4,
  } = options;

  const range = PITCH_SHIFT_RANGES[mode] || PITCH_SHIFT_RANGES.normal;

  let best = null;

  for (let shift = range.min; shift <= range.max; shift++) {
    const resultingKey = transposeKey(sampleKey, shift);
    const rawScore = compatibilityScore(resultingKey, projectKey);
    const adjustedScore = rawScore - Math.abs(shift) * pitchPenalty;

    const candidate = {
      shift,
      score: rawScore,
      rawScore,
      adjustedScore,
      resultingKey,
    };

    if (
      !best ||
      candidate.adjustedScore > best.adjustedScore ||
      (
        candidate.adjustedScore === best.adjustedScore &&
        Math.abs(candidate.shift) < Math.abs(best.shift)
      )
    ) {
      best = candidate;
    }
  }

  return best;
}

// Helper for UI copy.
export function pitchShiftLabel(shift) {
  if (!Number.isFinite(shift) || shift === 0) return "No shift";

  return shift > 0 ? `+${shift} semitones` : `${shift} semitones`;
}

// Useful for dropdowns, testing, and key selectors.
export const ALL_KEYS = (() => {
  const keys = [];

  for (let tonic = 0; tonic < 12; tonic++) {
    keys.push({ tonic, mode: MODES.MINOR });
    keys.push({ tonic, mode: MODES.MAJOR });
  }

  return keys;
})();
