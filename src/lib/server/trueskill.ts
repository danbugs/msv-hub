const DEFAULT_MU = 25;
const DEFAULT_SIGMA = DEFAULT_MU / 3;
const BETA = DEFAULT_SIGMA / 2;
const TAU = DEFAULT_SIGMA / 100;
const SIGMA_FLOOR = DEFAULT_SIGMA / 6;
const POINTS_SCALE = 200;

export interface Rating {
	mu: number;
	sigma: number;
}

export function createRating(mu = DEFAULT_MU, sigma = DEFAULT_SIGMA): Rating {
	return { mu, sigma };
}

export function ratingToPoints(r: Rating): number {
	return Math.round(r.mu * POINTS_SCALE);
}

function gaussianPdf(x: number): number {
	return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function gaussianCdf(x: number): number {
	const t = 1 / (1 + 0.2316419 * Math.abs(x));
	const d = 0.3989422804014327;
	const p =
		d *
		t *
		(-0.3565638 +
			t * (1.781478 + t * (-1.8212560 + t * (1.3302744 + t * -1.8212560))));
	// Hart's approximation
	if (x >= 0) return 1 - p * Math.exp(-0.5 * x * x);
	return p * Math.exp(-0.5 * x * x);
}

// Rational approximation of erfc for higher accuracy CDF
function erfcApprox(x: number): number {
	const p = 0.3275911;
	const a1 = 0.254829592;
	const a2 = -0.284496736;
	const a3 = 1.421413741;
	const a4 = -1.453152027;
	const a5 = 1.061405429;

	const t = 1.0 / (1.0 + p * Math.abs(x));
	const t2 = t * t;
	const t3 = t2 * t;
	const t4 = t3 * t;
	const t5 = t4 * t;
	const val = (a1 * t + a2 * t2 + a3 * t3 + a4 * t4 + a5 * t5) * Math.exp(-x * x);
	return x >= 0 ? val : 2 - val;
}

function cdf(x: number): number {
	return 0.5 * erfcApprox(-x / Math.SQRT2);
}

function vFunc(t: number): number {
	const denom = cdf(t);
	if (denom < 1e-15) return -t;
	return gaussianPdf(t) / denom;
}

function wFunc(t: number, v: number): number {
	return v * (v + t);
}

export function rate1v1(winner: Rating, loser: Rating): { winner: Rating; loser: Rating } {
	const wSigma2 = winner.sigma * winner.sigma + TAU * TAU;
	const lSigma2 = loser.sigma * loser.sigma + TAU * TAU;
	const c = Math.sqrt(2 * BETA * BETA + wSigma2 + lSigma2);
	const t = (winner.mu - loser.mu) / c;
	const v = vFunc(t);
	const w = wFunc(t, v);

	const wMu = winner.mu + (wSigma2 / c) * v;
	const wSigma = Math.sqrt(wSigma2 * (1 - (wSigma2 / (c * c)) * w));
	const lMu = loser.mu - (lSigma2 / c) * v;
	const lSigma = Math.sqrt(lSigma2 * (1 - (lSigma2 / (c * c)) * w));

	return {
		winner: { mu: wMu, sigma: Math.max(wSigma, SIGMA_FLOOR) },
		loser: { mu: lMu, sigma: Math.max(lSigma, SIGMA_FLOOR) }
	};
}

export function matchQuality(a: Rating, b: Rating): number {
	const totalSigma2 = a.sigma * a.sigma + b.sigma * b.sigma + 2 * BETA * BETA;
	const muDiff = a.mu - b.mu;
	return Math.exp((-muDiff * muDiff) / (2 * totalSigma2)) * Math.sqrt((2 * BETA * BETA) / totalSigma2);
}

export { DEFAULT_MU, DEFAULT_SIGMA, BETA, TAU, SIGMA_FLOOR, POINTS_SCALE };
