# PoolSim

A simulation of two-seat ride pooling (think early Uber Pool) on a 50 × 50 street grid.

Every run plays out in two cities side by side. In one, riders who opt in can share a cab. In the other, everyone rides
alone. The riders, their request times and the cab start positions are identical in both, so any difference between
the two maps comes from pooling and nothing else.

On top of the original simulation I added a driver earnings guarantee, fairer pool pricing, an optional batch matcher,
a side-by-side comparison with the original rules, threat zones you can declare anywhere on the map while the city runs
(as many as you like), and traffic lights that make right turns cost time.

## Running it

Open `index.html` in a browser. No install, no build, no network needed.
If you prefer a server: `python3 -m http.server`, then visit http://localhost:8000.
If you've opened an older version before, hard-refresh (Cmd+Shift+R) so the browser doesn't use cached scripts.

Tests: `node test/sim.test.js` (Node 18+, no dependencies).

Built with plain HTML, CSS and JavaScript. The maps are drawn on a canvas, the charts are SVG, and the slower
background re-runs happen in Web Workers.

## How it works

K riders request rides at random times and places over P seconds. N cabs serve them. Once a second, waiting requests
are matched, oldest first:

- A solo rider gets the best free cab within the ping radius.
- A pool rider can also be slotted into a cab that's already carrying a pool rider, at any point in its remaining
  stops. The cab reroutes to fit them in.

A few rules always hold:

- Never more than two passengers in a cab. This is checked along the whole planned route, not just at the current moment.
- No pool rider spends more than 1.5× their solo ride time in the car.
- A pickup that's already been promised can slip by at most 20 seconds when a cab reroutes.
- Riders who go unmatched for 120 seconds give up.

Drivers are paid per second with a rider aboard, plus a premium (X) while two are aboard. The drive to a pickup is
unpaid, and every block driven has a running cost. Pool riders get a discount (Y).

When the run ends, a report compares the two cities for riders, drivers and the platform. It also re-runs the city at
different ping radii to find the best setting, and points out three things the run reveals.

## What I changed

Before changing anything I measured the original (default settings, no traffic lights). Four problems stood out:

1. Nothing stopped a driver losing money on a pooled ride. With low pay and high running costs, both of which the
   sidebar allows, pooled rides regularly ended with the driver out of pocket.
2. Pooling usually paid drivers less than the same riders would have riding solo, because a shared minute is paid
   once rather than twice. At the defaults, about 13 pooled rides per run fell short.
3. The discount went to every rider who opted in, whether or not anyone ever joined them. That came to about $154 per run
   for nothing in return.
4. The rider already in the car absorbs most of the detour (1.21× their solo time, against 1.06× for the rider who
   joins), but both got the same discount.

Here's what I added. The first two fix those problems; the threat zone and traffic lights were new requirements that came later.
Everything except the comparison panel can be switched off in the sidebar.

**Driver guarantee.** When a cab that carried a pool rider becomes free again, the driver is topped up so they earn
at least what those riders would have paid solo, and never end below $0 after running costs. The unpaid drive to
the pickup counts towards those costs. This applies to pooled rides only: if the pay settings make solo rides unprofitable, drivers
can still finish a run in the red.

**Fair pricing.** A pool rider is charged a small discount at pickup (10%). At drop-off they get the full discount only if
they actually shared, plus a credit for every extra second the detour cost them. That way the rider who absorbed the detour is
the one who gets paid for it.

**Original vs enhanced comparison.** The report re-runs the exact same city under the other set of rules and shows the two
side by side. Runs are deterministic, so both columns are real results rather than estimates.

**Batch matching** (off by default). Instead of serving requests strictly oldest first, it matches the cheapest
rider-cab pairs across the whole queue, while still favouring people who've waited longest. It helps when demand is
dense and does nothing otherwise, which is why it's off by default.

**Threat zones.** Closed circular areas you can declare at any moment by clicking the map, as many as you like. Cabs are routed
around them, and every affected ride is handled safely. More detail below.

**Traffic lights.** Right turns stop at a light and cost time; left turns cost less. Routes are chosen by total time, not
distance. More detail below.

I also fixed two smaller bugs: the radius sweep showed "0 s" where it had no data, and the engine accepted impossible
inputs such as a 150% discount.

