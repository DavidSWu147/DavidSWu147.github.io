# SIMILI endgame solver

`simili-solver.js` is a standalone exact solver for the last rounds of SIMILI.
It has no dependencies and runs in the browser (as `window.SimiliSolver`) or in Node
(`require`). `index.html` uses it for the next-round preview (below).

## Next-round preview in the game

The preview and the Hint button (below) are only available with **Hints On**, the
last Gameplay setting (default Hints Off). Like the other Gameplay settings it can
only be changed before a game starts, and it is recorded in the game log.

During the booking phase of rounds 8 and 9, each player's booking panel has a
**Preview Round 9 odds** / **Preview Round 10 odds** button. It shows the win chance
and points if you win for each category at the start of the next round, assuming you
end the round with the digits booked so far. Nothing is committed: change the booking
and the result is marked out of date; go back to a booking you already previewed and
its result reappears without recomputing.

- Round 9 → Round 10 odds are computed on the page (well under a second).
- Round 8 → Round 9 odds run in Web Workers (`simili-worker.js`), one per CPU core
  minus one (up to 8), each taking one category and ten rolls at a time, with a
  progress bar and a Cancel button. On a single worker this takes the times measured
  below (median about 33 s); more cores divide that roughly by the worker count.
- Pages opened straight from a file cannot start workers, so the round-8 preview then
  runs on the page itself and the page stays sluggish until it finishes.
- With Lax Placement on, the solver is given the same board in strict layout (see
  below), so the odds are exact for lax games too.

## Round 9 win chances

The game always shows the Round 10 win chance under the category buttons once a
category is picked. With Hints On, Round 9 gets the same: pick a category before
the roll and its exact win chance appears (four decimals, out of 1,000,000 roll
pairs), staying in view through the booking phase. The average final score if you
win follows "to win" in parentheses (six decimals, see below). Round 10 shows it the
same way after the outs (three decimals), e.g. "to win (102.440)". It is left out
when it is exactly 100 (every win scores exactly 100) and at 0%.

Each player's starting position is solved in the background as soon as Round 9
begins, one player at a time on all workers, so the number is often ready by the
time you pick. Until then a progress percentage is shown. Results are cached by
position, so if you previewed the booking you ended Round 8 with, the Round 9
numbers appear immediately. With Hints Off nothing is computed.

## Lax Placement

Lax Placement changes Matching scoring (any three copies count) and Ladder placement
(any cells, as long as the row holds at most two adjacent digits, two of each). In
both cases what a row can still become depends only on its digits, not where they
sit. So `index.html` hands the solver each lax row rearranged into strict layout
(Matching copies packed left, Ladder digits each in their own pair), and maps the
solver's booking back onto the player's real rows: same row, same digits, into that
row's empty cells, choosing cells that make the row look most like the strict
pattern, otherwise leftmost first. `node ai/test/verify-lax.js [b] [m]` checks this
against the game's own lax rules: on `b` messy boards a lax brute force agrees with
the solver roll by roll, and on `m` boards every booking the solver could make,
mapped back, is legal under lax and never scores lower.

## Hint button

In rounds 8, 9 and 10 a golden **Hint** button sits between Undo and End Round. It
books the solver's best play from the start of the round (taking back anything
booked by hand first) and stays highlighted; in round 9 the Round 10 odds appear
straight away, and in round 10 a note gives the final score. Clicking it again
takes the whole booking back. Booking or undoing a digit by hand leaves hint mode.
End Round keeps the suggested booking. While the hint is active, the cells it
booked are highlighted in gold; ending the round returns them to the usual colours.

In round 8 the exact search can take from seconds to far longer (see "Round 8"
below), so it runs in the background on Web Workers (one per spare core, up to 12).
Each worker keeps its solver caches small (20,000 tables, 200,000 round-10 positions):
with the solver's defaults one worker grew to about 1.4 GB on a big Sequence decision,
and a tab with 7 of them was killed by the browser. With the smaller caches a 7-worker
search levels off at about 2.2 GB for the whole browser, at roughly 20% less speed.
The computer player's own 30-second Round 8 search uses at most 4 workers, since it can
run at the same time as your Hint.
While it works, a gold progress bar and the time so far sit next to the button; the
blue bar further down is the Round 9 odds preview, a separate job. There is no time
limit: clicking Hint again stops the search, and so does ending the round, switching
Hints off or leaving the round. When it finishes, the best booking is made straight
away, as in rounds 9 and 10, unless you have booked or undone something meanwhile:
then the button says "Hint ready" and the next click books it (taking back what you
booked). The Round 9 odds preview then starts by itself.

