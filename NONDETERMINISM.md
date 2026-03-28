# Non-Determinism in Playdate E2E Testing

Design doc exploring sources of non-determinism and how `playdate-e2e` addresses them.

Related: [#1](https://github.com/alexzajac/playdate-e2e/issues/1)

## References

- [The Challenges of Testing in a Non-Deterministic World](https://www.sei.cmu.edu/blog/the-challenges-of-testing-in-a-non-deterministic-world/) — CMU SEI. Categorizes non-determinism into physical, emergent, concurrent, and exceptional. Recommends testing _against_ non-determinism sources rather than pretending they don't exist.
- [Automated Game Testing](https://www.eidosmontreal.com/news/automated-game-testing/) — Eidos Montreal. Distinguishes intentional randomness (game RNG) from unintentional (multiprocessing, network). Advocates conditional rule systems and state-based assertions over fixed input sequences.

---

## The 1-Bit Advantage

The Playdate's 1-bit 400×240 display eliminates the single largest source of non-determinism in visual testing: **rendering variance**. Browser and mobile screenshot testing requires fuzzy matching because of anti-aliasing, subpixel rendering, font hinting, and GPU differences. None of these exist on Playdate. Every pixel is 0 or 1, every frame is deterministic at the rendering level.

This means exact-match screenshot comparison (threshold = 0 differing pixels) is viable as the default — something no browser testing framework can claim.

The remaining sources of non-determinism are in the **test infrastructure**, not the display. This doc addresses each one.

---

## Sources of Non-Determinism

### 1. Frame Timing — HIGH impact

**The problem:** `waitFrames(30)` assumes the game runs at exactly 30fps. If the simulator drops frames under CPU load, if an animation takes a variable number of frames, or if the game uses `playdate.display.setRefreshRate()` to run at a different rate, the test captures the wrong frame.

**Why it matters:** A screenshot taken one frame too early shows an incomplete transition. One frame too late shows the next state. Both produce false failures that train developers to distrust the framework.

**Architectural mitigation:** The PING/PONG protocol provides frame-level synchronization. Each PING sent by the runner is answered by a PONG after the game processes one frame. `waitFrames(n)` sends n PINGs and waits for n PONGs — it counts _game frames_, not wall-clock time.

**Remaining gap:** Frame counting is necessary but not sufficient. The test author must know _how many frames_ an animation or transition takes — and that number can change as the game evolves. This is the core brittleness of fixed-count waits.

**Solution — conditional waits:**

```typescript
// Wait until the screen actually changes (not "wait 30 frames and hope")
await game.waitUntilScreenChanges({ timeout: 5000 });

// Wait until game state reaches a condition
await game.waitUntilState('score', (value) => value > 0, { timeout: 5000 });

// Wait until the screen stops changing (animation settled)
await game.waitUntilStable({ settleFrames: 3, timeout: 5000 });
```

These are built on the same PING/PONG mechanism: each frame, the runner captures the framebuffer or queries state, checks the condition, and either resolves or sends another PING. The timeout prevents infinite hangs if the condition is never met.

**Guidance for test authors:**

- Use `waitFrames()` only when you know the exact frame count and it won't change (e.g., a fixed-duration fade that's part of the game's contract).
- Use `waitUntilScreenChanges()` when you want to wait for _something_ to happen visually.
- Use `waitUntilStable()` after triggering an animation, to wait for it to finish.
- Use `waitUntilState()` when the assertion is about game logic, not pixels.

---

### 2. TCP Communication — MEDIUM impact

**The problem:** TCP is a stream protocol — it does not guarantee message boundaries. A single `read()` call might return half a message, two messages concatenated, or any other split. Platform-specific TCP stack behavior (Nagle's algorithm, buffer sizes, coalescing) adds variance.

**Architectural mitigation:** The binary length-prefixed protocol (`[1B type][2B length][payload]`) provides unambiguous framing. The parser accumulates bytes in a buffer and only processes complete messages. One command per frame (in `pdk_e2e_update()`) prevents write-side race conditions.

**Remaining gap:** The parser must be tested under adversarial conditions, not just happy-path round-trips.

**Required protocol tests:**

- Receive a complete message 1 byte at a time
- Receive two messages concatenated in a single TCP packet
- Receive a message truncated mid-payload (parser must buffer and wait)
- Receive an unknown message type (must respond with ERROR, not crash)
- Receive a message with payload length exceeding the receive buffer

---

### 3. Simulator Lifecycle — MEDIUM impact

**The problem:** If tests share a simulator process, state from one test leaks into the next. If the simulator isn't fully killed between suites, TCP ports remain in TIME_WAIT, blocking the next suite's server. Zombie simulator processes accumulate on CI.

**Test isolation strategy:**

| Granularity          | Speed                                      | Isolation | Recommendation                                        |
| -------------------- | ------------------------------------------ | --------- | ----------------------------------------------------- |
| Per test             | Slow (2-3s launch overhead per test)       | Perfect   | Not recommended — too slow                            |
| Per suite            | Moderate (one launch per `describe` block) | Good      | **Default recommendation**                            |
| Shared across suites | Fast                                       | Poor      | Only for advanced users who understand the trade-offs |

**Contract for `game.close()`:**

1. Kill the simulator process (SIGTERM, then SIGKILL after timeout)
2. Wait for the TCP port to be released
3. Clean up any temporary files
4. Must not throw — cleanup failures are logged, not fatal

**Guidance for test authors:**

- Always call `game.close()` in `afterEach`, even if the test failed
- Use `releaseInput()` between tests within a suite to reset injected buttons/crank
- Do not rely on game state persisting between tests — if the simulator is restarted, it's gone

---

### 4. Input Injection Timing — LOW-MEDIUM impact

**The problem:** The C module's `pdk_e2e_update()` reads TCP commands and sets internal state (injected buttons, crank angle). If this function runs _after_ the game has already read input for the current frame, the injected input arrives one frame late.

**The contract:** `pdk_e2e_update()` must be called **before** game logic reads input. The integration pattern in README enforces this:

```c
// In update():
PDButtons pushed;
pd->system->getButtonState(NULL, &pushed, NULL);
pushed |= pdk_e2e_update();  // ← OR in injected buttons BEFORE using them
```

If the developer calls `pdk_e2e_update()` at the end of their update function, injected input is delayed by one frame. This is a developer error, not a framework bug — but the error message should diagnose it.

**Crank injection edge case:** Games that use `getCrankChange()` (delta) rather than `getCrankAngle()` (absolute) will see a large delta on the first frame of injection (e.g., 0° → 180° = +180° change). The framework injects absolute angles — games must account for this in their test harness by using absolute angle reads, or by moving the crank in small increments.

---

### 5. Game-Side Randomness — NOT OUR PROBLEM (but we should help)

**The problem:** Games with RNG produce different visual output and state on each run. A screenshot of a randomly-generated level will never match a reference.

**Why it's not our problem:** The framework provides transport and comparison primitives. It does not know what a "level" is or what "random" means in the game's context.

**Guidance for game developers:**

1. **Seed your RNG deterministically in test builds.** The Playdate SDK does not provide a built-in seedable RNG, but most games use their own. Expose a seed mechanism and set it in your test harness.

2. **Prefer state assertions over screenshots for random content.** `queryInt('enemyCount')` is deterministic even if enemy _positions_ are random.

3. **Use `maxDiffPixels` for visual tests of random content.** If a test asserts "the game screen has _something_ on it" rather than "the screen looks exactly like this," set a non-zero threshold:

   ```typescript
   await game.toMatchScreenshot('gameplay', { maxDiffPixels: 500 });
   ```

4. **Guard randomness behind a test flag.** Consider `#ifdef TARGET_SIMULATOR` to disable randomness in test builds, or expose a "test mode" that uses fixed seeds.

---

### 6. Cross-Platform Rendering — LOW impact

**The problem:** The Playdate Simulator on macOS, Windows, and Linux might render fonts, system UI overlays, or sprite scaling differently. Screenshots generated on macOS won't match those generated on Windows.

**Current status:** macOS is the primary CI target. Linux is blocked (simulator hangs in xvfb). Windows is untested.

**Recommendation — defer to Phase 6 (polish):**

Two viable approaches:

1. **Per-platform snapshot directories** — store references under `__screenshots__/darwin/`, `__screenshots__/win32/`, `__screenshots__/linux/`. The runner detects `process.platform` and uses the matching directory.

2. **Single-platform snapshots** — document that snapshots must be generated and tested on the same platform. CI generates and compares; local dev uses `--update-snapshots` if their platform differs.

The right choice depends on whether cross-platform CI becomes a real need. Until then, document the constraint and move on.

---

## Summary

| Source              | Impact     | Mitigated by             | Remaining work                   |
| ------------------- | ---------- | ------------------------ | -------------------------------- |
| Rendering variance  | Eliminated | 1-bit display            | —                                |
| Frame timing        | HIGH       | PING/PONG frame sync     | Conditional wait API             |
| TCP framing         | MEDIUM     | Length-prefixed protocol | Adversarial parser tests         |
| Simulator lifecycle | MEDIUM     | Per-suite restart        | `close()` contract, port cleanup |
| Input timing        | LOW-MED    | Integration contract     | Documentation, error messages    |
| Game RNG            | N/A        | Not our problem          | Developer guidance               |
| Cross-platform      | LOW        | Deferred                 | Phase 6 decision                 |

## Conditional Wait API

The single most impactful mitigation. Full signatures:

```typescript
class PlaydateGame {
  // ... existing API ...

  /**
   * Wait until the framebuffer differs from the current frame.
   * Captures once, then polls each frame via PING/PONG until pixels change.
   * Throws if timeout is reached without a change.
   */
  async waitUntilScreenChanges(options?: { timeout?: number }): Promise<void>;

  /**
   * Wait until a named state value satisfies a predicate.
   * Sends QUERY_STATE each frame via PING/PONG until the predicate returns true.
   * Throws if timeout is reached or if the state name is not registered.
   */
  async waitUntilState<T extends number | string>(
    name: string,
    predicate: (value: T) => boolean,
    options?: { timeout?: number },
  ): Promise<T>;

  /**
   * Wait until the framebuffer stops changing for N consecutive frames.
   * Useful for waiting for animations to complete.
   * Default settleFrames: 3. Throws if timeout is reached.
   */
  async waitUntilStable(options?: {
    settleFrames?: number;
    timeout?: number;
  }): Promise<void>;
}
```

These methods are tracked in [#7](https://github.com/alexzajac/playdate-e2e/issues/7) and should be implemented in Phase 3 alongside input injection.
