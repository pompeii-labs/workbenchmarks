/** Hand-drawn geometry shared by every inked drawing on the page. */

/** Small deterministic generator so each seed gets its own wobble. */
export function rng(s: number) {
    let a = (s * 2654435761 + 1013904223) >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const f1 = (n: number) => Math.round(n * 10) / 10;

/** A rectangle drawn by hand: jittered corners, gently bowed edges. `amp` scales the jitter for small parts. */
export function wobblyRect(
    x0: number,
    y0: number,
    w: number,
    h: number,
    rnd: () => number,
    footJitter = 1,
    amp = 1
): string {
    const j = (k = 1) => (rnd() * 2 - 1) * 2.4 * k * amp;
    const p: [number, number][] = [
        [x0 + j(), y0 + j()],
        [x0 + w + j(), y0 + j()],
        [x0 + w + j(), y0 + h + j(footJitter)],
        [x0 + j(), y0 + h + j(footJitter)],
    ];
    let d = `M ${f1(p[0][0])} ${f1(p[0][1])} `;
    for (let k = 0; k < 4; k++) {
        const [ax, ay] = p[k];
        const [bx, by] = p[(k + 1) % 4];
        const across = k % 2 === 0;
        const b1 = j(1.5);
        const b2 = j(1.5);
        const c1 = across
            ? [ax + (bx - ax) / 3, ay + b1]
            : [ax + b1, ay + (by - ay) / 3];
        const c2 = across
            ? [ax + (2 * (bx - ax)) / 3, by + b2]
            : [bx + b2, ay + (2 * (by - ay)) / 3];
        d += `C ${f1(c1[0])} ${f1(c1[1])} ${f1(c2[0])} ${f1(c2[1])} ${f1(bx)} ${f1(by)} `;
    }
    return d + 'Z';
}

/** A circle drawn by hand: `n` points with jittered radius, joined by smooth cubics. */
export function wobblyCircle(
    cx: number,
    cy: number,
    r: number,
    rnd: () => number,
    n = 10,
    amp = 1
): string {
    const pts: [number, number][] = Array.from({ length: n }, (_, k) => {
        const a = (k / n) * Math.PI * 2 + (rnd() - 0.5) * 0.12;
        const rr = r + (rnd() * 2 - 1) * 1.4 * amp;
        return [cx + Math.cos(a) * rr, cy + Math.sin(a) * rr];
    });
    // Catmull-Rom through the points, as cubic Béziers.
    let d = `M ${f1(pts[0][0])} ${f1(pts[0][1])} `;
    for (let k = 0; k < n; k++) {
        const p0 = pts[(k - 1 + n) % n];
        const p1 = pts[k];
        const p2 = pts[(k + 1) % n];
        const p3 = pts[(k + 2) % n];
        const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
        const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
        d += `C ${f1(c1[0])} ${f1(c1[1])} ${f1(c2[0])} ${f1(c2[1])} ${f1(p2[0])} ${f1(p2[1])} `;
    }
    return d + 'Z';
}
