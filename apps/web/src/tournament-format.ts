/** Points are in hundredths, like multipliers: 350 is 3.50 points. */
export function formatPoints(points: number): string {
  return (points / 100).toFixed(2);
}

export function describePlace(place: { rank: number | null; points: number } | null): string {
  if (!place || place.rank === null) {
    return 'No points yet';
  }

  return `#${place.rank} · ${formatPoints(place.points)} points`;
}
