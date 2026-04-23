export type DiceState =
  | 'IDLE'
  | 'ROLLING'
  | 'FLYING'
  | 'IMPACT'
  | 'SETTLE'
  | 'WAITING'
  | 'WIN_GLOW';

export const ALL_FACES = [3, 6, 9, 12, 15, 18];
export const LOW_FACES = [3, 6, 9];

/**
 * Values shown on the top + right perspective faces for each front value.
 * Cycles through ALL_FACES so the die reads as a real 3D object with
 * distinct pips on every visible side.
 */
export const FACE_NEIGHBORS: Record<number, { top: number; right: number }> = {
  3: { top: 6, right: 9 },
  6: { top: 9, right: 12 },
  9: { top: 12, right: 15 },
  12: { top: 15, right: 18 },
  15: { top: 18, right: 3 },
  18: { top: 3, right: 6 },
};

/** Pip positions as fractions of face size, origin top-left of front face */
export function getPipPositions(value: number): [number, number][] {
  switch (value) {
    case 3:
      return [
        [0.25, 0.25],
        [0.5, 0.5],
        [0.75, 0.75],
      ];
    case 6:
      return [
        [0.3, 0.22],
        [0.7, 0.22],
        [0.3, 0.5],
        [0.7, 0.5],
        [0.3, 0.78],
        [0.7, 0.78],
      ];
    case 9:
      return [
        [0.25, 0.22],
        [0.5, 0.22],
        [0.75, 0.22],
        [0.25, 0.5],
        [0.5, 0.5],
        [0.75, 0.5],
        [0.25, 0.78],
        [0.5, 0.78],
        [0.75, 0.78],
      ];
    case 12:
      return [
        [0.25, 0.17],
        [0.5, 0.17],
        [0.75, 0.17],
        [0.25, 0.39],
        [0.5, 0.39],
        [0.75, 0.39],
        [0.25, 0.61],
        [0.5, 0.61],
        [0.75, 0.61],
        [0.25, 0.83],
        [0.5, 0.83],
        [0.75, 0.83],
      ];
    case 15:
      return [
        [0.25, 0.14],
        [0.5, 0.14],
        [0.75, 0.14],
        [0.25, 0.32],
        [0.5, 0.32],
        [0.75, 0.32],
        [0.25, 0.5],
        [0.5, 0.5],
        [0.75, 0.5],
        [0.25, 0.68],
        [0.5, 0.68],
        [0.75, 0.68],
        [0.25, 0.86],
        [0.5, 0.86],
        [0.75, 0.86],
      ];
    case 18:
      return [
        [0.25, 0.11],
        [0.5, 0.11],
        [0.75, 0.11],
        [0.25, 0.27],
        [0.5, 0.27],
        [0.75, 0.27],
        [0.25, 0.43],
        [0.5, 0.43],
        [0.75, 0.43],
        [0.25, 0.57],
        [0.5, 0.57],
        [0.75, 0.57],
        [0.25, 0.73],
        [0.5, 0.73],
        [0.75, 0.73],
        [0.25, 0.89],
        [0.5, 0.89],
        [0.75, 0.89],
      ];
    default:
      return [[0.5, 0.5]];
  }
}
