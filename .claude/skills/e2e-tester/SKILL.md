---
name: e2e-tester
description: Write end-to-end tests using the TestScenario DSL
---

# Write E2E Test

Write an end-to-end test for in the proper, accepted ways

## Step 1: Understand the Feature

1. Read `e2e/CLAUDE.md` for the latest DSL reference (it may have been updated since this skill was written)
2. Parse the argument — it could be a feature description, an existing spec file path, or a ticket number
3. If a ticket number: fetch with `gh issue view <number>` to understand requirements
4. If a spec file: read the file to understand what's already covered
5. Search for related e2e tests in `e2e/features/` to find existing patterns for this domain

## Step 2: Discover Game Systems

Find the game code relevant to what you're testing:

- **Skills**: `src/type-definitions/skills.ts`, `src/constants/skillDescriptions.ts`
- **Classes**: `src/state/units/selectors/selectUnitSkills.ts` (class-skill relationships)
- **Talents**: `src/constants/talent-trees/*.ts`
- **Combat**: `src/state/combat/` selectors and systems
- **Conditions**: `src/type-definitions/conditions/` and `src/systems/conditions/`
- **Environmental effects**: `src/systems/game/environmental-effects/`
- **Game constants**: `src/constants/gameConstants.ts`

Use `Grep` and `Glob` to find relevant code. Understand the mechanics before writing the test.

## Step 3: Write the Test

### File Location

Place tests in `e2e/features/{domain}/{feature}.spec.ts`. Match existing directory structure:

```
e2e/features/
  combat/
  conditions/
  environmental/
  items/
  mechanisms/
  movement/
  skills/
  talents/
  traits/
  ...
```

Note: `scripts/select-e2e-tests.js` works with `scripts/e2e-test-mapping.json` to help find relevant specs to be run during pre-commit.

### Test Template

```typescript
import { test } from '@playwright/test';
import { TestScenario } from 'e2e/dsl';

test.describe('Feature Name', () => {
  test('specific behavior being tested', async ({ page }, testInfo) => {
    const scenario = TestScenario.for(page).given.boardWithUnits(
      [
        {
          id: 'warrior',
          class: 'warrior',
          position: [2, 5, 0],
          team: 'player',
        },
        { id: 'enemy', class: 'beast', position: [5, 5, 0], team: 'enemy' },
      ] as const, // REQUIRED for type-safe unit IDs
      { width: 10, height: 10 },
    );

    await scenario.when
      .unit('warrior')
      .movesTo([4, 5, 0])
      .then.unit('warrior')
      .hasStatValue('pace')
      .equals(0)
      .execute();
  });
});
```

### DSL API Quick Reference

**Given (Setup):**

```
.given.boardWithUnits(units, config?)  — Board with units (preferred)
.given.levelEditor(config)             — Configure dimensions only
.given.withUnits(units)                — Add units after levelEditor
```

**Unit Config:**

```typescript
{
  id: string,                           // Unique ID for .when.unit('id')
  class: string,                        // 'warrior', 'cavalier', 'mage', 'beast', etc.
  position: [x, y, z],                  // Board coordinates
  team: 'player' | 'enemy' | 'ally',
  level?: number,                       // Default: 1
  experience?: number,
  talents?: string[],                   // e.g., ['A:1', 'B:1', 'C:1']
  traits?: string[],                    // e.g., ['venomous', 'flying']
  equipmentPreset?: 'none' | 'basic' | 'advanced',
  statModifiers?: Array<{ stat: string, value: number } | { preset: string }>,
  behavior?: string,                    // For enemy units: 'passive', 'coward', etc.
  conditions?: Array<{ type: string, duration: number }>,
  usableItems?: Array<{ category: string, rating: number }>,
}
```

**Board Config (optional second arg to boardWithUnits):**

```typescript
{
  width?: number,            // Default: 10
  height?: number,           // Default: 10
  tiles?: Array<{ material: string, position: [x, y] }>,
  environmentalEffects?: Array<{
    type: string,            // 'fire', 'wind', 'rain', 'ice'
    position: [x, y, z],
    intensity?: number,
    direction?: string,      // For wind: 'north', 'south', etc.
  }>,
}
```

**When (Actions):**

