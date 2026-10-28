<script lang="ts">
    import {
        blinkDelays,
        blinkPeriods,
        glanceDelays,
        glancePeriods,
    } from './rhythm';
    import './benchcharacter.css';
    import { pauseOffscreen } from './pauseoffscreen';
    import { f1, rng, wobblyRect } from './wobble';

    /**
     * A Workbench character: one flat plank with a wobbly benchInk outline, two
     * cartoon benchEyes that blink on their own timer, and one small prop that says
     * "ready for business" (or, with `cape`, flying off to do it). Every benchBench is an elongated rectangle; the family
     * lies flat and varies in length and depth so the planks can stack. Inline SVG only.
     *
     * `bar` is the horizontal plank used in the stack illustration: its body
     * stretches to `extent` of the container while the face keeps its size at
     * the right end, so the benchEyes ride the tip as the bar grows.
     */
    export type BenchShape = 'block' | 'slab' | 'beam' | 'wide' | 'bar';
    export type BenchColor =
        'blue' | 'brick' | 'olive' | 'tan' | 'orange' | 'slate';
    export type BenchProp =
        'none' | 'glasses' | 'bowler' | 'tie' | 'briefcase' | 'coffee' | 'cape';
    export type BenchMood = 'calm' | 'keen' | 'skeptical' | 'determined';
    export type BenchCrop = 'baseline' | 'tight';

    type Eye = { cx: number; cy: number; r: number };
    type Geometry = {
        body: string;
        eyes: [Eye, Eye];
        top: [number, number];
        arm: [number, number];
        /** Props scale down on short planks so a briefcase never drags on the ground. */
        armScale: number;
        tieScale: number;
        box: [number, number, number, number];
    };

    /** Planks lie flat, always wider than tall: width by height, centred on x = 100, feet on y = 200. */
    const planks: Record<Exclude<BenchShape, 'bar'>, [number, number]> = {
        block: [124, 72],
        slab: [152, 86],
        beam: [176, 70],
        wide: [196, 60],
    };

    const BAR_H = 40;
    const BAR_FACE = 56;
    const BAR_REACH = 28;

    const fills: Record<BenchColor, string> = {
        blue: 'var(--bench-blue)',
        brick: 'var(--bench-brick)',
        olive: 'var(--bench-olive)',
        tan: 'var(--bench-tan)',
        orange: 'var(--bench-orange)',
        slate: 'color-mix(in oklch, var(--muted-foreground) 65%, var(--background))',
    };

    let {
        shape,
        color,
        prop = 'none',
        mood = 'calm',
        lashes = false,
        seed = 0,
        crop = 'baseline',
        extent = 1,
        delay = 0,
        grow = true,
        tag,
        face: showFace = true,
        land,
        label,
        class: className = '',
    }: {
        shape: BenchShape;
        color: BenchColor;
        prop?: BenchProp;
        mood?: BenchMood;
        lashes?: boolean;
        seed?: number;
        /** `baseline` shares one viewBox height so a row stands on one line; `tight` hugs the art for stacking. */
        crop?: BenchCrop;
        /** Bar only: width as a fraction of the container. */
        extent?: number;
        /** Bar only: seconds before the bar grows. */
        delay?: number;
        /** Bar only: grow from zero width on mount. `false` renders the bar at its extent from the first frame. */
        grow?: boolean;
        /** Bar only: a small mono nameplate pinned at the left end of the plank. */
        tag?: string;
        /** `false` leaves the plank blank: no eyes, brows, lashes or prop. */
        face?: boolean;
        /** Seconds until the benchEyes blink once, on top of the regular blink. Used when a plank lands. */
        land?: number;
        label?: string;
        class?: string;
    } = $props();

    const g = $derived.by<Geometry>(() => {
        const rnd = rng(seed + 11);
        if (shape === 'bar') {
            const r = 9;
            const cy = BAR_H / 2;
            return {
                body: wobblyRect(3, 3, 994, BAR_H - 6, rnd),
                eyes: [
                    { cx: BAR_FACE - 38, cy: cy + 1, r },
                    { cx: BAR_FACE - 16, cy: cy - 1, r },
                ],
                top: [BAR_FACE - 27, 3],
                arm: [BAR_FACE, 8],
                armScale: 0.6,
                tieScale: 0.3,
                box: [0, 0, BAR_FACE, BAR_H],
            };
        }
        const [w, h] = planks[shape];
        const x0 = 100 - w / 2;
        const y0 = 200 - h;
        const upright = h > w;
        const r = Math.round(
            Math.min(Math.max((upright ? w : h) * 0.15, 8), 13)
        );
        const spread = upright ? w * 0.22 : Math.min(w * 0.15, 24);
        const cy = upright ? y0 + h * 0.22 + r : y0 + h * 0.42;
        const ay = upright ? y0 + h * 0.5 : y0 + h * 0.2;
        const armScale = Math.min(1, (198 - ay) / 64);
        const ty = cy + r * 2.1;
        return {
            body: wobblyRect(x0, y0, w, h, rnd, 0.4),
            eyes: [
                { cx: f1(100 - spread), cy: f1(cy + 1.5), r },
                { cx: f1(100 + spread), cy: f1(cy - 1.5), r },
            ],
            top: [100, y0],
            arm: [x0 + w, f1(ay)],
            armScale,
            tieScale: Math.min(1, (196 - ty) / 48),
            box: [x0, y0, x0 + w, 200],
        };
    });
    const fill = $derived(fills[color]);
    const i = $derived(seed % blinkPeriods.length);
    const doubleBlink = $derived(seed % 2 === 1);
    const propFill = $derived(
        color === 'tan' ? 'var(--bench-brick)' : 'var(--bench-tan)'
    );
    const reach = $derived(
        (prop === 'coffee' ? 72 : prop === 'briefcase' ? 50 : 0) * g.armScale
    );
    /** How far the cape and its wind streaks trail past the back of the plank. */
    const CAPE_TRAIL = 114;

    /** A flag-shaped cape tied on at the front of the plank's top edge, in plank-local units (origin at the top left corner). */
    function cape(w: number): string {
        return [
            `M ${f1(w * 0.6)} 6`,
            `C ${f1(w * 0.4)} -12 ${f1(w * 0.2)} -22 -40 -26`,
            'C -56 -28 -68 -29 -80 -32',
            'C -72 -24 -84 -14 -76 -5',
            'C -68 3 -80 11 -72 20',
            'C -52 12 -32 24 -12 15',
            `C -4 12 4 14 ${f1(w * 0.3)} 20 Z`,
        ].join(' ');
    }
    /** The nameplate is drawn in a 120 by 26 box and stretched to the text it holds; the stroke does not scale. */
    const plate = $derived(wobblyRect(2.5, 2.5, 115, 21, rng(seed + 29)));

    // Crop the drawing to its own body plus room for a held prop, so a row of
    // benches at one height gets natural widths and a shared baseline. The
    // tight crop hugs the art so two planks can stand on each other.
    const viewBox = $derived.by(() => {
        const [bodyMinX, minY, bodyMaxX] = g.box;
        // A bowler brim is wider than the narrow planks.
        const minX =
            prop === 'bowler'
                ? Math.min(bodyMinX, g.top[0] - 50)
                : prop === 'cape'
                  ? bodyMinX - CAPE_TRAIL
                  : bodyMinX;
        const maxX =
            prop === 'bowler' ? Math.max(bodyMaxX, g.top[0] + 50) : bodyMaxX;
        const right = Math.max(maxX, g.arm[0] + reach) + 10;
        if (crop === 'baseline')
            return `${minX - 10} -20 ${right - minX + 10} 224`;
        let top = minY;
        if (prop === 'bowler') top = Math.min(top, g.top[1] - 40);
        if (prop === 'coffee') top = Math.min(top, g.arm[1] - 20 * g.armScale);
        if (prop === 'cape') top = Math.min(top, g.box[1] - 56);
        top -= 6;
        return `${minX - 6} ${f1(top)} ${right - minX + 6} ${f1(204 - top)}`;
    });

    function brow(eye: Eye, side: 'left' | 'right'): string {
        const { cx, cy, r } = eye;
        if (mood === 'determined') {
            // Furrowed: each brow dips toward the nose.
            const outer = cy - r * 1.75;
            const inner = cy - r * 1.05;
            const [yl, yr] = side === 'left' ? [outer, inner] : [inner, outer];
            return `M ${f1(cx - r * 1.05)} ${f1(yl)} C ${f1(cx - r * 0.3)} ${f1((yl + yr) / 2 - 2)} ${f1(cx + r * 0.3)} ${f1((yl + yr) / 2 - 1)} ${f1(cx + r * 1.05)} ${f1(yr)}`;
        }
        const lift = mood === 'keen' ? 1.95 : 1.6;
        const skew =
            mood === 'skeptical' ? (side === 'right' ? 0.45 : -0.1) : 0;
        const y0 = cy - r * (lift - skew);
        const y1 = cy - r * (lift + 0.25 + skew);
        const x0 = cx - r * 0.95;
        const x1 = cx + r * 0.95;
        return `M ${f1(x0)} ${f1(y0 + 2)} C ${f1(cx - r * 0.3)} ${f1(y1 - 3)} ${f1(cx + r * 0.4)} ${f1(y1 - 1)} ${f1(x1)} ${f1(y1 + 1)}`;
    }

    /** Determined lids: the top of the eye hidden under a slanted lid, lower toward the nose. */
    function lid(
        eye: Eye,
        side: 'left' | 'right'
    ): { cover: string; line: string } {
        const { cx, cy, r } = eye;
        const outer = cy - r * 0.55;
        const inner = cy - r * 0.15;
        const [yl, yr] = side === 'left' ? [outer, inner] : [inner, outer];
        const half = r * 0.9;
        const top = cy - r - 3;
        const slope = (yr - yl) / (2 * half);
        const xl = cx - r - 3;
        const xr = cx + r + 3;
        return {
            cover: `M ${f1(xl)} ${f1(yl - slope * (r + 3 - half))} L ${f1(xr)} ${f1(yr + slope * (r + 3 - half))} L ${f1(xr)} ${f1(top)} L ${f1(xl)} ${f1(top)} Z`,
            line: `M ${f1(cx - half)} ${f1(yl)} L ${f1(cx + half)} ${f1(yr)}`,
        };
    }

    function lash(eye: Eye, angleDeg: number): string {
        const a = (angleDeg * Math.PI) / 180;
        const { cx, cy, r } = eye;
        const x0 = cx + Math.cos(a) * (r + 1);
        const y0 = cy + Math.sin(a) * (r + 1);
        const x1 = cx + Math.cos(a) * (r + 8);
        const y1 = cy + Math.sin(a) * (r + 8);
        return `M ${f1(x0)} ${f1(y0)} L ${f1(x1)} ${f1(y1)}`;
    }
