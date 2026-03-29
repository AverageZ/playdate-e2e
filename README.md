# playdate-e2e — End-to-End Testing for Playdate Games

Open-source e2e testing library for the Playdate handheld. Works with both C and Lua games. Two packages: a game-side module (C drop-in or Lua C extension) and a TypeScript test runner (dev side).

## Why This Exists

Playdate developers have unit tests and property-based tests for pure logic, but no way to test "when I press A on the title screen, the game starts." The community has been requesting simulator automation, hopefully this fills that gap.

## Requirements

<!-- AIDEV-NOTE: SDK version 2.6.0 is a best guess for TCP API introduction — verify against Playdate SDK changelog -->

- **Playdate SDK ≥ 2.6.0** — required for `pd->network->tcp` APIs (`requestAccess`, `newConnection`, `open`, `getBytesAvailable`, `read`, `write`, `close`). The `pd->graphics->getDisplayFrame()` API has been available since SDK 1.0.
- **Node.js ≥ 24** — required for the TypeScript test runner
- **pnpm ≥ 10.24.0** — package manager
- **`PLAYDATE_SDK_PATH`** environment variable — must point to your Playdate SDK installation

## Installation

### TypeScript test runner

```bash
npm install --save-dev playdate-e2e
# or
pnpm add -D playdate-e2e
```

### C module (C games)

Copy `pdk_e2e.h` and `pdk_e2e.c` from this repository into your game's source directory. No build system changes needed — the files compile with the Playdate SDK directly. See [Game integration](#game-integration) for usage.

### Lua C extension (Lua games)

Copy `pdk_e2e.c` and `pdk_e2e_ext.c` from this repository into your source directory and add them to your CMakeLists.txt:

```cmake
add_executable(${PLAYDATE_GAME_NAME}
    src/pdk_e2e.c
    src/pdk_e2e_ext.c
)
```