Big decisions (300 or more possible end positions, nearly always Sequence) would
take far too long to finish, so the search goes for the likeliest plays first:
1. every position is ranked by the computer player's Round 9 network (all of them in
   well under a second; until October 2026 this was an estimate from 11 of the 220
   rolls, then 44 rolls for the top 96, which took about a third of the whole search:
   2.3 core-hours of a 6.4 on an 8,548-position decision. If the network cannot be
   loaded, the positions go in order of their upper bounds);
2. (no second step any more);
3. positions are then solved exactly in that order. After the first 24 the best so
   far is booked, with the note "Best so far · 24 of N plays checked", and the
   gold bar keeps going. Whenever something better turns up it is booked instead
   (while the sheet still shows the hint);
4. when every position has been checked (or skipped because its bound shows it
   cannot win), the note says "Best play · all plays checked", or "Better play
   found · all plays checked" if the last step changed the booking.

Taking the hint back stops it from booking anything by itself; "Hint ready" then
offers the latest best. The ranking is only used for the order, so the final answer
is still exact.

Proving the other plays worse is most of the work: on that 8,548-position decision the
per-roll upper bounds were all 100% against a best of 91.4%, so nearly every position
had to be partly solved, about 55 of its 660 roll-solves. These now take the rolls in
the order the best play so far loses on them, worst first (each solve that sets a new
best sends back its per-roll results). That rules a position out after about as many
rolls, but those rolls are quicker to solve: 0.89 s instead of 1.68 s per position on
average over 210 sampled positions. On four decisions with 367-606 positions (2
workers), the whole search took 275 s instead of 474 s, with the same answers, and
the first best-so-far came after 2-28 s instead of 42-76 s.

Earlier measurements of the estimate (kept for the record): On 12 Sequence decisions from self-play with known exact answers
(11 to 1,625 positions), the best play was 1st or 2nd after step 2 every time. Step
1 alone was as low as 35th once, and ranking by points booked this round put it as
low as 321st-1,028th. The cost: about 0.3 s per position on one core for the
6,476-position case (about 5 minutes on 7 workers before the first answer), much less
on most boards.

Both the preview and the Hint work per player in 2-player mode: each acts on its
own sheet only, and two round-8 previews can run at once (they share the CPU, so
each takes longer). The solver still plays for the player's own chance of reaching
100, not for beating the other player.

## What it optimizes

Expectimax over *choose category → roll (220 distinct rolls, out of 1000) → booking*,
comparing outcomes in this order:

1. chance of finishing with at least 100 points
2. average final score when winning ("points if you win"; Quad Bonus excluded)
3. chance of holding a Quad (four of a kind in a Matching row), win or lose
4. average final score when losing. A lost game still counts 0 match points, but
   the computer keeps playing for its best score instead of giving up.
5. most points at the end of this round (greedy; tie-break between bookings)

Then, when all of the above are equal (bookings only, not before round 10):

6. the next round's second-best category: highest win chance, then highest points
   if win; then the same for its worst category. A booking that keeps a fallback
   open is better if the dice push you away from your first choice.

Then, deciding which digits to book:

7. fewest digits booked
8. avoid the most recently banked digits: compare the latest bank position used,
   then the next latest, and so on.

Finally, with the digits settled, where to put them among equivalent places:

9. ordinary books before Sequence Bonus II-A, and II-B last (a play that wins
   without II-B also wins in Classic, where II-B does not exist).
10. lean left: prefer the cells that come first in reading order (category, row,
   column), so `890_` beats `_890`, and the upper of two identical empty rows is used.
11. if still tied (`890_` vs `098_`, `3344` vs `4433`), prefer Sequences and Ladders written
    ascending (for Ladders, Y = X + 1 wrapping round: `9900` is ascending, `0099` is not).

Item 6 costs little. In round 9 it only needs the three round-10 category values of
the tied bookings, which are table lookups. In round 8 the search keeps every position
equal to the best on items 1-5 and then works out the other two round-9 categories
for those only (in display mode, since only win chance and points if win count).

Items 2 and 4 only decide between options with the same win chance, so the solver
compares them as sums over the winning and losing outcomes. Only items 1-3 matter for
the game itself (item 3 only with Quad Bonus on); items 4 and 5 just make the computer
play on sensibly when the outcome no longer depends on it. In round 10 the Hint note
always gives the outcome: "Best play wins with 105" or "No booking reaches 100", even
when the best play books nothing. Because the Quad comes before the losing score, a
lost game still goes for its first Quad (even with Quad Bonus off), while a won game
always takes the higher score.