</script>

{#snippet face()}
    {#if prop === 'tie'}
        {@const tx = (g.eyes[0].cx + g.eyes[1].cx) / 2}
        {@const ty = Math.max(g.eyes[0].cy, g.eyes[1].cy) + g.eyes[0].r * 2.1}
        <g class="prop" transform="translate({tx} {ty}) scale({g.tieScale})">
            <path
                d="M -7 0 C -2 -3 2 -3 7 0 L 3 8 L -3 8 Z"
                fill="var(--bench-brick)"
                class="benchInk"
                stroke-width="3"
            />
            <path
                d="M -3 8 C -8 22 -9 34 -1 46 C 9 34 8 22 3 8 Z"
                fill="var(--bench-brick)"
                class="benchInk"
                stroke-width="3"
            />
        </g>
    {/if}

    {#if prop === 'briefcase'}
        <g
            class="prop"
            transform="translate({g.arm[0]} {g.arm[1]}) scale({g.armScale})"
        >
            <path
                d="M 0 0 C 12 4 20 14 26 27"
                fill="none"
                class="benchInk"
                stroke-width="4"
            />
            <path
                d="M 21 30 C 21 26 31 26 31 30 L 31 35 L 21 35 Z"
                fill="none"
                class="benchInk"
                stroke-width="3"
            />
            <path
                d="M 8 36 C 20 34 34 37 44 35 C 45 44 44 54 45 61 C 32 63 20 60 7 62 C 6 53 9 45 8 36 Z"
                fill={propFill}
                class="benchInk"
                stroke-width="3.5"
            />
            <path
                d="M 8 47 C 20 46 34 48 44 46"
                fill="none"
                class="benchInk"
                stroke-width="2.5"
            />
        </g>
    {/if}

    {#if prop === 'coffee'}
        <g
            class="prop"
            transform="translate({g.arm[0]} {g.arm[1]}) scale({g.armScale})"
        >
            <path
                d="M 0 0 C 14 -2 24 4 34 12"
                fill="none"
                class="benchInk"
                stroke-width="4"
            />
            <path
                d="M 28 6 C 38 5 48 7 58 6 C 56 18 54 30 52 40 C 46 41 38 40 34 40 C 32 30 30 18 28 6 Z"
                fill="var(--bench-eye)"
                class="benchInk"
                stroke-width="3.5"
            />
            <path
                d="M 57 14 C 68 12 68 30 55 30"
                fill="none"
                class="benchInk"
                stroke-width="3"
            />
            <path
                d="M 38 -4 C 35 -9 41 -13 38 -18"
                fill="none"
                class="benchInk"
                stroke-width="2.5"
            />
            <path
                d="M 48 -3 C 45 -8 51 -12 48 -17"
                fill="none"
                class="benchInk"
                stroke-width="2.5"
            />
        </g>
    {/if}

    {#if prop === 'bowler'}
        {@const [hx, hy] = g.top}
        <g class="prop">
            <path
                d="M {hx - 30} {hy + 1} C {hx - 33} {hy - 22} {hx - 18} {hy -
                    36} {hx} {hy - 35} C {hx + 19} {hy - 35} {hx + 33} {hy -
                    21} {hx + 29} {hy + 1} Z"
                fill="var(--bench-ink)"
                class="benchInk"
                stroke-width="4"
            />
            <path
                d="M {hx - 48} {hy + 3} C {hx - 20} {hy - 1} {hx + 22} {hy +
                    3} {hx + 48} {hy - 1}"
                fill="none"
                class="benchInk"
                stroke-width="5"
            />
        </g>
    {/if}

    {#if lashes}
        {#each g.eyes as eye, k (k)}
            <path d={lash(eye, -118)} class="benchInk" stroke-width="2.5" />
            <path d={lash(eye, -90)} class="benchInk" stroke-width="2.5" />
            <path d={lash(eye, -62)} class="benchInk" stroke-width="2.5" />
        {/each}
    {/if}

    <g class="benchEyes" class:benchDouble={doubleBlink}>
        {#each g.eyes as eye, k (k)}
            <g class="benchEye">
                <circle
                    cx={eye.cx}
                    cy={eye.cy}
                    r={eye.r}
                    fill="var(--bench-eye)"
                    class="benchInk"
                    stroke-width="3.5"
                />
                <g class="benchPupil">
                    <circle
                        cx={eye.cx + (mood === 'determined' ? 3.5 : 1)}
                        cy={eye.cy + (mood === 'determined' ? 2.5 : 1.5)}
                        r={eye.r * (mood === 'determined' ? 0.48 : 0.42)}
                        fill="var(--bench-ink)"
                    />
                </g>
                {#if mood === 'determined'}
                    {@const l = lid(eye, k === 0 ? 'left' : 'right')}
                    <path d={l.cover} {fill} />
                    <path d={l.line} class="benchInk" stroke-width="3.5" />
                {/if}
            </g>
        {/each}
    </g>

    <!-- Brows sit outside the blink group so they hold still. -->
    <path
        d={brow(g.eyes[0], 'left')}
        fill="none"
        class="benchInk"
        stroke-width="4"
    />
    <path
        d={brow(g.eyes[1], 'right')}
        fill="none"
        class="benchInk"
        stroke-width="4"
    />

    {#if prop === 'glasses'}
        <g class="prop">
            <circle
                cx={g.eyes[0].cx}
                cy={g.eyes[0].cy}
                r={g.eyes[0].r + 5}
                fill="none"
                class="benchInk"
                stroke-width="3.5"
            />
            <circle
                cx={g.eyes[1].cx}
                cy={g.eyes[1].cy}
                r={g.eyes[1].r + 5}
                fill="none"
                class="benchInk"
                stroke-width="3.5"
            />
            <path
                d="M {g.eyes[0].cx + g.eyes[0].r + 5} {g.eyes[0].cy - 3} C {(g
                    .eyes[0].cx +
                    g.eyes[1].cx) /
                    2 -
                    1} {g.eyes[0].cy - 8} {(g.eyes[0].cx + g.eyes[1].cx) / 2 +
                    1} {g.eyes[1].cy - 8} {g.eyes[1].cx - g.eyes[1].r - 5} {g
                    .eyes[1].cy - 3}"
                fill="none"
                class="benchInk"
                stroke-width="3.5"
            />
        </g>
    {/if}
{/snippet}

{#if shape === 'bar'}
    <!-- The slot holds the final width from the first frame, so whatever sits after the bar never moves while it grows. -->
    <span
        use:pauseOffscreen
        class={['benchBench benchBenchSlot', className]}
        class:benchLanding={land !== undefined}
        style:--bar-extent="{Math.round(extent * 1000) / 10}%"
        style:--bar-delay="{delay}s"
        style:--land-delay="{land ?? 0}s"
        style:--blink-period="{blinkPeriods[i]}s"
        style:--blink-delay="{blinkDelays[i]}s"
        style:--glance-period="{glancePeriods[i]}s"
        style:--glance-delay="{glanceDelays[i]}s"
        role={label ? 'img' : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : 'true'}
    >
        <span class="benchBenchBar" class:benchStill={!grow}>
            <!-- The body stretches with the bar; the stroke stays one benchInk weight. -->
            <svg
                class="benchBarBody"
                viewBox="0 0 1000 {BAR_H}"
                preserveAspectRatio="none"
                aria-hidden="true"
                focusable="false"
            >
                <path d={g.body} {fill} transform="translate(4 2)" />
                <path
                    d={g.body}
                    fill="none"
                    class="benchInk"
                    stroke-width="3.5"
                    vector-effect="non-scaling-stroke"
                />
            </svg>
            {#if tag}
                <!-- The nameplate: an eye-white plate in the same wobbly ink, sized by the text it carries. -->
                <span class="benchBarTag">
                    <svg
                        class="benchTagPlate"
                        viewBox="0 0 120 26"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                        focusable="false"
                    >
                        <path
                            d={plate}
                            fill="var(--bench-eye)"
                            class="benchInk"
                            stroke-width="2.5"
                            vector-effect="non-scaling-stroke"
                        />
                    </svg>
                    <span class="benchTagText">{tag}</span>
                </span>
            {/if}
            <!-- The face keeps its size and rides the right end. -->
            <svg
                class="benchBarFace"
                viewBox="0 0 {BAR_FACE +
                    (prop === 'briefcase' ? BAR_REACH : 0)} {BAR_H}"
                style:width="{(BAR_FACE +
                    (prop === 'briefcase' ? BAR_REACH : 0)) /
                    16}rem"
                style:left="calc(100% - {BAR_FACE / 16}rem)"
                aria-hidden="true"
                focusable="false"
            >
                {#if showFace}{@render face()}{/if}
            </svg>
        </span>
    </span>
{:else}
    <svg
        use:pauseOffscreen
        {viewBox}
        preserveAspectRatio="xMidYMax meet"
        class={['benchBench', className]}
        class:benchLanding={land !== undefined}
        style:--land-delay="{land ?? 0}s"
        style:--blink-period="{blinkPeriods[i]}s"
        style:--blink-delay="{blinkDelays[i]}s"
        style:--glance-period="{glancePeriods[i]}s"
        style:--glance-delay="{glanceDelays[i]}s"
        role={label ? 'img' : undefined}
        aria-label={label}
        aria-hidden={label ? undefined : 'true'}
        focusable="false"
    >
        {#if prop === 'cape'}
            {@const [x0, y0] = g.box}
            {@const w = g.box[2] - g.box[0]}
            <!-- Drawn before the body so the plank covers where it ties on. -->
            <g transform="translate({x0} {y0})">
                <!-- Wind streaks hold still while the cape flaps. -->
                {#each ['M -22 -46 c -6 -6 -11 6 -17 0 s -11 6 -17 0 s -11 6 -17 0', 'M -40 34 c -6 -6 -11 6 -17 0 s -11 6 -17 0 s -11 6 -17 0', 'M -86 -8 c -4 -5 -8 5 -12 0 s -8 5 -12 0'] as d, k (k)}
                    <path
                        {d}
                        fill="none"
                        pathLength="100"
                        class="benchInk benchWind"
                        stroke-width="3"
                        style:animation-delay="{-k * 0.37}s"
                    />
                {/each}
                <g class="benchCape">
                    <path
                        d={cape(w)}
                        fill="var(--bench-brick)"
                        class="benchInk"
                        stroke-width="4"
                    />
                    <path
                        d="M -8 -12 C -30 -16 -50 -14 -70 -20 M -12 4 C -32 0 -50 6 -66 4"
                        fill="none"
                        class="benchInk"
                        stroke-width="2.5"
                    />
                </g>
            </g>
        {/if}
        <!-- Body: the fill is registered a hair off the keyline, like a print. -->
        <path d={g.body} {fill} transform="translate(2.5 2)" />
        <path d={g.body} fill="none" class="benchInk" stroke-width="5" />
        {@render face()}
    </svg>
{/if}