```
.when.unit('id').movesTo([x, y, z])
.when.unit('id').attacks('targetId')
.when.unit('id').castsSkill('SkillName', 'targetId')
.when.unit('id').castsSelfTargetSkill('SkillName')
.when.unit('id').opensSkillTargeting('SkillName')
.when.unit('id').opensCombatPreview('targetId')
.when.unit('id').opensSkillPreview('SkillName', 'targetId')
.when.unit('id').picksUpItem([x, y, z])
.when.unit('id').selectsTalent('B:1')                           — Select a talent node
.when.unit('id').usesItem('itemName')                           — Use consumable item
.when.unit('id').skips()                                        — Skip unit's turn
.when.unit('id').activates('mechanismId')                       — Activate switch
.when.unit('id').opens('mechanismId')                           — Open door
.when.unit('id').closes('mechanismId')                          — Close door
.when.unit('id').attacksMechanism('mechanismId')                — Attack mechanism
.when.registerDynamicUnit('id', { summonedBy: 'unitId' })       — Register summoned/spawned units
.when.confirmSkillCast()                                        — Confirm pending skill cast
.when.closeCombatPreview()
.when.closeSkillPreview()
.when.endTurn()
.when.advanceTurns(n)
.when.waitForTimeout(ms)                                        — Wait for async state propagation
.when.pressKey('Escape')                                        — Press keyboard key
.when.custom(async (context) => { ... })    — Escape hatch (AVOID) — calls ensureCleanState() first!
.when.observe(async (context) => { ... })   — For complex assertions — NO cleanup, preserves UI state
```

**Then (Assertions):**

```
.then.unit('id').hasCondition('Name')           — Has condition
.then.unit('id').hasCondition('Name', false)    — Does NOT have condition
.then.unit('id').hasStatValue('stat').equals(n)
.then.unit('id').hasStatValue('stat').greaterThan(n)
.then.unit('id').hasStatValue('stat').lessThan(n)
.then.unit('id').hasStatValue('stat').lessThan(scenario.captured('key'))
.then.unit('id').hasMaxStatValue('stat').equals(n)
.then.unit('id').hasStatValue('stat').capture('key')
.then.unit('id').isDead()
.then.unit('id').isAlive()
.then.unit('id').isAtPosition('x,y,z')
.then.unit('id').hasSkillOnCooldown('SkillName', true)
.then.unit('id').hasScheduledEffect('Bleed')                    — Has scheduled effect
.then.unit('id').hasScheduledEffect('Bleed', false)             — Does NOT have effect
.then.unit('id').hasStatModifier('name')                        — Has stat modifier
.then.unit('id').hasStatModifier('name', false)                 — Does NOT have modifier
.then.unit('id').hasSkill('SkillName')                          — Has skill
.then.unit('id').hasSkill('SkillName', false)                   — Does NOT have skill
.then.unit('id').hasClass('warrior')                            — Has specific class
.then.unit('id').hasLevel(5)                                    — Has specific level
.then.mechanism('id').hasHealth(n)                              — Mechanism health check
.then.mechanism('id').isDestroyed()                             — Mechanism destroyed
.then.mechanism('id').isOpen() / .isClosed() / .isLocked()      — Door state
.then.mechanism('id').isActivated() / .isDeactivated()          — Switch state
.then.dialogIsVisible() / .dialogIsNotVisible()                 — Dialog state
.then.dialogContainsText('text')                                — Dialog content
.then.combatPreview('attacker', 'damage').equals(n)
.then.combatPreview('attacker', 'damage').capture('key')
.then.combatPreview('attacker', 'damage').isGreaterThan(scenario.captured('key'))
.then.combatPreview('defender', 'hit-chance').isGreaterThan(n)
.then.castTile([x, y, z]).isVisible()
.then.castTile([x, y, z]).isDisabled()
.then.castTile([x, y, z]).isNotVisible()
.then.tile([x, y, z]).hasEnvironmentalEffect('fire')
.then.tile([x, y, z]).hasEnvironmentalEffect('fire', { intensity: 2 })
.then.tile([x, y, z]).hasNoEnvironmentalEffect('fire')
.then.showsVictoryScreen()
.then.showsDefeatScreen()
.then.isTurn(turnNumber, team, phase)
```

**Note — method naming differs between builders:**
Unit stat assertions use bare names (`greaterThan`, `lessThan`, `equals`),
while combat/skill/mechanism preview assertions use `is`-prefixed names
(`isGreaterThan`, `isLessThan`, `equals`). This is because unit stat builders
return `this` for chaining `.capture()`, while preview builders follow a
different pattern. When in doubt, check the builder source.

### Discovering More DSL Methods

The Quick Reference above covers the most common methods. The DSL has additional
methods not listed here. When you need functionality not shown above, read the
builder source files directly:

- `e2e/dsl/builders/WhenBuilder.ts` — All `.when.*` actions
- `e2e/dsl/builders/UnitActionBuilder.ts` — All `.when.unit('id').*` actions
- `e2e/dsl/builders/ThenBuilder.ts` — All `.then.*` assertion entry points
- `e2e/dsl/builders/UnitAssertionBuilder.ts` — All `.then.unit('id').*` assertions
- `e2e/dsl/builders/MechanismAssertionBuilder.ts` — Mechanism assertions
- `e2e/dsl/builders/TileAssertionBuilder.ts` — Tile/environment assertions
- `e2e/dsl/builders/GivenBuilder.ts` — Setup methods

