# DIAGNOSIS — shared video-stall watchdog: the recovery latch never re-arms when recovery does not swap `src`

**Status: DIAGNOSIS — hold for device verification before merge.** No behavioural code changed in this PR. This is a root-cause writeup plus the exact fix shape and the device test that would confirm it.

## Surfaces and the shared layer

The stuck-video bug hits both `radio.fluncle.com` and the homepage Stories reel because all three full-screen `<video>` surfaces drive their element through one shared hook:

- `apps/web/src/lib/use-video-recovery.ts` — `useVideoStallRecovery` (the watchdog) + `mediaStallVerdict` (the pure decision core).
- Consumers: `apps/web/src/routes/radio.tsx` (~line 609), `apps/web/src/components/stories/story-view.tsx` (~line 96), `apps/web/src/components/log/log-footage.tsx` (~line 156).

The watchdog (added in #126) already closes the _first_ gap — a stuck load that fires `stalled`/`waiting` (or just never advances `readyState`) and **never** an `error`, so the one-shot `onError` fallback never runs. It polls `mediaStallVerdict` on a 1s tick and fires `onStall` once per "wedge episode."

The remaining intermittent stall is a **second-order gap in the episode latch.**

## Root cause: the `recovered` latch only clears on `loadstart`/`emptied`, but radio's recovery can leave `src` unchanged

`useVideoStallRecovery` (use-video-recovery.ts:155–226) keeps a per-episode latch:

```js
let recovered = false; // line 155
// ... in the tick (line 205):
if (recovered) {
  return;
} // dead until re-armed
// ... on wedge (line 222):
recovered = true;
onStallRef.current();
```

The latch is re-armed **only** by `onLoadStart`, wired to `loadstart` + `emptied` (lines 164–170, 193–194):

```js
const onLoadStart = () => {
  /* ... */ recovered = false;
};
video.addEventListener("loadstart", onLoadStart);
video.addEventListener("emptied", onLoadStart);
```

This is correct for two of the three recovery paths:

- **Stories** (`story-view.tsx:79–94`) and **/log** (`log-footage.tsx:71–87`): the master-reload branch calls `video.load()`. Per the HTML media-element load algorithm, `load()` aborts the current load and fires `emptied` → `loadstart`, so `onLoadStart` runs and `recovered` re-arms. Self-healing. OK.

- **Radio, FIRST wedge** (`radio.tsx:590–603`, `recoverStuckVideo`): also calls `video.load()` → `emptied`/`loadstart` → re-arm. OK.

- **Radio, SECOND wedge** (`radio.tsx:601–602`): calls `void resolveSlot()` to re-resolve the authoritative broadcast slot instead of reloading the element. **`resolveSlot()` frequently resolves to the SAME `videoUrl`** — the warm steady-state crop for the current finding (the common case: the schedule has not rolled; we are recovering a transient edge stall, not a catalogue change). When `videoUrl` is unchanged, React does **not** re-assign the `<video src>` attribute, so the browser runs **no** new load algorithm: **no `emptied`, no `loadstart`.** `onLoadStart` never fires, `recovered` stays `true`, and the watchdog is **dead for the remaining lifetime of this effect instance.**

The effect only re-runs (rebuilding fresh state with `recovered = false`) when its deps `[videoRef, src, expectsPlayback]` change (line 242). With `src` unchanged and `expectsPlayback` steady, the watchdog stays latched-off. A _subsequent_ edge stall on that same clip then has **no recovery path at all** — the clip hangs on its poster (or last frame) until the schedule organically advances to a different finding. That is the "occasionally gets stuck loading" report: rare (needs two wedges on the same unchanged slot), surface-shared (same hook), and not radio-clock-related (#115/#117 are not involved).

### Why it reproduces on Stories too, less often

Stories' recovery always ends in `video.load()`, so its latch re-arms. But Stories shares the **same standing-down rule**: `mediaStallVerdict` returns `false` forever once `readyState >= HAVE_CURRENT_DATA` (lines 92–94, by design — "a later rebuffer is the browser's own"). A Stories clip that reaches `canplay`, starts, then **wedges mid-loop on a re-buffer of a cold rendition rung** is outside the watchdog by design. This is a narrower, separate, and intentional gap; calling it out so it is not mistaken for the latch bug. Do not "fix" it without a deliberate decision — auto-recovering post-playable rebuffers risks fighting the browser's own buffering.

### Secondary aggravator (rare): rendition-width URL churn

`useResponsiveWidth` (`use-responsive-width.ts`) re-emits a new `RenditionWidth` on every `ResizeObserver` callback, and `videoCrop`/`videoRendition` bake the width into the URL (`media.ts`), so `videoUrl` changes on a genuine **rung** change (orientation flip, a resize crossing 360/480/720/1080). `setWidth` to the same rung is a no-op (React bails), so an idle scroll does **not** thrash it — this is not the primary cause, but an orientation flip mid-load aborts the in-flight fetch and restarts it, which can compound a flaky edge. No fix recommended here; documented so it is not chased as the root cause.

## Recommended fix (small, contained, in the shared hook)

Re-arm the episode latch when the element returns to health, instead of relying solely on a fresh `loadstart`/`emptied`. Two equivalent shapes; prefer (A):

**(A) Re-arm on a healthy verdict transition / bounded window.** After firing once, allow the latch to clear the next time the element shows fresh progress since the recovery, OR after a bounded re-arm window — so a no-op recovery (`src` unchanged) is not permanently latched. Cap total attempts so a hard-dead source can never become a tight loop.

```ts
// sketch — inside the interval, replacing the bare `if (recovered) return;`
if (recovered) {
  // Re-arm once the element actually made progress after the recovery, OR
  // after a bounded re-arm window so a no-op recovery (src unchanged) is not
  // permanently latched. Cap total attempts so a dead source can't loop.
  if (video.readyState >= HAVE_CURRENT_DATA || now() - recoveredAt >= STALL_TIMEOUT_MS) {
    recovered = false;
  } else {
    return;
  }
}
```

with `let recoveredAt = 0;` set alongside `recovered = true; recoveredAt = now();` at the wedge, and a `let attempts = 0;` guard (`if (attempts >= MAX_RECOVERY_ATTEMPTS) return;`) so radio's second-wedge `resolveSlot()` path gets a _bounded_ retry instead of going permanently dead.

**(B) Caller-side, narrower.** In `radio.tsx`, make the second-wedge recovery force a reload even when the slot is unchanged — e.g. after `resolveSlot()`, if the resolved `videoUrl` is identical, call `video.load()` so an `emptied`/`loadstart` re-arms the latch. Smaller blast radius (radio-only) but leaves the shared hook with a latch that silently assumes recovery always swaps `src`.

(A) is preferred because the latch's "one recovery per episode, never a tight loop" guarantee should not depend on every caller's recovery happening to emit `loadstart`. The pure `mediaStallVerdict` stays unchanged; only the hook's latch lifecycle gains a bounded re-arm, so the existing `use-video-recovery.test.ts` verdict tests still hold and a new test would cover "latch re-arms after a no-op recovery within the window, capped at N attempts."

### Risk

Medium. It changes the shared watchdog's latch semantics for **all three** live playback surfaces. The failure mode of a wrong fix is a tight recovery loop hammering `load()`/`resolveSlot()` on a genuinely dead source — which is exactly what the original single-shot latch was protecting against — so the bounded `MAX_RECOVERY_ATTEMPTS` cap is load-bearing and must be in the same change.

## Device test that would confirm it (and gate the fix)

1. Open `radio.fluncle.com` on a real phone over throttled/flaky cellular (or DevTools "Slow 4G" + intermittent offline toggling) so a silent crop cold-MISSes the edge twice on the **same** finding without the schedule rolling.
2. Instrument the element: log `loadstart`, `emptied`, `stalled`, `waiting`, `canplay`, `playing`, `error`, and `readyState` on the radio `<video>`, plus a log inside `recoverStuckVideo` for which branch ran (`load()` vs `resolveSlot()`).
3. **Repro (current code):** after the second wedge fires `resolveSlot()` and it resolves to the same `videoUrl`, confirm **no** `emptied`/`loadstart` follows and the clip stays frozen on its poster while the observation audio keeps running (the clock is the audio, so the stage freezes but the page does not error).
4. **Confirm fix:** with fix (A), the latch re-arms within `STALL_TIMEOUT_MS` of the no-op recovery, a bounded retry fires `video.load()`, an `emptied`/`loadstart` follows, and the clip recovers; verify it caps at `MAX_RECOVERY_ATTEMPTS` and does not loop on a hard-dead source (kill the network entirely and confirm it stops after N).
5. Repeat the same instrumentation on a Stories clip to confirm the by-design post-`canplay` rebuffer gap is understood and intentionally left (separate decision).

## Files / lines

- `apps/web/src/lib/use-video-recovery.ts:155` (`recovered` latch), `:164–170` (`onLoadStart` re-arm), `:193–194` (only `loadstart`/`emptied` re-arm it), `:205–208` (`if (recovered) return;`), `:92–94` (stand-down once playable — by design).
- `apps/web/src/routes/radio.tsx:590–603` (`recoverStuckVideo`: first wedge `load()`, second wedge `resolveSlot()` — the path that can leave `src` unchanged).
- `apps/web/src/components/stories/story-view.tsx:79–94` and `apps/web/src/components/log/log-footage.tsx:71–87` (recoveries that always `load()`, so they self-rearm).
- `apps/web/src/lib/use-responsive-width.ts` + `apps/web/src/lib/media.ts` (`videoCrop`/`videoRendition` width-in-URL churn — secondary aggravator, no fix recommended).
