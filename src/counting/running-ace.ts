/** Original `modules/strategy.js` RA: `acesLeft / (32 * decksLeft) - 1`.
 *  A full shoe is −0.875. This is not `acesLeft / (4 * decksLeft) - 1` (that is +0.00).
 */
export function runningAce(acesLeft: number, decksLeft: number): number {
  const expAces = 32 * decksLeft;
  return expAces > 0 ? acesLeft / expAces - 1 : 0;
}
