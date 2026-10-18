/** Vertical FOV (degrees, what Three.js wants) from a diagonal FOV and aspect ratio. */
export function verticalFovFromDiagonal(diagonalDeg: number, aspect: number): number {
  const d = Math.min(Math.max(diagonalDeg, 10), 170) * (Math.PI / 180);
  const h = 1 / Math.sqrt(1 + aspect * aspect); // screen height / diagonal
  return (2 * Math.atan(Math.tan(d / 2) * h) * 180) / Math.PI;
}