Values are kept as exact integers (counts out of 1000 per remaining round), so
ties are real ties and the tie-breaks behave as intended. The solver always
assumes Strict Placement; Classic vs Modern is the only rules option.

## Rules modelled

- Row legality and scoring are copied from `index.html` (strict placement).
- Booking limit: 3 digits, or 4 if Sequence is chosen and a Sequence was already
  complete when the round was rolled.
- Bonus II free books (II-A, and II-B in Modern) can be used in any round once
  unlocked, including in the same round they are unlocked. A free book may go
  into any category, except that a second free book must go into Sequence if the
  first one did not. The round-10 bonus-only phase is covered too: a free book
  saved until then could equally have been used during round 10.
- A free book can finish a row the main books started, so in round 10 the main
  books may usefully go into a row without scoring yet. For example, Ladder with
  3344 in the bank and II-B waiting: 3, 3, 4 into an empty row, then the free
  book's 4 makes 3344 for 20. Earlier versions only considered round-10 bookings
  that scored on their own, so they missed such wins (0% shown instead of 100%).
  `ai/test/verify-free.js` checks these positions against a brute force.
- Bonus III gives +5, once. Modern also awards it for a full Matching or Ladder grid.

## API

```js
const solver = new SimiliSolver.Solver({ classic: false });
const { state, bankList } = SimiliSolver.fromGame(playerState, bank.map(b => b.digit));

// Start of a round: value of each category. roundsLeft counts the current round (round 10 = 1).
solver.analyzeRoundStart(state, roundsLeft);
// -> { categories: [{ category, winPct, winPctExact, pointsIfWin, pointsIfWinText, quadPct, quadPctExact }, ...], best }

// After the roll: the best booking. bankList must include this round's three digits.
solver.bestBooking(state, categoryIndex, bankList, roundsLeft);
// -> { placements: [{ category, row, col, digit, bankIdx, bonus }], winPct, winPctExact, pointsIfWin, pointsIfWinText, ... }

// Round 8 (three rounds left): same answer as bestBooking(state, cat, bankList, 3), by branch and bound.
solver.bestBookingBnB(state, categoryIndex, bankList, { timeLimit: 60000 });
// -> same fields plus stats: { positions, solved, boundMs, ms }, or { timedOut: true, stats } past the time limit
// opts.bounds: 'roll' (default), 'lazy' (what the page uses) or 'quick'; same answer, see "Round 8" below
// opts.order: 'sample' (with opts.sampleK) or 'r10' solves in the order of a cheap estimate; same answer
```

`winPctExact` and `quadPctExact` are exact decimal strings. With k rolls still to
come every value is an integer out of 1000^k, so a percentage is exact at 3k-2
decimals (before the round-9 roll, e.g. `19.7857`%).

`pointsIfWin` is the expected final score given that you win, so it is always at
least 100 (Quad Bonus excluded; `null` if no win is possible). It is a ratio of two
integers (sum of winning scores over number of winning outcomes). When every outcome
wins, the denominator is 1000^k and the value is exact at 3k decimals, so
`pointsIfWinText` uses 3k decimals, rounded half up when it does not terminate
(102.440 rather than a rounded 102.4). Ranking is unaffected by showing it this
way: total expected points = win chance × points if win, so at equal win chances
both orderings agree.

Placements list the main books first, then free books (`bonus: 'A' | 'B'`);
apply them in that order. A solver instance caches results, so reuse one instance
for a whole game.

## How fast it is (Node, one core)

| Decision | Exact? | Time |
|---|---|---|
| Round 10: category choice and booking | yes | ~1 ms |
| Round 9: booking after the roll | yes | median 40 ms, worst seen 2 s |
| Round 9: category choice (2 rounds of lookahead) | yes | 1–8 s typical, 10–30 s with free books in play |
| Round 8: booking after the roll | yes | 40 s – 4 min in most tested cases; over 10 min for the richest (see below) |
| Round 8: category choice | not yet | far beyond that |

The final round uses a shortcut. A booking works for a roll exactly when the
digits it is missing from the bank are among the rolled digits, so the solver
lists bookings once per category with up to three "wildcard" digits, then answers
all 220 rolls from that list. This is about 10× faster than enumerating each roll.

