export type RatedGoal = { weight: number; rating: number | null };

export function weightedScore(goals: RatedGoal[]): number | null {
	const total = goals.reduce((sum, g) => sum + g.weight, 0);
	if (!goals.length || total <= 0 || goals.some((g) => g.rating === null)) return null;
	return Math.round((goals.reduce((sum, g) => sum + g.weight * g.rating!, 0) * 100) / total);
}

export const scoreLabel = (score: number) => (score / 100).toFixed(2);
