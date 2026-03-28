---
name: bot-behavior
description: Design, implement, tune, or debug bot AI behavior including actions, conditions, scoring functions, and coordination. Use when adding new bot actions, conditions, scoring logic, or debugging stuck AI states.
allowed-tools: Read, Grep, Glob, Write, Edit, Bash
model: sonnet
---

# Bot AI Action & Scoring System

You are an expert AI systems designer for a turn-based tactics game. You design and implement bot behavior using a Condition -> Action -> Scoring pipeline. Bot behavior must be deterministic given the same game state (Design Pillar #5: no random proc mechanics).

## Architecture Overview

The bot planner lives in `src/systems/bot-planner/`. Each bot unit has a `script` (array of `Tactics.Tactic`) that the `BotBrain` class evaluates every turn.

### Processing Pipeline

1. **Coordination Phase**: Hero/pragmatist units broadcast `TargetRecommendation`s (`src/systems/bot-planner/coordination/`)
2. **Condition Evaluation**: For each tactic in the unit's script, evaluate condition against game state
3. **Scoring**: Every matched condition produces an `ActionScore` via scoring functions
4. **Selection**: Highest `adjustedScore` wins. `adjustedScore = rawScore * PRIORITY_MULTIPLIERS[priority]`
5. **Execution**: Dispatch the winning action, wait for Ok/Err response

### Key Files

| File | Purpose |
|------|---------|
| `src/systems/bot-planner/BotBrain.ts` | Core brain: condition -> score -> select best -> execute |
| `src/systems/bot-planner/index.ts` | Planner entry point, iterates units, creates BotBrain instances |
| `src/systems/bot-planner/types.ts` | `MatchEffect` type for condition evaluators |
| `src/systems/bot-planner/tacticGuards.ts` | Type guards and string parsers for tactic conditions |
| `src/systems/bot-planner/defaultScripts.ts` | Default behavior scripts per `Behavior` type |
| `src/systems/bot-planner/scoring/constants.ts` | All behavior weight constants |
| `src/systems/bot-planner/scoring/createActionScore.ts` | Score factory function |
| `src/type-definitions/tactics.ts` | All `Tactics` namespace types (conditions, actions, contexts) |
| `src/state/game/botActions.ts` | Redux actions for bot operations (action/ok/err pattern) |
| `src/systems/bot-planner/conditions/` | Condition evaluator implementations |
| `src/systems/bot-planner/scoring/` | Scoring function implementations |
| `src/systems/bot-planner/actions/` | Action saga implementations |

### Behavior Types

Seven behaviors with distinct weight profiles defined in `scoring/constants.ts`:

`coward`, `hero`, `maverick`, `mindless`, `passive`, `pragmatist`, `reckless`

Each has different weights for: aggression, retreat urgency, item usage, taunt resistance, skill usage, coordination receptiveness, hazard tolerance, capture priority, and placement strategy.

Weight design:
- `0.0` = Cannot/Will Not (action impossible or completely out of character)
- `1.0` = Neutral Baseline (maverick typically serves as reference)
- `> 2.0` = Strong Preference (core personality trait)

**Smart behaviors**: we colloquially term `hero` and `pragmatist` behaviors as "smart" which means they have the ability to suggest targets to other bots on their team (see **Coordination Phase**).

### Scoring System

Every scoring function returns `Tactics.ActionScore`:

```typescript
{
  rawScore: number;
  priority: ActionPriority;         // 'critical' | 'high' | 'normal' | 'low'
  adjustedScore: number;            // rawScore * PRIORITY_MULTIPLIERS[priority]
  reason: string;                   // Human-readable explanation
  components: Record<string, number>; // Breakdown for debugging
}
```

Priority multipliers: `critical=10`, `high=2`, `normal=1`, `low=0.5`

Always use `createActionScore()` from `scoring/createActionScore.ts` to create scores.

### Coordination System

Hero/pragmatist ("smart") units can broadcast `TargetRecommendation`s to nearby allies:
- Influence radius = `sqrt(presenceScore) * COORDINATION_RADIUS_MULTIPLIER`
- Receiving units get an engage score bonus capped at `MAX_RECOMMENDATION_BONUS`
- Receptiveness varies by behavior (`RECOMMENDATION_RECEPTIVENESS` in constants)

### Taunt System

When a unit has `target.intent === 'taunt'`, BotBrain injects a virtual `engage target` tactic at `high` priority competing with the unit's normal script. Taunt resistance varies by behavior (`TAUNT_RESISTANCE_WEIGHTS`).

## Workflow: Adding a New Bot Action

1. **Define the action type** in `src/type-definitions/tactics.ts`:
   - Add to the `Action` union type
   - Add Ok/Err context types if needed

2. **Add Redux actions** in `src/state/game/botActions.ts`:
   - Create `actionName`, `actionNameOk`, `actionNameErr` actions following existing pattern

3. **Create the action saga** in `src/systems/bot-planner/actions/<action-name>/`:
   - Saga performs the action and dispatches Ok/Err
   - Follow the existing engage-target or retreat patterns

4. **Create the scoring function** in `src/systems/bot-planner/scoring/`:
   - `score<ActionName>Action.ts`
   - Add behavior weight constants to `constants.ts`
   - Export from `src/systems/bot-planner/scoring/index.ts`

5. **Update `BotBrain.ts`**:
   - Add `isAnyOf` matchers at top for Ok/Err types
   - Add case to `scoreAction()` switch
   - Add case to `runTactic()` switch (dispatch action, wait for Ok/Err, handle result)

6. **Add to default scripts** in `defaultScripts.ts` for relevant behaviors

7. **Wire the action saga** in `src/systems/rootSaga.ts` if not already watching

8. **Write tests**:
   - Scoring function unit tests with property-based tests for numeric formulas
   - E2E test in `e2e/features/ai-behavior/`

9. **Run `pnpm type-check`** -- `assertNever` in BotBrain switches flags any missing cases

## Workflow: Adding a New Condition Evaluator

1. **Define the condition type** in `src/type-definitions/tactics.ts`:
   - Add namespace with `Condition` and `Context` types
   - Add to `ConditionContext` union
   - Add to `Condition` union
   - Add to both `SingleTactic` and `NestedTactic` unions (they mirror each other)

2. **Create the evaluator** in `src/systems/bot-planner/conditions/<condition-name>.ts`:
   - Export a `matcher` function matching `MatchEffect` type signature
   - Return `[true, context]` or `[false, undefined]`

3. **Create a type guard** in `tacticGuards.ts`:
   - `tacticIs<ConditionName>()` function
   - If condition has parameters, add `paramsFrom<ConditionName>()` parser

4. **Update `BotBrain.ts` `evaluateTacticCondition()`**:
   - Import the new condition module
   - Add the guard check and matcher call following existing pattern

5. **Write tests** for the condition evaluator

6. **Run `pnpm type-check`** to catch missed union members

## Workflow: Tuning Scoring Functions

1. **Read existing scoring functions** (e.g., `scoreEngageAction.ts`, `scoreRetreatAction.ts`) to understand the pattern

2. **Document the formula** in a JSDoc comment:
   - `baseScore = ...`
   - `rawScore = baseScore * behaviorWeight`
   - What each component represents

3. **Track score components** in the `components` record for debugging:
   ```typescript
   const components: Record<string, number> = {};
   components.targetVulnerability = vulnerabilityScore;
   components.behaviorWeight = ENGAGE_AGGRESSION_WEIGHTS[unit.behavior];
   components.coordinationBonus = recommendationBonus;
   ```

4. **Write property-based tests** for scoring invariants:
   - Monotonicity: more danger = higher retreat score
   - Boundary: 0 score when action is impossible
   - Behavior ordering: `reckless.engage > coward.engage`

5. **Test with default scripts** to verify scoring produces sensible decisions

## Workflow: Debugging Stuck AI States

Important: Use `mechanics-explainer` skill to confirm game mechanics

1. **Check console logs**: BotBrain logs every step with `[BotBrain]` prefix:
   - `Starting script processing...` with tactic count
   - Condition match results
   - Score breakdowns with components
   - Selected action with adjusted/raw scores and runner-up
   - Ok/Err results

2. **Common causes of stuck bots**:
   - Unit died mid-process (known interruption bug, see AIDEV-NOTE in `index.ts`)
   - No condition matched (check `anyConditionMet` in logs)
   - All scores were 0 or negative
   - Ok/Err action never dispatched (saga error or missing watcher)

3. **Check `narrowStateFromPreviousConditions`**: Previous condition contexts narrow available targets, which can exclude valid targets in subsequent tactics

4. **Verify the unit's script** has a fallback tactic (usually `{ action: { type: 'engage target' }, condition: 'nearest foe' }` at the end for combat behaviors)

5. **Check behavior weights**: A behavior with `0.0` weight for an action type will always score 0 for that action

## Constraints and Rules

### DO

- Use `assertNever` in all switch statements on action/condition types
- Document scoring formulas in JSDoc comments
- Add behavior weight constants to `constants.ts` (never inline magic numbers)
- Use `createActionScore()` for all score creation
- Track individual score components in the `components` field
- Return score of 0 when an action is impossible (do not throw)
- Write condition evaluators as pure functions (receive state, return match result)
- Add AIDEV-NOTE comments for complex scoring logic
- Update both `SingleTactic` and `NestedTactic` unions when adding conditions

### DON'T

- Add random/probabilistic decision-making (Design Pillar #5: deterministic combat)
- Hardcode behavior-specific logic outside of weight constants
- Skip the Ok/Err pattern for action results
- Modify game state directly in scoring functions (they are read-only)
- Create scoring functions without corresponding unit tests
- Forget to export new scoring functions from `scoring/index.ts`

### Anti-Patterns

- **Score inflation**: Adding large flat bonuses that dominate over behavior weights. Use multiplicative weights instead.
- **Condition overlap**: Two conditions matching the same situation with different priorities causing unpredictable behavior. Use the scoring system to differentiate instead.
- **Missing fallback**: A behavior script with no low-priority fallback tactic. Always include a `nearest foe` engage at the end for combat behaviors.
- **Direct state mutation**: Scoring functions must never dispatch actions or modify state. They are selection logic only.
- **Ignoring coordination**: When adding engage-related scoring, account for `coordination.recommendations` bonus. Omitting it breaks focus-fire behavior.
- **Bypassing BotBrain**: All bot actions must flow through BotBrain's process() method. Never dispatch bot actions directly from other systems.

## Integration Points

| System | How It Integrates |
|--------|------------------|
| Movement (`src/systems/game/movement/`) | Engage and retreat actions trigger movement |
| Combat (`src/systems/combat/`) | Engage action triggers combat after movement |
| Items (`src/state/items/`) | Consume and place item actions use item state |
| Skills (`src/systems/game/skill-effects/`) | Use skill action triggers skill effects |
| Environmental Effects (`src/systems/environmental-effects/`) | Scoring evaluators check tile hazards via `HAZARD_TOLERANCE` |
| Pathfinding (`src/utils/pathfinder/`) | Movement calculations for retreat, engage, pursue |
| Win Conditions (`src/systems/conditions/`) | Capture condition feeds into pursue objective |

## Testing Requirements

- Every scoring function and condition evaluator must have unit tests
- Scoring functions with numeric formulas should use fast-check property-based tests
- Major behavior changes need E2E coverage in `e2e/features/ai-behavior/`
- Safe test commands: `pnpm test:src:single -- path/to/file.test.ts`
- Never pipe test output
