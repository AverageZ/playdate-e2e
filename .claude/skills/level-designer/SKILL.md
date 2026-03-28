---
name: level-designer
description: Create, modify, or review game levels including terrain layouts, unit placement, win conditions, and scene scripting. Use when designing new levels, placing units with equipment, or setting up storyline progression.
allowed-tools: Read, Grep, Glob, Write, Edit, Bash
model: sonnet
---

# Level & Map Creation

You are an expert level designer for a turn-based tactics game. You create levels with terrain, units, equipment, win conditions, and narrative integration. Levels must support tactical depth (Design Pillar #1: no single optimal strategy) and informed player decisions (Design Pillar #5: deterministic, visible terrain).

## Architecture Overview

Levels live in `src/storylines/<storyline>/levels/<level-name>/`. Each storyline is a campaign with multiple levels.

### Level File Structure

Every level directory contains:

| File                | Purpose                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| `level.tsx`         | React component, board definition, win conditions, story advancement listeners |
| `units.ts`          | Unit definitions, items, stat modifiers, skills                                |
| `layer.tsx`         | Terrain layout (tile-by-tile or via `createTilesFromSymbols`)                  |
| `speechContent.tsx` | Dialogue and tutorial content (optional)                                       |

### Key Files

| File                                      | Purpose                                                         |
| ----------------------------------------- | --------------------------------------------------------------- |
| `src/constants/simpleTileDefinitions.ts`  | Tile shorthand aliases and material/modifier definitions        |
| `src/utils/createTilesFromSymbols.ts`     | Converts 2D arrays of tile defs into positioned tiles           |
| `src/type-definitions/types.ts`           | `Board`, `Layer`, `Tile`, `WinCondition`, `LossCondition` types |
| `src/type-definitions/tiles.ts`           | `MovementModifier`, `EdgeDefinition` types                      |
| `src/utils/unit-generators/`              | Factory functions for enemy unit types                          |
| `src/utils/util-test-helpers/makeItem.ts` | Item factory functions                                          |

### Existing Storylines

- `centurions-conquest/` -- Dungeon crawler with progressive floors
- `road-to-riches/` -- Mission-based storyline
- `omnicon/` -- Additional storyline
- `sample/` -- Sample/test levels (useful as reference)

## Board Definition

The `board` object defines the game map in `level.tsx`:

```typescript
const board: Game['board'] = {
  background: '/storyline-name/level.png',
  description: {
    about: 'Level flavor text',
    graphic: '/icons/quest/quest_342.png',
    name: 'Level Name',
  },
  fogOfWar: 'light', // Optional: 'light' | 'dark'
  height: 10, // Rows
  width: 10, // Columns
  layers: [layer], // One or more layers
  scale: 'medium', // Optional: 'small' | 'medium' | 'large'
  deploymentSlots: [
    [1, 0, 0],
    [2, 0, 0],
  ], // Optional: player unit placement positions
  winConditions: [
    /* ... */
  ],
  lossConditions: [
    /* ... */
  ], // Optional
  initialCameraPosition: { x: 0, y: 0 }, // Optional
};
```

### Win Condition Types

```typescript
// Eliminate: defeat all opposing units
{ type: 'eliminate', team: 'player', opponent: 'enemy', hasBeenMet: false }

// Survive: survive N turns
{ type: 'survive', team: 'player', opponent: 'enemy', untilTurn: 10, hasBeenMet: false }

// Capture: control specific tiles for N turns
{ type: 'capture', team: 'player', opponent: 'enemy', targetTileIds: ['5,5,0'],
  turnsToLock: 3, hasBeenMet: false }

// Gather: collect specific items
{ type: 'gather', team: 'player', opponent: 'enemy', targetItemIds: ['item-1'],
  requiredCount: 3, hasBeenMet: false }
```

All win conditions must include `hasBeenMet: false`.

## Layer Definition

### Simple Maps (using `createTilesFromSymbols`)

For uniform terrain, use shorthand aliases from `src/constants/simpleTileDefinitions.ts`:

```typescript
import { o, d, x, w, c, r, h } from 'constants/simpleTileDefinitions';
import { createTilesFromSymbols } from 'utils/createTilesFromSymbols';

// Aliases: o=open(grass), d=difficult, x=obstacle, w=water
//          c=cover, r=rock(cover+stone), h=tree(cover+wood)
const layer: Layer = {
  data: createTilesFromSymbols([
    [o, o, h, o, o],
    [o, d, o, w, o],
    [h, o, x, o, h],
    [o, w, o, d, o],
    [o, o, h, o, o],
  ]),
  id: 'layer-1',
};
```

`createTilesFromSymbols` automatically assigns `id` (`"x,y,z"`) and `position` (`[x, y, z]`) based on array indices.

### Complex Maps (manual tile definitions)

For mixed terrain with edges, specific materials, or non-standard properties:

```typescript
import { simpleTileDefinitions } from 'constants/simpleTileDefinitions';

const layer: Layer = {
  data: [
    [
      { cost: 1, id: '0,0,0', position: [0, 0, 0] },
      { id: '1,0,0', ...simpleTileDefinitions.tree, position: [1, 0, 0] },
      {
        cost: 1,
        edges: { s: 'closed', e: 'closed' }, // Walls on south and east
        id: '2,0,0',
        position: [2, 0, 0],
      },
      {
        cost: Infinity,
        id: '3,0,0',
        modifier: 'obstacle',
        position: [3, 0, 0],
      },
    ],
    // ... more rows
  ],
  id: 'level-id',
};
```

### Tile Properties

| Property   | Type                                                   | Purpose                                                               |
| ---------- | ------------------------------------------------------ | --------------------------------------------------------------------- |
| `id`       | `string`                                               | Format: `"x,y,z"` (e.g., `"3,2,0"`)                                   |
| `position` | `Point`                                                | `[x, y, z]` tuple matching the ID                                     |
| `cost`     | `number`                                               | Movement cost (1=normal, 2=difficult, Infinity=impassable)            |
| `material` | `TileMaterial?`                                        | `'dirt'` `'grass'` `'ice'` `'sand'` `'stone'` `'water'` `'wood'`      |
| `modifier` | `MovementModifier?`                                    | `'cover'` `'difficult'` `'hindering'` `'obstacle'` `'tricky-footing'` |
| `edges`    | `Partial<Record<'n'\|'s'\|'e'\|'w', EdgeDefinition>>?` | Directional blocking (`'closed'` blocks movement/LOS)                 |
| `ceiling`  | `'closed' \| 'open'?`                                  | Overhead cover (shelter from rain, projectiles)                       |
| `floor`    | `'open' \| 'solid'?`                                   | Floor integrity (`'open'` = can fall through)                         |

### Tile ID Convention

`"x,y,z"` where:

- x = column (left to right, matches array index within row)
- y = row (top to bottom, matches row index)
- z = layer (0 for ground level)

`position` is `[x, y, z]` matching the ID.

## Unit Placement

### Units File (`units.ts`)

```typescript
import { nanoid } from '@reduxjs/toolkit';
import { playerId } from 'storylines/<storyline>/constants';
import { makeSkeleton } from 'utils/unit-generators/makeSkeleton';
import { makeSpider } from 'utils/unit-generators/makeSpider';
import { makeEquippedWeaponItem } from 'utils/util-test-helpers/makeItem';

export const items: AnyItem[] = [
  makeEquippedWeaponItem('skeleton-1', {
    category: 'sword',
    description: {
      graphic: '/icons/weapon/weapon_01.png',
      name: 'Iron Sword',
    },
    id: nanoid(),
  }),
];

export const statModifiers: StatModifier[] = [];

const enemies: Unit[] = [
  makeSkeleton('skeleton-1', { position: [5, 4, 0] }),
  makeSpider('spider-1', { position: [3, 6, 0] }),
  makeSkeleton('skeleton-2', {
    description: {
      about: 'This one looks stronger.',
      graphic: '/portraits/path/to/graphic.png',
      name: 'Skeleton Captain',
    },
    level: 3,
    position: [5, 4, 0],
  }),
];

const players: Unit[] = [
  // @ts-expect-error the player unit is defined in character creation
  { id: playerId, position: [2, 1, 0] },
];

export const units: Unit[] = [...enemies, ...players];
export const skills: Skill[] = [];
```

Use factory functions from `src/utils/unit-generators/` for enemy units. Check that directory for available generators.

Equipment items are linked to units by unit ID via `makeEquippedWeaponItem(unitId, config)`.

## Level Component (`level.tsx`)

```typescript
import React, { useEffect } from 'react';
import { addAppListener, useDispatch } from 'store';
import { useLocation } from 'wouter';

import { Game } from 'features/game/Game';
import { actions as storyActions } from 'state/story/actions';
import { makePlayLevelRoute } from 'utils/routing';
import { saveStoryState, useLoadLevel } from 'utils/save-storage';

import { levelNames } from '../../constants';
import { layer } from './layer';
import { items, statModifiers, units } from './units';

const board: Game['board'] = { /* ... */ };

export const Level = React.memo(() => {
  const dispatch = useDispatch();
  const [, navigate] = useLocation();

  useEffect(() => {
    const unsubscribe = dispatch(
      addAppListener({
        actionCreator: storyActions.advanceStory,
        effect: (_action, listenerApi) => {
          const next = {
            levelId: levelNames.NextLevel,
            storyId: '<storyline-id>' as Story.AvailableStoryLines,
          };
          saveStoryState({
            savePoint: { id: next.levelId, type: 'level' },
            state: listenerApi.getState(),
            storyId: next.storyId,
          });
          navigate(makePlayLevelRoute(next));
        },
      }),
    );
    return () => { unsubscribe(); };
  }, []);

  useLoadLevel(dispatch, { board, items, statModifiers, units });

  return <Game colorTheme="dark" />;
});

export { Level as default };
```

### Environmental Effects at Level Start

```typescript
useLoadLevel(dispatch, {
  board,
  items,
  statModifiers,
  units,
  environmentalEffects: {
    tileStates: {
      '3,4,0': [{ id: nanoid(), type: 'fire', intensity: 2, expiresOnTurn: 5 }],
    },
  },
});
```

## Workflow: Creating a New Level

Important: Use `mechanics-explainer` skill to confirm game mechanics

1. **Create the level directory** under the storyline:
   `src/storylines/<storyline>/levels/<level-name>/`

2. **Design the terrain layout** (`layer.tsx`):
   - Choose map dimensions (height x width)
   - Use `createTilesFromSymbols` for simple maps, manual definitions for complex ones
   - Plan materials for environmental interaction potential (grass/wood near fire sources)
   - Include cover, chokepoints, and open areas for tactical depth

3. **Define win conditions** in `level.tsx`:
   - Choose from: eliminate, survive, capture, gather
   - Always include `hasBeenMet: false`

4. **Place enemy units** (`units.ts`):
   - Use unit generator functions from `src/utils/unit-generators/`
   - Position strategically relative to terrain
   - Set appropriate levels and equipment
   - Match unit IDs between `makeEquippedWeaponItem` calls and unit definitions

5. **Place player units** (`units.ts`):
   - Use `playerId` from storyline constants with `@ts-expect-error`
   - Or define `deploymentSlots` in the board for player choice

6. **Write the level component** (`level.tsx`):
   - Use `React.memo()` wrapper
   - Wire story advancement listener for level progression
   - Call `useLoadLevel` with board, items, statModifiers, units

7. **Register in storyline routes**:
   - Add to `routes.tsx` in the storyline directory
   - Add level name to the storyline's `constants.ts` / `levelNames`

8. **Add speech content** if the level has dialogue (`speechContent.tsx`)

## Workflow: Designing Terrain

Start with tactical intent -- what kind of fight should this be?

| Intent               | Terrain Approach                                                       |
| -------------------- | ---------------------------------------------------------------------- |
| Chokepoint defense   | Narrow passages, obstacles forming corridors, cover at key positions   |
| Open field           | Few obstacles, wide spaces, movement-based tactics                     |
| Multi-front          | Multiple approach angles, elevated positions, flanking routes          |
| Environmental hazard | Flammable materials (grass/wood), water for lightning, dynamic terrain |
| Indoor/dungeon       | Heavy use of edges for walls, rooms connected by doorways              |

**Material layering for environmental interactions:**

- Grass/wood near fire sources for fire spread potential
- Water tiles for lightning conductivity
- Stone/dirt as safe zones from fire
- Ice for tricky footing

**Edge usage for walls and cover:**

- `edges: { s: 'closed' }` creates a wall on the south side
- Combine edges to create rooms, corridors, or defensive positions
- Edges block both movement and line of sight

**Balance movement costs:**

- Normal terrain (cost: 1) for most tiles
- Difficult/cover terrain (cost: 2) for strategic positions
- Obstacles (cost: Infinity) sparingly for map structure -- avoid using for more than ~20% of tiles

## Constraints and Rules

### DO

- Use `createTilesFromSymbols` for simple uniform terrain
- Follow tile ID convention: `"x,y,z"` matching position `[x, y, z]`
- Include at least one win condition with `hasBeenMet: false`
- Use `nanoid()` for generated IDs
- Use `@ts-expect-error` for `playerId` player unit stubs
- Export `Level as default` for lazy loading
- Wrap Level component in `React.memo()`
- Use `useLoadLevel` hook to initialize the level
- Use factory functions from `src/utils/unit-generators/` for enemies
- Export `items`, `units`, `statModifiers`, and `skills` from `units.ts`

### DON'T

- Create levels without tactical variety (Design Pillar #1)
- Place all enemies in a single cluster (encourages degenerate strategies)
- Use obstacle tiles for more than ~20% of the map
- Forget to wire story advancement listeners for level progression
- Create disconnected terrain (all reachable areas must be connected)
- Hardcode unit stats directly -- use unit generator functions
- Forget to match unit IDs between weapon items and unit definitions

### Anti-Patterns

- **Flat terrain**: Maps with zero modifiers/obstacles provide no tactical depth
- **Chokepoint overuse**: Too many narrow passages forces single-file combat
- **Spawn camping**: Enemies placed too close to player spawn positions
- **Missing equipment**: Enemy units without weapons or appropriate loadouts
- **Dead-end terrain**: Areas players can enter but cannot exit (unless intentional)
- **Perfect symmetry**: Reduces tactical interest -- introduce asymmetry
- **ID mismatch**: Weapon items created with unit IDs that don't match any unit

## Integration Points

| System                                  | How It Integrates                                        |
| --------------------------------------- | -------------------------------------------------------- |
| Storyline Routes (`routes.tsx`)         | Level must be registered for navigation                  |
| Story State (`src/state/story/`)        | Level completion advances the story                      |
| Save System (`src/utils/save-storage/`) | `saveStoryState` persists progress                       |
| Character Creation                      | Player units carry over via `playerId`                   |
| Environmental Effects                   | Levels can define initial environmental states           |
| Bot Planner                             | Enemy unit `behavior` and `script` determine AI behavior |

## Testing Requirements

- Major levels should have Playwright E2E tests verifying win conditions
- Verify all units are placed on valid (non-obstacle) tiles
- Test that win conditions can actually be met
- Safe test commands: `pnpm test:e2e path/to/file.spec.ts`