### Value Capture Pattern

Break the chain after captures to get proper TypeScript types on `scenario.captured()`:

```typescript
// Phase 1: Setup and capture
const scenario = TestScenario.for(page)
  .given.boardWithUnits([...] as const)
  .then.unit('warrior').hasStatValue('pace').greaterThan(0).capture('initialPace')
  .when.unit('warrior').opensCombatPreview('enemy')
  .then.combatPreview('attacker', 'damage').capture('baseDamage');

// Phase 2: Use captured values (scenario.captured() now has proper types)
await scenario.when
  .closeCombatPreview()
  .when.unit('warrior').movesTo([4, 5, 0])
  .then.unit('warrior').hasStatValue('pace').lessThan(scenario.captured('initialPace'))
  .execute();
```

### Multi-Phase Captures

When captures occur at different test stages, break the chain at each capture point:

```typescript
// Phase 1: Initial state
const s1 = TestScenario.for(page)
  .given.boardWithUnits([...] as const)
  .then.unit('ranger').hasStatValue('health').capture('healthBefore')
  .when.unit('ranger').castsSelfTargetSkill('summon-familiar')
  .when.registerDynamicUnit('familiar', { summonedBy: 'ranger' })
  .then.unit('familiar').hasStatValue('health').capture('familiarHealthBefore');

// Phase 2: After combat — new captures reference s1's captures
const s2 = s1.when
  .endTurn()
  .then.isTurn(2, 'player', 'active')
  .then.unit('familiar').hasStatValue('health')
  .lessThan(s1.captured('familiarHealthBefore'))
  .capture('familiarHealthAfterCombat');

// Phase 3: Final assertions reference s2's captures
await s2.when
  .unit('cleric').castsSkill('heal', 'ranger')
  .then.unit('ranger').hasStatValue('health')
  .greaterThan(s2.captured('healthBefore'))
  .then.unit('familiar').hasStatValue('health')
  .equals(s2.captured('familiarHealthAfterCombat'))
  .execute();
```

**Key rules:**
- `.capture()` returns synchronously — never `await` the chain break
- Each new scenario ref (`s2`) inherits all prior captures
- Only reference captures from the scenario ref that has them in its type

### Math on Captured Values — Prefer You Don't

The DSL doesn't support arithmetic on captured refs (no `captured('x') * 1.25`). You might be tempted to work around this with `.observe()` + closure variables:

```typescript
// ❌ Brittle — couples the test to the exact multiplier
let baseDamage = 0;
await scenario.when
  .observe(async (context) => {
    baseDamage = parseInt(
      await context.game.getCombatPreviewStat('attacker', 'damage'), 10,
    );
  })
  // ... later ...
  .when.observe(async (context) => {
    const damage = parseInt(
      await context.game.getCombatPreviewStat('attacker', 'damage'), 10,
    );
    expect(damage).toBe(Math.round(baseDamage * 1.25)); // breaks if multiplier changes
  })
  .execute();
```

**Don't do this.** If the talent's multiplier changes from 1.25x to 1.3x, the test fails even though the feature works fine. E2E tests should validate observable behavior, not formulas.

**Instead, use DSL capture with relative comparisons:**

```typescript
// ✅ Resilient — tests the contract: "damage increased"
const scenario = TestScenario.for(page)
  .given.boardWithUnits([...] as const)
  .when.unit('ranger').opensCombatPreview('enemy')
  .then.combatPreview('attacker', 'damage').capture('baseDamage');

await scenario.when
  .closeCombatPreview()
  .when.unit('ranger').selectsTalent('E:2')
  .when.unit('ranger').opensCombatPreview('enemy')
  .then.combatPreview('attacker', 'damage')
  .isGreaterThan(scenario.captured('baseDamage'))
  .execute();
```

**If you need exact formula validation**, write a unit test on the calculation function instead — that's where multiplier precision belongs.

### Deterministic Combat (Stat Modifier Cheat Sheet)

Always use stat modifiers to avoid flaky tests from RNG:

| Goal                  | Stat           | Value               | Effect                 |
| --------------------- | -------------- | ------------------- | ---------------------- |
| Ensure hits land      | `perception`   | 30                  | +10 accuracy modifier  |
| Reduce target dodge   | `dexterity`    | -20                 | Much lower dodge       |
| Survive multiple hits | `constitution` | 100                 | Very high HP pool      |
| High damage output    | `might`        | 50                  | Strong physical damage |
| Start damaged         | preset         | `'Damaged (Heavy)'` | Reduced HP             |

