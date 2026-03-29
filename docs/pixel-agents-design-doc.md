# Pixel Plains Idle Visualization -- Complete Design Document

## Quick Summary

94% asset utilization plan across 8 scenes, 7 creature roles, 6 progression systems, and casino-inspired engagement mechanics. Every PNG in the Pixel Plains pack gets a purpose.

## Scenes (8)

1. **The Workshop** (default/active coding) - tiles-1, props-spring, monitors+desks
2. **The Library** (research/planning) - bookshelves fill as knowledge accumulates
3. **The Garden** (healthy project/milestone) - sunflowers grow per task, fountain = velocity
4. **The Waterfront** (integration/deployment) - water tiles, crates ship from staging to prod
5. **The Cave** (debugging/deep investigation) - dark, torches, bigger knights, tool pickups
6. **The Winter Lodge** (night/off-hours/low activity) - winter tiles, fireplace, snow, cozy
7. **The Harvest Field** (sprint completion/review) - pumpkins per completed task, autumn leaves
8. **The Cliff Overlook** (idle/AFK/screensaver) - contemplation, waterfall, clouds, zen

## Creature Roles

| Creature | Role | Trigger |
|---|---|---|
| DG Knight 01 (green) | Normal task | Standard task message |
| DG Knight 02 (blue) | Code review | Patrols between reviewer + author desks |
| DG Knight 03 (red) | Critical bug | 1.5x size, scares cats from 6 tiles |
| DG Knight 04 (purple) | Tech debt | Spawns mini-knights every 60s until killed |
| Gato (white) | Office Cat | Ambient, flees knights |
| Gato (orange) | Productivity Cat | Appears when agent types >30s continuously |
| Gato (gray) | Curious Cat | Follows walking agents like a shadow |
| Red Demon | Scope Creep | 6+ active tasks simultaneously |
| Ice Elemental | Blocked State | Agent in waiting >20s |
| Blue Cat | CI/CD Bot | terminal/status_update messages |
| Pink Panda | Pair Programming | 2 agents working adjacent >60s |
| Bunny | Easter Eggs | Random 2-5 min, variable rewards (60/25/10/5% tiers) |

## Progression Systems

1. **Sunflower Growth** = individual task lifecycle (seed -> sprout -> stem -> bud -> bloom)
2. **Fountain** = project velocity (off -> trickle -> flowing -> full spray)
3. **Pumpkins** = completed milestones (accumulate with face variants)
4. **Bookshelf Filling** = knowledge accumulation (empty -> overflowing, per message type)
5. **Barrel/Crate Stockpile** = deployable artifacts (staging -> ship -> production)
6. **Tool Rack** = agent capabilities (sword/hammer/wand/shield/potion light up by activity)

## Environmental Storytelling (No UI needed)

- Room furnishing density = project maturity (sparse -> full)
- Water state = data flow health (flowing/frozen/turbulent/dried)
- Tree state = long-term health (blossom/canopy/autumn/bare)
- Weather intensity = stress level (clear -> rain -> storm)
- Light level = stress modifier on top of day/night cycle

## Multi-Agent Collaboration

- **Formation**: 2 agents flank knight, 3 triangle, 4 cardinal
- **Focus beams**: Dashed lines from agents to knight, sparkle at convergence
- **Shared thought bubbles**: One large bubble spanning paired agents
- **Celebration cascade**: Kill sparkles drift toward nearby damaged knights
- **Relay line**: Animated data-packet dots travel between sender/receiver agents

## Casino/Experience Design Tricks

1. **Variable rewards**: Bunny system (60/25/10/5% tiers), rare ambient events
2. **Near-miss**: Knight reinforcement at 20% HP (15% chance), fountain stutter before full spray
3. **Loss aversion**: Gato departure warning sequence, plant wilting near knights
4. **Social proof**: Celebration contagion spreads to nearby agents
5. **Almost done anticipation**: Knight health bar pulses at <15%, knight tries to flee
6. **Tension/release cycles**: Tension score (0-1) drives lighting, weather, gato count, knight spawn rate
7. **Daily specials**: Different featured creature per weekday

## Tension Engine

```
Tension increases: +0.1/knight, +0.3/demon, +0.1/elemental, +0.05/min without resolution
Tension decreases: -0.3/kill, -0.5/demon defeat, -0.1/gato, -0.05/blooming sunflower

0.0-0.2 CALM:   Warm light, max gatos, full fountain, sparkles
0.2-0.5 NORMAL: Standard
0.5-0.7 TENSE:  Darker, gatos scarce, faster knight spawns
0.7-0.9 CRISIS: Rain, dark overlay, wilting plants, fountain sputtering
0.9-1.0 SIEGE:  Vignette, rain only, no sparkles
```

## Scene Transition Triggers

1. Manual (user picks)
2. Activity-based (message types + knight count)
3. Temporal (time-of-day + season)
4. Idle timeout (10min no activity -> Cliff Overlook)

## Asset Credit

Pixel Plains by SnowHex (snowhex.itch.io/pixel-plains) - MIT-like license, commercial OK with credit.