The **Original rules** button in the sidebar turns the guarantee, fair pricing, batch matching and the traffic lights off. The app then
behaves exactly like the original simulation, and a test checks this against outputs recorded before any of these changes. The threat
zone changes nothing unless you declare one.

## Results

These are averages over five cities with traffic lights on (the default). Original rules on the left of each arrow, the new
pricing and guarantee on the right.

| | Default fleet (30 cabs) | Too few cabs (15) | Too many cabs (60) |
|---|---|---|---|
| Pooled rides paying the driver less than solo | 6.6 → 0 | 3.2 → 0 | 7.4 → 0 |
| Discount to riders who never shared | $156 → $52 | $35 → $12 | $408 → $136 |
| Platform margin, after paying the guarantee | $539 → $564 | $331 → $280 | $640 → $901 |
| Saving for the rider already aboard | $6.35 → $9.15 | $5.66 → $8.03 | $7.10 → $9.22 |

With low pay ($0.10/s) and high running costs ($0.12/block), pooled rides that lost the driver money went from 19 per
run to 0.

The trade-off is that margin falls when cabs are scarce. In that case most riders do get matched, so they earn the full discount
and drivers collect their top-ups. Both discounts are adjustable.

Pricing and the guarantee only move money, so rides delivered and wait times don't change. Batch matching is the only addition
that changes who rides when: with 400 riders it delivered 208 rides instead of 204 and cut the average wait by 3 s, but with
too few cabs it made no real difference. That's why it stays off by default.

## Threat zones

Each zone is a circle with a fixed radius (6 blocks by default, set in the sidebar before the run; every zone in a run has the
same radius). You can declare as many as you like, at any moment, and they may overlap. Each one closes every intersection
inside it in both cities at the same moment, so the comparison between them stays fair.

**On screen:**
- **Add threat**, then click intersections on either map. It stays armed, so each click adds another zone; press it again
  (*Done adding*) or Esc to stop.
- **Remove threat**, then click inside a zone to lift just that one.
- **Clear all** lifts every zone.

Lifting a zone reopens only the area no other zone still covers.

Each time a zone is added:

- **Cabs inside** drive straight out, and a cab heading in turns around. They take no new work until they're out.
- **Routes** that went through it are recalculated around it. While it's active, every distance is the real driving time around
  the zone: a search over the open grid that also counts the lights (see *Traffic lights*). ETAs, the ping radius and the detour
  cap all use it, and cabs drive exactly the route the planner timed. The map draws those detours.
- **Riders waiting for a match** whose pickup or destination is inside, or who have no way around it, are cancelled and never charged.
  New requests like that are refused, and the reason is recorded.
- **Riders already matched** whose cab can no longer reach them on time go back in the queue, with their patience clock restarted.
- **Riders aboard are always delivered.**
  - If their destination is inside, they're dropped at the nearest safe intersection the cab can reach and pay only for the share of the trip covered.
  - If the way round pushes them past the 1.5× limit, they're delivered anyway, but their drop-off time is frozen so no later
    match can delay them further.
  - If the zone over their destination is lifted before they arrive, they're taken to their real destination after all.
    Lifting some other zone changes nothing for them.
- Two passengers at most, the driver guarantee and non-negative fares all still hold.

The status bar under the maps lists the active zones and keeps count for each city: cabs rerouted, cabs that drove out, rides
cancelled or refused, riders back in the queue, and riders dropped short. The report adds a *Threat zones* section listing each zone with
when it was added and lifted, and the same numbers broken down by reason. The radius sweep and the comparison replay every add and
removal at the same moment, so their numbers match the run you watched.

## Traffic lights

Driving a block takes the same time as before. On top of that, a turn at a light adds a delay:

| Move at an intersection | Added time (default) | Rule |
|---|---|---|
| Straight on | 0 s | free |
| Left turn | 3 s | 75% of a right turn (no stop at the light) |
| Right turn | 4 s | stops at the light; set by the *Right-turn delay* slider |
| U-turn | 5 s | 125% of a right turn, and only where there's no other way |

A few assumptions:

- A cab leaving a pickup or drop-off has just stopped, so it can set off in any direction with no delay. Turns only cost time
  when the cab is already driving.
