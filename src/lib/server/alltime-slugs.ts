export interface AllTimeEventConfig {
	slug: string;
	weight: number;
	singlesOnly?: boolean;
}

const SPECIAL_SLUGS: Record<number, string> = {
	3: '3-special-edition',
	17: '17-bobc-pre-pre-pre-pre-local',
	29: '29-3',
	34: '34-1',
	46: '46-1',
	49: '49-squad-strike-edition',
	50: '50-crew-battle-edition-1',
	58: '58-1',
	73: '73-1',
	88: '88-burnout-edition',
	90: '90-northeastern-invitational',
	102: '102-1'
};

const REDUCED_WEIGHT: Record<number, number> = {
	49: 0.5,
	88: 0.5,
	90: 0.75
};

const SINGLES_ONLY = new Set([50]);

export function getAllTimeEvents(): AllTimeEventConfig[] {
	const events: AllTimeEventConfig[] = [];

	events.push({ slug: 'microspacing-vancouver-prologue', weight: 1.0 });

	for (let i = 1; i <= 138; i++) {
		const suffix = SPECIAL_SLUGS[i] ?? String(i);
		events.push({
			slug: `microspacing-vancouver-${suffix}`,
			weight: REDUCED_WEIGHT[i] ?? 1.0,
			singlesOnly: SINGLES_ONLY.has(i) || undefined
		});
	}

	const macroSlugs = [
		'macrospacing-vancouver-0',
		'macrospacing-vancouver-1',
		'macrospacing-vancouver-2',
		'macrospacing-vancouver-3-battle-of-bc-6-monday-pre-local',
		'macrospacing-vancouver-4',
		'macrospacing-vancouver-5-battle-of-bc-7-monday-pre-local',
		'macrospacing-vancouver-6'
	];
	for (const slug of macroSlugs) {
		events.push({ slug, weight: 1.0 });
	}

	return events;
}