Tables are shared between positions whenever the rows involved are functionally the
same. The rows can be in any order, and each row is reduced to a class of
interchangeable rows. Two rows are interchangeable if each can answer every digit
the other takes with the same digit and stay at least as good, so any plan for one
works for the other. The digits already in the rows need not be the same. The classes
are computed from the rules when the solver loads (102 Sequence, 52 Matching and 42
Ladder classes, against 131/91/61 for mirror images alone). Examples:

- **Sequence:** mirror images (1___ = ___1, 12__ = __21, _23_ = _32_), and 3-runs
  waiting for the same digit: 123_ = _567 = 765_ (all need a 4). So after Bonus I,
  booking 4 onto 123_ plus _567 in a new row gives the same board as booking 4567 in
  the new row, since each has one complete 4-run and one 3-run that needs a 4.
- **Matching:** one digit anywhere; 11__ = _11_ = 1_1_ = __11, but not 1__1, which
  needs both middle cells for anything. Likewise 111_ = _111, but 1_11 = 11_1 is a
  separate class.
- **Ladder:** cells within a pair can swap, so 1_2_ = 1__2 = _12_ = 2__1 and so on,
  and 11__ = __11. Rows one digit from done that need the same digit also match:
  001_ = 1_22 (both need a 1).
- **Rows that can never score more** are interchangeable with any row of the same
  score.

`node ai/test/verify.js` checks this by swapping every row of 300 random positions
for a random member of its class and re-solving. The same rule keys the page's
preview cache, so two bookings that give equivalent boards are only solved once.
(Under Lax Placement the page hands the solver strict-layout rows, so 3_33 and 333_
meet there too.)

**When a Bonus II free book may come into play** in round 10, the position needs
the slower whole-position search. Three things keep that fast:
- Sequence with no free book at hand yet: only bookings that actually unlock one are
  searched; the rest come from the ordinary Sequence table.
- A free digit that scores nothing is only tried if the other free book can finish
  that same row. When both are already unlocked, only one order is tried, and the
  second free digit is scored directly.
- The result only depends on part of the position, so it is cached by that part. The
  booked category and Sequence count in full. Any other category can receive at most
  one free digit, so only its rows that one digit improves matter, plus its full-row
  count and Quad. Results are stored relative to the current score.

On two Sequence-heavy round-9 positions this took the analysis from 70 s to 4 s,
and from about 30 minutes to 19 s (one core). Before the free-book fix the same
positions took 7 s and 94 s, but missed some wins.

## Round 8: what works and what doesn't

A round-8 booking decision means a two-round search from every distinct position
the booking can lead to. Bookings that give the same position (rows in any order,
interchangeable rows, same bank and free-book state) are grouped, keeping the
group's tie-break favourite: 38–1,884 positions in the cases below, each needing a
round-9 analysis.

**Making one round-9 analysis cheap (all exact):**
- **Lean booking lists.** Among extensions of a row that use the same digits, only
  the best results are kept (one of each set of interchangeable results; Matching
  1__1 is dropped next to 11__). An empty Ladder row goes from 240 extensions to 60,
  Matching from 150 to 40. The Hint, which has to name cells, still uses the full lists.
- **Booking lists per row set.** In a round-9 search the same booked rows meet a new
  bank under almost every roll. A row set that comes back gets a list of all its
  scoring bookings (made once, ignoring the bank). Each new bank is then a scan of
  that list instead of a fresh search, and evaluated directly at the needed score.
- **Alpha skipping.** For one round-9 roll, a booking only matters if it can beat the
  best found so far. Before evaluating a category for it, the solver checks the most
  that row set could ever give (its biggest gain on every roll). If that cannot win
  where the best already wins, or cannot beat the best's points, it is skipped.
- **Display mode** (`exactLoss: false`, used by the odds previews): the 4th value,
  points if lost, is not needed there, so it can skip even more. Win chance, points
  if win and Quad stay exact (`ai/test/verify-loose.js`).

On the earlier test positions a round-9 analysis now takes 1–8 s instead of 5–90 s
(one core). Boards where a Bonus II free book may come into play in round 10 are
still the slow ones (10–30 s), because each needs its own whole-position search.

**Branch and bound (`bestBookingBnB`, exact).** For each position, round-9 category
and round-9 roll, a cheap upper bound on the best booking:
- round 10 in the same category: booking P now and Q later ends where P and Q
  together would, so at most a final-round table of today's rows with the bank after
  the roll and both rounds' booking limits combined;
- round 10 in another category: those rows are untouched, so at most that table with
  the whole bank, at a base score raised by the most round 9 could add;