```typescript
// Attacker that always hits
{
  statModifiers: [{ stat: 'perception', value: 30 }];
}

// Target that survives and can't dodge
{
  statModifiers: [
    { stat: 'constitution', value: 100 },
    { stat: 'dexterity', value: -20 },
  ];
}
```

### Forcing Bot Behavior

A common cause of flaky tests or "strange" assertion problems usually comes from the `behavior` set on the non-player units. It is important to reference the game mechanics for what a behavior is likely to impact.

Important: Use `mechanics-explainer` skill to confirm game mechanics

Cheat Sheet

| Behavior | Likely Outcome | Notes |
| mindless | move aggressively towards nearby player units | |
| passive | stands in place and does nothing | this is a good one for tests |

### Custom Bot Scripts

Units can have custom tactic scripts that override behavior presets. The DSL doesn't support `script` natively — use `.when.custom()` to interact with the BotScriptPanel:

```typescript
.when.custom(async (ctx) => {
  const unit = ctx.getUnit('enemy');
  await unit.click();
  await ctx.page.getByTestId('toggle-custom-script').click();
  await ctx.page.getByTestId('add-tactic-button').click();
  await ctx.page.getByTestId('tactic-condition-select').selectOption('always');
  await ctx.page.getByTestId('tactic-action-select').selectOption('use skill');
  await ctx.page.getByTestId('tactic-skill-select').selectOption('Fireball');
  await ctx.page.getByTestId('tactic-priority-select').selectOption('nearest');
  await ctx.page.getByTestId('confirm-add-tactic').click();
})
```

**Key test-ids:** `toggle-custom-script`, `add-tactic-button`, `tactic-condition-select`, `tactic-action-select`, `tactic-priority-select`, `confirm-add-tactic`, `cancel-add-tactic`, `reset-script-button`. Conditional fields: `tactic-skill-select` (use skill), `tactic-item-stat-select` / `tactic-item-operation-select` (use item), `tactic-place-strategy-select` (place item). List management: `tactic-item-${index}`, `move-tactic-up-${index}`, `move-tactic-down-${index}`, `remove-tactic-${index}`.

### Page Objects (When DSL Doesn't Cover)

The DSL does NOT yet cover these — use page objects from `e2e/objects/shared/`:

- Character Creation → `CharacterCreation`
- Deployment Phase → `Deployment`
- Trade Interface → `Trade`
- Settings → `Settings`
- Scene Navigation → `Scene`
- Storyline-specific levels

Note: if you come across one of these, alert the user *immediately*

## Step 4: Run & Verify

Run the test:

```bash
pnpm test:e2e --grep "test name"
```

If it fails:

1. Check if a unit died unexpectedly (add constitution)
2. Check if combat missed (add perception, reduce dexterity)
3. Check turn sequencing (verify turn number and phase)
4. Check for timeout — but **do not** just increase `testInfo.setTimeout()`. Investigate why it's slow first:
   - Unnecessary `advanceTurns` calls or heavy setup?
   - Some UI blocking selection?
   - Multiple items/units/selectors matching?
   - Too many observe/custom blocks with expensive selectors?
   - Incorrect setup (talents, items)?

   **Timeout guidance:**
   - **Default (no `setTimeout`)**: Single-turn tests — movement, attacks, previews, conditions
   - **30s (`testInfo.setTimeout(30_000)`)**: Tests with `endTurn()` + phase transitions, talent selection mid-test
   - **60s (`testInfo.setTimeout(60_000)`)**: Multiple turn cycles, familiar summoning + combat + heal sharing, complex talent synergy verification

   Only add timeouts for tests that genuinely need them. The Playwright default is 30s — match it explicitly for turn-based tests so intent is clear.
5. Review error context in `test-results/{test-name}/error-context.md`
6. Use `mechanics-explainer` skill to confirm game mechanics

Iterate until the test passes consistently. Run 3+ times to confirm no flakiness.

## Anti-Patterns

- **Never** use the old `setupLevelEditorWithUnits` pattern — use the DSL
- **Never** pipe test output (`pnpm test:e2e | grep` causes memory leaks)
- **Never** access `window.__STORE__` or `globalThis.__STORE__` — configure ALL state through the Level Editor UI
- **Never** use `page.evaluate()` to dispatch Redux actions — extend the Level Editor if a property isn't supported
- **Always** use `as const` on the units array for type-safe IDs
- **Avoid** `.when.custom()` unless the DSL genuinely can't express the action
- **Don't** test implementation details — test observable behavior
- **Don't** forget `.execute()` at the end of the scenario chain
- **Don't** add `testInfo.setTimeout()` unless the test genuinely needs more than the 30s Playwright default (e.g., multi-layer environmental propagation). Bumping timeouts to fix flaky tests masks the real problem — investigate root cause instead
