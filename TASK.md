Make a ~45 second, fully animated explainer video: "How to use Workbenches from your harness." Audience: workbenches.dev visitors and a launch post on X. No real footage or screen captures; everything is motion graphics. 16:9.

## The story (the workflow, in order)
1. **Plan.** The user works in their own harness with a smart model (show a small, single tag once: "e.g. Claude Code · Opus 5.5"; otherwise call it "your harness"; no third-party logos). They plan what to build. The plan splits into bounded pieces of work.
2. **Delegate.** Each piece is handed to the right Workbench for the job. They run in the cloud, in the background, in parallel.
3. **Return.** Finished work comes back to the harness.
4. **Assess and polish.** The harness and the user's judgement review it. This is the first step of their CI/CD: often very little needs changing (show a small diff, a couple of lines).
5. **Stage and merge.** Polished work is staged into a branch and merged into main through the user's own process.
6. **Repeat.** The loop starts again with the next plan.

Payoff (show, never number): tokens are spent efficiently, harness usage goes further, and the overall result is better. Show it visually: e.g. a usage meter on the harness that barely moves while the Workbenches do the heavy work in the cloud, and the small polish diff. Put NO figures, percentages, or multipliers on screen.

## The visual concept (required)
- **The harness is a tall rectangular column with data flowing down it** (a continuous stream: plan items, code fragments, glyphs). It is the spine of the whole video.
- **Workbenches bind to the column** as the work is delegated. Workbenches are the workbenches.dev characters ("Benchies"): flat plank bodies with a wobbly ink outline, two cartoon eyes that blink, one small prop (glasses, bowler, tie, briefcase, coffee, cape). The cape prop means "flying off to do it", use it for the trip to the cloud.
- When they finish, animate the return: the Benchies bring results back, the work flows into the column, gets a quick polish pass, then integrates (staged, then merged into main). Make clear how little polishing is needed.
- End on the loop restarting, then the workbenches.dev mark and URL.

## Brand assets (use these, do not redraw from memory)
`reference/benchies/` holds the real source from workbenches.dev: `benchcharacter.svelte` (+ `.css`, `rhythm.ts`, `wobble.ts`) generates every Benchie procedurally as inline SVG (shapes, colors, props, moods, blink and glance timing). Port its geometry and drawing to React/Remotion components faithfully, driven by frame instead of CSS timers, so the characters animate. `theme.css` has the brand tokens (`--bench-*` colors, ink, background); use them. `benchie.svelte` is the mascot config. `workbench-mark.svg` and `brandmark.svg` are the brand marks. Vary Benchies by job (shape, color, prop) so they read as different specialists.

## Copy rules
Serious, concise copy. Whimsy lives in the characters only. No em dashes anywhere. Don't claim new technology or that Workbenches change the model; claim the workflow: plan in your harness, delegate to experts, polish, merge. Short on-screen lines, few words per beat.

Workspace: deliver the video project in `video/` as the bench normally does.