- free books, only when one could still be unlocked in time *and* Sequence is played
  in round 9 or 10 (or one is already waiting): +2 to the booking limits, plus what
  two single digits could add elsewhere.

Lexicographic order is compatible with addition, so the per-roll bounds add up to a
bound per position. The search runs in two phases:
1. On the first three values only (win, points if win, Quad), positions are solved
   best bound first. A round-9 category is dropped as soon as its rolls so far plus
   the bounds of the rest cannot reach the best, and the search stops when no bound
   can. Every position tying the best is kept.
2. The tied positions are solved again on all four values, with the same cut-offs,
   and equal values fall back to the booking tie-breaks.

The answer is the same booking `bestBooking` picks: `ai/test/verify-r8.js` compares
against the exhaustive search.

Measured (one core, 10-minute cap; positions from greedy self-play after seven rounds):

| Position | Positions after booking | Branch and bound | Exhaustive |
|---|---|---|---|
| 50 pts, Sequence, roll 7-1-1 | 326 | 31 s (28 s of it bounds) | 575 s, same answer |
| 70 pts, Ladder, roll 7-8-8 | 50 | 112 s | – |
| 55 pts, Ladder, roll 4-8-2 | 82 | over 10 min (free books in play) | – |
| 65 pts, Sequence, roll 9-6-1 | 1,884 | over 10 min (338 started) | – |
| 65 pts, Ladder, roll 1-5-3 | 38 | 71 s | 521 s, same answer |
| 50 pts, Sequence, roll 8-8-2 (Classic) | 489 | 223 s | 722 s, same answer |
| 55 pts, Matching, roll 9-4-5 | 60 | 40 s | 211 s, same answer |
| 65 pts, Matching, roll 3-4-7 (page test) | 176 | 29 s | – |
| 65 pts, Sequence, roll 3-4-7, 10-digit bank (page test) | 6,476 | over 25 min (815 started) | – |

Two days earlier every case but the first gave up after 5 minutes. The work splits
evenly across positions, so Web Workers would divide these times by the number of
cores used: well under a minute for most cases on an 8-core machine. The
Sequence-heavy decision with 1,884 positions and the one with free books in play are
still minutes to tens of minutes.

**Quick bounds (`bounds: 'lazy'`, what the page uses).** Per-roll bounds cost about
80 ms per position, which on the 6,476-position Sequence case is nine minutes on one
core before anything is solved. A cheaper bound skips the rolls: a bank with three
more of every digit contains the bank after any roll, and a bigger bank never does
worse, so one evaluation bounds all 220 rolls. Positions are ordered and skipped by
that, and per-roll bounds are worked out only for those that still have to be
solved. Same answers (`BOUNDS=lazy node ai/test/verify-r8.js 1 1` matches the
exhaustive search); on positions where the quick bound is loose (most of them early in
the game, when 100 is still within reach either way) it saves little, since nearly
every position ends up needing its per-roll bounds anyway.

**Shared-bound pruning inside round 9 (`prune: true`, exact, off by default).** An
older experiment: the same kind of bound, used to skip round-9 bookings. Superseded by
alpha skipping.

**Round 8 category choice and earlier rounds.** Choosing the round-8 category exactly
is another factor of 220 rolls on top of a booking decision and stays out of reach.
The practical route for rounds 1–8 remains the one backgammon programs took: the
exact solver as an endgame table for rounds 9–10 (and round-8 bookings where time
allows), with a heuristic evaluation of earlier positions.

## Computer Player setting

The first Gameplay setting is **Human Player / Computer Player** (default Human Player).
With Computer Player:
- **1 player:** the computer plays the game and you watch. It picks its category at the
  start of each round; you click ROLL; it books (its new digits are gold, with a note
  such as "Booked 3 digits") and you click its End Round.
- **2 players:** you are Player 1 and the computer is Player 2. Its category shows as
  "Category chosen ✓" until you have chosen yours. After the roll its sheet says
  "Decided · end your turn to see its booking"; its booking appears once you click your
  End Round, and then you click its End Round. Everything else (Hints, previews) works
  for your sheet as usual; the computer's sheet cannot be clicked.