See [Build integration](#build-integration) for details.

## Architecture

```
┌──────────────────────┐       TCP (localhost)       ┌──────────────────────┐
│  TypeScript Runner   │◄────────────────────────────│  Game (Simulator)    │
│                      │                              │                      │
│  - TCP server        │  ◄── READY (game connected) │  - pdk_e2e.c module  │
│  - sends commands    │  ──► CAPTURE_FRAME           │  - connects on init  │
│  - receives frames   │  ◄── FRAME_DATA (12480 B)   │  - polls each frame  │
│  - snapshot compare  │  ──► INJECT_INPUT            │  - reads framebuffer │
│  - vitest/jest       │  ◄── INPUT_ACK               │  - injects buttons   │
└──────────────────────┘                              └──────────────────────┘
```

**Key constraint**: SDK TCP API is client-only (no listen/bind/accept). The TypeScript runner hosts the server; the game connects to it.

**Key advantage**: 1-bit 400×240 display = deterministic pixels. No anti-aliasing, no subpixel rendering. Screenshot comparison is exact — drastically more reliable than browser screenshot testing.

**Non-determinism**: The 1-bit display eliminates rendering variance, but frame timing, TCP framing, and simulator lifecycle still introduce non-determinism in tests. The library mitigates these with frame-synced PING/PONG, length-prefixed binary framing, and conditional wait APIs. See [NONDETERMINISM.md](NONDETERMINISM.md) for the full analysis and mitigation strategy.

## Two Testing Layers

### Layer 1: Visual assertions (minimal setup)

Capture the framebuffer and compare against saved PNGs. Requires a small C harness — one init call plus drop-in replacements for `getButtonState()` and `getCrankAngle()` — or 1 guarded call in Lua. No changes to game logic (you swap two SDK calls for drop-in replacements).

```typescript
await game.pressA();
await game.waitFrames(30);
await game.toMatchScreenshot('title-screen');
```

### Layer 2: State assertions (opt-in)

Developer registers named values. Tests query exact numbers.

```c
// game side — optional
pdk_e2e_expose_int("score", &ctx->playerPoints);
```

```typescript
// test side
const score = await game.queryInt('score');
expect(score).toBe(3);
```

---

## C Module: `pdk_e2e.h / pdk_e2e.c`

Lives in this repository. Follows existing conventions: `pdk_` prefix, file-scoped static `PlaydateAPI *pd`, init once during `kEventInit`, no heap after init.

### Device builds — compiles to nothing

```c
#if !TARGET_SIMULATOR
#define pdk_e2e_init(pd, port)           ((void)0)
#define pdk_e2e_update()                 ((void)0)
#define pdk_e2e_get_buttons(c, p, r)     pd->system->getButtonState(c, p, r)
#define pdk_e2e_crank()                  (pd->system->getCrankAngle())
#define pdk_e2e_expose_int(name, ptr)    ((void)0)
#define pdk_e2e_expose_float(name, ptr)  ((void)0)
#define pdk_e2e_expose_string(name, ptr) ((void)0)
#endif
```

### Simulator builds — full API

```c
void pdk_e2e_init(PlaydateAPI *pd, int port);    // connect to runner's TCP server
void pdk_e2e_update(void);                            // poll and process TCP commands
void pdk_e2e_get_buttons(PDButtons *current, PDButtons *pushed, PDButtons *released);  // drop-in for getButtonState(), ORs in injected buttons
float pdk_e2e_crank(void);                        // return injected crank, or real crank if none injected
void pdk_e2e_expose_int(const char *name, const int *ptr);
void pdk_e2e_expose_float(const char *name, const float *ptr);
void pdk_e2e_expose_string(const char *name, const char **ptr);
```

### Connection state machine

```
REQUESTING_ACCESS → WAITING_ACCESS → CONNECTING → WAITING_CONNECT → CONNECTED
                                                                         │
                                                              (sends READY 0xFE)
```

Uses `pd->network->tcp->requestAccess()` → `newConnection()` → `open()`. On `CONNECTED`, sends READY. Each frame, `pdk_e2e_update()` checks `getBytesAvailable()` and processes one command. `pdk_e2e_get_buttons()` wraps `pd->system->getButtonState()` and ORs in any injected buttons. `pdk_e2e_crank()` returns the injected crank angle if set, otherwise the real crank angle.

### Game integration

```c
#include "pdk_e2e.h"

// In kEventInit:
pdk_e2e_init(pd, 54321);

// In update():
pdk_e2e_update();                              // process TCP commands

PDButtons pushed;
pdk_e2e_get_buttons(NULL, &pushed, NULL);      // drop-in for pd->system->getButtonState()
float crank = pdk_e2e_crank();                 // drop-in for pd->system->getCrankAngle()
```

---

## Lua Module: `pdk_e2e_ext.c`

A C extension that reuses all `pdk_e2e.h` internals but registers functions into the Lua runtime via `kEventInitLua`. The Playdate SDK's TCP, framebuffer, and input APIs are C-only, so a C extension is the only viable path for Lua games — but Lua devs never touch C directly.

### How it works

The C extension's `eventHandler` handles two events:

- **`kEventInit`** — stores `PlaydateAPI*`, opens TCP connection (same as pure-C path)
- **`kEventInitLua`** — calls `pd->lua->addFunction()` to register the `playdate.e2e.*` namespace into the Lua runtime. Does NOT call `setUpdateCallback` — Lua owns the update loop.

### Device builds — compiles out cleanly

The C extension wraps all `addFunction()` calls in `#if TARGET_SIMULATOR`. On device builds, the `playdate.e2e` namespace is never registered. The Lua guard `if playdate.e2e then` evaluates to `nil` (falsy) and the call is skipped — zero overhead, no crash.

### Lua API

```lua
-- Layer 1: poll commands, inject input, capture framebuffer
playdate.e2e.update()

-- Layer 1: get injected crank angle, or real crank if none injected
playdate.e2e.crank()

-- Layer 2: expose game state via callback (type inferred from return value)
playdate.e2e.expose(name, callback)
```

### Layer 2: State exposure for Lua

C pointer-based `pdk_e2e_expose_int("score", &ptr)` can't work for Lua values (they live on the Lua stack, not at fixed C addresses). Instead, Lua devs register a callback:

```lua
playdate.e2e.expose("score", function() return gameState.score end)
playdate.e2e.expose("level", function() return gameState.currentLevel end)
```

When a `QUERY_STATE` command arrives over TCP, the C extension dispatches to a Lua-side lookup table, reads the return value, infers the type (int/float/string), and sends the `STATE_VALUE` response. Same wire protocol — the TypeScript runner has no idea whether the game is C or Lua.

### Game integration (1 guarded call in playdate.update)

```lua
local gfx <const> = playdate.graphics

function playdate.update()
    if playdate.e2e then playdate.e2e.update() end
    gfx.sprite.update()
    -- ... rest of game
end

-- Optional: Layer 2 state exposure
if playdate.e2e then
    playdate.e2e.expose("score", function() return gameState.score end)
end
```

### Build integration

Lua games that include C extensions use the SDK's CMake template, which already supports mixed Lua+C builds. Add `pdk_e2e.c` and `pdk_e2e_ext.c` to the source list:

```cmake
# In CMakeLists.txt
add_executable(${PLAYDATE_GAME_NAME}
    src/pdk_e2e.c
    src/pdk_e2e_ext.c
)
```

Alternatively, pre-built binaries (`pdex.dylib`/`pdex.so`/`pdex.dll`) could be distributed for devs who don't want to compile C at all.

---

## Wire Protocol

Binary, length-prefixed messages over TCP. No HTTP parsing needed in C.

```
[1 byte: type] [2 bytes: payload length, big-endian] [N bytes: payload]
```

### Commands (Runner → Game)

| Byte | Name          | Payload                                 |
| ---- | ------------- | --------------------------------------- |
| 0x01 | PING          | (empty)                                 |
| 0x02 | CAPTURE_FRAME | (empty)                                 |
| 0x03 | INJECT_INPUT  | 1B button bitmask + 4B crank float32 LE |
| 0x04 | QUERY_STATE   | null-terminated name string             |
| 0x05 | RELEASE_INPUT | (empty)                                 |

#### INJECT_INPUT payload (0x03)

**Button bitmask** (1 byte) — each bit maps to one button:

| Bit | Value | Button               |
| --- | ----- | -------------------- |
| 0   | 0x01  | A                    |
| 1   | 0x02  | B                    |
| 2   | 0x04  | Up                   |
| 3   | 0x08  | Down                 |
| 4   | 0x10  | Left                 |
| 5   | 0x20  | Right                |
| 6–7 | —     | Reserved (must be 0) |

Multiple buttons: OR the values together. Example: A + Up = `0x01 | 0x04` = `0x05`.

**Crank angle** (4 bytes, float32 little-endian) — absolute angle in degrees.

- Valid range: `0.0` – `359.99` (maps to `getCrankAngle()` on the Playdate)
- Sentinel value: `-1.0` means "no crank injection" — `pdk_e2e_crank()` passes through the real hardware crank angle
- **Delta warning:** Games that use `getCrankChange()` (delta) instead of `getCrankAngle()` (absolute) will see a large instantaneous delta on the first frame of injection (e.g., real angle 0° → injected 180° = +180° change). Use small incremental angle steps to avoid this, or use the TS-side `rotateCrank(delta)` helper.

Response: INPUT_ACK (0x83).

#### RELEASE_INPUT semantics (0x05)

Clears **all** injected input state:

- Button bitmask resets to 0 — `pdk_e2e_get_buttons()` passes through real `getButtonState()` values
- Crank sentinel resets to -1.0 — `pdk_e2e_crank()` returns real hardware crank angle

After RELEASE_INPUT, the game behaves as if no input injection has occurred. Use between tests within a suite to reset state.

Response: INPUT_ACK (0x83).

### Responses (Game → Runner)

| Byte | Name            | Payload                                                                |
| ---- | --------------- | ---------------------------------------------------------------------- |
| 0x81 | PONG            | (empty)                                                                |
| 0x82 | FRAME_DATA      | 12,480 bytes raw framebuffer (52 bytes/row × 240 rows, MSB-first bits) |
| 0x83 | INPUT_ACK       | (empty)                                                                |
| 0x84 | STATE_VALUE     | 1B type tag (0=int32, 1=float32, 2=string) + value                     |
| 0x85 | STATE_NOT_FOUND | (empty)                                                                |
| 0xFE | READY           | (empty) — sent once on connection                                      |
| 0xFF | ERROR           | null-terminated string                                                 |

### Frame synchronization (PING/PONG)

PING/PONG provides **frame-level synchronization** between the runner and the game. This is the core mechanism for deterministic test timing — it counts _game frames_, not wall-clock time.

**Protocol:**

1. Runner sends PING (0x01)
2. Game's `pdk_e2e_update()` receives PING during the current frame
3. Game sends PONG (0x81) after processing the frame
4. Runner receives PONG — one game frame has elapsed

**One PING/PONG round-trip = exactly one game frame**, regardless of the game's refresh rate or simulator CPU load. The runner must wait for PONG before sending the next PING.

**`waitFrames(n)` implementation:** Send PING, wait for PONG, repeat `n` times. Each iteration advances the game by exactly one frame.

**Constraint:** Since `pdk_e2e_update()` processes at most one command per frame, a PING arriving in the same frame as another command will be queued and processed next frame.

### Framebuffer encoding

`pd->graphics->getDisplayFrame()` returns `uint8_t*` — raw LCD memory. 400px wide = 50 data bytes + 2 padding = 52 bytes/row (LCD_ROWSIZE). 240 rows. 1 = white, 0 = black, MSB = leftmost pixel. TypeScript decodes the 52-byte stride, strips padding, converts to PNG.

---

## TypeScript Package: `playdate-e2e`

### Structure

```
playdate-e2e/
  src/
    index.ts                 # public exports
    PlaydateGame.ts          # main class — launch, connect, assert, close
    connection/
      TcpServer.ts           # TCP server, waits for game connection
      Protocol.ts            # message encode/decode
    input/
      InputHelpers.ts        # pressA(), dpadUp(), setCrank(), pressButtons(), tap()
    assert/
      Screenshot.ts          # toMatchScreenshot() with snapshot mgmt
      FrameBuffer.ts         # decode 1-bit framebuffer ↔ PNG
      StateQuery.ts          # queryInt(), queryFloat(), queryString()
    simulator/
      Launcher.ts            # cross-platform simulator discovery + spawn
    types.ts
  test/
    Protocol.test.ts
    FrameBuffer.test.ts
```

### Public API

```typescript
enum PlaydateButton {
  A = 0x01,
  B = 0x02,
  Up = 0x04,
  Down = 0x08,
  Left = 0x10,
  Right = 0x20,
}

class PlaydateGame {
  // Lifecycle
  static async launch(
    pdxPath: string,
    options?: { port?: number; timeout?: number },
  ): Promise<PlaydateGame>;
  async close(): Promise<void>;

  // Screenshots
  async screenshot(): Promise<Buffer>;
  async toMatchScreenshot(
    name: string,
    options?: { maxDiffPixels?: number },
  ): Promise<void>;

  // Input
  async pressA(): Promise<void>;
  async pressB(): Promise<void>;
  async dpadUp(): Promise<void>;
  async dpadDown(): Promise<void>;
  async dpadLeft(): Promise<void>;
  async dpadRight(): Promise<void>;
  async setCrank(angle: number): Promise<void>;
  async rotateCrank(delta: number): Promise<void>; // TS-side: tracks last angle, sends INJECT_INPUT(lastAngle + delta)
  async pressButtons(...buttons: PlaydateButton[]): Promise<void>;
  async releaseInput(): Promise<void>;
  async tap(button: PlaydateButton, holdFrames?: number): Promise<void>;

  // Timing
  async waitFrames(n: number): Promise<void>; // frame-synced via PING/PONG
  async waitMs(ms: number): Promise<void>;

  // Conditional waits (preferred over waitFrames for non-deterministic timing)
  async waitUntilScreenChanges(options?: { timeout?: number }): Promise<void>;
  async waitUntilState<T extends number | string>(
    name: string,
    predicate: (value: T) => boolean,
    options?: { timeout?: number },
  ): Promise<T>;
  async waitUntilStable(options?: {
    settleFrames?: number;
    timeout?: number;
  }): Promise<void>;

  // State queries (requires pdk_e2e_expose_* in game)
  async queryInt(name: string): Promise<number>;
  async queryFloat(name: string): Promise<number>;
  async queryString(name: string): Promise<string>;
}
```

### Cross-platform simulator launch

```typescript
// Launcher.ts finds the binary via PLAYDATE_SDK_PATH env var:
// macOS:   $PLAYDATE_SDK_PATH/bin/Playdate Simulator.app/Contents/MacOS/Playdate Simulator
// Windows: $PLAYDATE_SDK_PATH/bin/PlaydateSimulator.exe
// Linux:   $PLAYDATE_SDK_PATH/bin/PlaydateSimulator
```

### CI / Headless testing

The Playdate Simulator is a GUI application — there is no official `--headless` flag. CI feasibility depends on the runner's display environment:

| Platform    | CI support       | Notes                                                                                                                  |
| ----------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **macOS**   | **Works**        | GitHub Actions macOS runners have an emulated display server. Primary CI target.                                       |
| **Windows** | **Likely works** | Similar display support, less community-tested.                                                                        |
| **Linux**   | **Blocked**      | xvfb [hangs the simulator](https://devforum.play.date/t/simulator-hangs-in-xvfb/10796). No workaround currently known. |

**Recommended setup** (macOS GitHub Actions):

1. Install the SDK with [`setup-playdate-sdk`](https://github.com/marketplace/actions/setup-playdate-sdk)
2. Suppress the email signup popup that blocks unattended runs:
   ```bash
   defaults write date.play.simulator elistShown -bool YES
   ```
3. Build your game with `pdk_e2e` linked, then run tests normally

See [`.github/workflows/e2e.yml`](.github/workflows/e2e.yml) for a complete example workflow.

### Screenshot comparison

- First run: no reference → save captured frame as reference PNG
- Subsequent runs: XOR raw framebuffers, count differing bits
- Default threshold: 0 (exact match — viable because 1-bit is deterministic)
- On failure: generate diff PNG showing changed pixels
- Optional tolerance: `maxDiffPixels` parameter for screens with random content

### Snapshot storage

```
e2e/
  __screenshots__/
    title-screen.png
    prologue-1.png
  __screenshots__/diff/         # generated on failure only
    title-screen-diff.png
```

Reference PNGs are committed to the repo — 1-bit 400×240 images are ~1-3KB each, so 50 screenshots ≈ 50-150KB. Diff PNGs are `.gitignore`d.

### Snapshot update workflow

Snapshot updates use vitest's native `--update` flag. No custom CLI flags or environment variables.

**Update all snapshots in a run:**

```bash
vitest run e2e/ --update
```

**Update a single test file's snapshots:**

```bash
vitest run e2e/title.test.ts --update
```

**Update a single test's snapshot:**

```bash
vitest run e2e/title.test.ts -t "shows title screen" --update
```

**How it works:** `toMatchScreenshot()` detects update mode via vitest's `globalSetup` and `provide`/`inject`:

```typescript
// vitest.globalSetup.ts
export default function setup({ config, provide }) {
  provide('updateSnapshots', config.snapshotOptions?.updateSnapshot === 'all');
}

// Inside toMatchScreenshot() — uses inject('updateSnapshots') to decide
// whether to overwrite the reference PNG or compare against it.
```

**First-run behavior:** When no reference PNG exists, the captured frame is saved as the new reference. The test passes and logs: `Screenshot "title-screen" created (no reference existed)`. This matches vitest's convention for new snapshots.

---

## Limitations

Things this library **cannot** do (yet?):

| Capability                   | Status                  | Notes                                                                                                                                                                                |
| ---------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Accelerometer**            | Not supported           | Playdate's accelerometer cannot be injected or read via the testing protocol. Games that depend on tilt input cannot be fully e2e tested.                                            |
| **Sound/audio**              | Not supported           | No way to capture or assert on audio output. Test game logic and visual state instead.                                                                                               |
| **System menu**              | Not supported           | Cannot open, interact with, or verify the Playdate system menu.                                                                                                                      |
| **State types**              | int, float, string only | No bools, arrays, or composite types. Workaround: expose a bool as int (0/1), or serialize composites to a string.                                                                   |
| **State pointers (C usage)** | Global/static only      | `pdk_e2e_expose_int("x", &ptr)` stores a pointer — if `ptr` is a local variable, it will be garbage by query time. Only expose pointers to global, static, or heap-allocated values. |
| **Linux CI**                 | Blocked                 | Simulator [hangs under xvfb](https://devforum.play.date/t/simulator-hangs-in-xvfb/10796). macOS CI works. Windows CI is untested but likely works.                                   |

---

## Error Handling

### Timeouts

Every async operation in `PlaydateGame` accepts an optional `timeout` (milliseconds). When a timeout expires, the library throws with a message naming the operation and duration:

```
TimeoutError: waitFrames(30) timed out after 5000ms — is the simulator running? Is the game calling pdk_e2e_update()?
```

Default timeout: 5000ms for most operations. `PlaydateGame.launch()` uses 10000ms to allow for simulator startup.

### Connection failures

| Scenario                           | Behavior                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Simulator not running              | `launch()` times out. Error suggests checking `PLAYDATE_SDK_PATH` and that the `.pdx` was built with `pdk_e2e` linked. |
| Port already in use                | `launch()` fails immediately with `EADDRINUSE`. Kill the orphaned simulator or use a different port.                   |
| Game doesn't call `pdk_e2e_init()` | TCP server never receives READY. `launch()` times out.                                                                 |
| Game crashes mid-test              | TCP connection drops. Next command throws a connection error. Call `game.close()` in `afterEach` to clean up.          |
| TCP connection drops               | Commands throw immediately. The library does not auto-reconnect — kill and relaunch via a new `PlaydateGame.launch()`. |
| Simulator hangs                    | Commands time out. `game.close()` kills the simulator process.                                                         |

### Cleanup

Always use `afterEach` to close the game, even on test failure:

```typescript
afterEach(async () => await game?.close());
```

`close()` kills the simulator process and releases the TCP port.

---

## Example: steady-on "Prologue to Tournament"

```typescript
import { describe, it, afterEach } from 'vitest';
import { PlaydateGame } from 'playdate-e2e';

describe('Prologue to Tournament', () => {
  let game: PlaydateGame;
  afterEach(async () => await game?.close());

  it('shows 5 screens before the tutorial tournament', async () => {
    game = await PlaydateGame.launch('../SteadyOn.pdx');

    await game.toMatchScreenshot('title-screen');

    await game.pressA();
    await game.waitFrames(30);

    for (let i = 1; i <= 4; i++) {
      await game.toMatchScreenshot(`prologue-${i}`);
      await game.pressA();
      await game.waitFrames(30);
    }

    await game.toMatchScreenshot('mount-up');
    await game.setCrank(0); // undock crank
    await game.waitFrames(10);
    await game.pressA();
    await game.waitFrames(60); // visor closing animation

    await game.toMatchScreenshot('tournament-start');
  }, 30_000);
});
```

### Helper for skipping prologue in later tests

```typescript
export async function skipPrologue(game: PlaydateGame): Promise<void> {
  await game.pressA();
  await game.waitFrames(15);
  for (let i = 0; i < 4; i++) {
    await game.pressA();
    await game.waitFrames(15);
  }
  await game.setCrank(0);
  await game.waitFrames(10);
  await game.pressA();
  await game.waitFrames(60);
}
```

---

## Example: Lua game "Cranky Birds"

The TypeScript test side is identical — the runner doesn't know or care if the game is C or Lua.

```typescript
import { describe, it, afterEach } from 'vitest';
import { PlaydateGame } from 'playdate-e2e';

describe('Cranky Birds', () => {
  let game: PlaydateGame;
  afterEach(async () => await game?.close());

  it('launches to the title screen and starts a round', async () => {
    game = await PlaydateGame.launch('../CrankyBirds.pdx');

    await game.toMatchScreenshot('title-screen');

    await game.pressA();
    await game.waitFrames(30);
    await game.toMatchScreenshot('round-1-start');

    // Layer 2: query Lua-exposed state
    const score = await game.queryInt('score');
    expect(score).toBe(0);
  }, 15_000);
});
```

The Lua game side:

```lua
local gfx <const> = playdate.graphics

local gameState = { score = 0, level = 1 }

function playdate.update()
    if playdate.e2e then playdate.e2e.update() end
    gfx.sprite.update()
end

-- Layer 2: expose state for test assertions
if playdate.e2e then
    playdate.e2e.expose("score", function() return gameState.score end)
    playdate.e2e.expose("level", function() return gameState.level end)
end
```

---

## Open Questions

1. **Network access prompt** — `tcp->requestAccess()` may show a dialog on first use. Need to verify if it's remembered across sessions or if there's an auto-approve mechanism for simulator builds. If it blocks, tests can't run unattended.

2. **Crank dock state** — `isCrankDocked()` is separate from crank angle. Setting crank angle may not implicitly undock. May need a separate `DOCK_CRANK` / `UNDOCK_CRANK` command.

3. **Package naming** — `playdate-e2e` (discoverable, simple) vs `@pd-kit/e2e` (matches ecosystem, needs npm org). Leaning toward `playdate-e2e` for open source discoverability.

4. **PNG library** — `sharp` (fast, native deps) vs `pngjs` (pure JS, slower). Start with `sharp`, document `pngjs` fallback. Since 1-bit raw comparison is the hot path, PNG encoding is only for human-readable snapshots.

5. **Reconnection** — if a test crashes, the simulator stays open. Should the C module attempt reconnection, or should the runner kill and relaunch the simulator per test suite?

6. **Multiple commands per frame** — current design: one command per `pdk_e2e_update()` call (one per frame at 30fps). May be slow for screenshot-heavy tests. Could batch, but risks blocking the game loop.

7. **Lua input injection propagation** — C games use `pdk_e2e_get_buttons()` which wraps `getButtonState()` and ORs in injected buttons internally. Lua games use `playdate.buttonJustPressed()` etc. Does C-level button state manipulation propagate to these Lua APIs? If not, a Lua-side input wrapper is needed.

8. **Lua C extension conflicts** — if a Lua game already has its own C extension (`eventHandler` in a `.c` file), adding `pdk_e2e_ext.c` creates a duplicate symbol. Need to document how to merge `eventHandler` functions, or provide `pdk_e2e_ext.h` as an includable header instead of a standalone entry point.

9. **Pre-built binaries for Lua devs** — should pre-compiled `pdex.dylib`/`pdex.so`/`pdex.dll` be distributed via GitHub releases so Lua-only devs never need a C toolchain? Or is source compilation (via the SDK's CMake template) sufficient?

## Implementation Phases

| Phase | What                                                                                 | Days |
| ----- | ------------------------------------------------------------------------------------ | ---- |
| 1     | Wire protocol + TCP connection (C state machine + TS server + PING/PONG)             | 1-2  |
| 2     | Framebuffer capture (C getDisplayFrame + TS decode to PNG + snapshot compare)        | 1    |
| 3     | Input injection (C button/crank injection + TS helpers + waitFrames via PING/PONG)   | 1    |
| 3.5   | Lua C extension (`pdk_e2e_ext.c` + `kEventInitLua` registration + Lua input test)    | 1    |
| 4     | State exposure (C pointer registry + Lua callback dispatch + TS query methods)       | 0.5  |
| 5     | Simulator lifecycle (cross-platform launch/close + PlaydateGame.launch())            | 0.5  |
| 6     | Polish (--update-snapshots, diff images, Lua docs, pre-built binaries, package.json) | 1    |