- Driving out of a threat zone ignores the lights.
- *Right-turn delay* = 0 means no traffic lights, and the original code runs unchanged.

**How routes are chosen.** A route's time is `blocks ÷ speed + the delays of its turns`. With a threat zone active, the engine
searches over (intersection, direction of travel) with Dijkstra's algorithm, using the same move rules the cabs follow. Without
a zone there's an exact formula, written from the driver's point of view:

- **target straight ahead:** the blocks;
- **ahead or level, to the left:** blocks + one left; **to the right:** blocks + one right;
- **behind-left:** blocks + two lefts; **behind-right:** blocks + two rights;
- **directly behind:** a loop round a block (two extra blocks and three lefts, or three rights along the grid edge);
- **from a standing start:** blocks, plus one left if the trip needs a turn at all.

A test checks this formula against the full search for every position, direction and target on three different grids.

Cabs choose each block by the same numbers and really wait at the light, so arrival times still match the plan to the
microsecond. Matching, pooled insertions, re-dispatch, the ping radius (now "within R blocks' worth of driving time"), the
1.5× detour cap and the fare estimate all use these times.

**Can a longer route be faster? Not with this rule, and here's why.** Steering around one right turn means looping a block:
two extra blocks and three lefts. That's 2 s + 3 × 3 s = 11 s instead of the 4 s right turn. The same holds for any delay: three lefts
cost 2.25 right turns. And among equally short routes there's always one whose turns are lefts. A longer route would only win if
a left cost less than a third of a right. A test checks this for every position and direction on a 12 × 12 grid, against a spread
of targets; a separate check over every target on a 15 × 15 grid, with and without a threat zone, found no exception either.

What the lights do change is **which of the equally short routes is taken**. The original engine always drove the whole x leg first,
so it often made a right turn where an equally short left-turn route existed. The report shows a real leg from the run, for example:

| (41, 1) → (35, 0) | Distance | Left turns | Right turns | Turn time | Total |
|---|---|---|---|---|---|
| Fastest route (taken) | 7 blocks | 1 | 0 | 3 s | 10 s |
| Original x-then-y route | 7 blocks | 0 | 1 | 4 s | 11 s |

In the default run, cabs in the pool city made 274 left turns and 7 right turns. On 144 of 338 legs (about four in ten) the fastest
route beat the x-then-y route, saving 144 s of driving in total. Hovering over a cab shows the same comparison for its next leg.

## Try it

Set the speed to 50× and each run takes a few seconds.

1. Press **Start** with the defaults. In the report, scroll to *Original rules vs enhanced rules*. Pooled rides paying
   the driver less than solo go from 7 to 0, and margin goes from $496 to $506, with 146 riders delivered under both.
2. Set driver pay to 0.10, running cost to 0.12 and ping radius to 40, then run again. Under *Fair pool economics*,
   pooled rides that left the driver below $0 go to 0.
3. Turn off both guarantee switches and run again. The report shows the losing rides along with a button that turns the
   guarantee back on.
4. Set cabs to 60. The discount given to riders who never shared drops by about two-thirds.
5. Click **Original rules** and run. The comparison now puts your run (original rules) next to the new defaults.
6. Start a run, press **Stop**, press **Add threat**, and click two or three spots on a map. You'll see red circles in both cities,
   cabs inside with a dashed red ring driving out, and routes bending around the zones; the status bar lists them with counts.
   Press **Remove threat** and click one to lift it, or **Clear all**. Press **Start** to continue, then check the *Threat zones*
   section of the report.
7. Hover over any moving cab: the tooltip compares its route to the next stop with the original x-then-y route (distance, left and
   right turns, turn time, total). A small red dot on a cab means it's waiting at a light. After the run, see *Traffic lights* in the report.
   Set *Right-turn delay* to 0 to switch the lights off.

## Tests

`node test/sim.test.js` runs 51 tests, all passing.

The 16 original ones still check the core rules: capacity, the detour cap, the ping radius, patience, pay and fare accounting.
Three of them were adjusted because pay and fares now work differently by design.

The new ones cover:

- **Hand-built pooling cases:**
  - a rider whose trip lies on another's route: they share, with exact fares and driver pay;
  - a rider heading the other way: never shares;
  - three riders on one street: never a third passenger.