How it decides (all in Web Workers, so the page has to be served over http(s), as on
GitHub Pages):
- Rounds 1-7: the networks below (`ai/model.json`, or `ai/model-small.json` until that
  exists), with the top 6 bookings re-checked one round deeper, over all 220 rolls
  (a few seconds; it used to be 8 random rolls, whose luck alone often decided between
  near-equal bookings). Estimates within a margin of the best count as tied, and among
  them the computer books the fewest digits (then the best estimate): 0.5 points of win chance in Rounds 2 and 3, then 0.4, 0.3, 0.2 and 0.1
  in Rounds 4-7 (`TIE_MARGIN` in `simili-ai.js`). The networks are off by 1-2 points on
  average in the early rounds, so smaller differences mean nothing. Example: Round 2,
  bank 403, Ladder, roll 925: the network had 34, nothing, 90, 45 and 23 within 0.11
  points of each other, and the computer booked 23 (or another of them, by the luck of
  the 8 rolls); now it books nothing. Over 200 games on the same dice (small model): 78.0% wins with
  both changes against 76.0% before (104.2 points if win against 104.8), within the noise;
  the gain is in avoiding plays like that one rather than in the win rate.
- Round 8: the Round 8 Hint's exact search, on at most 4 workers, ordered by the
  network: its ranking of all the bookings (a few milliseconds) decides which positions
  are solved first, and its final choice (with the re-check) goes to the front as soon as
  it is known. If the search finishes within 30 seconds, its answer; otherwise its best so
  far, provided it has already solved the network's choice (so it is at least as good);
  otherwise the network's choice. (Before this, the search went in order of its upper
  bounds and only reported a best so far after 24 positions; in a game where the computer
  booked 5 and an extra 4 in Matching (94.7% to win) the best play, the 5 alone (97.4%),
  was 82nd of 137 in that order and 11th in the network's.)
- Rounds 9 and 10: exact (the same solver as the Hint).

Games with the computer have statistics pages of their own: "1 Computer Player" (the
computer alone) and "Human vs Computer" (you as Player 1), each for single games and
match play, and a line each in the Quad Bonus Statistics. The Display setting "Merge
Ver. Stats" (default) shows Modern and Classic games together on one page per mode
(10 pages in all); "Split Ver. Stats" gives each version its own page (18 pages).
Both versions are always stored separately, and the computer pages come after the
original ones in the saved `?stats=` string, so strings saved before still load.

## Computer player for the whole game (`ai/simili-ai.js`)

Rounds 9 and 10 are played exactly by the solver. For rounds 1-8 a small neural network
per round estimates how good a round-start position is: chance to reach 100, final
score if 100 is reached, chance of a Quad. A decision looks one step ahead: each
booking is judged by the estimate for the position it leaves; a category by the average
over the rolls of the best booking. Then the 6 best bookings are judged again one round
deeper over 8 sampled rolls (by the next round's network, or before Round 9 by the
exact solver): picking the best of ~1,000 estimates otherwise favours the ones the
network happens to overrate.

Estimates are never exactly equal, so the usual order (win, points if win, Quad) is one
score in which 5 more points if win count like about 0.07% more win chance and a sure
Quad like 0.2%.

**Inputs.** Each row is one of 102 / 52 / 42 interchangeable classes (see "equivalence
classes" above), so a category is how many of its rows are in each class. Then the bank
("at least 1, 2, 3, 4 copies" of each digit), bonus state and score: 245 inputs, about
25 active at a time. Hidden layer of 64, three outputs.

**Training (`ai/train/train.js`), backwards round by round.** Positions at the start of
rounds 2-9 come from self-play games. N[2] (start of round 9) learns values from the
exact solver (best Round 9 booking for 12 random rolls per category, Round 10 exact);
N[3] learns one-step look-ahead values using N[2]; and so on to N[9]. Things that turned
out to matter:
- *Two networks per round*, trained on different halves of the positions. The labels for
  the next round pick the best booking with one and take the other's estimate (and the
  other way round). Taking the best of many estimates and its own estimate overrates
  it, and that grew round after round: the first try thought the start of round 2 was a
  98% win.
