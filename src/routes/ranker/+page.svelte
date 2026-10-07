<script lang="ts">
	import { onMount } from 'svelte';
	import { track } from '$lib/analytics';
	import type { RankerPlayer } from './+page.server';

	let { data } = $props();

	interface Tier {
		id: string;
		label: string;
		color: string;
		items: string[];
	}

	const DEFAULT_TIERS: Omit<Tier, 'items'>[] = [
		{ id: 's', label: 'S', color: '#bb3437' },
		{ id: 'a', label: 'A', color: '#f19b38' },
		{ id: 'b', label: 'B', color: '#339a35' },
		{ id: 'c', label: 'C', color: '#1558ff' },
		{ id: 'd', label: 'D', color: '#7a35b0' },
		{ id: 'e', label: 'E', color: '#474747' }
	];
	const DEFAULT_TITLE = 'My MSV Tier List';
	const POOL = 'pool';

	const freshTiers = (): Tier[] => DEFAULT_TIERS.map((t) => ({ ...t, items: [] }));

	let tiers = $state<Tier[]>(freshTiers());
	let title = $state(DEFAULT_TITLE);
	let search = $state('');
	let sortBy = $state<'rank' | 'name'>('rank');
	// '' = any, NO_CHAR = players without character data, otherwise a character name
	let charFilter = $state('');
	const NO_CHAR = '__none__';
	let editRows = $state(false);
	let poolOpen = $state(true);
	// Ordered so a bulk move keeps the order players were picked (or the pool's order for "select all")
	let selected = $state<string[]>([]);
	let selectMode = $state(false);
	const selectedSet = $derived(new Set(selected));
	let exporting = $state(false);
	let loaded = $state(false);

	const byId = $derived(new Map<string, RankerPlayer>(data.players.map((p: RankerPlayer) => [p.id, p])));
	const placed = $derived(new Set(tiers.flatMap((t) => t.items)));
	const pool = $derived.by(() => {
		const q = search.trim().toLowerCase();
		const list = data.players.filter((p: RankerPlayer) =>
			!placed.has(p.id) &&
			(!q || p.tag.toLowerCase().includes(q)) &&
			(!charFilter || (charFilter === NO_CHAR ? !p.character : p.character === charFilter))
		);
		return sortBy === 'name' ? [...list].sort((a, b) => a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base' })) : list;
	});
	const remaining = $derived(data.players.length - placed.size);
	const characterOptions = $derived.by(() => {
		const counts = new Map<string, number>();
		let none = 0;
		for (const p of data.players as RankerPlayer[]) {
			if (p.character) counts.set(p.character, (counts.get(p.character) ?? 0) + 1);
			else none++;
		}
		return { chars: [...counts].sort((a, b) => a[0].localeCompare(b[0])), none };
	});

	const STORAGE_KEY = 'msv-ranker';

	onMount(() => {
		track('ranker');
		try {
			// Boards used to be saved per season (msv-ranker:<id>); pick up the newest one if that's all there is
			const legacy = Object.keys(localStorage).filter((k) => k.startsWith(`${STORAGE_KEY}:`)).sort().pop();
			const raw = localStorage.getItem(STORAGE_KEY) ?? (legacy ? localStorage.getItem(legacy) : null);
			if (raw) {
				const saved = JSON.parse(raw) as { title?: string; tiers?: Tier[] };
				if (saved.title) title = saved.title;
				if (Array.isArray(saved.tiers) && saved.tiers.length) {
					const seen = new Set<string>();
					tiers = saved.tiers.map((t) => ({
						...t,
						// Drop players who fell out of the eligible pool since the board was saved
						items: t.items.filter((id) => byId.has(id) && !seen.has(id) && seen.add(id))
					}));
				}
			}
		} catch {
			// Corrupt or blocked storage just means starting fresh
		}
		loaded = true;
	});

	$effect(() => {
		const snapshot = JSON.stringify({ title, tiers });
		if (!loaded) return;
		try {
			localStorage.setItem(STORAGE_KEY, snapshot);
		} catch {
			// Private mode / quota — the board still works for this visit
		}
	});

	function tierOf(id: string): Tier | undefined {
		return tiers.find((t) => t.items.includes(id));
	}

	// `index` is a position in the target row once the moving players have been taken out of it
	function moveMany(ids: string[], target: string, index?: number) {
		const moving = new Set(ids);
		for (const t of tiers) {
			if (t.items.some((x) => moving.has(x))) t.items = t.items.filter((x) => !moving.has(x));
		}
		if (target === POOL) return;
		const t = tiers.find((t) => t.id === target);
		if (!t) return;
		t.items.splice(index ?? t.items.length, 0, ...ids);
	}

	function clearSelection() {
		selected = [];
		selectMode = false;
	}

	function toggleSelected(id: string) {
		selected = selectedSet.has(id) ? selected.filter((x) => x !== id) : [...selected, id];
	}

	function selectAllInPool() {
		const extra = pool.map((p: RankerPlayer) => p.id).filter((id: string) => !selectedSet.has(id));
		selected = [...selected, ...extra];
	}

	// ── Drag & drop ─────────────────────────────────────────────
	// Pointer events rather than HTML5 DnD, which doesn't fire on touch screens.
	// Touch drags start after a short hold so a quick swipe still scrolls the page.

	const LONG_PRESS_MS = 180;
	const MOUSE_THRESHOLD = 4;
	const TOUCH_SLOP = 8;

	type DragKind = 'card' | 'row';
	// `ids` is the group being carried: just `id`, or the whole selection when dragging a selected card
	let drag = $state<{ kind: DragKind; id: string; ids: string[]; x: number; y: number } | null>(null);
	const dragIds = $derived(new Set(drag?.kind === 'card' ? drag.ids : []));
	let dropTarget = $state<{ zone: string; index: number } | null>(null);
	let rowTarget = $state<number | null>(null);
	const otherRows = $derived(drag?.kind === 'row' ? tiers.filter((t) => t.id !== drag!.id) : tiers);
	let pending: { kind: DragKind; id: string; x: number; y: number; touch: boolean; timer?: ReturnType<typeof setTimeout> } | null = null;
	let suppressClick = false;
	let poolEl: HTMLElement | undefined = $state();
	let scrollRaf = 0;

	function onDragPointerDown(e: PointerEvent, kind: DragKind, id: string) {
		if (e.button !== 0) return;
		if (kind === 'row') e.stopPropagation();
		const touch = e.pointerType !== 'mouse';
		pending = { kind, id, x: e.clientX, y: e.clientY, touch };
		if (touch) {
			pending.timer = setTimeout(() => {
				if (pending) startDrag(pending.kind, pending.id, pending.x, pending.y);
			}, LONG_PRESS_MS);
		}
		window.addEventListener('pointermove', onPointerMove);
		window.addEventListener('pointerup', onPointerUp);
		window.addEventListener('pointercancel', cancelPointer);
	}

	function startDrag(kind: DragKind, id: string, x: number, y: number) {
		if (pending?.timer) clearTimeout(pending.timer);
		pending = null;
		const group = kind === 'card' && selectedSet.has(id) && selected.length > 1;
		drag = { kind, id, ids: group ? [...selected] : [id], x, y };
		if (kind === 'card') clearSelection();
		navigator.vibrate?.(10);
		updateDropTarget(x, y);
		scrollRaf = requestAnimationFrame(autoScroll);
	}

	function onPointerMove(e: PointerEvent) {
		if (pending) {
			const dist = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
			if (pending.touch) {
				// Finger moved before the hold completed: this is a scroll, not a drag
				if (dist > TOUCH_SLOP) cancelPointer();
				else { pending.x = e.clientX; pending.y = e.clientY; }
			} else if (dist > MOUSE_THRESHOLD) {
				startDrag(pending.kind, pending.id, e.clientX, e.clientY);
			}
			return;
		}
		if (!drag) return;
		drag.x = e.clientX;
		drag.y = e.clientY;
		updateDropTarget(e.clientX, e.clientY);
	}

	function onPointerUp() {
		if (drag) {
			if (drag.kind === 'card' && dropTarget) moveMany(drag.ids, dropTarget.zone, dropTarget.index);
			if (drag.kind === 'row' && rowTarget !== null) moveRowTo(drag.id, rowTarget);
			suppressClick = true;
			setTimeout(() => (suppressClick = false), 0);
		}
		cancelPointer();
	}

	function cancelPointer() {
		if (pending?.timer) clearTimeout(pending.timer);
		pending = null;
		drag = null;
		dropTarget = null;
		rowTarget = null;
		cancelAnimationFrame(scrollRaf);
		window.removeEventListener('pointermove', onPointerMove);
		window.removeEventListener('pointerup', onPointerUp);
		window.removeEventListener('pointercancel', cancelPointer);
	}

	function updateDropTarget(x: number, y: number) {
		if (drag?.kind === 'row') {
			// Position among the other rows by vertical midpoint
			const rows = [...document.querySelectorAll<HTMLElement>('[data-row]')].filter((r) => r.dataset.row !== drag!.id);
			const i = rows.findIndex((r) => {
				const b = r.getBoundingClientRect();
				return y < b.top + b.height / 2;
			});
			rowTarget = i === -1 ? rows.length : i;
			return;
		}
		const zoneEl = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-zone]');
		if (!zoneEl || !drag) {
			dropTarget = null;
			return;
		}
		const zone = zoneEl.dataset.zone!;
		if (zone === POOL) {
			dropTarget = { zone, index: 0 };
			return;
		}
		// Index among the row's cards excluding the ones being dragged, in reading order
		const cards = [...zoneEl.querySelectorAll<HTMLElement>('[data-card]')].filter((c) => !dragIds.has(c.dataset.card!));
		let index = cards.length;
		for (let i = 0; i < cards.length; i++) {
			const r = cards[i].getBoundingClientRect();
			if (y < r.top || (y <= r.bottom && x < r.left + r.width / 2)) {
				index = i;
				break;
			}
		}
		dropTarget = { zone, index };
	}

	function autoScroll() {
		if (!drag) return;
		const edge = 70;
		const fixedPool = poolEl && getComputedStyle(poolEl).position === 'fixed';
		const bottom = fixedPool ? poolEl!.getBoundingClientRect().top : window.innerHeight;
		let dy = 0;
		if (drag.y < edge) dy = -Math.ceil((edge - drag.y) / 5);
		else if (drag.y > bottom - edge && drag.y < bottom) dy = Math.ceil((drag.y - (bottom - edge)) / 5);
		if (dy) {
			window.scrollBy(0, dy);
			updateDropTarget(drag.x, drag.y);
		}
		scrollRaf = requestAnimationFrame(autoScroll);
	}

	onMount(() => {
		// Pointer events can't stop a touch scroll once a drag is live; a non-passive touchmove can
		const block = (e: TouchEvent) => {
			if (drag) e.preventDefault();
		};
		window.addEventListener('touchmove', block, { passive: false });
		return () => {
			window.removeEventListener('touchmove', block);
			cancelPointer();
		};
	});

	// ── Tap to place (also the keyboard path, and how bulk moves work) ─────
	// Select mode, or Ctrl/Cmd/Shift-click, toggles players in and out of the selection.
	// Otherwise a tap selects one player, and tapping a row (or a placed player) moves the selection there.

	function onCardClick(e: MouseEvent, id: string) {
		e.stopPropagation();
		if (suppressClick) return;
		if (selectMode || e.ctrlKey || e.metaKey || e.shiftKey) {
			toggleSelected(id);
			return;
		}
		if (!selected.length || selectedSet.has(id)) {
			selected = selectedSet.has(id) && selected.length === 1 ? [] : [id];
			return;
		}
		const t = tierOf(id);
		if (t) {
			const before = t.items.filter((x) => !selectedSet.has(x)).indexOf(id);
			moveMany(selected, t.id, before);
			clearSelection();
		} else {
			selected = [id];
		}
	}

	function onZoneClick(zone: string) {
		if (!selected.length || suppressClick) return;
		moveMany(selected, zone);
		clearSelection();
	}

	// In select mode a row's label grabs (or releases) everyone in that row
	function onLabelClick(tier: Tier) {
		if (!selectMode || suppressClick || !tier.items.length) return;
		const all = tier.items.every((x) => selectedSet.has(x));
		selected = all
			? selected.filter((x) => !tier.items.includes(x))
			: [...selected, ...tier.items.filter((x) => !selectedSet.has(x))];
	}

	// Closed hand only while something is actually being carried
	$effect(() => {
		document.body.classList.toggle('dragging', !!drag);
		return () => document.body.classList.remove('dragging');
	});

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && (selected.length || selectMode)) clearSelection();
	}

	// ── Rows ─────────────────────────────────────────────────

	function addRow() {
		tiers.push({ id: `row-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, label: 'New', color: '#64748b', items: [] });
		editRows = true;
	}

	function removeRow(id: string) {
		tiers = tiers.filter((t) => t.id !== id);
	}

	function moveRowTo(id: string, index: number) {
		const from = tiers.findIndex((t) => t.id === id);
		if (from === -1) return;
		const [row] = tiers.splice(from, 1);
		tiers.splice(index, 0, row);
	}

	function moveRow(i: number, dir: -1 | 1) {
		const j = i + dir;
		if (j < 0 || j >= tiers.length) return;
		[tiers[i], tiers[j]] = [tiers[j], tiers[i]];
	}

	function clearBoard() {
		if (!placed.size || confirm('Move every player back to the pool?')) {
			for (const t of tiers) t.items = [];
		}
	}

	function resetBoard() {
		if (confirm('Reset rows, title, and placements to defaults?')) {
			tiers = freshTiers();
			title = DEFAULT_TITLE;
			editRows = false;
		}
	}

	// ── Export ───────────────────────────────────────────────

	function loadImage(url: string): Promise<HTMLImageElement | null> {
		return new Promise((resolve) => {
			const img = new Image();
			img.crossOrigin = 'anonymous';
			img.onload = () => resolve(img);
			img.onerror = () => resolve(null);
			// StartGG only sends CORS headers when asked and doesn't Vary on Origin, so a copy
			// cached from a plain <img> (e.g. the league page) fails the CORS check on Safari.
			// A distinct URL forces a fresh CORS-enabled fetch.
			const u = new URL(url);
			u.searchParams.set('cors', '1');
			img.src = u.href;
		});
	}

	// Shrink to fit on one line, then fall back to two lines, then ellipsize
	function fitName(ctx: CanvasRenderingContext2D, text: string, maxW: number, font: string): { lines: string[]; size: number } {
		for (let size = 15; size >= 11; size--) {
			ctx.font = `700 ${size}px ${font}`;
			if (ctx.measureText(text).width <= maxW) return { lines: [text], size };
		}
		const size = 11;
		ctx.font = `700 ${size}px ${font}`;
		const words = text.split(/\s+/);
		let first = '';
		let rest = text;
		if (words.length > 1) {
			for (let i = words.length - 1; i > 0; i--) {
				const candidate = words.slice(0, i).join(' ');
				if (ctx.measureText(candidate).width <= maxW) {
					first = candidate;
					rest = words.slice(i).join(' ');
					break;
				}
			}
		}
		if (!first) {
			// Single long word: hard-break by characters
			let n = text.length;
			while (n > 1 && ctx.measureText(text.slice(0, n)).width > maxW) n--;
			first = text.slice(0, n);
			rest = text.slice(n);
		}
		if (ctx.measureText(rest).width > maxW) {
			while (rest.length > 1 && ctx.measureText(rest + '…').width > maxW) rest = rest.slice(0, -1);
			rest += '…';
		}
		return { lines: [first, rest], size };
	}

	function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number | number[]) {
		ctx.beginPath();
		if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
		else ctx.rect(x, y, w, h);
	}

	async function exportImage() {
		exporting = true;
		try {
			const font = getComputedStyle(document.body).fontFamily || 'sans-serif';
			const W = 1200, PAD = 24, LABEL_W = 110, GAP = 6, CARD_W = 96, NAME_H = 30, CARD_H = CARD_W + NAME_H, ROW_GAP = 8;
			const TITLE_H = 70, FOOTER_H = 36;
			const contentW = W - PAD * 2 - LABEL_W;
			const perLine = Math.max(1, Math.floor((contentW - GAP) / (CARD_W + GAP)));
			const rowHeights = tiers.map((t) => {
				const lines = Math.max(1, Math.ceil(t.items.length / perLine));
				return lines * CARD_H + (lines + 1) * GAP;
			});
			const H = TITLE_H + rowHeights.reduce((a, b) => a + b + ROW_GAP, 0) + FOOTER_H;

			const urls = [...new Set(tiers.flatMap((t) => t.items.map((id) => byId.get(id)?.iconUrl).filter(Boolean)))] as string[];
			const images = new Map(await Promise.all(urls.map(async (u) => [u, await loadImage(u)] as const)));

			const scale = 2;
			const canvas = document.createElement('canvas');
			canvas.width = W * scale;
			canvas.height = H * scale;
			const ctx = canvas.getContext('2d')!;
			ctx.scale(scale, scale);

			ctx.fillStyle = '#1f1f1f';
			ctx.fillRect(0, 0, W, H);
			ctx.fillStyle = '#ffffff';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.font = `600 30px ${font}`;
			ctx.fillText(title || DEFAULT_TITLE, W / 2, TITLE_H / 2 + 4, W - PAD * 2);

			let y = TITLE_H;
			tiers.forEach((t, ti) => {
				const h = rowHeights[ti];
				ctx.fillStyle = '#141414';
				roundRect(ctx, PAD, y, W - PAD * 2, h, 10);
				ctx.fill();
				ctx.fillStyle = t.color;
				roundRect(ctx, PAD, y, LABEL_W, h, [10, 0, 0, 10]);
				ctx.fill();
				ctx.fillStyle = '#ffffff';
				ctx.font = `800 ${t.label.length > 3 ? 18 : 28}px ${font}`;
				ctx.fillText(t.label, PAD + LABEL_W / 2, y + h / 2, LABEL_W - 12);

				t.items.forEach((id, i) => {
					const p = byId.get(id);
					if (!p) return;
					const cx = PAD + LABEL_W + GAP + (i % perLine) * (CARD_W + GAP);
					const cy = y + GAP + Math.floor(i / perLine) * (CARD_H + GAP);
					ctx.fillStyle = '#2a2a2a';
					roundRect(ctx, cx, cy, CARD_W, CARD_H, 6);
					ctx.fill();
					const img = p.iconUrl ? images.get(p.iconUrl) : null;
					if (img) {
						ctx.drawImage(img, cx + 2, cy + NAME_H, CARD_W - 4, CARD_W - 4);
					} else {
						ctx.fillStyle = '#9ca3af';
						ctx.font = `800 34px ${font}`;
						ctx.fillText(p.tag.slice(0, 2).toUpperCase(), cx + CARD_W / 2, cy + NAME_H + CARD_W / 2);
					}
					const { lines, size } = fitName(ctx, p.tag, CARD_W - 8, font);
					ctx.fillStyle = '#ffffff';
					ctx.font = `700 ${size}px ${font}`;
					const lineH = size + 1;
					const top = cy + NAME_H / 2 - ((lines.length - 1) * lineH) / 2;
					lines.forEach((l, li) => ctx.fillText(l, cx + CARD_W / 2, top + li * lineH));
				});
				y += h + ROW_GAP;
			});

			ctx.fillStyle = '#8a8a8a';
			ctx.font = `500 14px ${font}`;
			ctx.textAlign = 'right';
			ctx.fillText(`${data.season?.name ?? ''} · msv-hub.vercel.app/ranker`, W - PAD, H - FOOTER_H / 2);

			const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
			if (!blob) throw new Error('Could not render image');
			const filename = `${(title || 'tier-list').replace(/[^\w-]+/g, '-').toLowerCase()}.png`;
			const file = new File([blob], filename, { type: 'image/png' });
			track('ranker', 'export');
			// Phones get the native share sheet so the image can go straight to Photos / Discord
			if (matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] })) {
				try {
					await navigator.share({ files: [file], title: title || DEFAULT_TITLE });
					return;
				} catch (err) {
					if ((err as Error).name === 'AbortError') return;
				}
			}
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = filename;
			a.click();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		} catch (err) {
			alert(`Export failed: ${(err as Error).message}`);
		} finally {
			exporting = false;
		}
	}

	function nameSize(tag: string): string {
		if (tag.length <= 7) return 'text-[11px]';
		if (tag.length <= 11) return 'text-[10px]';
		return 'text-[9px]';
	}
</script>

<svelte:window onkeydown={onKeydown} />

<svelte:head>
	<title>Tier List Maker — MSV League</title>
	<meta name="description" content="Rank Microspacing Vancouver players and export your tier list." />
</svelte:head>

{#snippet card(p: RankerPlayer, ghost = false)}
	<div class="flex h-full w-full flex-col overflow-hidden rounded-md bg-secondary shadow-sm {ghost ? 'ring-2 ring-primary shadow-xl' : ''}">
		<div class="flex h-[24px] shrink-0 items-center justify-center px-0.5 sm:h-[26px]">
			<span class="line-clamp-2 text-center font-bold leading-[1.05] text-foreground [overflow-wrap:anywhere] {nameSize(p.tag)}">{p.tag}</span>
		</div>
		<div class="relative min-h-0 flex-1">
			{#if p.iconUrl}
				<img src={p.iconUrl} alt={p.character ?? ''} draggable="false" loading="lazy"
					class="absolute inset-0 h-full w-full object-contain" />
			{:else}
				<div class="absolute inset-0 flex items-center justify-center text-lg font-extrabold text-muted-foreground">
					{p.tag.slice(0, 2).toUpperCase()}
				</div>
			{/if}
		</div>
	</div>
{/snippet}

{#snippet slot(id: string, inTier: boolean)}
	{@const p = byId.get(id)}
	{#if p}
		<button type="button" data-card={id}
			title="{p.tag}{p.character ? ` · ${p.character}` : ''} · #{p.rank}"
			onpointerdown={(e) => onDragPointerDown(e, 'card', id)}
			onclick={(e) => onCardClick(e, id)}
			oncontextmenu={(e) => e.preventDefault()}
			class="card relative h-[84px] w-[60px] shrink-0 cursor-pointer rounded-md transition-[opacity,transform] sm:h-[100px] sm:w-[74px]
				{dragIds.has(id) ? 'opacity-30' : ''}
				{selectedSet.has(id) ? 'ring-2 ring-primary ring-offset-2 ring-offset-background -translate-y-0.5' : ''}"
			aria-pressed={selectMode ? selectedSet.has(id) : undefined}>
			{@render card(p)}
			{#if selectMode || selectedSet.has(id)}
				<span class="absolute bottom-0.5 left-0.5 flex h-4 w-4 items-center justify-center rounded-full border text-[10px] font-bold leading-none
					{selectedSet.has(id) ? 'border-primary bg-primary text-primary-foreground' : 'border-white/70 bg-black/50'}" aria-hidden="true">
					{selectedSet.has(id) ? '✓' : ''}
				</span>
			{/if}
			{#if !inTier}
				<span class="absolute bottom-0.5 right-0.5 rounded bg-black/60 px-1 text-[9px] font-semibold text-white">#{p.rank}</span>
			{/if}
		</button>
	{/if}
{/snippet}

{#snippet indicator()}
	<div class="h-[84px] w-1 shrink-0 self-center rounded-full bg-primary sm:h-[100px]"></div>
{/snippet}

<div class="min-h-screen bg-background pb-[44vh] text-foreground lg:pb-0">
	<div class="border-b border-border bg-card/90 backdrop-blur-md">
		<div class="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-4">
			<div class="min-w-0">
				<h1 class="text-xl font-bold text-primary">Tier List Maker</h1>
				<p class="truncate text-sm text-muted-foreground">
					{data.season?.name ?? 'No active season'} · {data.players.length} players
				</p>
			</div>
			<a href="/league" class="shrink-0 rounded-md bg-secondary px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
				← Rankings
			</a>
		</div>
	</div>

	{#if !data.season}
		<div class="mx-auto max-w-3xl px-4 py-12 text-center text-muted-foreground">No season data yet.</div>
	{:else}
		<div class="mx-auto max-w-7xl px-4 py-4 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-6">
			<!-- Board -->
			<section class="min-w-0">
				<div class="mb-3 flex flex-wrap items-center justify-center gap-2">
					<button onclick={exportImage} disabled={exporting}
						class="rounded-md bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
						{exporting ? 'Rendering…' : 'Export image'}
					</button>
					<button onclick={() => (editRows = !editRows)}
						class="rounded-md px-3 py-1.5 text-sm font-medium {editRows ? 'bg-foreground text-background' : 'bg-secondary text-foreground hover:bg-accent'}">
						{editRows ? 'Done editing' : 'Edit rows'}
					</button>
					<button onclick={clearBoard} class="rounded-md bg-secondary px-3 py-1.5 text-sm font-medium text-foreground hover:bg-accent">Clear</button>
					<button onclick={resetBoard} class="rounded-md bg-destructive-muted px-3 py-1.5 text-sm font-medium text-destructive hover:opacity-90">Reset</button>
				</div>

				<input bind:value={title} maxlength="60" aria-label="Tier list title" placeholder={DEFAULT_TITLE}
					class="mb-3 w-full bg-transparent text-center text-2xl font-semibold tracking-wide text-foreground outline-none focus:underline decoration-primary/50 underline-offset-4" />

				{#if selected.length || selectMode}
					<div class="sticky top-2 z-20 mb-3 flex items-center justify-between gap-2 rounded-md border border-primary/40 bg-card/95 px-3 py-2 text-sm shadow-sm backdrop-blur">
						<span class="min-w-0 truncate">
							{#if !selected.length}
								Tap players to select them, or a row's label to grab the whole row
							{:else if selected.length === 1}
								Tap a row to place <strong>{byId.get(selected[0])?.tag}</strong>{tierOf(selected[0]) ? ', or the pool to remove' : ''}
							{:else}
								Tap a row to move <strong>{selected.length} players</strong>
							{/if}
						</span>
						<button onclick={clearSelection} class="shrink-0 text-xs text-muted-foreground hover:text-foreground">Cancel</button>
					</div>
				{/if}

				<div class="flex flex-col gap-2">
					{#each tiers as tier, ti (tier.id)}
						{@const others = tier.items.filter((x) => !dragIds.has(x))}
						{@const target = dropTarget?.zone === tier.id ? dropTarget.index : -1}
						{#if rowTarget !== null && tier.id !== drag?.id && otherRows.indexOf(tier) === rowTarget}
							<div class="h-1 rounded-full bg-primary"></div>
						{/if}
						<div data-row={tier.id} class="flex overflow-hidden rounded-lg bg-[#141414] transition-opacity {drag?.kind === 'row' && drag.id === tier.id ? 'opacity-30' : ''}">
							<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
							<div class="flex w-16 shrink-0 flex-col items-center justify-center gap-1 p-1 sm:w-24 {editRows ? '' : `grab ${selectMode ? 'cursor-pointer' : ''}`}"
								style="background:{tier.color}"
								title={editRows ? undefined : selectMode ? 'Tap to select everyone in this row' : 'Drag to reorder row'}
								onpointerdown={editRows ? undefined : (e) => onDragPointerDown(e, 'row', tier.id)}
								onclick={() => onLabelClick(tier)}
								oncontextmenu={(e) => { if (!editRows) e.preventDefault(); }}>
								{#if editRows}
									<input bind:value={tier.label} maxlength="12" aria-label="Row label"
										class="w-full rounded bg-black/25 px-1 py-0.5 text-center text-sm font-bold text-white outline-none" />
									<div class="flex items-center gap-1">
										<label title="Row colour" class="relative flex h-6 w-6 cursor-pointer items-center justify-center rounded bg-black/25 text-white hover:bg-black/40">
											<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
												<circle cx="13.5" cy="6.5" r="1" fill="currentColor" /><circle cx="17.5" cy="10.5" r="1" fill="currentColor" />
												<circle cx="8.5" cy="7.5" r="1" fill="currentColor" /><circle cx="6.5" cy="12.5" r="1" fill="currentColor" />
												<path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z" />
											</svg>
											<input type="color" bind:value={tier.color} aria-label="Row colour" class="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
										</label>
										<button onclick={() => removeRow(tier.id)} title="Delete row" aria-label="Delete row"
											class="flex h-6 w-6 items-center justify-center rounded bg-black/25 text-sm text-white hover:bg-black/40">✕</button>
									</div>
									<div class="flex gap-1">
										<button onclick={() => moveRow(ti, -1)} disabled={ti === 0} aria-label="Move row up"
											class="h-6 w-6 rounded bg-black/25 text-xs text-white disabled:opacity-30">▲</button>
										<button onclick={() => moveRow(ti, 1)} disabled={ti === tiers.length - 1} aria-label="Move row down"
											class="h-6 w-6 rounded bg-black/25 text-xs text-white disabled:opacity-30">▼</button>
									</div>
								{:else}
									<span class="break-all text-center font-extrabold text-white {tier.label.length > 3 ? 'text-sm' : 'text-2xl'}">{tier.label}</span>
									<span class="text-[10px] leading-none tracking-[0.2em] text-white/50" aria-hidden="true">⋮⋮</span>
								{/if}
							</div>
							<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
							<div data-zone={tier.id} onclick={() => onZoneClick(tier.id)}
								class="flex min-h-[96px] flex-1 flex-wrap content-start gap-1.5 p-1.5 transition-colors sm:min-h-[112px]
									{target !== -1 ? 'bg-white/5' : ''} {selected.length ? 'cursor-pointer hover:bg-white/5' : ''}">
								{#each tier.items as id (id)}
									{#if target !== -1 && !dragIds.has(id) && others.indexOf(id) === target}
										{@render indicator()}
									{/if}
									{@render slot(id, true)}
								{/each}
								{#if target !== -1 && target === others.length}
									{@render indicator()}
								{/if}
							</div>
						</div>
					{/each}
					{#if rowTarget !== null && rowTarget === otherRows.length}
						<div class="h-1 rounded-full bg-primary"></div>
					{/if}
				</div>

				<button onclick={addRow}
					class="mt-2 w-full rounded-lg border border-dashed border-border py-2 text-sm text-muted-foreground hover:border-primary hover:text-foreground">
					+ Add row
				</button>

				<p class="mt-4 hidden text-center text-xs text-muted-foreground lg:block">
					Drag players onto a row, or click a player then click a row. Use Select (or Ctrl/Shift-click) to move several at once. Your list saves in this browser.
				</p>
			</section>

			<!-- Player pool: sidebar on desktop, bottom sheet on mobile -->
			<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
			<aside bind:this={poolEl} data-zone={POOL} onclick={() => onZoneClick(POOL)}
				class="fixed inset-x-0 bottom-0 z-30 flex flex-col border-t border-border bg-card shadow-[0_-8px_24px_rgba(0,0,0,0.25)] transition-[height]
					{poolOpen ? 'h-[42vh]' : 'h-[52px]'}
					lg:sticky lg:top-4 lg:z-auto lg:h-[calc(100vh-2rem)] lg:rounded-xl lg:border lg:shadow-none
					{dropTarget?.zone === POOL ? 'ring-2 ring-primary' : ''}">
				<div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
					<button onclick={(e) => { e.stopPropagation(); poolOpen = !poolOpen; }}
						class="flex min-w-0 flex-1 items-center gap-2 text-left lg:pointer-events-none" aria-expanded={poolOpen}>
						<span class="text-xs text-muted-foreground transition-transform lg:hidden" class:rotate-90={poolOpen}>&#9654;</span>
						<span class="text-sm font-bold uppercase tracking-wider">Players</span>
						<span class="text-xs text-muted-foreground">{remaining} left</span>
					</button>
					<button onclick={(e) => { e.stopPropagation(); if (selectMode) clearSelection(); else { selectMode = true; poolOpen = true; } }}
						aria-pressed={selectMode}
						class="rounded-md px-2 py-1 text-xs font-medium {selectMode ? 'bg-primary text-primary-foreground' : 'bg-secondary text-foreground hover:bg-accent'}">
						{selectMode ? 'Done' : 'Select'}
					</button>
					<select bind:value={sortBy} onclick={(e) => e.stopPropagation()} aria-label="Sort players"
						class="rounded-md border border-border bg-background px-1.5 py-1 text-xs">
						<option value="rank">By rank</option>
						<option value="name">A–Z</option>
					</select>
				</div>
				<div class="flex shrink-0 gap-2 px-3 pt-2">
					<input bind:value={search} onclick={(e) => e.stopPropagation()} placeholder="Search players…" type="search"
						class="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary" />
					<select bind:value={charFilter} onclick={(e) => e.stopPropagation()} aria-label="Filter by character"
						class="w-32 shrink-0 rounded-md border border-border bg-background px-1.5 py-1.5 text-sm {charFilter ? 'border-primary' : ''}">
						<option value="">All characters</option>
						<option value={NO_CHAR}>No character ({characterOptions.none})</option>
						{#each characterOptions.chars as [name, n] (name)}
							<option value={name}>{name} ({n})</option>
						{/each}
					</select>
				</div>
				{#if selectMode || selected.length}
					<div class="flex shrink-0 items-center gap-2 px-3 pt-2 text-xs">
						<span class="font-semibold text-primary">{selected.length} selected</span>
						<span class="flex-1"></span>
						{#if selected.some((id) => placed.has(id))}
							<!-- Tapping empty pool space also works, but in a full pool you'd mostly hit cards -->
							<button onclick={(e) => { e.stopPropagation(); onZoneClick(POOL); }}
								class="rounded-md bg-secondary px-2 py-1 font-medium text-foreground hover:bg-accent">
								Back to pool
							</button>
						{/if}
						<button onclick={(e) => { e.stopPropagation(); selectAllInPool(); }} disabled={!pool.length}
							class="rounded-md bg-secondary px-2 py-1 font-medium text-foreground hover:bg-accent disabled:opacity-40">
							Select all{search || charFilter ? ' shown' : ''} ({pool.length})
						</button>
						<button onclick={(e) => { e.stopPropagation(); selected = []; }} disabled={!selected.length}
							class="rounded-md px-2 py-1 font-medium text-muted-foreground hover:text-foreground disabled:opacity-40">
							Clear
						</button>
					</div>
				{/if}
				<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
					{#if pool.length}
						<div class="flex flex-wrap justify-center gap-1.5">
							{#each pool as p (p.id)}
								{@render slot(p.id, false)}
							{/each}
						</div>
					{:else}
						<p class="py-6 text-center text-sm text-muted-foreground">
							{search || charFilter ? 'No matches.' : 'Everyone has been placed!'}
						</p>
					{/if}
				</div>
				<p class="shrink-0 border-t border-border px-3 py-1.5 text-center text-[11px] text-muted-foreground lg:hidden">
					Hold &amp; drag, or tap a player then tap a row · "Select" to move many
				</p>
			</aside>
		</div>
	{/if}
</div>

{#if drag?.kind === 'row'}
	{@const row = tiers.find((t) => t.id === drag!.id)}
	{#if row}
		<div class="pointer-events-none fixed left-0 top-0 z-50 flex h-14 w-48 items-center overflow-hidden rounded-lg bg-[#141414] shadow-xl ring-2 ring-primary"
			style="transform: translate({drag.x}px, {drag.y}px) translate(-24px, -50%)">
			<div class="flex h-full w-14 items-center justify-center font-extrabold text-white" style="background:{row.color}">{row.label}</div>
			<span class="px-3 text-xs text-white/70">{row.items.length} player{row.items.length === 1 ? '' : 's'}</span>
		</div>
	{/if}
{:else if drag}
	{@const p = byId.get(drag.id)}
	{#if p}
		<div class="pointer-events-none fixed left-0 top-0 z-50 h-[84px] w-[60px] sm:h-[100px] sm:w-[74px]"
			style="transform: translate({drag.x}px, {drag.y}px) translate(-50%, -60%) scale(1.1)">
			{#if drag.ids.length > 1}
				<!-- Offset backing cards read as a stack -->
				<div class="absolute inset-0 translate-x-2 translate-y-2 rounded-md bg-secondary/80 ring-1 ring-primary/50"></div>
				<div class="absolute inset-0 translate-x-1 translate-y-1 rounded-md bg-secondary/90 ring-1 ring-primary/70"></div>
			{/if}
			<div class="relative h-full w-full">{@render card(p, true)}</div>
			{#if drag.ids.length > 1}
				<span class="absolute -right-2 -top-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold text-primary-foreground shadow">
					{drag.ids.length}
				</span>
			{/if}
		</div>
	{/if}
{/if}

<style>
	.card,
	.grab {
		touch-action: pan-y;
		user-select: none;
		-webkit-user-select: none;
		-webkit-touch-callout: none;
	}

	:global(body.dragging),
	:global(body.dragging *) {
		cursor: grabbing !important;
	}
</style>