- **Economics:** the guarantee holding everywhere, including the low-pay city; the fair-pricing arithmetic; clamping of invalid inputs.
- **Regression:** the original rules reproducing the old output exactly.
- **Threat zone:** one test per edge case, with the safety rules (nothing routed into the zone, two aboard at most) checked
  every 0.1 s of simulated time.
- **Traffic lights:**
  - the 75% / 125% / free rules;
  - the left-turn route chosen over the right-turn one (13 s vs 14 s, same 10 blocks);
  - a target directly behind handled with three lefts and no U-turn (14 s, not 17 s);
  - the exact formula matching the full search everywhere;
  - a longer route never being faster;
  - a cab really waiting at the light and arriving exactly when planned, in a busy city too;
  - lights and a threat zone together.

  The core rule checks (capacity, detour cap, ping radius, pay, fares, guarantee) and the busy-city threat-zone test run with the
  lights on. The hand-built cases that assert exact times, and the regression against the original, run with them off.

| Threat-zone case | What the test checks |
|---|---|
| No cabs nearby | Nobody is evacuated; only trips touching the zone are refused |
| Around a cab | The cab drives out, then serves a rider normally |
| Across an active route | Rerouted 6 blocks round a radius-2 zone, arriving at exactly the planned time (26 s instead of 20 s, lights off), with a detour credit |
| Over a pickup | The ride is cancelled, nothing is charged, the cab is freed |
| Over a destination | Dropped at (17, 0) instead of (20, 0), paying 85% of the fare; if the zone is cleared in time, they go all the way |
| A pooled ride | Both riders delivered, still sharing, both rerouted |
| A promise that can't be kept | Back in the queue, patience restarted, then rematched and delivered |
| No feasible route | A zone that cuts off a corner: the rider aboard is dropped at the closest reachable point; a new trip into the corner is refused |
| Many requests at once | Busy cities, including batch matching and a big zone: every rider accounted for |
| Several zones at once | Three zones closed and avoided every step; lifting one reopens only its area |
| Overlapping zones | Lifting one keeps the shared area closed while the other still covers it |
| Lifting the right zone | A rider dropped short goes all the way only when the zone over their destination is lifted |
| Replay | The comparison re-run with adds and removals matches the live run exactly |

## Why the ping radius is a diamond

The radius on the map is a diamond, not a circle or a hexagon, because cabs drive on a grid. The cabs that can reach a
pickup within R blocks are exactly the ones whose horizontal plus vertical distance is at most R, and that shape is a diamond.
A circle or hexagon of the same size would include corner cabs that are too far away and miss some that are close
enough.

The threat zone, on the other hand, is a circle: it's a physical area on the map, not a driving distance.

Hexagons, like Uber's H3 grid, are useful for something else: dividing a real city into equal zones for demand maps,
surge pricing or moving idle cabs toward busy areas. Nothing like that exists here yet, and with demand spread evenly
across the city it wouldn't show much.

## Files

```
index.html        page layout and the threat-zone controls (add, remove, clear all)
styles.css        light and dark themes
js/sim.js         the engine: matching, turn-aware routing, pay, pricing, guarantee, threat zone
js/metrics.js     comparisons, summary numbers, replays for the report
js/render.js      the maps: routes as driven, the threat zone, cabs waiting at lights
js/report.js      the end-of-run report
js/app.js         controls, playback, background re-runs
test/sim.test.js  tests
```

## Limitations

- No traffic, so arrival times are exact. Real pooling also has to absorb delays.
- Idle cabs wait where they are, and every cab accepts every request it's offered.
- Demand is spread evenly. Real commute patterns would raise match rates.
- Waiting time isn't covered by any promise. About a quarter of pool riders still arrive later than their solo twin.
- The guarantee settles each time a cab becomes free, so a cab that's still busy at the end of the run isn't settled yet.
- Turns only cost time while driving; setting off from a stop is free, and the lights have no red/green cycle (every right turn waits the same).
- U-turns are avoided and only happen where no other move exists, at 125% of a right turn. That's my reading of the requirement.
- Every threat zone has the same radius, and it can't change mid-run. Near a zone, the drawn ping diamond is only a guide:
  which cabs actually get the request is decided by the real driving distance around the zones.