- *The game is symmetric under renaming digits* d -> s*d + t (mod 10), s = +-1, i.e.
  shifting the digits round the cycle and reflecting about any axis: runs, pairs and
  ladders wrap around (9012, 0099) and the dice are uniform (checked for every legal
  row). So the up to 20 renamings of a position have the same value, and:
  - in play the network only ever sees the *canonical* renaming (the one with the
    smallest bank, as the counts of 0, 1, ..., 9, then the smallest rows). Its estimates
    are then exactly the same for all 20 (`ai/test/verify-canonical.js`), and choices
    between equivalent plays are true ties, decided by the usual tie-breaks. Before
    this, the first small model booked a pair of 8s in Round 1 (but no other pair) and
    preferred Matching in Round 1 by 0.00000001, both just network noise; now it books
    nothing after any Round 1 roll and the three categories tie (Sequence first, as in
    the solver's order);
  - one renaming per *decision*: every option of a booking (or every category, for a
    roll) is judged in the canonical renaming of the position being decided, so the
    network's small digit-specific errors are the same for all the options compared.
    Renaming each option on its own made them differ between options and played worse
    (72.5% against 78.3% on 240 games). Per decision against no renaming at all, over
    480 games on 4 sets of dice: 76.0% against 77.1%, which is within the noise (the two
    only differ on near-ties; set by set the gap went both ways, from -5.9 to +7.5);
  - in training it still learns from all 20 renamings of each labelled position (20
    examples each). On round-9 starts with 1,500 positions that took the error from 11
    to 8.7 points of win chance; tested on canonical inputs it is 7.8 points with 5,100
    positions, against 8.4 when trained on canonical inputs only (the canonical choice
    jumps around between similar positions, which makes the inputs harder to learn).
  (Extra inputs did not help: the exact one-round-left value, a two-round relaxation,
  which bank digits extend which rows.)
- *Who plays the games.* Pass 1 uses a greedy player (most points now, in the category
  that scores most on average). A first try with random categories and many random
  bookings gave almost only lost positions (about 1% to win by round 9), and the
  networks learnt nothing. Later passes play with the computer from the pass before
  (plus a quarter of greedy games), so the networks see the positions the computer
  actually steers into, including the ones it wrongly liked. Half of each later pass's
  positions come from earlier passes' games: a third pass trained on its own games only
  came out weaker than the second (63% instead of 75% below).

**Results so far** (trained here on 2 cores: 8,000 games, 6,000 labels per round, 8
rolls per label; 120 whole games on the same dice, `ai/train/evaluate.js`):

| Player | Reaches 100 | Points if win | Books nothing in Round 1 | Own estimate at Round 2 |
|---|---|---|---|---|
| Greedy (exact in rounds 9-10) | 55.0% | 103.9 | - | - |
| Computer after pass 1 | 45.0% | 103.8 | 71 of 120 | 82.6% |
| Computer after pass 2 | 65.8% | 103.4 | 117 of 120 | 69.3% |
| Pass 2 + re-checking the top 6 bookings | **75.0%** | 104.7 | 120 of 120 | 69.3% |
| Pass 3 (own games only) + re-check | 63.3% | 103.2 | 100 of 120 | 73.6% |

It found "book nothing in Round 1" by itself. The weak spot is the round-9-start
network: about 9-11 points of win chance off on average against the exact solver (the
re-check covers for it before Round 9). More positions help; the full run below uses
about 7 times as many.

### Training it on your Mac

1. Install Node.js: the LTS installer from https://nodejs.org (or `brew install node`).
   Check with `node --version` in Terminal (18 or newer).
2. In Terminal, go to the repository (`cd` to the folder with `index.html`) on the
   `simili-ai-solver` branch.
3. Run
   ```
   node ai/train/train.js
   ```
   It uses every core, prints progress with time left, and writes `ai/model.json` after
   each network. Defaults: 40,000 games, 40,000 labelled positions per round, 12 rolls
   per label, 3 passes. Expect roughly 1-2 hours per pass on an 8-core Mac (overnight
   for 3), and up to 0.5 GB of memory per core.
4. If it stops (Ctrl+C, sleep), run the same command again: it continues after the last
   finished network (positions and labels are kept in `ai/train/data/`, which is not
   committed). To start over, delete `ai/model.json` and `ai/train/data/`.
5. Check it: `node ai/train/evaluate.js --games 200` plays 200 games against the greedy
   player (about 10 seconds per game per core). After each pass a copy is kept
   (`ai/model-pass1.json`, ...); `--model ai/model-pass2.json` evaluates one of them,
   and if an earlier pass does better, copy it over `ai/model.json`.

Commit `ai/model.json` (about 1.5 MB); `ai/train/data/` stays out of git.

`ai/model-small.json` is the pass-2 model from the small run here (the 75% row above),
to compare against: `node ai/train/evaluate.js --model ai/model-small.json`.

## Tests

```
node ai/test/verify.js [n]            # rules vs index.html, PDF examples, n random round-10 positions
node ai/test/verify-fast.js [n]       # fast final round == general expectimax
node ai/test/verify-two-round.js [n]  # same, from the start of round 9 (slow)
node ai/test/verify-prune.js [n]      # experimental pruned search == plain search (slow)
node ai/test/verify-fast2.js [n]      # fast round-9 analysis == reference path (slow)
node ai/test/verify-free.js [n] [r]   # round 10 with free books == brute force (slow)
node ai/test/verify-loose.js [n]      # display mode: first three values == exact
node ai/test/verify-r8.js [n] [seed]  # round-8 branch and bound == exhaustive search (very slow)
node ai/test/verify-tiebreak.js [n]   # round-9 Hint: second/worst-category tie-break == brute force
node ai/test/verify-save-free.js [n]  # free books saved for round 10: same round-9 values
node ai/test/verify-canonical.js      # computer player: same estimate for all 20 digit renamings
node ai/test/bench.js <round> <count> [start|book]
```

`verify.js` compares win chances with the game's own `computeRound10WinChances`.
Wherever they disagree, a brute force using only the game's per-digit legality
checks decides which one is right.

## Bugs in the game's round-10 calculator

The round-10 win chances the game shows (with or without Hints) now come from this
solver: `computeRound10WinChances` asks it which rolls win and keeps the same outs
notation. The old search is kept as `computeRound10WinChancesLegacy`, used only if
`simili-solver.js` fails to load and by the tests as an independent implementation;
`node ai/test/verify-r10-display.js` checks the display against both. The notes below
describe the legacy calculator.

`computeRound10WinChancesLegacy` in `index.html` is not exact, in both directions.
The test harness can apply the first four fixes below (`SIMILI_PATCH_SEQ=1`), and
`round10-calculator-fix.diff` contains them as a patch to `index.html`.

**False wins (it counts a roll as winning when no legal booking reaches 100):**

1. **Phantom Sequence moves.** `getSequenceRowMovesOpt` checks a 3-cell target
   only against the three cells it covers, not against a digit already in the
   fourth cell. Example: for the row `__12`, the target 3-2-1 in cells 0-2 is
   accepted, giving `3212`. Scoring sees three in a row and awards 10, but the
   game would never let you book it.
2. **End-of-search free book ignores "must go into Sequence".** If one free
   book was used outside Sequence, the other must go into Sequence. The shortcut
   that adds a leftover free book at the end of the search skips that check.
3. **Overflow into a free book ignores it too.** When the chosen category's
   main books run out and an extra digit spills into a free book, the same check
   is skipped (it is only applied to rows outside the chosen category).
4. **A free book unlocked mid-round has no constraint at all.** The "must go into
   Sequence" list is only built for free books already unlocked at the start of
   the round.

**Missed wins (it reports a loss when a legal win exists):**

5. **Free book on a row that also received main books**, when that same row's
   completion is what unlocked the free book. The code forbids this on purpose,
   but the real game allows it. Example: booking 6 and 5 into `___4` makes `_654`
   the fifth Sequence row scoring 10, unlocking II-A; the free book then puts 7
   in front for `7654`.
6. **Chains after a free book.** The end-of-search shortcut never re-checks
   unlocks or Bonus III after placing a free book. Example: II-A's free book
   completes a fourth 4-Sequence, which unlocks II-B, whose free book completes
   the fifth and earns Bonus III.

Measured on 3,000 random round-10 positions (a third Classic, half of them
Sequence-heavy): with fixes 1-4 applied, 11 rolls still disagree, all of them
missed wins of type 5 or 6. The brute force sided with the solver every time.

Fixes 5 and 6 would mean reworking the search order, so the simpler fix is to
replace the calculator with this solver's round-10 evaluation, which is exact
and takes about 1 ms per position.

### Example of a false win (bug 1)

Modern rules, start of round 10, 45 points:

- **Sequence rows:** 8765, `__12`, `67__`, `21_9`, `543_`
- **Matching:** empty
- **Ladder rows:** `_7__`, `5_6_`, `88_7`, `8___`, 4455
- **Unused bank digits:** 3, 8

For Sequence, the game reports 0.9% (rolls 0-0-7 and 0-2-7). Only 0-0-7 wins (0.3%):

1. Book 0 → `_012`, 8 → `678_`, 0 → `2109`. That gives five Sequence rows scoring 10 or more.
2. This unlocks Bonus II-A. Use the free book to put the 7 into `88_7`.
3. Final score: exactly 100.

With 0-2-7 the calculator books 0 → `2109`, 8 → `678_` and 3, 2 → `3212`, then
the free book 7 → `8877`. But `3212` is not a legal booking, and the best
reachable score is 75.
