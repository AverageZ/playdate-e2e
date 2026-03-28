# playdate-e2e — End-to-End Testing for Playdate Games

First open-source e2e testing library for the Playdate handheld. Two packages: a C drop-in module (game side) and a TypeScript test runner (dev side).

## Why This Exists

Playdate developers have unit tests and property-based tests for pure logic, but no way to test "when I press A on the title screen, the game starts." The community has been requesting simulator automation — this fills that gap.

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

## Two Testing Layers

### Layer 1: Visual assertions (zero game code changes)

Capture the framebuffer and compare against saved PNGs. Works out of the box for any Playdate game.

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

Lives in pd-kit. Follows existing conventions: `pdk_` prefix, file-scoped static `PlaydateAPI *pd`, init once during `kEventInit`, no heap after init.

### Device builds — compiles to nothing

```c
#if !TARGET_SIMULATOR
#define pdk_e2e_init(pd, port)           ((void)0)
#define pdk_e2e_update()                 ((PDButtons)0)
#define pdk_e2e_crank()                  (-1.0f)
#define pdk_e2e_expose_int(name, ptr)    ((void)0)
#define pdk_e2e_expose_float(name, ptr)  ((void)0)
#define pdk_e2e_expose_string(name, ptr) ((void)0)
#endif
```

### Simulator builds — full API

```c
void pdk_e2e_init(PlaydateAPI *pd, int port);    // connect to runner's TCP server
PDButtons pdk_e2e_update(void);                   // poll commands, return injected buttons
float pdk_e2e_crank(void);                        // return injected crank or -1.0f
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

Uses `pd->network->tcp->requestAccess()` → `newConnection()` → `open()`. On `CONNECTED`, sends READY. Each frame, `pdk_e2e_update()` checks `getBytesAvailable()` and processes one command.

### Game integration (3 lines in main.c)

```c
#include "pdk_e2e.h"

// In kEventInit:
pdk_e2e_init(pd, 54321);

// In update():
PDButtons pushed;
pd->system->getButtonState(NULL, &pushed, NULL);
pushed |= pdk_e2e_update();                        // OR in injected buttons

float crank = pdk_e2e_crank();                      // check for injected crank
if (crank < 0) crank = pd->system->getCrankAngle(); // fallback to real crank
```

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
      InputHelpers.ts        # pressA(), dpadUp(), setCrank(), tap()
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
  async releaseInput(): Promise<void>;
  async tap(button: PlaydateButton, holdFrames?: number): Promise<void>;

  // Timing
  async waitFrames(n: number): Promise<void>; // frame-synced via PING/PONG
  async waitMs(ms: number): Promise<void>;

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

### Screenshot comparison

- First run: no reference → save captured frame as reference PNG
- Subsequent runs: XOR raw framebuffers, count differing bits
- Default threshold: 0 (exact match — viable because 1-bit is deterministic)
- `--update-snapshots` flag to regenerate references
- On failure: generate diff PNG showing changed pixels

### Snapshot storage

```
e2e/
  __screenshots__/
    title-screen.png
    prologue-1.png
  __screenshots__/diff/         # generated on failure only
    title-screen-diff.png
```

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

## Open Questions

1. **Network access prompt** — `tcp->requestAccess()` may show a dialog on first use. Need to verify if it's remembered across sessions or if there's an auto-approve mechanism for simulator builds. If it blocks, tests can't run unattended.

2. **Crank dock state** — `isCrankDocked()` is separate from crank angle. Setting crank angle may not implicitly undock. May need a separate `DOCK_CRANK` / `UNDOCK_CRANK` command.

3. **Package naming** — `playdate-e2e` (discoverable, simple) vs `@pd-kit/e2e` (matches ecosystem, needs npm org). Leaning toward `playdate-e2e` for open source discoverability.

4. **PNG library** — `sharp` (fast, native deps) vs `pngjs` (pure JS, slower). Start with `sharp`, document `pngjs` fallback. Since 1-bit raw comparison is the hot path, PNG encoding is only for human-readable snapshots.

5. **Reconnection** — if a test crashes, the simulator stays open. Should the C module attempt reconnection, or should the runner kill and relaunch the simulator per test suite?

6. **Multiple commands per frame** — current design: one command per `pdk_e2e_update()` call (one per frame at 30fps). May be slow for screenshot-heavy tests. Could batch, but risks blocking the game loop.

## Implementation Phases

| Phase | What                                                                               | Days |
| ----- | ---------------------------------------------------------------------------------- | ---- |
| 1     | Wire protocol + TCP connection (C state machine + TS server + PING/PONG)           | 1-2  |
| 2     | Framebuffer capture (C getDisplayFrame + TS decode to PNG + snapshot compare)      | 1    |
| 3     | Input injection (C button/crank injection + TS helpers + waitFrames via PING/PONG) | 1    |
| 4     | State exposure (C registry + TS query methods)                                     | 0.5  |
| 5     | Simulator lifecycle (cross-platform launch/close + PlaydateGame.launch())          | 0.5  |
| 6     | Polish (--update-snapshots, diff images, README, package.json)                     | 1    |
