// The evidence that the numbers are right.
//
// Caffeine.js and Presets.js are QML JavaScript resources, not ES modules, so
// they are loaded into a vm context the way radio-atlas loads its model. The
// context is deliberately minimal: anything these files reach for that isn't
// listed here is something they shouldn't be reaching for.

import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { fileURLToPath } from "node:url"

const testDir = path.dirname(fileURLToPath(import.meta.url))

function load(file) {
  const context = { Math, Number, Array, String, Date, RegExp, JSON, isFinite }
  vm.createContext(context)
  vm.runInContext(fs.readFileSync(path.join(testDir, "..", file), "utf8"), context)
  return context
}

const caffeine = load("Caffeine.js")
const presets = load("Presets.js")

const HOUR = 3600
const NOW = 1756704000 // 2025-09-01T05:20:00Z, fixed so nothing here is clock-dependent

const at = (hoursAgo, mg, label = "test") => ({ ts: NOW - hoursAgo * HOUR, mg, label })

// Local wall-clock timestamps, because bedtime is a wall clock: bedtimeSeconds
// rolls by calendar day, so a test that fixed these in UTC would pass or fail
// on the machine's timezone.
const localTs = (y, m, d, h, min) => Math.floor(new Date(y, m, d, h, min, 0, 0).getTime() / 1000)

// Arrays built inside the vm realm carry that realm's Array prototype, which
// a strict deep-equal against a host literal rejects. Rehydrate through the
// host's Array.from rather than loosening the assertion.
const idsOf = (list) => Array.from(list, (preset) => preset.id)

// Same trap, same fix, for a plain object: an object built inside the vm has
// that realm's Object prototype, which strict deep-equal rejects against a
// host literal that looks identical. Copy it into a host object rather than
// reaching for the loose comparison.
const plain = (value) => Object.assign({}, value)

// ---------------------------------------------------------------- the curve

test("one 95mg dose peaks at ~48 minutes at ~90% of the dose", () => {
  const tmax = caffeine.timeToPeak(5)
  assert.ok(tmax > 0.75 && tmax < 0.85, `Tmax was ${tmax}h`)
  assert.ok(Math.abs(tmax * 60 - 48) < 3, `Tmax was ${tmax * 60} min`)

  const fraction = caffeine.peakFraction(5)
  assert.ok(fraction > 0.88 && fraction < 0.92, `peak fraction was ${fraction}`)

  const peak = caffeine.levelAt([at(tmax, 95)], NOW, 5)
  assert.ok(Math.abs(peak - 95 * fraction) < 0.01)
  assert.ok(peak > 84 && peak < 87, `peak was ${peak}mg`)

  // The peak really is a peak, not just a large sample.
  assert.ok(caffeine.levelAt([at(tmax - 0.25, 95)], NOW, 5) < peak)
  assert.ok(caffeine.levelAt([at(tmax + 0.25, 95)], NOW, 5) < peak)
})

test("a dose is down to ~50% one half-life later, out in the tail", () => {
  // Measured peak-to-peak+halfLife: absorption is done by then, so the decay
  // is the elimination term alone and the halving should be clean.
  const tmax = caffeine.timeToPeak(5)
  const peak = caffeine.levelAt([at(tmax, 100)], NOW, 5)
  const later = caffeine.levelAt([at(tmax + 5, 100)], NOW, 5)
  assert.ok(Math.abs(later / peak - 0.5) < 0.02, `ratio was ${later / peak}`)

  // And the same holds a second half-life on.
  const laterStill = caffeine.levelAt([at(tmax + 10, 100)], NOW, 5)
  assert.ok(Math.abs(laterStill / peak - 0.25) < 0.02, `ratio was ${laterStill / peak}`)
})

test("doses superpose", () => {
  const first = [at(3, 95)]
  const second = [at(1, 125)]
  const both = caffeine.levelAt([...first, ...second], NOW, 5)
  const sum = caffeine.levelAt(first, NOW, 5) + caffeine.levelAt(second, NOW, 5)
  assert.ok(Math.abs(both - sum) < 1e-9)
  assert.ok(both > caffeine.levelAt(first, NOW, 5))
})

test("a 12h half-life still holds ~25% of a 24h-old dose", () => {
  // The case a 24h compute window loses outright, and the reason the window
  // is 72h. Anyone on oral contraceptives or pregnant sits here.
  const level = caffeine.levelAt([at(24, 200)], NOW, 12)
  const peak = caffeine.peakLevel(200, 12)
  assert.ok(level / peak > 0.22 && level / peak < 0.28, `kept ${level / peak}`)
  assert.ok(level > 40, `only ${level}mg left`)
})

test("the compute window covers four days and stops there", () => {
  const window = caffeine.COMPUTE_WINDOW_HOURS
  const ceiling = caffeine.HALF_LIFE_MAX_HOURS
  assert.ok(caffeine.levelAt([at(window - 1, 200)], NOW, ceiling) > 0)
  assert.equal(caffeine.levelAt([at(window + 1, 200)], NOW, ceiling), 0)
  // The window's guarantee is a function of the ceiling, and it was widened
  // with it at Phase 10: at the slowest half-life the model can derive, what
  // falls off the end of the window is still under 2% of a dose.
  assert.ok(caffeine.levelAt([at(window - 0.1, 200)], NOW, ceiling)
    < 0.02 * caffeine.peakLevel(200, ceiling))
})

test("levelOverRange samples the requested span inclusively", () => {
  const samples = caffeine.levelOverRange([at(1, 95)], NOW - 12 * HOUR, NOW + 12 * HOUR, 5, 100)
  assert.equal(samples.length, 100)
  assert.equal(samples[0].ts, NOW - 12 * HOUR)
  assert.equal(samples[99].ts, NOW + 12 * HOUR)
  for (const sample of samples) assert.ok(isFinite(sample.mg) && sample.mg >= 0)
  // Before the dose, nothing; after it, something; and it is falling by the end.
  assert.equal(samples[0].mg, 0)
  assert.ok(samples[99].mg < caffeine.levelAt([at(1, 95)], NOW, 5))
})

// ---------------------------------------------------------------- the cup

test("a large coffee very nearly fills the cup, and nothing overflows it", () => {
  // Not exactly 1: timestamps are whole seconds, so a dose can only land near
  // Tmax, never on it.
  const fresh = caffeine.cupFill([at(caffeine.timeToPeak(5), 150)], NOW, 5)
  assert.ok(Math.abs(fresh - 1) < 1e-6, `fill was ${fresh}`)

  // The scale stretches rather than clipping, so the mark never claims to be
  // as full as it goes when there is twice as much on board.
  const doubled = caffeine.cupFill([at(caffeine.timeToPeak(5), 300)], NOW, 5)
  assert.ok(doubled <= 1)
  assert.ok(doubled > 0.9)

  assert.equal(caffeine.cupFill([], NOW, 5), 0)
})

// ---------------------------------------------------------------- bedtime

test("bedtime rolls to the next occurrence of the clock", () => {
  const bedtime = caffeine.bedtimeSeconds(NOW, "23:00")
  assert.ok(bedtime > NOW)
  assert.ok(bedtime - NOW <= 24 * HOUR)
  const asDate = new Date(bedtime * 1000)
  assert.equal(asDate.getHours(), 23)
  assert.equal(asDate.getMinutes(), 0)

  // Junk falls back to 23:00 rather than throwing inside the shell process.
  assert.equal(caffeine.bedtimeSeconds(NOW, "nonsense"), bedtime)
  assert.equal(caffeine.bedtimeSeconds(NOW, "99:99"), bedtime)
  assert.equal(caffeine.bedtimeSeconds(NOW, ""), bedtime)
  assert.equal(caffeine.bedtimeSeconds(NOW, null), bedtime)
})

test("bedtime bands split at 30 and 60mg, and follow the threshold setting", () => {
  assert.equal(caffeine.bedtimeBand(0), "clear")
  assert.equal(caffeine.bedtimeBand(29.9), "clear")
  assert.equal(caffeine.bedtimeBand(30), "marginal")
  assert.equal(caffeine.bedtimeBand(60), "marginal")
  assert.equal(caffeine.bedtimeBand(60.1), "disruptive")

  // The shipped default reproduces the pair the science notes derived, so
  // moving the setting is the only way to move the bands.
  assert.equal(caffeine.BEDTIME_MARGINAL_MG,
    caffeine.BEDTIME_CLEAR_MG * caffeine.BEDTIME_MARGINAL_MULTIPLE)
  assert.equal(caffeine.bedtimeBand(29.9, caffeine.BEDTIME_CLEAR_MG), "clear")

  // Someone who sleeps badly on half a cup drops it; the upper band follows.
  assert.equal(caffeine.bedtimeBand(12, 10), "marginal")
  assert.equal(caffeine.bedtimeBand(9, 10), "clear")
  assert.equal(caffeine.bedtimeBand(21, 10), "disruptive")

  // And someone who does not notice a coffee raises it.
  assert.equal(caffeine.bedtimeBand(90, 100), "clear")
  assert.equal(caffeine.bedtimeBand(150, 100), "marginal")

  // Junk and out-of-range clamp rather than banding everything as disruptive.
  assert.equal(caffeine.bedtimeBand(29.9, "nonsense"), "clear")
  assert.equal(caffeine.bedtimeBand(29.9, 0), "disruptive")   // clamped to 10
  assert.equal(caffeine.bedtimeBand(150, 99999), "marginal")  // clamped to 100
})

test("the sleep threshold clamps to its own bounds", () => {
  assert.equal(caffeine.sanitizeThreshold(undefined), caffeine.BEDTIME_CLEAR_MG)
  assert.equal(caffeine.sanitizeThreshold("45"), 45)
  assert.equal(caffeine.sanitizeThreshold(44.4), 44)
  assert.equal(caffeine.sanitizeThreshold(0), caffeine.SLEEP_THRESHOLD_MIN_MG)
  assert.equal(caffeine.sanitizeThreshold(-5), caffeine.SLEEP_THRESHOLD_MIN_MG)
  assert.equal(caffeine.sanitizeThreshold(99999), caffeine.SLEEP_THRESHOLD_MAX_MG)
  assert.equal(caffeine.sanitizeThreshold("nope"), caffeine.BEDTIME_CLEAR_MG)
  assert.ok(caffeine.SLEEP_THRESHOLD_MIN_MG < caffeine.BEDTIME_CLEAR_MG)
  assert.ok(caffeine.BEDTIME_CLEAR_MG < caffeine.SLEEP_THRESHOLD_MAX_MG)
})

test("the bedtime projection reads the level at bedtime, not now", () => {
  // A wall-clock morning, not NOW: inside the late window after bedtime the
  // projection reads the level now instead of at a bedtime that has passed,
  // which is its own behaviour and tested separately. NOW is fixed in UTC, so
  // it falls in that window across the Americas and this test would be
  // asserting the other branch there.
  const morning = localTs(2025, 8, 1, 8, 0)
  const bedtime = caffeine.bedtimeSeconds(morning, "23:00")
  const doses = [{ ts: morning, mg: 200, label: "test" }]
  const projection = caffeine.bedtimeProjection(doses, morning, 5, "23:00")
  assert.equal(projection.at, bedtime)
  assert.ok(Math.abs(projection.mg - caffeine.levelAt(doses, bedtime, 5)) < 1e-9)
  assert.ok(projection.mg < caffeine.levelAt(doses, morning + HOUR, 5))
  assert.equal(projection.band, caffeine.bedtimeBand(projection.mg))
  assert.equal(projection.rounded, caffeine.roundDisplay(projection.mg))
  assert.ok(projection.hoursAway > 0)
})

test("the strong-dose line finds the last dose over 100mg", () => {
  const doses = [at(2, 95), at(7, 125), at(30, 200)]
  assert.equal(caffeine.lastStrongDose(doses, NOW).ts, NOW - 7 * HOUR)
  assert.ok(Math.abs(caffeine.hoursSinceLastStrongDose(doses, NOW) - 7) < 1e-9)

  const lead = caffeine.strongDoseLead(doses, NOW, 5, "23:00")
  // The bedtime a dose is measured against is the one following *the dose*,
  // not the one following now — that is defect #5, tested below. Deriving the
  // expectation from NOW instead agreed with the code only in a timezone where
  // both timestamps happen to land on the same side of 23:00, which is why
  // this passed at UTC+1 and failed in CI's UTC.
  const bedtime = caffeine.bedtimeSeconds(NOW - 7 * HOUR, "23:00")
  assert.ok(Math.abs(lead.hoursBeforeBed - (bedtime - (NOW - 7 * HOUR)) / HOUR) < 1e-9)

  // Nothing over the threshold reports nothing, rather than zero hours.
  assert.equal(caffeine.lastStrongDose([at(2, 95)], NOW), null)
  assert.equal(caffeine.hoursSinceLastStrongDose([at(2, 95)], NOW), null)
  assert.equal(caffeine.strongDoseLead([at(2, 95)], NOW, 5, "23:00"), null)
  assert.equal(caffeine.lastStrongDose([], NOW), null)
})

test("the strong-dose line does not call a 100 mg dose 'over 100 mg'", () => {
  // The threshold is inclusive on purpose — 100 mg is the figure the trials
  // call strong — so the shipped Americano, which is exactly 100, reaches this
  // line. It used to read "Last dose over 100 mg (100 mg)".
  assert.equal(caffeine.lastStrongDose([at(2, 100)], NOW).mg, 100)
  assert.equal(caffeine.formatStrongDoseHead(100, 100), "Last dose of 100 mg")

  // Above it, nothing changed: the bracket carries the dose the line is about.
  assert.equal(caffeine.formatStrongDoseHead(125, 100), "Last dose over 100 mg (125 mg)")
  assert.equal(caffeine.formatStrongDoseHead(200, 100), "Last dose over 100 mg (200 mg)")

  // The threshold is a parameter, so the same rule has to hold off 100.
  assert.equal(caffeine.formatStrongDoseHead(80, 80), "Last dose of 80 mg")
  assert.equal(caffeine.formatStrongDoseHead(95, 80), "Last dose over 80 mg (95 mg)")

  // Junk in either position falls back rather than rendering NaN at a user.
  assert.equal(caffeine.formatStrongDoseHead(125, undefined), "Last dose over 100 mg (125 mg)")
  assert.equal(caffeine.formatStrongDoseHead(undefined, 100), "Last dose of 100 mg")
})

test("a dose drunk after bedtime is not '23h before bed'", () => {
  // The defect, exactly: 23:57, a double espresso 27 minutes old, bedtime
  // 23:00 — which has already happened, so the next one is 23h30m away.
  const now = localTs(2025, 8, 1, 23, 57)
  const doses = [{ ts: localTs(2025, 8, 1, 23, 30), mg: 125, label: "test" }]
  const lead = caffeine.strongDoseLead(doses, now, 5, "23:00")

  // The arithmetic was never wrong, and is unchanged.
  assert.ok(Math.abs(lead.hoursBeforeBed - 23.5) < 1e-6)
  // The reading is the other way round.
  assert.equal(lead.afterBedtime, true)
  assert.ok(Math.abs(lead.hoursAfterBed - 0.5) < 1e-6)
  assert.equal(caffeine.formatLead(lead), "30m after bedtime")

  // Still tonight at 2am; back to counting down by 5.
  const small = localTs(2025, 8, 2, 2, 0)
  assert.equal(caffeine.formatLead(
    caffeine.strongDoseLead([{ ts: small, mg: 125, label: "t" }], small + 60, 5, "23:00")),
    "3h after bedtime")
  const morning = localTs(2025, 8, 2, 5, 0)
  assert.equal(caffeine.formatLead(
    caffeine.strongDoseLead([{ ts: morning, mg: 125, label: "t" }], morning + 60, 5, "23:00")),
    "18h before bed")

  // A morning coffee counts down to tonight, which is what it always did.
  const eight = localTs(2025, 8, 2, 8, 0)
  assert.equal(caffeine.formatLead(
    caffeine.strongDoseLead([{ ts: eight, mg: 125, label: "t" }], eight + 1800, 5, "23:00")),
    "15h before bed")

  // On the hour itself, "now after bedtime" would be nonsense.
  const onTime = localTs(2025, 8, 1, 23, 0)
  assert.equal(caffeine.formatLead(
    caffeine.strongDoseLead([{ ts: onTime, mg: 125, label: "t" }], onTime + 60, 5, "23:00")),
    "at bedtime")

  assert.equal(caffeine.formatLead(null), "")
})

test("defect #5: a dose before bedtime, read after it, counts to the bedtime it preceded", () => {
  // The report, exactly: bedtime 23:00, a 200mg cold brew at 22:12, read at
  // 23:52. The dose is before bedtime (so D41's "after bedtime" branch does
  // not fire) and now is after it (so D42's does), which is the gap the two
  // branches left between them.
  const now = localTs(2025, 8, 1, 23, 52)
  const doses = [{ ts: localTs(2025, 8, 1, 22, 12), mg: 200, label: "Cold brew" }]
  const lead = caffeine.strongDoseLead(doses, now, 5, "23:00")

  // 48 minutes, not 24h48m. The old measurement was to the bedtime following
  // *now*, which had already rolled to tomorrow.
  assert.ok(Math.abs(lead.hoursBeforeBed - 0.8) < 1e-6)
  assert.equal(lead.afterBedtime, false)
  assert.equal(lead.bedtimePassed, true)
  assert.equal(lead.bedtimeAt, localTs(2025, 8, 1, 23, 0))
  assert.equal(caffeine.formatLead(lead), "48m before bedtime, which has passed")

  // Read one minute *before* bedtime the number is the same and the sentence
  // is the plain one — nothing about the dose changed, only what is true of
  // the bedtime it is measured against.
  const early = localTs(2025, 8, 1, 22, 59)
  const before = caffeine.strongDoseLead(doses, early, 5, "23:00")
  assert.ok(Math.abs(before.hoursBeforeBed - 0.8) < 1e-6)
  assert.equal(before.bedtimePassed, false)
  assert.equal(caffeine.formatLead(before), "48m before bed")

  // And outside D42's four-hour window, where the hero is projecting to
  // tonight again, the line is still about the bedtime the dose preceded —
  // which is why the wording cannot say "tonight's".
  const morning = localTs(2025, 8, 2, 5, 0)
  const old = caffeine.strongDoseLead(doses, morning, 5, "23:00")
  assert.ok(Math.abs(old.hoursBeforeBed - 0.8) < 1e-6)
  assert.equal(old.bedtimePassed, true)
  assert.equal(caffeine.formatLead(old), "48m before bedtime, which has passed")
})

test("the bedtime clock runs both ways", () => {
  const at2330 = localTs(2025, 8, 1, 23, 30)
  assert.equal(caffeine.previousBedtimeSeconds(at2330, "23:00"), localTs(2025, 8, 1, 23, 0))
  assert.equal(caffeine.bedtimeSeconds(at2330, "23:00"), localTs(2025, 8, 2, 23, 0))

  const at0800 = localTs(2025, 8, 2, 8, 0)
  assert.equal(caffeine.previousBedtimeSeconds(at0800, "23:00"), localTs(2025, 8, 1, 23, 0))

  // On the clock exactly, the bedtime that has just arrived is the previous
  // one and the next is tomorrow's — the same convention bedtimeSeconds uses.
  const at2300 = localTs(2025, 8, 1, 23, 0)
  assert.equal(caffeine.previousBedtimeSeconds(at2300, "23:00"), at2300)
  assert.equal(caffeine.bedtimeSeconds(at2300, "23:00"), localTs(2025, 8, 2, 23, 0))
})

test("the key hint states the nudge step and drops what does not apply", () => {
  const full = caffeine.formatKeyHint(true, 5)
  assert.ok(full.includes("1–5 log"))
  // The step is the constant, not a number someone typed into a string.
  assert.ok(full.includes("shift " + caffeine.NUDGE_MINUTES + "m"))
  // The settings page is reachable from the legend that says it is.
  assert.ok(full.includes("s settings"))

  // Nothing logged: no dose to delete, move or shift.
  const empty = caffeine.formatKeyHint(false, 5)
  assert.ok(empty.includes("1–5 log"))
  assert.ok(empty.includes("s settings"))
  for (const gone of ["delete", "shift", "arrows"]) assert.ok(!empty.includes(gone))

  // The line has to fit, so it holds six items and no more: "m more" left
  // when "s settings" arrived, because the "+ More" button states its own key
  // and the settings page has nothing but this line to state its.
  assert.ok(!full.includes("m more"))
  assert.ok(full.split("·").length <= 7)
})

test("the log range counts the catalog, not the main row", () => {
  // The bug: the line said "1–5" whatever the catalog held, and five is the
  // main row's size. D32 hangs the digits on catalog positions so a drink's
  // key does not come and go with the overflow, so `6`-`0` log the next five
  // drinks with the row collapsed — keys the legend denied existed.
  assert.ok(caffeine.formatKeyHint(true, presets.digitCount(presets.DEFAULTS))
    .startsWith("0–9 log"))

  // Ten is the ceiling because it is what a keyboard has, and past it the
  // range stops growing while the catalog keeps going (29 is the cap).
  assert.ok(caffeine.formatKeyHint(false, 10).startsWith("0–9 log"))
  assert.ok(caffeine.formatKeyHint(false, 29).startsWith("0–9 log"))

  // Under the ceiling it is the catalog's own length, so a user who deleted
  // down to three drinks is not offered a `4`.
  assert.ok(caffeine.formatKeyHint(false, 3).startsWith("1–3 log"))
  assert.ok(caffeine.formatKeyHint(false, 9).startsWith("1–9 log"))
  // One drink is not a range.
  assert.ok(caffeine.formatKeyHint(false, 1).startsWith("1 log"))

  // And nothing to press is nothing to say. Presets never hands out an empty
  // catalog, so this is the defensive branch rather than a reachable state —
  // what it must not do is print "1–0 log" or a bare "log".
  const none = caffeine.formatKeyHint(false, 0)
  assert.ok(!none.includes("log"))
  assert.ok(none.startsWith("n note"))
})

test("the catalog's digit count is the one the pills paint from", () => {
  // digitCount and digitFor must agree about where the digits stop: the last
  // counted position has a key printed on it and the next one does not.
  const catalog = presets.DEFAULTS
  const count = presets.digitCount(catalog)
  assert.equal(count, 10)
  assert.ok(catalog.length > count)
  assert.equal(presets.digitFor(count - 1), "0")
  assert.equal(presets.digitFor(count), "")

  // A short catalog counts itself, and a mangled one counts what survives
  // sanitising rather than what was handed in — which for an empty or absent
  // list is the shipped seventeen, the same fallback the panel reads. That is
  // why the legend's own zero branch is unreachable from here.
  assert.equal(presets.digitCount(catalog.slice(0, 3)), 3)
  assert.equal(presets.digitCount([]), count)
  assert.equal(presets.digitCount(null), count)
})

test("no legend ends on the ? any more, because the corner holds it", () => {
  // **D94.** The "?" pointer was the last item of four of these lines, put
  // there by D40 so a line that elides advertises its own overflow — and D67's
  // rule then cost this legend four donors to keep it there. It is a fixed
  // corner beside the bean now, on every page and in both states, so no line
  // carries it and no line can lose it.
  for (const line of [caffeine.formatKeyHint(true, 5), caffeine.formatKeyHint(false, 5),
                      caffeine.formatCatalogHint("mg"), caffeine.formatNotesHint(true),
                      caffeine.formatNotesHint(false), caffeine.formatSettingsHint(),
                      caffeine.formatProfileHint()]) {
    assert.ok(!line.includes("?"), `"${line}" still carries the pointer`)
  }
  // And the corner's own word does not change with what is behind the key,
  // which is D51's rule deleted rather than kept: a fixed slot with a wobbling
  // word in it is worse than either wording.
  assert.equal(caffeine.formatHelpHint(), "? help")
  // The quiet setting's description promises this string by name, so the two
  // cannot drift.
  assert.ok(caffeine.formatHelpHint().includes("help"))
})

test("the note key takes a slot rather than adding one", () => {
  // The line is at its ceiling: seven items, and the eighth elides the last —
  // which is "? keys", the item D40 put there so the line advertises its own
  // overflow. This is the third swap ("m more" at Phase 8, "arrows move" at
  // Phase 11), and the property all three preserve is this one.
  const full = caffeine.formatKeyHint(true, 5)
  assert.ok(full.includes("n note"))
  // Six since D94 took the "?" pointer into the corner — the first time this
  // line has ever got *shorter*. The slot it hands back stays empty: all four
  // items evicted by D67's rule will look like candidates to restore, and the
  // line was last balanced against a corner that did not exist.
  assert.equal(full.split("  ·  ").length, 6)
  assert.ok(full.endsWith("s settings"))
  // The donor left, and it is the one with a control on screen doing its job:
  // every dose row paints a ✕ at its trailing edge.
  assert.ok(!full.includes("x delete"))

  // Nothing logged is still under the ceiling, and the note key stays: a day
  // with no drinks on it is a day you can still write "no coffee today" on.
  const empty = caffeine.formatKeyHint(false, 5)
  assert.ok(empty.includes("n note"))
  assert.ok(empty.endsWith("s settings"))
  assert.ok(empty.split("  ·  ").length < 6)
})

// ---------------------------------------------------------------- rounding

test("display values round to the nearest 5 above 50mg", () => {
  assert.equal(caffeine.roundDisplay(0), 0)
  assert.equal(caffeine.roundDisplay(12.4), 12)
  assert.equal(caffeine.roundDisplay(49.6), 50)
  assert.equal(caffeine.roundDisplay(52), 50)
  assert.equal(caffeine.roundDisplay(53), 55)
  assert.equal(caffeine.roundDisplay(118), 120)
  assert.equal(caffeine.roundDisplay(-5), 0)
  assert.equal(caffeine.roundDisplay(NaN), 0)

  assert.equal(caffeine.formatMg(118), "120 mg")
  assert.equal(caffeine.formatMgApprox(118), "~120 mg")
  assert.equal(caffeine.formatMgApprox(12), "12 mg")
})

test("durations format for both elapsed and remaining spans", () => {
  assert.equal(caffeine.formatDuration(0), "now")
  assert.equal(caffeine.formatDuration(0.75), "45m")
  assert.equal(caffeine.formatDuration(4), "4h")
  assert.equal(caffeine.formatDuration(4.333), "4h 20m")
  assert.equal(caffeine.formatDuration(-4.333), "4h 20m")
  assert.equal(caffeine.formatDuration(NaN), "now")
})

// ---------------------------------------------------------------- store help

test("sanitising drops malformed entries and orders newest first", () => {
  const list = caffeine.sanitizeDoses([
    at(5, 95, "old"),
    at(1, 125, "new"),
    { ts: "nope", mg: 95 },
    { ts: NOW, mg: 0 },
    { ts: NOW, mg: -10 },
    { ts: NOW },
    null,
    "not an object",
    { ts: NOW, mg: Infinity }
  ])
  assert.equal(list.length, 2)
  assert.equal(list[0].label, "new")
  assert.equal(list[1].label, "old")
  assert.equal(caffeine.sanitizeDoses(null).length, 0)
  assert.equal(caffeine.sanitizeDoses("[]").length, 0)
})

test("pruning keeps 30 days and hands the rest back to be archived", () => {
  const doses = [at(1, 95), at(29 * 24, 95), at(31 * 24, 125)]
  const split = caffeine.prune(doses, NOW, 30)
  assert.equal(split.kept.length, 2)
  assert.ok(split.kept.every(dose => dose.ts >= NOW - 30 * 86400))

  // D44. What falls off the window is returned rather than dropped: the Store
  // appends it to archive.json, so a month-old coffee stops being drawn
  // without ceasing to have happened. Nothing is lost between the two halves.
  assert.equal(split.expired.length, 1)
  assert.equal(split.expired[0].mg, 125)
  assert.ok(split.expired.every(dose => dose.ts < NOW - 30 * 86400))
  assert.equal(split.kept.length + split.expired.length, doses.length)

  // Newest first in both, so the archive reads the way doses.json does.
  const older = [at(31 * 24, 1), at(40 * 24, 2), at(35 * 24, 3)]
  const all = caffeine.prune(older, NOW, 30)
  assert.equal(all.kept.length, 0)
  assert.deepEqual(Array.from(all.expired, (dose) => dose.mg), [1, 3, 2])

  // Nothing expired is an empty list, not a missing one — the Store branches
  // on its length.
  assert.equal(caffeine.prune([at(1, 95)], NOW, 30).expired.length, 0)
})

// ------------------------------------------------------------------- undo

test("undo hands deletions back in the order they were deleted", () => {
  // The bug that asked for D113: three doses taken by one held key. They are
  // deleted oldest-first here on purpose — the order you delete in has nothing
  // to do with the order they were drunk in, and the stack has to follow the
  // deleting.
  const morning = at(6, 95, "morning")
  const noon = at(3, 120, "noon")
  const late = at(1, 60, "late")

  let stack = caffeine.pushUndo([], morning)
  stack = caffeine.pushUndo(stack, noon)
  stack = caffeine.pushUndo(stack, late)
  assert.deepEqual(Array.from(stack, (dose) => dose.label), ["late", "noon", "morning"])

  const first = caffeine.popUndo(stack)
  assert.equal(first.dose.label, "late")
  const second = caffeine.popUndo(first.rest)
  assert.equal(second.dose.label, "noon")
  const third = caffeine.popUndo(second.rest)
  assert.equal(third.dose.label, "morning")

  // And then it is empty, rather than repeating the last one forever.
  const empty = caffeine.popUndo(third.rest)
  assert.equal(empty.dose, null)
  assert.deepEqual(Array.from(empty.rest), [])
  assert.equal(caffeine.popUndo([]).dose, null)
  assert.equal(caffeine.popUndo(null).dose, null)
})

test("the undo stack has a floor and a ceiling", () => {
  let stack = []
  for (let i = 0; i < caffeine.UNDO_DEPTH + 10; i++) stack = caffeine.pushUndo(stack, at(i, 95, `d${i}`))
  assert.equal(stack.length, caffeine.UNDO_DEPTH)
  // The oldest deletions fall off, not the newest: what you just did is what
  // you are most likely to be taking back.
  assert.equal(stack[0].label, `d${caffeine.UNDO_DEPTH + 9}`)
  assert.equal(stack[stack.length - 1].label, `d${10}`)

  assert.equal(caffeine.pushUndo([], at(1, 95), 2).length, 1)
  assert.equal(caffeine.pushUndo([at(1, 95), at(2, 95)], at(3, 95), 2).length, 2)
  assert.deepEqual(Array.from(caffeine.pushUndo([at(1, 95)], at(2, 95), 0)), [])

  // Nothing worth putting back is not an entry on the stack. A `u` that
  // restored an unparseable line would put a dose on the curve that the log
  // itself would refuse to load.
  assert.deepEqual(Array.from(caffeine.pushUndo([], null)), [])
  assert.deepEqual(Array.from(caffeine.pushUndo([], { ts: NOW, mg: 0 })), [])
  assert.equal(caffeine.pushUndo([at(1, 95)], "not a dose").length, 1)

  // Junk already on the stack is stepped over rather than popped as a null
  // undo, so one bad entry cannot make the key look broken.
  const step = caffeine.popUndo([null, { ts: NOW, mg: "x" }, at(4, 110, "good")])
  assert.equal(step.dose.label, "good")
  assert.deepEqual(Array.from(step.rest), [])
})

test("a dose put back lands at its own time, not at the top of the log", () => {
  // The panel deletes the middle dose and then undoes it. What comes back has
  // to sort into the same slot it left — a restored dose that arrived at the
  // head of the list would read as a coffee you just had, and would move the
  // curve to match.
  const log = caffeine.sanitizeDoses([at(1, 60, "late"), at(3, 120, "noon"), at(6, 95, "morning")])
  const gone = log[1]
  const without = log.filter((dose) => dose !== gone)
  const stack = caffeine.pushUndo([], gone)

  const step = caffeine.popUndo(stack)
  const restored = caffeine.prune([step.dose].concat(without), NOW, 30).kept
  assert.deepEqual(Array.from(restored, (dose) => dose.label), ["late", "noon", "morning"])
  assert.deepEqual(plain(restored[1]), plain(gone))

  // Byte for byte the log it started as: undo is not a re-log with a
  // reconstructed timestamp, which is what the user was reduced to doing.
  assert.equal(JSON.stringify(restored), JSON.stringify(log))
})

// ---------------------------------------------------------------- degenerate

test("degenerate inputs stay finite", () => {
  const cases = [
    [],
    null,
    undefined,
    [at(-3, 95)],                              // taken three hours from now
    [{ ts: NOW + 86400, mg: 500 }],            // taken tomorrow
    [{ ts: NOW, mg: 1e9 }],
    [{ ts: 0, mg: 95 }],
    [at(1, 95), null, { ts: NOW, mg: "x" }]
  ]
  const halfLives = [2, 5, 12, 0, -1, 1e9, NaN, undefined, "5"]

  for (const doses of cases) {
    for (const halfLife of halfLives) {
      for (const fn of ["levelAt", "cupFill"]) {
        const value = caffeine[fn](doses, NOW, halfLife)
        assert.ok(isFinite(value), `${fn} returned ${value}`)
        assert.ok(value >= 0, `${fn} returned ${value}`)
      }
      assert.ok(isFinite(caffeine.peakFraction(halfLife)))
      assert.ok(caffeine.peakFraction(halfLife) > 0)
      assert.ok(isFinite(caffeine.timeToPeak(halfLife)))
      assert.ok(isFinite(caffeine.fillScale(doses, NOW, halfLife)))
      assert.ok(caffeine.fillScale(doses, NOW, halfLife) > 0)

      const projection = caffeine.bedtimeProjection(doses, NOW, halfLife, "23:00")
      assert.ok(isFinite(projection.mg) && projection.mg >= 0)
      assert.ok(isFinite(projection.at))

      for (const sample of caffeine.levelOverRange(doses, NOW - 12 * HOUR, NOW + 12 * HOUR, halfLife, 20)) {
        assert.ok(isFinite(sample.mg) && sample.mg >= 0, `sample was ${sample.mg}`)
      }
    }
  }
})

test("a future dose contributes nothing until it is taken", () => {
  const doses = [{ ts: NOW + HOUR, mg: 200 }]
  assert.equal(caffeine.levelAt(doses, NOW, 5), 0)
  assert.ok(caffeine.levelAt(doses, NOW + 2 * HOUR, 5) > 0)
})

test("half-life is clamped to the settings range", () => {
  assert.equal(caffeine.sanitizeHalfLife(0), caffeine.HALF_LIFE_MIN_HOURS)
  assert.equal(caffeine.sanitizeHalfLife(100), caffeine.HALF_LIFE_MAX_HOURS)
  assert.equal(caffeine.sanitizeHalfLife(NaN), caffeine.HALF_LIFE_DEFAULT_HOURS)
  assert.equal(caffeine.sanitizeHalfLife(7), 7)
  // The range itself, which Phase 10 widened at the top so that the profile's
  // largest sourced figure - late pregnancy, "15h+" - is derived rather than
  // silently clamped away.
  assert.equal(caffeine.HALF_LIFE_MIN_HOURS, 2)
  assert.equal(caffeine.HALF_LIFE_MAX_HOURS, 16)
  // Clamping means the extremes behave like the extremes, not like garbage.
  assert.equal(caffeine.levelAt([at(5, 100)], NOW, 0),
    caffeine.levelAt([at(5, 100)], NOW, caffeine.HALF_LIFE_MIN_HOURS))
  assert.equal(caffeine.levelAt([at(5, 100)], NOW, 99),
    caffeine.levelAt([at(5, 100)], NOW, caffeine.HALF_LIFE_MAX_HOURS))
})

test("the ka == ke degenerate case has a finite limit", () => {
  // Unreachable through settings, but the guard is what stops a rogue value
  // putting Infinity into a binding inside the shell process.
  const value = caffeine.contribution(100, 1, 4.5)
  assert.ok(isFinite(value) && value > 0, `got ${value}`)
  const near = caffeine.contribution(100, 1, 4.5 - 1e-12)
  assert.ok(Math.abs(near - value) < 1e-3, `limit discontinuous: ${near} vs ${value}`)
})

// ---------------------------------------------------------------- presets

test("the preset table matches the sourced values, except where the author re-priced it", () => {
  assert.equal(presets.DEFAULTS.length, 17)
  assert.equal(presets.mgFor("espresso-double"), 125)
  assert.equal(presets.mgFor("coffee"), 95)
  assert.equal(presets.mgFor("cold-brew"), 200)
  assert.equal(presets.mgFor("iced-coffee"), 100)

  // **D102's two re-priced rows, pinned as the pair of figures they are.**
  // Fifteen of the seventeen are still the sourced value; these two are the
  // author's, and the assertion says so rather than just asserting the new
  // number — a test that only knew 80 would let someone "restore" 75 as a
  // correction to a typo.
  assert.equal(presets.mgFor("latte"), 80)          // sourced 75 (D86)
  assert.equal(presets.mgFor("americano"), 100)     // sourced 125 (D96)
  // And the americano's *detail* moved with its figure rather than against it:
  // at "Double" the shipped 100 sat between one measured shot and two, which
  // is the thing the author was asked about. It is a single.
  assert.equal(presets.byId("americano").detail, "Single")

  // And the two pinnings D96 made are therefore broken on purpose. The
  // cappuccino was set to the latte's figure because it is a latte's shot in
  // less milk; the americano to the espresso double's because that is what it
  // is. Both were true of the sourced table and neither survives an author's
  // list, so they are asserted apart instead of together.
  assert.equal(presets.mgFor("cappuccino"), 75)
  assert.notEqual(presets.mgFor("cappuccino"), presets.mgFor("latte"))
  assert.notEqual(presets.mgFor("americano"), presets.mgFor("espresso-double"))
  assert.equal(presets.mgFor("instant-coffee"), 57)
  assert.equal(presets.mgFor("mocha"), 80)
  assert.equal(presets.mgFor("decaf"), 2)
  assert.equal(presets.mgFor("nope"), 0)
  assert.equal(presets.labelFor("espresso-double"), "Espresso (Double)")
  assert.equal(presets.labelFor("green-tea"), "")

  const ids = new Set()
  for (const preset of presets.DEFAULTS) {
    assert.ok(preset.id && !ids.has(preset.id), `duplicate id ${preset.id}`)
    ids.add(preset.id)
    assert.ok(preset.mg > 0 && isFinite(preset.mg))
    assert.ok(preset.label.length > 0)
  }
})

test("the main row is the catalog's first five, and the overflow is the rest", () => {
  const size = presets.MAIN_ROW_SIZE
  assert.equal(size, 5)

  // D31: which drinks are on the row is not a separate selection any more, it
  // is where they sit. So the row follows a reordered catalog by construction.
  const reordered = presets.moveDrink(presets.DEFAULTS, 10, -1)
  assert.equal(idsOf(presets.mainRow(reordered)).length, size)
  assert.deepEqual(idsOf(presets.mainRow(reordered)),
    idsOf(reordered).slice(0, size))
  assert.deepEqual(idsOf(presets.overflow(reordered)), idsOf(reordered).slice(size))

  // A catalog shorter than the row is a short row, not a padded one: there is
  // no other drink to have meant.
  const three = presets.sanitizeCatalog([
    { label: "One", mg: 10 }, { label: "Two", mg: 20 }, { label: "Three", mg: 30 }])
  assert.equal(presets.mainRow(three).length, 3)
  assert.equal(presets.overflow(three).length, 0)

  // And junk falls back to the shipped table rather than to an empty row.
  assert.equal(presets.mainRow("nope").length, size)
})

test("the default main row is the author's own first five", () => {
  // D6 chose by spread, D86 amended it to frequency — and D102 replaced both
  // with a person. This is the author's catalog order, so the assertion is a
  // record of a preference rather than of a rule, and there is nothing to
  // derive it from if it is ever broken. Change it only with the author.
  assert.deepEqual(Array.from(presets.MAIN_ROW_IDS),
    ["espresso-double", "americano", "latte", "mocha", "tea-green"])

  // The panel calls these with no argument, so the default has to be the
  // decision rather than whatever order the table happens to be in.
  assert.deepEqual(idsOf(presets.mainRow()), Array.from(presets.MAIN_ROW_IDS))

  // D31 makes the catalog order the user's data and the main row its first
  // five, so the shipped table has to already be in that order — otherwise
  // Phase 9's "restore defaults" would quietly change which drinks are on the
  // row.
  assert.deepEqual(idsOf(presets.DEFAULTS).slice(0, presets.MAIN_ROW_SIZE),
    Array.from(presets.MAIN_ROW_IDS))

  const rest = idsOf(presets.overflow())
  assert.equal(rest.length, presets.DEFAULTS.length - presets.MAIN_ROW_SIZE)
  for (const id of presets.MAIN_ROW_IDS) assert.ok(!rest.includes(id))
  // And the overflow keeps the catalog's own order, since the digits count
  // straight on through it.
  assert.deepEqual(rest, idsOf(presets.DEFAULTS).slice(presets.MAIN_ROW_SIZE))

  // What the row gave up, stated as assertions so nobody reverses it believing
  // nothing was traded. D86 took the span from 47-200 to 47-125 by moving cold
  // brew down; D102 takes it to 29-125 and puts two cups of nearly the same
  // size (latte and mocha, both 80) side by side. D6 would have refused that
  // row and D86 would have queried the pair — both were reasoning about a
  // generic user, and this row is one person's.
  const mg = Array.from(presets.mainRow(), (preset) => preset.mg)
  assert.equal(Math.min(...mg), 29)
  assert.equal(Math.max(...mg), 125)
  assert.equal(presets.mgFor("latte"), presets.mgFor("mocha"))
  // Cold brew and large coffee are still in the overflow rather than gone, and
  // since D102 plain Coffee is down there with them — off the row, but ninth,
  // so it keeps a digit.
  for (const id of ["cold-brew", "large-coffee", "coffee"]) assert.ok(rest.includes(id), id)

  // Every shipped drink carries an icon now, and every one of them is a glyph
  // the picker offers — sanitizeIcon would silently degrade anything else to
  // none, which is a table shipping a tofu box nobody could explain.
  for (const preset of presets.DEFAULTS) {
    assert.notEqual(preset.icon, presets.ICON_NONE, preset.label)
    assert.equal(presets.sanitizeIcon(preset.icon), preset.icon, preset.label)
  }

  // No shipped drink is branded, and neither is the example that teaches the
  // add row's syntax (D86).
  const brands = /costa|starbucks|nero|nescafe|dunkin|mccafe|monster/i
  for (const preset of presets.DEFAULTS) assert.doesNotMatch(preset.label, brands)
})

test("the digits address catalog positions, and run out at ten", () => {
  assert.equal(presets.DIGIT_SLOTS, 10)

  // 1-9 then 0, and nothing at all past the tenth.
  assert.deepEqual(Array.from({ length: 12 }, (_, i) => presets.digitFor(i)),
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "", ""])
  assert.equal(presets.digitFor(-1), "")
  assert.equal(presets.digitFor("nope"), "")

  // The key printed on a pill logs that pill.
  for (let i = 0; i < presets.DIGIT_SLOTS; i++) {
    assert.equal(presets.indexForDigit(presets.digitFor(i)), i)
  }
  for (const other of ["", "x", "-", "12", " ", "+"]) {
    assert.equal(presets.indexForDigit(other), -1)
  }

  // Since D96 the table is seventeen and seven drinks are past the tenth slot,
  // so which seven is the decision rather than an accident of the table's
  // length: the seven least often reached for, decaf last — it stayed last
  // when D96 put four above it.
  // D102 reorders which seven those are. The author's first pass put plain
  // Coffee among them, which would have shipped the drink this plugin is named
  // after with no key at all; asked about it, they traded it with Iced coffee.
  // So the digit is on the commoner drink and the rarer one does without —
  // which is the whole of what ten slots and seventeen drinks are for.
  assert.deepEqual(idsOf(presets.DEFAULTS).slice(presets.DIGIT_SLOTS),
    ["matcha", "energy-drink", "cola", "cold-brew", "iced-coffee", "instant-coffee", "decaf"])
  assert.equal(presets.digitFor(idsOf(presets.DEFAULTS).indexOf("coffee")), "9")
  for (let i = presets.DIGIT_SLOTS; i < presets.DEFAULTS.length; i++)
    assert.equal(presets.digitFor(i), "")
})

// ----------------------------------------------------------- the catalog
//
// D31. The shipped eleven are a default now, and the table is data the user
// owns: added to, re-priced, reordered, cut down. All of it is read back out
// of a JSON file a hand edit can reach and parsed inside the shell process, so
// the interesting cases here are the wrong ones.

test("the shipped table is the default catalog, and an absent one means it", () => {
  assert.equal(presets.DEFAULTS.length, 17)
  assert.equal(presets.CATALOG_MAX, 29)
  // D97, and this is the whole of why the cap moved: a shipped catalog that
  // is already at the cap makes the Add row dead on a fresh install.
  assert.ok(presets.canAdd(presets.DEFAULTS),
    "a fresh install cannot add a drink")

  // Absent, empty, the wrong type, or an array with no readable drink in it:
  // every one of them is the shipped table rather than an empty log row.
  for (const nothing of [undefined, null, {}, "drinks", 7, [], [null, 3, "x"],
                         [{ label: "", mg: 5 }], [{ label: "No dose" }]]) {
    assert.deepEqual(idsOf(presets.sanitizeCatalog(nothing)), idsOf(presets.DEFAULTS),
      `${JSON.stringify(nothing)} did not degrade to the shipped table`)
  }
  assert.deepEqual(idsOf(presets.catalogOf({})), idsOf(presets.DEFAULTS))
  assert.deepEqual(idsOf(presets.catalogOf({ drinks: "nope" })), idsOf(presets.DEFAULTS))
  assert.ok(presets.isDefaultCatalog(presets.catalogOf({})))

  // A stored catalog is returned as itself, not merged with the defaults.
  const mine = presets.catalogOf({ drinks: [{ label: "Only", mg: 60 }] })
  assert.equal(mine.length, 1)
  assert.equal(mine[0].label, "Only")
  assert.ok(!presets.isDefaultCatalog(mine))
})

test("a stored catalog is sanitised entry by entry, not believed", () => {
  const catalog = presets.sanitizeCatalog([
    { id: "ok", label: "Fine", detail: "240 ml", mg: 95 },
    // Out of range clamps: a typo with an obvious intention.
    { label: "Huge", mg: 9000 },
    { label: "Tiny", mg: 0 },
    { label: "Fractional", mg: 12.6 },
    // A string dose is what a hand edit and a shell that quotes both produce.
    { label: "Quoted", mg: "80" },
    // Unreadable drops: a drink whose dose cannot be read is not a drink.
    { label: "Wordy", mg: "nope" },
    { label: "", mg: 50 },
    // Unknown fields are dropped rather than carried into the panel.
    { label: "Extra", mg: 40, colour: "red", nested: { a: 1 } },
    // Two entries can slug to one id; both survive, distinctly.
    { label: "Fine", mg: 30 }
  ])

  assert.deepEqual(Array.from(catalog, (drink) => drink.label),
    ["Fine", "Huge", "Tiny", "Fractional", "Quoted", "Extra", "Fine"])
  assert.equal(presets.mgFor("huge", catalog), presets.MG_MAX)
  assert.equal(presets.mgFor("tiny", catalog), presets.MG_MIN)
  assert.equal(presets.mgFor("fractional", catalog), 13)
  assert.equal(presets.mgFor("quoted", catalog), 80)
  assert.deepEqual(Object.keys(plain(catalog[0])).sort(), ["detail", "icon", "id", "label", "mg"])

  // Distinct ids, always: an entry that shadowed another would make one of
  // them unreachable by every function that takes an id.
  const ids = idsOf(catalog)
  assert.equal(new Set(ids).size, ids.length)

  // Names are one line, capped, and free of control characters.
  const nasty = presets.sanitizeCatalog([
    { label: "  Spaced   out\nname\t ", mg: 10 },
    { label: "x".repeat(200), mg: 10 }
  ])
  assert.equal(nasty[0].label, "Spaced out name")
  assert.equal(nasty[1].label.length, presets.LABEL_MAX)

  // And the cap is a cap: a file with fifty drinks in it yields fifteen.
  const many = presets.sanitizeCatalog(
    Array.from({ length: 50 }, (_, i) => ({ label: `Drink ${i}`, mg: 50 })))
  assert.equal(many.length, presets.CATALOG_MAX)
  assert.equal(many[0].label, "Drink 0")
})

test("adding stops at the cap, and removing never empties the list", () => {
  let catalog = presets.DEFAULTS
  assert.ok(presets.canAdd(catalog))

  const shipped = presets.DEFAULTS.length
  catalog = presets.addDrink(catalog, { label: "Flat white", mg: 130 })
  assert.equal(catalog.length, shipped + 1)
  assert.equal(catalog[shipped].id, "flat-white")
  assert.equal(catalog[shipped].mg, 130)
  // Appended, so nothing that already had a number key changes one.
  assert.deepEqual(idsOf(catalog).slice(0, shipped), idsOf(presets.DEFAULTS))

  // A drink with no name or no readable dose is not added at all.
  for (const junk of [null, {}, { label: "No dose" }, { label: "", mg: 50 },
                      { mg: 50 }, { label: "Bad", mg: "nope" }]) {
    assert.equal(presets.addDrink(catalog, junk).length, catalog.length)
  }

  while (presets.canAdd(catalog)) catalog = presets.addDrink(catalog, { label: "Filler", mg: 50 })
  assert.equal(catalog.length, presets.CATALOG_MAX)
  assert.equal(presets.canAdd(catalog), false)
  // The thirtieth is refused rather than pushing the first one off.
  const full = presets.addDrink(catalog, { label: "One more", mg: 50 })
  assert.equal(full.length, presets.CATALOG_MAX)
  assert.deepEqual(idsOf(full), idsOf(catalog))

  // Removing works down to one, and then stops: an empty catalog reads back as
  // the shipped table, so emptying the list would look like a restore.
  let cut = presets.DEFAULTS
  assert.equal(presets.removeDrink(cut, "nope").length, cut.length)
  cut = presets.removeDrink(cut, "coffee")
  assert.equal(cut.length, presets.DEFAULTS.length - 1)
  assert.ok(!idsOf(cut).includes("coffee"))
  while (cut.length > 1) cut = presets.removeDrink(cut, cut[0].id)
  assert.equal(cut.length, 1)
  assert.equal(presets.removeDrink(cut, cut[0].id).length, 1)
})

test("reordering moves the drink, its slot on the row, and its number key", () => {
  // D32: the digits address catalog positions, so moving a drink into slot 3
  // makes it key "3". Nothing else has to be told.
  let catalog = presets.addDrink(presets.DEFAULTS, { label: "Flat white", mg: 130 })
  const added = presets.DEFAULTS.length
  assert.equal(presets.digitFor(added), "")         // past the tenth, no key
  assert.ok(!idsOf(presets.mainRow(catalog)).includes("flat-white"))

  for (let at = added; at > 2; at--) catalog = presets.moveDrink(catalog, at, -1)
  assert.equal(idsOf(catalog)[2], "flat-white")
  assert.equal(presets.digitFor(2), "3")
  assert.equal(presets.indexForDigit("3"), 2)
  assert.equal(presets.mainRow(catalog)[2].id, "flat-white")
  // And what it displaced is still there, one slot down.
  assert.equal(idsOf(catalog)[3], "latte")

  // A press is undone by the opposite press.
  assert.deepEqual(idsOf(presets.moveDrink(presets.moveDrink(catalog, 2, 1), 3, -1)),
    idsOf(catalog))

  // Off either end is refused rather than wrapping: the top of the list is the
  // top of the list.
  assert.deepEqual(idsOf(presets.moveDrink(catalog, 0, -1)), idsOf(catalog))
  assert.deepEqual(idsOf(presets.moveDrink(catalog, catalog.length - 1, 1)), idsOf(catalog))
  for (const junk of [-1, 99, "x", null]) {
    assert.deepEqual(idsOf(presets.moveDrink(catalog, junk, 1)), idsOf(catalog))
  }
})

test("editing a drink changes what it will log, and never what it has logged", () => {
  // The point of the snapshot, stated as a test because it is what makes the
  // catalog safe to edit at all. A dose carries {mg, label} taken at log time,
  // so re-pricing the drink tomorrow cannot rewrite today's curve.
  const catalog = presets.DEFAULTS
  const espresso = presets.byId("espresso-double", catalog)
  const dose = { ts: NOW - 2 * HOUR, mg: espresso.mg, label: presets.labelOf(espresso) }

  const before = caffeine.levelAt([dose], NOW, 5)
  const projectionBefore = plain(caffeine.bedtimeProjection([dose], NOW, 5, "23:00"))

  const edited = presets.updateDrink(catalog, "espresso-double", { mg: 400 })
  assert.equal(presets.mgFor("espresso-double", edited), 400)
  assert.equal(presets.mgFor("espresso-double", catalog), 125)   // and not in place

  assert.equal(dose.mg, 125)
  assert.equal(dose.label, "Espresso (Double)")
  assert.equal(caffeine.levelAt([dose], NOW, 5), before)
  assert.deepEqual(plain(caffeine.bedtimeProjection([dose], NOW, 5, "23:00")), projectionBefore)

  // Removing the drink outright does not reach the dose either: the label is a
  // string that was copied, not a lookup that can fail.
  const gone = presets.removeDrink(catalog, "espresso-double")
  assert.equal(presets.byId("espresso-double", gone), null)
  assert.equal(caffeine.levelAt([dose], NOW, 5), before)
  assert.equal(dose.label, "Espresso (Double)")

  // An edit keeps the id and touches only what it was given.
  // Found by id rather than by index: since D102 the table's order is the
  // author's preference, so an index here would be a test that breaks every
  // time somebody drags a row.
  const renamed = presets.byId("coffee", presets.updateDrink(catalog, "coffee",
    { label: "Filter coffee" }))
  assert.equal(renamed.id, "coffee")
  assert.equal(renamed.label, "Filter coffee")
  assert.equal(renamed.mg, 95)
  assert.equal(renamed.detail, "240 ml")

  // A refused edit returns the catalog unchanged rather than a broken drink.
  for (const junk of [{ mg: "nope" }, { label: "" }, { label: "   " }]) {
    assert.deepEqual(idsOf(presets.updateDrink(catalog, "coffee", junk)), idsOf(catalog))
    assert.equal(presets.mgFor("coffee", presets.updateDrink(catalog, "coffee", junk)), 95)
  }
  assert.deepEqual(idsOf(presets.updateDrink(catalog, "nope", { mg: 5 })), idsOf(catalog))
})

test("the add row reads a name and an amount off one line", () => {
  // One field rather than three, because the panel's editing idiom is one pill
  // you type into and three tab stops on a keyboard-driven page is a form.
  const parse = (text, cups = false) => {
    const got = presets.parseDrinkEntry(text, caffeine.CUP_MG_DEFAULT, cups)
    return got === null ? null : plain(got)
  }

  assert.deepEqual(parse("Costa cappuccino 200"),
    { label: "Costa cappuccino", detail: "", mg: 200 })
  assert.deepEqual(parse("Costa cappuccino 200mg"),
    { label: "Costa cappuccino", detail: "", mg: 200 })
  assert.deepEqual(parse("Costa cappuccino   200 MG  "),
    { label: "Costa cappuccino", detail: "", mg: 200 })
  assert.deepEqual(parse("Flat white (small) 130 mg"),
    { label: "Flat white", detail: "small", mg: 130 })

  // D46: a bare number means the unit the panel is showing, and an explicit
  // unit wins over both, so the same line typed on a cups panel is not a
  // different drink by accident.
  assert.deepEqual(parse("Cortado 1", true), { label: "Cortado", detail: "", mg: 100 })
  assert.deepEqual(parse("Cortado 1.4 cups"), { label: "Cortado", detail: "", mg: 140 })
  // And against a cup the user has moved, since D84 the figure is theirs.
  assert.deepEqual(plain(presets.parseDrinkEntry("Cortado 2 cups", 60, false)),
    { label: "Cortado", detail: "", mg: 120 })
  assert.deepEqual(parse("Cortado 130mg", true), { label: "Cortado", detail: "", mg: 130 })

  // Out of range clamps, exactly as a stored value does.
  assert.equal(parse("Silly 9000").mg, presets.MG_MAX)
  assert.equal(parse("Homeopathic 0").mg, presets.MG_MIN)

  // No name, no number, or nothing at all: refused, so the field can stay open
  // and say so rather than storing a drink nobody described.
  for (const junk of ["", "   ", "200", "200mg", "Just a name", "(detail) 90",
                      "Coffee -5", "Coffee5"]) {
    assert.equal(presets.parseDrinkEntry(junk, caffeine.CUP_MG_DEFAULT, false), null, junk)
  }

  // A number inside the name is a name, not a second dose: the amount is the
  // last word, and that is what makes a one-field form readable at all.
  assert.deepEqual(parse("Monster 500ml 160mg"),
    { label: "Monster 500ml", detail: "", mg: 160 })
})

test("stepping an amount moves what is on screen, in either unit", () => {
  // D46 as a guarantee rather than a comment. 5mg is right in milligrams and
  // invisible in cups, where one decimal of a 100mg cup is 10mg -- which is
  // the bug Phase 8 found in the sleep threshold, arriving here as a control
  // over a number that DOES convert.
  const step = (mg, dir, units) =>
    caffeine.stepAmount(mg, dir, units, presets.MG_MIN, presets.MG_MAX)

  assert.equal(step(125, 1, "mg"), 130)
  assert.equal(step(125, -1, "mg"), 120)
  // Snapped to the grid first, so an odd stored value joins it.
  assert.equal(step(47, 1, "mg"), 50)
  assert.equal(step(47, -1, "mg"), 40)

  for (const units of ["mg", "cups"]) {
    let mg = 2
    for (let press = 0; press < 200; press++) {
      const next = step(mg, 1, units)
      if (mg >= presets.MG_MAX) break
      assert.notEqual(caffeine.formatLogged(next, units), caffeine.formatLogged(mg, units),
        `${units}: ${mg} -> ${next} did not move the display`)
      mg = next
    }
    assert.equal(mg, presets.MG_MAX)
    for (let press = 0; press < 200; press++) {
      const next = step(mg, -1, units)
      if (mg <= presets.MG_MIN) break
      assert.notEqual(caffeine.formatLogged(next, units), caffeine.formatLogged(mg, units),
        `${units}: ${mg} -> ${next} did not move the display`)
      mg = next
    }
    assert.equal(mg, presets.MG_MIN)
  }

  // The sub-0.1 floor still holds for a user-added tiny drink, on the pill and
  // in the catalog row alike -- Phase 6's Decaf lesson, now that any drink can
  // be any dose.
  assert.equal(caffeine.formatLogged(1, "cups"), "<0.1 cups")
  assert.equal(caffeine.formatLogged(2, "cups"), "<0.1 cups")
  assert.equal(caffeine.formatLogged(4, "cups"), "<0.1 cups")
  assert.equal(caffeine.formatLogged(5, "cups"), "0.1 cups")
  // And the first press off the floor reaches a tenth rather than another
  // string that reads the same.
  assert.equal(caffeine.formatLogged(step(2, 1, "cups"), "cups"), "0.1 cups")
})

test("an amount seeds its editor typeably, and comes back the same", () => {
  // The editor edits the unit on screen (D46), so the seed has to be the value
  // you were shown -- and "<0.1" is the right thing to read and the wrong
  // thing to hand a text field.
  for (const units of ["mg", "cups"]) {
    for (const mg of [1, 2, 5, 29, 47, 95, 125, 200, 500]) {
      const seed = caffeine.amountSeed(mg, units)
      assert.ok(/^[0-9]+(\.[0-9]+)?$/.test(seed), `${units}: ${mg} seeded "${seed}"`)
      const back = Math.round(caffeine.parseAmountText(seed, units))
      assert.ok(Math.abs(back - mg) <= (units === "cups" ? 5 : 0),
        `${units}: ${mg} seeded "${seed}" and came back ${back}`)
      assert.equal(caffeine.formatLogged(back, units), caffeine.formatLogged(mg, units))
    }
  }

  assert.equal(caffeine.amountSeed(125, "mg"), "125")
  assert.equal(caffeine.amountSeed(125, "cups"), "1.3")
  assert.equal(caffeine.amountSeed(2, "cups"), "0.02")
  // At a 60 mg cup the same dose is a different number of cups, and the seed
  // follows the setting rather than a constant.
  assert.equal(caffeine.amountSeed(125, "cups", 60), "2.1")

  // An explicit unit wins over the setting, in the editor as in the add row.
  assert.equal(caffeine.parseAmountText("200mg", "cups"), 200)
  assert.equal(caffeine.parseAmountText("1 cup", "mg"), caffeine.CUP_MG_DEFAULT)
  assert.equal(caffeine.parseAmountText("2", "cups"), caffeine.CUP_MG_DEFAULT * 2)
  assert.equal(caffeine.parseAmountText("2", "mg"), 2)
  for (const junk of ["", "  ", "nope", "12 34", "-5", "1/2", "5 grams"]) {
    assert.equal(caffeine.parseAmountText(junk, "mg"), null, junk)
  }
})

test("D53's icons are a closed list, and the bash and the engine hold the same one", () => {
  // Twelve, four wide, with "no icon" first: the shipped state of every drink
  // and the way back out of a choice.
  assert.equal(presets.ICONS.length, 12)
  assert.equal(presets.ICON_COLUMNS, 4)
  assert.equal(presets.ICONS[0].icon, presets.ICON_NONE)
  assert.equal(presets.ICON_NONE, "")
  // Every cell is named, because a wall of glyphs nobody can type is a rebus.
  for (const choice of presets.ICONS) {
    assert.ok(choice.name.length > 0)
    assert.equal(typeof choice.icon, "string")
  }
  // Distinct, or two cells would look like one having no effect.
  assert.equal(new Set(Array.from(presets.ICONS, (c) => c.icon)).size, presets.ICONS.length)

  // Anything else degrades to no icon rather than reaching a Text as a glyph
  // the shell's font has no drawing for — which paints a tofu box and looks
  // like a broken drink rather than an unknown one.
  for (const junk of ["X", "\u0001", "coffee", null, undefined, 7, {}, ["\uf0f4"]]) {
    assert.equal(presets.sanitizeIcon(junk), presets.ICON_NONE, String(junk))
  }
  for (const choice of presets.ICONS) {
    assert.equal(presets.sanitizeIcon(choice.icon), choice.icon)
    assert.equal(presets.iconNameOf(choice.icon), choice.name)
  }
  assert.equal(presets.iconIndexOf("nope"), 0)

  // A stored drink always arrives with the key, so nothing downstream has to
  // ask whether it is there before drawing it.
  const catalog = presets.sanitizeCatalog([{ label: "Iced", mg: 95, icon: "\uf2dc" },
                                           { label: "Plain", mg: 95 },
                                           { label: "Junk", mg: 95, icon: "!" }])
  assert.deepEqual(Array.from(catalog, (d) => d.icon), ["\uf2dc", "", ""])

  // An icon is patched like every other field, and patching it leaves the
  // rest of the drink — and its id, which the log is keyed on — alone.
  const patched = presets.updateDrink(catalog, "iced", { icon: "\uf06c" })
  assert.equal(patched[0].icon, "\uf06c")
  assert.equal(patched[0].mg, 95)
  assert.equal(patched[0].id, "iced")
  assert.equal(presets.updateDrink(catalog, "iced", { icon: "!" })[0].icon, presets.ICON_NONE)

  // The two implementations, pinned: the bash refuses out loud what the engine
  // degrades silently, so the list they are refusing against must be one list.
  const script = fs.readFileSync(path.join(testDir, "..", "caffeine-curve-settings"), "utf8")
  const declared = /^drink_icons="(.*)"$/m.exec(script)
  assert.ok(declared, "the helper script declares no icon list")
  assert.deepEqual(JSON.parse(declared[1].replace(/\\"/g, '"')),
    Array.from(presets.ICONS, (c) => c.icon))

  // D91's migration. A glyph this plugin used to draw is not an unknown one:
  // the engine maps it onto its replacement rather than degrading it to none,
  // and the helper accepts it for the same reason — so the two lists of
  // aliases have to be one list.
  const aliases = /^drink_icon_aliases="(.*)"$/m.exec(script)
  assert.ok(aliases, "the helper script declares no icon aliases")
  assert.deepEqual(JSON.parse(aliases[1].replace(/\\"/g, '"')),
    Object.keys(plain(presets.ICON_ALIASES)))
  // Every alias resolves to a glyph that is actually in the list, and none of
  // them is still in it — an alias for a glyph the picker still offers would
  // be a rename nobody made.
  for (const from of Object.keys(plain(presets.ICON_ALIASES))) {
    assert.equal(presets.sanitizeIcon(from), presets.ICON_ALIASES[from], from)
    assert.ok(!Array.from(presets.ICONS, (c) => c.icon).includes(from))
  }
  // The mug is the one that moved, and it moved because nobody could see it.
  // Coffee and Large coffee go on sharing it, which was D86's point — the
  // second is the first, bigger. Both espressos share the other one for the
  // same reason.
  const iconOf = (id) => presets.byId(id, presets.DEFAULTS).icon
  assert.equal(presets.sanitizeIcon("\ue256"), "\udb80\udd76")
  assert.equal(iconOf("coffee"), iconOf("large-coffee"))
  assert.equal(iconOf("espresso-double"), iconOf("espresso-single"))
  // D101. The larger mark goes on the larger drinks — until this phase the
  // coffees wore the small mug and the espressos the cup-and-saucer, which is
  // the wrong way round, and the pair only reads as a pair when both move.
  assert.equal(iconOf("coffee").codePointAt(0), 0xf0f4)
  // A plane-15 codepoint, so it is a surrogate pair and two JS characters —
  // which is the trap the source comment is about.
  assert.equal(iconOf("espresso-double").codePointAt(0), 0xf0176)
  // And the Latte's beer mug is gone, with an alias behind it (correction 37):
  // \uf0fc is on every catalog on disk, so the stored value follows the mark.
  assert.equal(iconOf("latte").codePointAt(0), 0xf02a6)
  assert.equal(presets.sanitizeIcon("\uf0fc"), iconOf("latte"))
  assert.ok(!Array.from(presets.ICONS, (entry) => entry.icon).includes("\uf0fc"))
})

test("the catalog page has its own legend, and it points at the card", () => {
  const hint = caffeine.formatCatalogHint("mg")
  assert.ok(hint.includes("Esc back"))
  // D67's rule, fourth time of asking (Phase 13). D53 needed a slot and the
  // line was already the longest of the four legends, so the item that left is
  // the one with a control on screen already doing its job: "J K reorder" has
  // the ⌃ ⌄ pair painted on the highlighted row, and "i icon" has nothing on
  // the page for it to be about until it has been pressed once.
  assert.ok(hint.includes("i icon"))
  assert.ok(!hint.includes("J K"))
  // D94: the "?" pointer is a fixed corner now, not the last item here — and
  // this is the page with more keys than the line holds, which is what the
  // card is for, so it is the page that most needed the pointer to stop being
  // squeezable off the end. The ✕ on every row states the remove key instead.
  assert.ok(hint.endsWith("Esc back"))
  assert.ok(!hint.includes("log"))

  // D46, in a legend rather than a control: the line names the unit the ‹ ›
  // will step, so a page of rows reading "2.1 cups" is not captioned "‹ › mg".
  assert.ok(caffeine.formatCatalogHint("mg").includes("‹ › mg"))
  assert.ok(caffeine.formatCatalogHint("cups").includes("‹ › cups"))
  assert.ok(!caffeine.formatCatalogHint("cups").includes("mg"))
})

// ---------------------------------------------------------------- settings
//
// Everything below reads what shell.json holds, so the interesting cases are
// the wrong ones: a value that is a string because `omarchy bar set` quotes
// it, an option reworded between plugin versions, a hand edit.

test("the half-life picker maps every option, and junk falls back", () => {
  const options = Array.from(caffeine.METABOLISM_OPTIONS)
  assert.equal(options.length, 5)

  // Every non-custom option means the hours printed in its own label, so the
  // manifest cannot advertise one number and apply another.
  for (const option of options) {
    if (option.hours === 0) continue
    assert.match(option.label, new RegExp(`\\(${option.hours} hours\\)`))
    assert.equal(caffeine.halfLifeFor(option.label, 0), option.hours)
  }

  // Custom defers to the raw field, including when the shell hands it over as
  // a string, and clamps it the way every other half-life is clamped.
  assert.equal(caffeine.halfLifeFor(caffeine.METABOLISM_CUSTOM, 9), 9)
  assert.equal(caffeine.halfLifeFor(caffeine.METABOLISM_CUSTOM, "9"), 9)
  assert.equal(caffeine.halfLifeFor(caffeine.METABOLISM_CUSTOM, 99), caffeine.HALF_LIFE_MAX_HOURS)
  assert.equal(caffeine.halfLifeFor(caffeine.METABOLISM_CUSTOM, "nope"), 5)

  // Absent, and reworded-but-still-numbered, and outright junk.
  assert.equal(caffeine.halfLifeFor(undefined, 0), 5)
  assert.equal(caffeine.halfLifeFor("", 0), 5)
  assert.equal(caffeine.halfLifeFor("Something else entirely (8 hours)", 0), 8)
  assert.equal(caffeine.halfLifeFor("gibberish", 7), 5)
})

test("bedtime accepts a 12-hour clock, because the field is free text", () => {
  assert.deepEqual({ ...caffeine.parseClock("22:30") }, { hours: 22, minutes: 30 })
  assert.deepEqual({ ...caffeine.parseClock("10:30pm") }, { hours: 22, minutes: 30 })
  assert.deepEqual({ ...caffeine.parseClock("10:30 PM") }, { hours: 22, minutes: 30 })
  assert.deepEqual({ ...caffeine.parseClock("11 pm") }, { hours: 23, minutes: 0 })
  assert.deepEqual({ ...caffeine.parseClock("12:15am") }, { hours: 0, minutes: 15 })
  assert.deepEqual({ ...caffeine.parseClock("12:15pm") }, { hours: 12, minutes: 15 })
  assert.deepEqual({ ...caffeine.parseClock("00:30") }, { hours: 0, minutes: 30 })

  // Anything unreadable is 23:00 rather than a throw or a NaN date.
  for (const junk of ["", "nope", "25:00", "10:99", "13pm", "0pm", undefined, null, 7]) {
    assert.deepEqual({ ...caffeine.parseClock(junk) }, { hours: 23, minutes: 0 })
  }
})

test("a cup is a round figure you set, and the Coffee preset is not it", () => {
  // D84, and the point of the change: a serving and a unit stop pretending to
  // be one number. The preset is a measured 95 mg; the cup is an arbitrary 100
  // that the user owns, because an americano is larger than an espresso and
  // may carry the same dose — a cup here is caffeine, not liquid.
  assert.equal(caffeine.CUP_MG_DEFAULT, 100)
  assert.equal(presets.mgFor("coffee"), 95)
  assert.notEqual(presets.mgFor("coffee"), caffeine.CUP_MG_DEFAULT)

  assert.equal(caffeine.formatAmount(125, "Milligrams"), "125 mg")
  assert.equal(caffeine.formatAmount(125, "Cups of coffee"), "1.3 cups")
  assert.equal(caffeine.formatAmount(100, "cups"), "1 cup")
  assert.equal(caffeine.formatAmount(0, "cups"), "0 cups")

  // Every conversion takes the setting, so there is no route to a cups figure
  // that quietly used the default instead.
  assert.equal(caffeine.formatAmount(125, "cups", 50), "2.5 cups")
  assert.equal(caffeine.formatAmount(125, "cups", 250), "0.5 cups")
  assert.equal(caffeine.formatLogged(60, "cups", 60), "1 cup")
  assert.equal(caffeine.formatLoggedValue(300, "cups", 150), "2")

  // Out of range clamps and unreadable falls back, the same contract as every
  // other stored number: the engine cannot afford to crash the shell.
  assert.equal(caffeine.cupSize(10), caffeine.CUP_MIN_MG)
  assert.equal(caffeine.cupSize(9000), caffeine.CUP_MAX_MG)
  assert.equal(caffeine.cupSize(0), caffeine.CUP_MG_DEFAULT)
  for (const junk of ["", undefined, null, "nope", NaN, -5, {}]) {
    assert.equal(caffeine.cupSize(junk), caffeine.CUP_MG_DEFAULT, String(junk))
  }
  assert.equal(caffeine.cupSize("120"), 120)
  assert.equal(caffeine.cupSize(119.6), 120)

  // Unknown, absent and hand-edited unit strings all read as milligrams,
  // which is the honest unit and the default.
  for (const units of ["", undefined, null, "Litres", 3]) {
    assert.equal(caffeine.formatAmount(125, units), "125 mg")
  }

  // The tilde marks an estimate being asserted, and follows the same
  // threshold in both units: half a cup is 50 mg.
  assert.equal(caffeine.formatAmountApprox(200, "mg"), "~200 mg")
  assert.equal(caffeine.formatAmountApprox(40, "mg"), "40 mg")
  assert.equal(caffeine.formatAmountApprox(200, "cups"), "~2 cups")
  assert.equal(caffeine.formatAmountApprox(20, "cups"), "0.2 cups")
})

test("a logged amount is stated exactly, and one cup is not one cups", () => {
  // A preset you tapped and a total you drank are not estimates off the model,
  // so roundDisplay's nearest-5 has no false precision to remove here.
  assert.equal(caffeine.formatLogged(372, "mg"), "372 mg")
  assert.equal(caffeine.formatLogged(47, "mg"), "47 mg")
  assert.equal(caffeine.formatLogged(125, "cups"), "1.3 cups")
  assert.equal(caffeine.formatLogged(200, "cups"), "2 cups")
  assert.equal(caffeine.formatLogged(0, "cups"), "0 cups")

  // One cup is one cup in whatever the cup currently is, so the singular has
  // to be right at every setting rather than at one pinned number.
  for (const cup of [50, 95, 100, 145, 300]) {
    assert.equal(caffeine.formatLogged(cup, "cups", cup), "1 cup")
    assert.equal(caffeine.formatAmount(cup, "cups", cup), "1 cup")
  }

  // Decaf is 2mg on purpose, and at one decimal that rounds to zero — which
  // says the opposite of the thing the preset is in the table to say.
  assert.equal(presets.mgFor("decaf"), 2)
  assert.equal(caffeine.formatLogged(2, "cups"), "<0.1 cups")
  assert.equal(caffeine.formatAmount(2, "cups"), "<0.1 cups")
  assert.equal(caffeine.formatAmountApprox(2, "cups"), "<0.1 cups")
  // Zero is still zero: the floor is for amounts that exist and are small.
  assert.equal(caffeine.formatLogged(0, "cups"), "0 cups")
  assert.equal(caffeine.formatAmount(0, "cups"), "0 cups")

  // Every preset renders in both units without a plural slip.
  for (const preset of presets.DEFAULTS) {
    for (const units of ["Milligrams", "Cups of coffee"]) {
      for (const cup of [caffeine.CUP_MIN_MG, undefined, caffeine.CUP_MAX_MG]) {
        const text = caffeine.formatLogged(preset.mg, units, cup)
        assert.doesNotMatch(text, /^1 cups$/)
        assert.match(text, /^(<0\.1|[0-9.]+) (mg|cup|cups)$/)
      }
    }
  }
})

test("a future dose reads as one", () => {
  assert.equal(caffeine.formatOffset(-0.75), "45m")
  assert.equal(caffeine.formatOffset(0.75), "in 45m")
  assert.equal(caffeine.formatOffset(-4.5), "4h 30m")
  assert.equal(caffeine.formatOffset(4.5), "in 4h 30m")
  // Inside a minute either way there is nothing to say about direction.
  assert.equal(caffeine.formatOffset(0.001), "now")
  assert.equal(caffeine.formatOffset(-0.001), "now")
})

test("a nudge forward stops at the edge of the window, and back does not", () => {
  const step = caffeine.NUDGE_MINUTES
  const edge = NOW + caffeine.CURVE_WINDOW_HOURS * HOUR

  // Backward is unbounded: walking a dose back changes the level now, so the
  // chart answers every press.
  assert.equal(caffeine.nudgeMinutes(NOW - 100 * HOUR, -step, NOW), -step)
  assert.equal(caffeine.nudgeMinutes(NOW, -step, NOW), -step)

  assert.equal(caffeine.nudgeMinutes(NOW, step, NOW), step)
  assert.equal(caffeine.nudgeMinutes(edge - step * 60, step, NOW), step)

  // The whole step is refused rather than truncated, so a dose stays on the
  // 15-minute grid it started on instead of landing at an arbitrary clock.
  assert.equal(caffeine.nudgeMinutes(edge - step * 60 + 1, step, NOW), 0)
  assert.equal(caffeine.nudgeMinutes(edge, step, NOW), 0)
  assert.equal(caffeine.nudgeMinutes(edge + HOUR, step, NOW), 0)
})

test("the daily cap clamps, and its switch reads a hand-edited boolean", () => {
  assert.equal(caffeine.DAILY_CAP_DEFAULT_MG, 400)
  assert.equal(caffeine.sanitizeCap(400), 400)
  assert.equal(caffeine.sanitizeCap("250"), 250)
  assert.equal(caffeine.sanitizeCap(0), caffeine.DAILY_CAP_MIN_MG)
  assert.equal(caffeine.sanitizeCap(99999), caffeine.DAILY_CAP_MAX_MG)
  assert.equal(caffeine.sanitizeCap("nope"), 400)

  // A hand edit of the settings file, or a shell that quotes what it writes,
  // both produce the string form — so it is the one to be sure of.
  assert.equal(caffeine.truthy(true), true)
  assert.equal(caffeine.truthy("true"), true)
  assert.equal(caffeine.truthy("TRUE"), true)
  assert.equal(caffeine.truthy(1), true)
  for (const off of [false, "false", "", undefined, null, 0, "nope"]) {
    assert.equal(caffeine.truthy(off), false)
  }
})

// D43 moved the settings out of the manifest and into a file this plugin
// owns, so there is no schema left to pin. What is still worth pinning — and
// is the whole of what the old manifest test was really checking — is that the
// default this plugin *states* and the default its engine *applies* are the
// same number. They live in two places on purpose: SETTINGS_DEFAULTS is what
// the helper script prints and the README quotes, and each sanitiser's
// fallback is what a missing key actually gets.
// -------------------------------------------- D89: the bar's number
//
// Three answers, and the third is the whole reason the setting exists: the
// reading is present exactly while it still has something to say.

test("the bar's number defaults to moving, absent or garbled", () => {
  assert.deepEqual(Array.from(caffeine.BAR_NUMBER_MODES), ["always", "moving", "never"])
  assert.equal(caffeine.sanitizeBarNumber("moving"), "moving")
  assert.equal(caffeine.sanitizeBarNumber("NEVER"), "never")
  // **D99, overturning D89 one phase after it shipped.** D89 defaulted to
  // `always` on the rule that a setting changing what a bar looks like must
  // default to the bar people already have — which is a good rule with no
  // installs to be true of. And the sanitiser moved with it deliberately: a
  // garbled value is not a different question from an absent one, which is
  // what SETTINGS_DEFAULTS' own header says about every value in it.
  for (const junk of [undefined, null, "", "sometimes", 7, {}, "no"])
    assert.equal(caffeine.sanitizeBarNumber(junk), "moving", String(junk))
  assert.equal(caffeine.SETTINGS_DEFAULTS.barNumber, "moving")
  // One word each, in the pill. Phase 10 paid for that lesson.
  for (const mode of caffeine.BAR_NUMBER_MODES)
    assert.match(caffeine.barNumberName(mode), /^[A-Z][a-z]+$/)
})

test("the moving window is Tmax, which is derived rather than chosen", () => {
  // ~48 minutes at the 5-hour default, which is where the science notes put
  // it — and it moves with the person, which "45 minutes" could not.
  assert.equal(Math.round(caffeine.barNumberWindowSeconds(5) / 60), 48)
  // A smoker's 2.5 hours absorbs to a peak sooner; a slow 16 later.
  assert.ok(caffeine.barNumberWindowSeconds(2.5) < caffeine.barNumberWindowSeconds(5))
  assert.ok(caffeine.barNumberWindowSeconds(16) > caffeine.barNumberWindowSeconds(5))
  assert.equal(caffeine.barNumberWindowSeconds(5),
    Math.round(caffeine.timeToPeak(5) * 3600))
})

test("moving shows the number after a drink and stops when it stops climbing", () => {
  const now = 1_700_000_000
  const shown = (mode, doses, at) => caffeine.barNumberShown(mode, doses, at, 5)
  const window = caffeine.barNumberWindowSeconds(5)
  const justNow = [{ ts: now, mg: 125, label: "Espresso" }]

  assert.equal(shown("moving", justNow, now), true)
  assert.equal(shown("moving", justNow, now + window - 60), true)
  assert.equal(shown("moving", justNow, now + window + 60), false)
  // The two fixed answers do not consult the log at all.
  assert.equal(shown("always", [], now), true)
  assert.equal(shown("never", justNow, now), false)
  // An empty log has nothing to be moving about.
  assert.equal(shown("moving", [], now), false)
  assert.equal(shown("moving", null, now), false)

  // The newest dose is the only one that can open the window, and an older one
  // cannot hold it open. sanitizeDoses sorts newest first; this is written
  // out of order on purpose.
  const older = [{ ts: now - 4 * 3600, mg: 95 }, { ts: now - 10, mg: 47 }]
  assert.equal(shown("moving", older, now), true)
  assert.equal(shown("moving", [{ ts: now - 4 * 3600, mg: 95 }], now), false)

  // D20 makes a future dose a real state, and a drink you have not had yet
  // does not open the window — but it does the moment it arrives.
  const planned = [{ ts: now + 1800, mg: 125 }, { ts: now - 4 * 3600, mg: 95 }]
  assert.equal(shown("moving", planned, now), false)
  assert.equal(shown("moving", planned, now + 1800), true)

  // A slower half-life holds it longer, because Tmax is later.
  assert.equal(caffeine.barNumberShown("moving", justNow, now + 55 * 60, 5), false)
  assert.equal(caffeine.barNumberShown("moving", justNow, now + 55 * 60, 16), true)

  // **The rejected candidate, pinned so the reason survives.** "While the
  // level is actually rising" needs no window, and it is a strict subset of
  // this one — but it can be empty: a 2 mg decaf on a 200 mg board never lifts
  // the total at all, so the number would never appear for a drink you just
  // logged. This window always does, which is what was asked for.
  const board = [{ ts: now, mg: 2 }, { ts: now - 3600, mg: 125 }, { ts: now - 7200, mg: 125 }]
  const rising = caffeine.levelAt(board, now, 5) < caffeine.levelAt(board, now + 60, 5)
  assert.equal(rising, false)
  assert.equal(shown("moving", board, now), true)
})

test("the shipped defaults and the engine's fallbacks agree", () => {
  const defaults = caffeine.SETTINGS_DEFAULTS

  // An absent settings file is the ordinary first-run state, and it must land
  // on exactly the advertised object.
  assert.deepEqual(plain(caffeine.sanitizeSettings({})), {
    bedtime: defaults.bedtime,
    chartFrame: defaults.chartFrame,
    dayStart: defaults.dayStart,
    dayEnd: defaults.dayEnd,
    halfLifeHours: defaults.halfLifeHours,
    sleepThresholdMg: defaults.sleepThresholdMg,
    units: defaults.units,
    cupMg: defaults.cupMg,
    dailyCapEnabled: defaults.dailyCapEnabled,
    dailyCapMg: defaults.dailyCapMg,
    quietPanel: defaults.quietPanel,
    barNumber: defaults.barNumber
  })

  // D51 ships off, and only ever off. A disclaimer you have dismissed is not
  // a disclaimer you were never shown, and the second of those is what a
  // default of `true` would produce for every new install.
  assert.equal(defaults.quietPanel, false)
  assert.equal(caffeine.sanitizeSettings({}).quietPanel, false)
  // Anything that is not a plain yes leaves the lines up, which is the safe
  // direction for the line D13 rests on.
  for (const junk of ["maybe", "", null, 0, "TRUE-ish", {}]) {
    assert.equal(caffeine.sanitizeSettings({ quietPanel: junk }).quietPanel, false, String(junk))
  }
  for (const on of [true, "true", "True", 1]) {
    assert.equal(caffeine.sanitizeSettings({ quietPanel: on }).quietPanel, true, String(on))
  }
  // So are the shapes a corrupt or hand-mangled file can produce.
  for (const junk of [null, undefined, "not an object", 7, []]) {
    assert.deepEqual(plain(caffeine.sanitizeSettings(junk)), plain(caffeine.sanitizeSettings({})))
  }

  // Each default, against the constant the rest of the engine reasons with.
  assert.equal(defaults.halfLifeHours, caffeine.HALF_LIFE_DEFAULT_HOURS)
  assert.equal(defaults.sleepThresholdMg, caffeine.BEDTIME_CLEAR_MG)
  assert.equal(defaults.dailyCapMg, caffeine.DAILY_CAP_DEFAULT_MG)
  assert.equal(defaults.units, caffeine.UNITS_MG)
  assert.equal(defaults.dailyCapEnabled, false)   // D13: the cap ships off
  // D105, and its default is an argument rather than an inheritance (D99):
  // rolling is the framing that always contains now, and it is the one every
  // capture in this project has been of.
  assert.equal(defaults.chartFrame, caffeine.FRAME_ROLLING)
  assert.equal(defaults.dayStart, caffeine.DAY_START_DEFAULT)
  assert.equal(defaults.dayEnd, caffeine.DAY_END_DEFAULT)
  assert.equal(defaults.bedtime, caffeine.BEDTIME_DEFAULT)
  assert.equal(caffeine.parseClock(defaults.bedtime).hours, 23)

  // Every default is inside the bounds the helper script and the panel's
  // chevrons enforce, so a fresh install is never already out of range.
  assert.ok(defaults.halfLifeHours >= caffeine.HALF_LIFE_MIN_HOURS
    && defaults.halfLifeHours <= caffeine.HALF_LIFE_MAX_HOURS)
  assert.ok(defaults.sleepThresholdMg >= caffeine.SLEEP_THRESHOLD_MIN_MG
    && defaults.sleepThresholdMg <= caffeine.SLEEP_THRESHOLD_MAX_MG)
  assert.ok(defaults.dailyCapMg >= caffeine.DAILY_CAP_MIN_MG
    && defaults.dailyCapMg <= caffeine.DAILY_CAP_MAX_MG)

  // The manifest must NOT carry a schema any more (D43): a settings form
  // landing in a later Omarchy would write inline settings onto the shell.json
  // entry that nothing here reads — a form that appears and silently does
  // nothing, which is worse than no form at all.
  const manifest = JSON.parse(
    fs.readFileSync(path.join(testDir, "..", "manifest.json"), "utf8"))
  assert.equal(manifest.barWidget.schema, undefined)
  assert.equal(manifest.barWidget.defaults, undefined)
  assert.equal(manifest.barWidget.settingsForm, undefined)
})

test("the settings file is read as untrusted text", () => {
  // The values arrive from a JSON file a hand edit can reach, so every one of
  // them is clamped rather than believed. Same contract the dose log has had
  // since Phase 1 — this runs unsandboxed inside the shell process.
  const mangled = caffeine.sanitizeSettings({
    bedtime: "10:30 pm",
    halfLifeHours: "99",
    sleepThresholdMg: -4,
    units: "Cups of coffee",
    dailyCapEnabled: "true",
    dailyCapMg: "250"
  })
  assert.equal(mangled.bedtime, "22:30")
  assert.equal(mangled.halfLifeHours, caffeine.HALF_LIFE_MAX_HOURS)
  assert.equal(mangled.sleepThresholdMg, caffeine.SLEEP_THRESHOLD_MIN_MG)
  assert.equal(mangled.units, caffeine.UNITS_CUPS)
  assert.equal(mangled.dailyCapEnabled, true)
  assert.equal(mangled.dailyCapMg, 250)

  // The units label the manifest used to ship still reads, so a settings file
  // written against the Phase 6 enum is not orphaned by the move.
  assert.equal(caffeine.sanitizeUnits("Milligrams"), caffeine.UNITS_MG)
})

test("a half-life set directly beats the picker, which is still readable", () => {
  // D34, and what the panel's own control depends on: the number field writes
  // halfLifeHours, and it must win over a metabolism string that says
  // otherwise — including the shipped "Typical (5 hours)", which would
  // otherwise pin every user to five whatever they typed.
  assert.equal(caffeine.halfLifeSetting({ halfLifeHours: 8 }), 8)
  assert.equal(caffeine.halfLifeSetting({ halfLifeHours: 8, metabolism: "Typical (5 hours)" }), 8)
  assert.equal(caffeine.halfLifeSetting({ halfLifeHours: "3" }), 3)
  assert.equal(caffeine.halfLifeSetting({ halfLifeHours: 99 }), caffeine.HALF_LIFE_MAX_HOURS)

  // D26's enum stays live for anyone whose file has one and no number, which
  // is the migration Phase 10's profile needs.
  assert.equal(caffeine.halfLifeSetting({ metabolism: "I smoke (3 hours)" }), 3)
  assert.equal(caffeine.halfLifeSetting({ metabolism: "Pregnancy or the pill (10 hours)" }), 10)

  // Nothing at all, and the shapes an empty field produces, fall to default.
  assert.equal(caffeine.halfLifeSetting({}), caffeine.HALF_LIFE_DEFAULT_HOURS)
  assert.equal(caffeine.halfLifeSetting(null), caffeine.HALF_LIFE_DEFAULT_HOURS)
  assert.equal(caffeine.halfLifeSetting({ halfLifeHours: "" }), caffeine.HALF_LIFE_DEFAULT_HOURS)
  assert.equal(caffeine.halfLifeSetting({ halfLifeHours: null }), caffeine.HALF_LIFE_DEFAULT_HOURS)
})

test("a bedtime is stored unambiguously, and refused when it is junk", () => {
  // What goes in the file is always 24-hour and zero-padded, whatever the
  // machine's clock renders — the store has to be readable by a person and by
  // the helper script's own regex.
  assert.equal(caffeine.sanitizeBedtime("23:00"), "23:00")
  assert.equal(caffeine.sanitizeBedtime("10:30 pm"), "22:30")
  assert.equal(caffeine.sanitizeBedtime("11 PM"), "23:00")
  assert.equal(caffeine.sanitizeBedtime("7:05"), "07:05")
  assert.equal(caffeine.sanitizeBedtime("0:00"), "00:00")
  assert.equal(caffeine.sanitizeBedtime("junk"), caffeine.BEDTIME_DEFAULT)

  // Reading degrades quietly; writing does not. The settings field needs the
  // difference, or typing "quarter past" would silently store 23:00.
  assert.equal(caffeine.parseClockStrict("quarter past"), null)
  assert.equal(caffeine.parseClockStrict("25:00"), null)
  assert.equal(caffeine.parseClockStrict("13:00 pm"), null)
  assert.equal(caffeine.parseClockStrict(""), null)
  assert.deepEqual(plain(caffeine.parseClockStrict("22:30")), { hours: 22, minutes: 30 })
  assert.deepEqual(plain(caffeine.parseClock("quarter past")), { hours: 23, minutes: 0 })
})

test("the bedtime chevrons step a quarter hour and wrap at midnight", () => {
  assert.equal(caffeine.shiftClock("23:00", caffeine.NUDGE_MINUTES), "23:15")
  assert.equal(caffeine.shiftClock("23:00", -caffeine.NUDGE_MINUTES), "22:45")

  // Midnight is a bedtime people have, so the control wraps rather than
  // stopping dead — clamping would make the hour either side of it
  // unreachable from one direction.
  assert.equal(caffeine.shiftClock("23:50", 15), "00:05")
  assert.equal(caffeine.shiftClock("00:05", -15), "23:50")
  assert.equal(caffeine.shiftClock("00:00", -1), "23:59")

  // Twelve-hour input and junk both leave through the canonical form.
  assert.equal(caffeine.shiftClock("10:30 pm", 30), "23:00")
  assert.equal(caffeine.shiftClock("nonsense", 0), "23:00")
})

// ---------------------------------------------------------------- D42

test("once bedtime has passed the panel reports now, not tomorrow night", () => {
  // Defect #4, exactly as it was found: 23:25, a 125mg espresso ten minutes
  // old, bedtime 23:00. Aimed at the next occurrence of the clock that is
  // 23h35m out, by which point a five-hour half-life has taken everything —
  // so the panel said CLEAR FOR SLEEP over an 80mg reading, in the one window
  // where it is most likely to be open.
  const now = localTs(2025, 8, 1, 23, 25)
  const doses = [{ ts: localTs(2025, 8, 1, 23, 15), mg: 125, label: "test" }]
  const level = caffeine.levelAt(doses, now, 5)
  assert.ok(level > 60, `level was ${level}mg`)

  const projection = caffeine.bedtimeProjection(doses, now, 5, "23:00")
  assert.equal(projection.afterBedtime, true)
  assert.equal(projection.at, now)
  assert.ok(Math.abs(projection.mg - level) < 1e-9)
  assert.equal(projection.band, "disruptive")
  assert.ok(Math.abs(projection.hoursAfterBed - 25 / 60) < 1e-6)
  assert.equal(projection.hoursAway, 0)

  // The bedtime that has just gone, not tomorrow's: it is at most four hours
  // back and so still inside the curve's twelve-hour window, where tomorrow's
  // is sixteen hours off the right edge and the hairline simply disappears.
  assert.equal(projection.bedtimeAt, localTs(2025, 8, 1, 23, 0))
  assert.ok(projection.bedtimeAt > now - caffeine.CURVE_WINDOW_HOURS * HOUR)

  // What it used to say, for the record: aimed a day out, the same dose is
  // clear. That number was never wrong — it was about the wrong night.
  const tomorrow = caffeine.bedtimeSeconds(now, "23:00")
  assert.ok(caffeine.bedtimeBand(caffeine.levelAt(doses, tomorrow, 5)) === "clear")
})

test("the late window is D41's window, and outside it nothing changes", () => {
  const doses = [{ ts: localTs(2025, 8, 1, 22, 0), mg: 200, label: "t" }]

  // Before bedtime: unchanged, and still projecting forward.
  const evening = localTs(2025, 8, 1, 22, 30)
  const before = caffeine.bedtimeProjection(doses, evening, 5, "23:00")
  assert.equal(before.afterBedtime, false)
  assert.equal(before.at, localTs(2025, 8, 1, 23, 0))
  assert.equal(before.bedtimeAt, before.at)
  assert.ok(before.hoursAway > 0)

  // On the clock exactly, the bedtime that has arrived is the previous one —
  // the same convention previousBedtimeSeconds uses — so the late window opens
  // at the stroke of it and the two readings agree there.
  const onTime = caffeine.bedtimeProjection(doses, localTs(2025, 8, 1, 23, 0), 5, "23:00")
  assert.equal(onTime.afterBedtime, true)
  assert.equal(onTime.hoursAfterBed, 0)

  // At the last minute of the window it is still reporting now.
  const late = localTs(2025, 8, 2, 2, 59)
  assert.equal(caffeine.bedtimeProjection(doses, late, 5, "23:00").afterBedtime, true)

  // Past it, the night has ended and the panel counts down to the next one.
  const morning = localTs(2025, 8, 2, 3, 30)
  const after = caffeine.bedtimeProjection(doses, morning, 5, "23:00")
  assert.equal(after.afterBedtime, false)
  assert.equal(after.at, localTs(2025, 8, 2, 23, 0))
  assert.ok(after.hoursAway > 19)

  // It is exactly the window D41 already uses to call a dose "after bedtime",
  // which is why the two lines on screen cannot contradict each other.
  const boundary = localTs(2025, 8, 1, 23, 0) + caffeine.LATE_DOSE_HOURS * HOUR
  assert.equal(caffeine.bedtimeProjection(doses, boundary, 5, "23:00").afterBedtime, true)
  assert.equal(caffeine.bedtimeProjection(doses, boundary + 60, 5, "23:00").afterBedtime, false)
})

test("the hero states the verdict itself once bedtime has gone", () => {
  const late = caffeine.bedtimeProjection(
    [{ ts: localTs(2025, 8, 1, 23, 15), mg: 125, label: "t" }],
    localTs(2025, 8, 1, 23, 25), 5, "23:00")
  // A double espresso at 21:30 is still 90-odd mg at an 23:00 bedtime.
  const early = caffeine.bedtimeProjection(
    [{ ts: localTs(2025, 8, 1, 21, 30), mg: 125, label: "t" }],
    localTs(2025, 8, 1, 22, 0), 5, "23:00")

  // Before bedtime: the second number, and the verdict under it. D4, intact.
  assert.equal(caffeine.projectionHeadline(early, "mg", "11:00 PM"),
    caffeine.formatAmountApprox(early.mg, "mg") + " at 11:00 PM")
  assert.equal(caffeine.projectionCaption(early), "Likely to disrupt sleep")

  // After it there is no second number — the hero's left side already states
  // now — so the verdict takes the headline and the caption says why.
  assert.equal(caffeine.projectionHeadline(late, "mg", "11:00 PM"), "Likely to keep you up")
  assert.equal(caffeine.projectionCaption(late), "Past bedtime")

  // D42's failure modes, as assertions: the headline must not restate the
  // level, and the caption must not carry a duration that competes with
  // D41's line right underneath it.
  const level = caffeine.formatAmountApprox(late.mg, "mg")
  assert.ok(!caffeine.projectionHeadline(late, "mg", "11:00 PM").includes(level))
  assert.ok(!/\d/.test(caffeine.projectionCaption(late)))
  assert.ok(!caffeine.projectionHeadline(late, "mg", "11:00 PM").includes("11:00 PM"))

  // Cups still convert on the side that has a number (D27), and the setting
  // reaches it: since D84 a cup is whatever the user says it is, so what this
  // asserts is the unit rather than one figure.
  assert.match(caffeine.projectionHeadline(early, "cups", "11:00 PM"), / cups? at /)
  assert.notEqual(caffeine.projectionHeadline(early, "cups", "11:00 PM", 60),
    caffeine.projectionHeadline(early, "cups", "11:00 PM", 200))

  assert.equal(caffeine.projectionHeadline(null, "mg", "11:00 PM"), "")
  assert.equal(caffeine.projectionCaption(null), "")
})

test("the verdict changes tense when it stops being a forecast", () => {
  // The bands are the same three; what changes is that "likely to disrupt
  // sleep" is about a night you have not started, and past bedtime you have.
  assert.equal(caffeine.verdictFor("clear", false), "Clear for sleep")
  assert.equal(caffeine.verdictFor("marginal", false), "Borderline for sleep")
  assert.equal(caffeine.verdictFor("disruptive", false), "Likely to disrupt sleep")

  assert.equal(caffeine.verdictFor("clear", true), "Clear to sleep now")
  assert.equal(caffeine.verdictFor("marginal", true), "Borderline to sleep on")
  assert.equal(caffeine.verdictFor("disruptive", true), "Likely to keep you up")

  // D13 everywhere: hedged, descriptive, and never an instruction.
  for (const band of ["clear", "marginal", "disruptive"]) {
    for (const late of [true, false]) {
      const text = caffeine.verdictFor(band, late)
      assert.ok(text.length > 0)
      assert.ok(!/should|must|don't|avoid|danger/i.test(text), text)
    }
  }
})

test("the settings page's jump keys collide with nothing, which is the whole test", () => {
  // D109. Nine letters that put the cursor on a row, and **the two ways this
  // can be wrong were both in the request as it was written**: `b` was asked
  // for twice, for Bedtime and for the bar's number, and `l` was asked for at
  // all — `l` being how the stock PanelKeyCatcher moves the cursor right. Both
  // were caught by reading, and this is what would have caught them by running.
  const jumps = Array.from(caffeine.SETTINGS_JUMPS, (jump) => plain(jump))
  assert.equal(jumps.length, 9)

  // No letter twice.
  const keys = jumps.map((jump) => jump.key)
  assert.equal(new Set(keys).size, keys.length, `duplicate jump key in ${keys}`)

  // No letter the catcher eats before the panel ever sees it. This is the
  // assertion that fails if somebody "restores" `l` to the half-life row.
  for (const key of keys) {
    assert.ok(!Array.from(caffeine.CATCHER_KEYS).includes(key),
      `${key} is consumed by PanelKeyCatcher and cannot reach the panel`)
  }

  // And no letter this page already spends on something else.
  for (const key of keys) {
    assert.ok(!Array.from(caffeine.SETTINGS_PAGE_KEYS).includes(key),
      `${key} already does something on the settings page`)
  }

  // Every one is a single character, because that is what `textKey` delivers.
  for (const key of keys) assert.equal(key.length, 1, key)

  // The two the user settled by hand, pinned so a later tidy-up cannot
  // silently undo the reasoning: `b` is Bedtime and not the bar's number, and
  // the half-life is the shifted `L`.
  assert.equal(caffeine.settingsJumpFor("b"), "bedtime")
  assert.equal(caffeine.settingsJumpFor("n"), "barNumber")
  assert.equal(caffeine.settingsJumpFor("L"), "halfLifeHours")
  assert.equal(caffeine.settingsJumpFor("l"), "")

  // A letter with no jump is not an error, it is a letter with no jump.
  for (const nothing of ["z", "", " ", "D", "1", undefined, null, "bb"]) {
    assert.equal(caffeine.settingsJumpFor(nothing), "", String(nothing))
  }

  // Every target names a row that exists. `settingRows` is built in QML and
  // cannot be reached from here, so the list is restated — which is worth it
  // for the one failure it catches: a row renamed without its jump following.
  // The keys are the panel's, verbatim.
  const rows = ["drinks", "bedtime", "sleepThresholdMg", "halfLifeHours",
                "profile", "units", "cupMg", "barNumber", "dailyCapEnabled",
                "dailyCapMg", "chartFrame", "dayStart", "dayEnd", "quietPanel",
                "restore"]
  for (const jump of jumps) {
    assert.ok(rows.includes(jump.row), `${jump.key} jumps to no such row: ${jump.row}`)
  }

  // Two of those rows are conditional — `cupMg` only in cups, `dailyCapMg`
  // only once the cap is on — and neither has a jump, deliberately: a
  // shortcut to a row that is usually not there is a key that usually does
  // nothing.
  for (const conditional of ["cupMg", "dailyCapMg"]) {
    assert.ok(!jumps.some((jump) => jump.row === conditional), conditional)
  }
})

test("the settings page has its own legend", () => {
  // None of the drink keys reach that page, so a footer that offered them
  // would be advertising controls that are not on screen.
  const hint = caffeine.formatSettingsHint()
  assert.ok(hint.includes("Esc back"))
  assert.ok(hint.includes("adjust"))
  for (const gone of ["log", "delete", "more"]) assert.ok(!hint.includes(gone), hint)
})

// The helper script is a second implementation of the same bounds, in bash,
// and it is the one a person typing at a terminal meets. It validates strictly
// (it can afford to say no) where the engine clamps silently (it cannot afford
// to crash the shell) — but the numbers have to be the same numbers, or the
// script refuses a value the panel's own chevrons will happily produce.
test("the helper script enforces the engine's bounds", () => {
  const script = fs.readFileSync(path.join(testDir, "..", "caffeine-curve-settings"), "utf8")

  const bounds = (key) => {
    const match = new RegExp(`integer_between "\\$value" (\\d+) (\\d+) \\|\\| die "${key}`)
      .exec(script)
    assert.ok(match, `no bounds check for ${key} in the helper script`)
    return [Number(match[1]), Number(match[2])]
  }

  assert.deepEqual(bounds("halfLifeHours"),
    [caffeine.HALF_LIFE_MIN_HOURS, caffeine.HALF_LIFE_MAX_HOURS])
  assert.deepEqual(bounds("sleepThresholdMg"),
    [caffeine.SLEEP_THRESHOLD_MIN_MG, caffeine.SLEEP_THRESHOLD_MAX_MG])
  assert.deepEqual(bounds("dailyCapMg"),
    [caffeine.DAILY_CAP_MIN_MG, caffeine.DAILY_CAP_MAX_MG])
  // D84's new number, pinned the way every other one is.
  assert.deepEqual(bounds("cupMg"), [caffeine.CUP_MIN_MG, caffeine.CUP_MAX_MG])

  // Its --defaults output is the object the engine applies, so `--defaults`
  // and a fresh install cannot describe different plugins.
  const printed = /^defaults='(.*)'$/m.exec(script)
  assert.ok(printed, "the helper script has no defaults line")
  assert.deepEqual(JSON.parse(printed[1]), plain(caffeine.SETTINGS_DEFAULTS))

  // Every key the panel writes is a key the script accepts, and nothing else
  // is: an unknown key is a typo, not a new setting.
  //
  // Two keys may share one `case` arm — D105's dayStart and dayEnd do, because
  // they are the same clock validated the same way and splitting them would be
  // the same eight lines twice — so the pattern allows a key to appear as one
  // alternative among several rather than alone.
  for (const key of Object.keys(caffeine.SETTINGS_DEFAULTS)) {
    assert.ok(new RegExp(`^  (?:\\w+ \\| )*${key}(?: \\| \\w+)*\\)$`, "m").test(script),
      `the helper script does not accept ${key}`)
  }

  // D105's three framings, pinned the way D89's three bar modes are just
  // below: the bash refuses out loud what sanitizeFrame degrades silently, and
  // the list they decide against has to be one list.
  const frames = /^    (rolling \| day \| hours)\) jq -cn/m.exec(script)
  assert.ok(frames, "the helper script does not accept the chartFrame answers")
  assert.deepEqual(frames[1].split(" | "), Array.from(caffeine.FRAMES))

  // D89's three answers, pinned the way the units pair and the profile's
  // answers already are: the bash refuses out loud what the engine degrades
  // silently, and the list they are deciding against has to be one list.
  const barModes = /^    (always \| moving \| never)\) jq -cn/m.exec(script)
  assert.ok(barModes, "the helper script does not accept the barNumber answers")
  assert.deepEqual(barModes[1].split(" | "), Array.from(caffeine.BAR_NUMBER_MODES))

  // And it ships executable, because a helper a plugin cannot run is not one.
  assert.ok(fs.statSync(path.join(testDir, "..", "caffeine-curve-settings")).mode & 0o111)
})

// The catalog is the one setting that is not a scalar, so it is the one the
// script takes as JSON - and the same two-implementations rule applies: the
// bash refuses out loud what Presets.js clamps silently, and the numbers have
// to be the same numbers or the panel can produce a catalog the terminal will
// not accept.
test("the helper script takes the catalog as JSON, to the engine's bounds", () => {
  const script = fs.readFileSync(path.join(testDir, "..", "caffeine-curve-settings"), "utf8")

  const constant = (name) => {
    const match = new RegExp(`^${name}=(\\d+)$`, "m").exec(script)
    assert.ok(match, `no ${name} in the helper script`)
    return Number(match[1])
  }
  assert.equal(constant("catalog_max"), presets.CATALOG_MAX)
  assert.equal(constant("mg_min"), presets.MG_MIN)
  assert.equal(constant("mg_max"), presets.MG_MAX)
  assert.equal(constant("label_max"), presets.LABEL_MAX)

  // The three actions Phase 9 needed, and the shape of each.
  assert.ok(/^--set-json\)$/m.test(script))
  assert.ok(/^--unset\)$/m.test(script))
  assert.ok(/^  drinks\)$/m.test(script))
  // `drinks` through --set is refused with a message that says what to do
  // instead, rather than being stored as the string "[object Object]".
  assert.ok(/drinks is a list, not a value/.test(script))
})

// ------------------------------------------------------------- the profile
//
// D34. The half-life stops being a number nobody knows and becomes a chain of
// multipliers over questions people can answer, every coefficient of which is
// in plan/caffeine-curve-science.md. These tests are what stop a coefficient
// drifting away from its source, and what pin the two guarantees the feature
// rests on: an untouched profile changes nothing, and a value set by hand is
// never overwritten by one that was derived.

test("an empty profile derives exactly the shipped default", () => {
  assert.equal(caffeine.deriveHalfLife({}), caffeine.HALF_LIFE_DEFAULT_HOURS)
  assert.equal(caffeine.deriveHalfLife(null), caffeine.HALF_LIFE_DEFAULT_HOURS)
  assert.equal(caffeine.deriveHalfLife("nonsense"), caffeine.HALF_LIFE_DEFAULT_HOURS)
  assert.equal(caffeine.deriveHalfLife([]), caffeine.HALF_LIFE_DEFAULT_HOURS)

  // Answering every question with its neutral value is the same thing, and
  // the derivation shows no steps at all rather than a page of "x 1.0".
  const neutral = caffeine.sanitizeProfile({})
  assert.equal(caffeine.deriveHalfLife(neutral), 5)
  assert.equal(caffeine.deriveSteps(neutral).steps.length, 0)
  assert.equal(caffeine.deriveSteps(neutral).clamped, false)
})

test("each factor alone moves the half-life to its sourced figure", () => {
  // Every number on the right is from the science notes' factor table, and
  // the comment beside each is the row it came from.
  const cases = [
    // "Roughly halves it (PAHs induce CYP1A2)".
    [{ smoker: "yes" }, 2.5],
    // Abernethy & Todd 1985: 7.88h against 5.37h, a ratio of 1.47.
    [{ contraceptives: "yes" }, 7.4],
    // "10h+ at 17 weeks" -> x2.0, and "15h+ late" -> x3.0.
    [{ pregnancy: "second" }, 10],
    [{ pregnancy: "third" }, 15],
    // Interpolated between the base and the 17-week anchor; marked as such.
    [{ pregnancy: "first" }, 7],
    // "+72%" at ~50g of alcohol a day.
    [{ alcohol: "yes" }, 8.6],
    // CYP1A2 slow (~6-8h+) and fast (~2-4h), asked as behaviour. Both land on
    // the hours D26's picker advertised for the same two sentences.
    [{ clearance: "slow" }, 8],
    [{ clearance: "fast" }, 3]
  ]
  for (const [profile, hours] of cases)
    assert.equal(caffeine.deriveHalfLife(profile), hours,
      `${JSON.stringify(profile)} derived ${caffeine.deriveHalfLife(profile)}h`)
})

test("factors stack, in one multiplier chain the page can show", () => {
  // 5 x 1.6 x 0.5 - a slow metaboliser who smokes. The two pull opposite ways
  // and the chain is the only thing that says where they land.
  assert.equal(caffeine.deriveHalfLife({ clearance: "slow", smoker: "yes" }), 4)

  // 5 x 2.0 x 1.47. This is the pair the phase brief named as the one that
  // would burst the old 12h ceiling, and it does: 14.7 is above it and below
  // the new one, so it is derived rather than clamped.
  const stacked = caffeine.deriveSteps({ pregnancy: "second", contraceptives: "yes" })
  assert.equal(stacked.hours, 14.7)
  assert.equal(stacked.clamped, false)
  assert.ok(14.7 > 12, "the old ceiling would have swallowed this")

  // The steps are the arithmetic, in the order the questions are asked, and
  // only the factors that moved the number are in it.
  assert.deepEqual(Array.from(stacked.steps, (step) => step.key),
    ["contraceptives", "pregnancy"])
  assert.deepEqual(Array.from(stacked.steps, (step) => step.factor), [1.47, 2])
  assert.equal(stacked.base, 5)
})

test("an unanswered profile shows no working, because there is none", () => {
  // The state a fresh install is in, and the one nobody had rendered: with no
  // answers there are no factors, so the base line and the total carried the
  // same number two lines apart with a rule between them — a sum with one term
  // in it, which is the "one figure twice, inches apart" shape D57 and D61 each
  // threw a build away for.
  const empty = caffeine.deriveSteps({})
  assert.equal(empty.steps.length, 0)
  assert.equal(caffeine.derivationHasSteps(empty), false)
  // No "=" either, because nothing was added up.
  assert.equal(caffeine.formatDerivationMark(empty), caffeine.formatHalfLife(empty.hours))
  assert.doesNotMatch(caffeine.formatDerivationMark(empty), /=/)

  // One answer brings the working back, equals sign and all.
  const one = caffeine.deriveSteps({ smoker: "yes" })
  assert.equal(one.steps.length, 1)
  assert.equal(caffeine.derivationHasSteps(one), true)
  assert.match(caffeine.formatDerivationMark(one), /^= /)

  // The total itself is unchanged in both: the page still states the number
  // and still says it is an estimate (D13).
  for (const derivation of [empty, one])
    assert.match(caffeine.formatDerivationTotal(derivation), /estimated/)
  assert.equal(caffeine.derivationHasSteps(null), false)
})

test("the derivation clamps at both ends, and says it did", () => {
  // **The top, and D100 is why this case is written out rather than assumed.**
  // Until that decision the ceiling was reached by one answer — fluvoxamine
  // was x6.2 on its own — so removing that row could have left the clamp and
  // everything that renders it as code nothing could enter. It cannot: slow
  // clearance, the pill, the third trimester and heavy drinking stack to x12.1
  // and derive 60.7 hours on the 5-hour base.
  const high = caffeine.deriveSteps({ clearance: "slow", contraceptives: "yes",
                                      pregnancy: "third", alcohol: "yes" })
  assert.equal(high.hours, caffeine.HALF_LIFE_MAX_HOURS)
  assert.equal(Math.round(high.raw * 10) / 10, 60.7)
  assert.equal(high.clamped, true)
  assert.match(caffeine.formatDerivationTotal(high), /16 hours estimated/)
  assert.match(caffeine.formatDerivationTotal(high), /from 60.7 hours/)
  // And a much milder stack clamps too, which is what says the ceiling is a
  // real part of this page rather than one extreme answer's landing spot:
  // slow x the pill x the second trimester is x4.7.
  assert.equal(caffeine.deriveSteps({ clearance: "slow", contraceptives: "yes",
                                      pregnancy: "second" }).clamped, true)
  // And when the estimate is not the number the panel is using, the line that
  // asserts it says so - it is the loudest thing on the page, and D34's
  // precedence is otherwise invisible until six rows further down.
  assert.equal(caffeine.formatDerivationTotal(caffeine.deriveSteps({ smoker: "yes" }), 9),
    "2.5 hours estimated — 9 hours is in use")
  assert.match(caffeine.formatDerivationNote(high, 9), /16 hours.*is in use|9 hours is in use/)
  assert.equal(caffeine.formatDerivationNote(high, null), caffeine.formatDerivationNote(high))
  // The two columns the page prints it in, which have to agree with the
  // one-line form or the panel says two different things about one number.
  assert.equal(caffeine.formatDerivationMark(high), "= 16 hours")
  assert.match(caffeine.formatDerivationNote(high), /^estimated/)
  assert.equal(caffeine.formatDerivationBase(), "5 hours")

  // And stacked, where no single factor would have reached it.
  const stacked = caffeine.deriveSteps({ pregnancy: "third", contraceptives: "yes" })
  assert.equal(stacked.hours, caffeine.HALF_LIFE_MAX_HOURS)
  assert.equal(stacked.clamped, true)

  // The bottom. A fast metaboliser who smokes derives 1.5h, under the floor.
  const low = caffeine.deriveSteps({ clearance: "fast", smoker: "yes" })
  assert.equal(low.hours, caffeine.HALF_LIFE_MIN_HOURS)
  assert.equal(low.raw, 1.5)
  assert.equal(low.clamped, true)

  // An unclamped derivation says nothing about a limit, because there is none
  // to say anything about.
  assert.equal(caffeine.formatDerivationTotal(caffeine.deriveSteps({ contraceptives: "yes" })),
    "7.4 hours estimated")
})

test("the ceiling had to move, and the compute window moved with it", () => {
  // Late pregnancy is "15h+" in the source table, so a 12h ceiling could not
  // hold the largest figure the model is asked to derive.
  assert.ok(caffeine.HALF_LIFE_MAX_HOURS >= 15)
  assert.equal(caffeine.deriveHalfLife({ pregnancy: "third" }), 15)

  // The window's own comment states a guarantee - that what falls outside it
  // is ~1.6% of a dose - and that guarantee is a function of the ceiling. At
  // the ceiling, the window must still leave under 2% on the table.
  const outside = Math.pow(0.5, caffeine.COMPUTE_WINDOW_HOURS / caffeine.HALF_LIFE_MAX_HOURS)
  assert.ok(outside < 0.02, `${(outside * 100).toFixed(1)}% falls outside the window`)

  // And the log is kept for far longer than the window needs.
  assert.ok(caffeine.RETENTION_DAYS * 24 > caffeine.COMPUTE_WINDOW_HOURS)
})

test("an unrecognised answer falls back to the one with no effect", () => {
  // Same contract as every other setting: a hand edit, or a file written by a
  // version that asked a question this one does not, must not be able to
  // apply a coefficient nobody chose.
  const junk = caffeine.sanitizeProfile({
    smoker: "sometimes", pregnancy: 3, clearance: null, alcohol: "yes",
    medication: "yes", nonsense: "yes"
  })
  assert.equal(junk.smoker, "no")
  assert.equal(junk.pregnancy, "no")
  assert.equal(junk.clearance, "typical")
  assert.equal(junk.alcohol, "yes")
  assert.equal(junk.nonsense, undefined)
  // **D100's migration, which is the reason that row is still in this
  // fixture.** A version that asked a question this one does not is exactly
  // what the settings file on any machine that ran Phase 13-C now is: the
  // stored `medication` answer is dropped rather than kept, so it can never
  // apply a coefficient this table no longer carries — and unlike a retired
  // glyph it needs no alias, because there is nothing for it to migrate to.
  assert.equal(junk.medication, undefined)
  assert.equal(caffeine.deriveHalfLife({ medication: "yes" }), caffeine.PROFILE_BASE_HOURS)

  // Every question is answered after sanitising, whether or not it was stored.
  assert.deepEqual(Object.keys(plain(caffeine.sanitizeProfile({}))).sort(),
    Array.from(caffeine.PROFILE_QUESTIONS, (question) => question.key).sort())
})

test("every question has a neutral answer, and it is the one that does nothing", () => {
  for (const question of caffeine.PROFILE_QUESTIONS) {
    const answers = Array.from(question.answers)
    const fallback = answers.filter((answer) => answer.value === question.fallback)
    assert.equal(fallback.length, 1, `${question.key} has no fallback answer`)
    assert.equal(fallback[0].factor, 1, `${question.key}'s fallback is not neutral`)
    // Exactly one answer does nothing, or "how many questions are answered"
    // counts something that is not an answer.
    assert.equal(answers.filter((answer) => answer.factor === 1).length, 1)
    // Every answer that does something says what it is, for the derivation.
    for (const answer of answers)
      assert.equal(answer.effect === "", answer.factor === 1,
        `${question.key}/${answer.value} has the wrong effect text`)
  }
})

test("answers are counted, and cycled, without wrapping into a factor nobody chose", () => {
  assert.equal(caffeine.profileAnswered({}), 0)
  assert.equal(caffeine.profileAnswered({ smoker: "yes" }), 1)
  assert.equal(caffeine.profileAnswered({ smoker: "yes", alcohol: "yes" }), 2)
  // A neutral answer stored explicitly is still not an answer.
  assert.equal(caffeine.profileAnswered({ smoker: "no" }), 0)

  // Cycling walks the answers in order and wraps, so a two-answer question
  // toggles and a four-answer one steps.
  let profile = {}
  const seen = []
  for (let i = 0; i < 5; i++) {
    profile = caffeine.cycleProfile(profile, "pregnancy", 1)
    seen.push(profile.pregnancy)
  }
  assert.deepEqual(seen, ["first", "second", "third", "no", "first"])
  assert.equal(caffeine.cycleProfile({}, "pregnancy", -1).pregnancy, "third")
  assert.equal(caffeine.cycleProfile({ smoker: "yes" }, "smoker", 1).smoker, "no")

  // An unknown question changes nothing rather than adding a key.
  assert.deepEqual(plain(caffeine.cycleProfile({}, "astrology", 1)),
    plain(caffeine.sanitizeProfile({})))
})

test("a half-life set by hand always beats one that was derived", () => {
  const profile = { pregnancy: "third" }

  // The profile alone.
  assert.equal(caffeine.halfLifeSetting({ profile }), 15)
  assert.equal(caffeine.halfLifeSource({ profile }), "profile")

  // The same profile with a number set by hand: the number wins, and the
  // source says so, which is what the settings row prints.
  assert.equal(caffeine.halfLifeSetting({ profile, halfLifeHours: 6 }), 6)
  assert.equal(caffeine.halfLifeSource({ profile, halfLifeHours: 6 }), "custom")

  // Editing the profile under a custom value cannot move the live figure.
  assert.equal(caffeine.halfLifeSetting({ profile: { smoker: "yes" }, halfLifeHours: 6 }), 6)

  // Nothing set at all is the profile path, deriving the shipped default.
  assert.equal(caffeine.halfLifeSetting({}), caffeine.HALF_LIFE_DEFAULT_HOURS)
  assert.equal(caffeine.halfLifeSource({}), "profile")

  // And it is clamped on the way out, like every other reader.
  assert.equal(caffeine.halfLifeSetting({ halfLifeHours: 99 }), caffeine.HALF_LIFE_MAX_HOURS)
})

test("D26's stored metabolism still resolves, as a custom value", () => {
  // The migration. Every option in the superseded picker carried its hours in
  // its own label, and each one must still apply exactly those hours - a
  // profile answer deriving something near them is not good enough, because
  // "I smoke (3 hours)" would derive 2.5 from the sourced coefficient and
  // silently move a curve half an hour.
  for (const option of caffeine.METABOLISM_OPTIONS) {
    if (option.hours <= 0) continue
    const values = { metabolism: option.label }
    assert.equal(caffeine.halfLifeSetting(values), option.hours,
      `${option.label} no longer resolves to ${option.hours}h`)
    // It resolves as custom, which is the state a profile edit cannot touch.
    assert.equal(caffeine.halfLifeSource(values), "custom")
  }

  // The custom option, which only ever meant "read the number below".
  assert.equal(caffeine.halfLifeSetting({ metabolism: "Custom - use the hours below" }),
    caffeine.HALF_LIFE_DEFAULT_HOURS)

  // A number set by hand still beats the old picker, as it did at Phase 8.
  assert.equal(caffeine.halfLifeSetting({ metabolism: "I smoke (3 hours)", halfLifeHours: 9 }), 9)

  // And a file carrying both a stale picker and a profile takes the picker:
  // the picker was chosen, the profile may be half-answered, and D34's rule is
  // that a chosen number is never overwritten by a derived one.
  assert.equal(caffeine.halfLifeSetting({
    metabolism: "I smoke (3 hours)", profile: { pregnancy: "third" }
  }), 3)
})

test("the engine reproduces the science notes' own bedtime derivation", () => {
  // Every row of the derivation table in plan/caffeine-curve-science.md s3,
  // which is where the shipped 30mg threshold comes from. These are the
  // published figures; if this test fails, our arithmetic has drifted from the
  // document the whole feature cites.
  const rows = [
    [107, 8.8, 31.6],   // meta-analysis: 107mg needs >= 8.8h before bed
    [217.5, 13.2, 34.8], // same meta-analysis, pre-workout dose
    [100, 4, 57.4],      // 2025 crossover trial: no significant impact
    [400, 12, 75.8],     // same trial: still disruptive
    [400, 6, 174]        // Drake 2013: ~1.2h of measured sleep lost
  ]
  for (const [mg, hours, residual] of rows) {
    const computed = caffeine.residualAtBedtime(mg, hours, 5)
    assert.ok(Math.abs(computed - residual) < 0.2,
      `${mg}mg at ${hours}h computed ${computed.toFixed(1)}mg, notes say ${residual}mg`)
  }

  // The safe cutoff read at the population half-life is the shipped default,
  // to the nearest step: 31.6mg, and the threshold ships at 30.
  assert.equal(caffeine.deriveThreshold(5), 32)
  assert.ok(Math.abs(caffeine.deriveThreshold(5) - caffeine.SETTINGS_DEFAULTS.sleepThresholdMg) <= 2)

  // It is clamped to the settable range like the setting it mirrors.
  assert.equal(caffeine.deriveThreshold(2), caffeine.SLEEP_THRESHOLD_MIN_MG)

  // And this is why the panel does not apply it. At the ceiling the derived
  // threshold would call 73mg "clear for sleep" - under the 75.8mg residual
  // the same table records as still disrupting sleep. The number is a correct
  // implementation of the notes' derivation and the wrong number to hand a
  // user, and the profile page says so in words.
  assert.equal(caffeine.deriveThreshold(caffeine.HALF_LIFE_MAX_HOURS), 73)
  assert.ok(caffeine.deriveThreshold(caffeine.HALF_LIFE_MAX_HOURS)
    < caffeine.residualAtBedtime(400, 12, 5))
})

test("the pregnancy cap note converts, and still cites the figure it came from", () => {
  // D46: the cap is a number the panel shows elsewhere - on the "220 / 400 mg
  // today" line and in this row's own pill - so it converts here. D27: a line
  // that quotes a study does not. This is the first row where both apply,
  // because the cited figure and the shown value are the same number, and in
  // cups the row read "2.1 cups" over a note citing "200 mg a day".
  assert.equal(caffeine.formatPregnancyCapNote("mg"),
    "In pregnancy the figure health authorities use is 200 mg a day.")
  // In cups it reads in cups, and the source's own number follows in brackets
  // so the attribution stays true - the strong-dose line's device exactly.
  //
  // D84 is why the bracket earns its place rather than looking like padding.
  // At the default 100 mg cup the conversion is a suspiciously round "2 cups"
  // and a reader could take that for EFSA's own figure; the bracket is what
  // stops them. At a cup the user has moved it is not round at all, and the
  // device is doing the same job either way.
  assert.match(caffeine.formatPregnancyCapNote("cups"), /2 cups a day/)
  assert.match(caffeine.formatPregnancyCapNote("cups"), /they state it as 200 mg/)
  assert.match(caffeine.formatPregnancyCapNote("cups", 95), /2\.1 cups a day/)
  assert.match(caffeine.formatPregnancyCapNote("cups", 50), /4 cups a day/)
  assert.match(caffeine.formatPregnancyCapNote("cups", 50), /they state it as 200 mg/)
  // And in milligrams the two agree, so the bracket does not appear.
  assert.doesNotMatch(caffeine.formatPregnancyCapNote("mg"), /they state it as/)
  // Junk units are milligrams, like every other reader.
  assert.equal(caffeine.formatPregnancyCapNote(undefined), caffeine.formatPregnancyCapNote("mg"))
})

test("a derived half-life renders at the precision the model claims", () => {
  // The custom value is a whole number and the derived one is not, and a
  // binding that concatenates the second kind prints 7.350000000000001.
  assert.equal(caffeine.formatHalfLife(5), "5 hours")
  assert.equal(caffeine.formatHalfLife(7.35), "7.4 hours")
  assert.equal(caffeine.formatHalfLife(14.7), "14.7 hours")
  assert.equal(caffeine.formatHalfLife(99), "16 hours")
  assert.equal(caffeine.formatHalfLife("junk"), "5 hours")

  // A multiplier prints its second decimal only when it is doing something.
  assert.equal(caffeine.formatFactor(1.47), "1.47")
  assert.equal(caffeine.formatFactor(2), "2.0")
  assert.equal(caffeine.formatFactor(0.5), "0.5")
  assert.equal(caffeine.formatFactor(6.2), "6.2")

  // And a step is the factor with the thing that caused it.
  assert.equal(
    caffeine.formatDerivationStep({ factor: 1.47, effect: "oral contraceptives" }),
    "× 1.47   oral contraceptives")
})

test("the one line that justifies the plugin states a finding and not a verdict", () => {
  // D13, on the sentence the science notes say is the most useful thing this
  // plugin can say. It reports what happened to people in a trial, in the past
  // tense, about nobody in this room.
  const line = caffeine.TRIAL_NOTE
  assert.match(line, /six hours before bed/)
  assert.match(line, /in trials/)
  assert.match(line, /without people noticing/)
  // No second person anywhere in it: "your sleep" would make a general finding
  // a claim about the reader, which is the whole of what D13 refuses.
  assert.doesNotMatch(line, /\byou(r|rs)?\b/i)
  assert.doesNotMatch(line, /\b(should|must|avoid|recommend|safe|advice|diagnos|risk)/i)
  // Past tense, because the trial is over and the reader's night is not.
  assert.match(line, /reduced/)
  assert.doesNotMatch(line, /\b(reduces|will reduce)\b/)

  // It carries a duration and no amount, so D27's funnel has nothing to do
  // here and D58's brackets have nothing to bracket. Pinning that, because
  // "six hours" reading as a number the units setting should have converted is
  // exactly the mistake the funnel exists to catch — and the reason it is not
  // one is that hours are hours in both units.
  assert.doesNotMatch(line, /\bmg\b|\bcups?\b/)
})

test("nothing the profile prints reads as advice", () => {
  // D13. Every derived figure the panel states says it is an estimate, and
  // nothing on this page tells anyone what to do about it.
  const derivation = caffeine.deriveSteps({ contraceptives: "yes" })
  assert.match(caffeine.formatDerivationTotal(derivation), /estimated/)
  assert.match(caffeine.formatPregnancyCapNote("mg"), new RegExp(String(caffeine.PREGNANCY_CAP_MG)))
  const copy = [
    caffeine.formatDerivationTotal(derivation),
    caffeine.formatPregnancyCapNote("mg"),
    caffeine.formatPregnancyCapNote("cups"),
    caffeine.formatProfileHint()
  ].concat(Array.from(caffeine.PROFILE_QUESTIONS, (q) => q.label + " " + q.description))
  for (const line of copy)
    assert.doesNotMatch(line, /\b(you should|must|recommend|safe to|advice|diagnos)/i, line)
})

// The profile is the second setting that is not a scalar, and the same
// two-implementations rule applies to it as to the catalog: the bash refuses
// out loud what Caffeine.js falls back silently, and the two lists of answers
// have to be the same list or the panel can write a profile the terminal will
// not accept.
test("the helper script takes the profile as JSON, to the engine's answers", () => {
  const script = fs.readFileSync(path.join(testDir, "..", "caffeine-curve-settings"), "utf8")

  const table = /^profile_answers='([\s\S]*?)'$/m.exec(script)
  assert.ok(table, "no profile_answers table in the helper script")
  const allowed = JSON.parse(table[1])

  assert.deepEqual(Object.keys(allowed).sort(),
    Array.from(caffeine.PROFILE_QUESTIONS, (question) => question.key).sort())
  for (const question of caffeine.PROFILE_QUESTIONS) {
    assert.deepEqual(allowed[question.key],
      Array.from(question.answers, (answer) => answer.value),
      `${question.key}'s answers differ between the script and the engine`)
  }

  // Same three shapes the catalog needed: validated as JSON, unsettable back
  // to its default, and refused through --set with the line to use instead.
  assert.ok(/^  profile\)$/m.test(script))
  assert.ok(/drinks \| profile \| metabolism\) ;;/.test(script))
  // D26's picker outranks the profile, so taking the profile's estimate has to
  // be able to drop it — which means --unset has to accept a key --set does
  // not, and refusing it there would make the offer appear to do nothing.
  assert.ok(/unknown setting: \$key/.test(script))
  assert.ok(/profile is an object, not a value/.test(script))
})

// ---------------------------------------------------------------- Phase 11
//
// The timeline. The bounds and the shift are the only new arithmetic — the
// sampler was already range-taking — so this is what has to hold.

const DAY = 24 * HOUR

test("the pan stops at now going forward", () => {
  const doses = [at(50, 125), at(2, 95)]
  assert.equal(caffeine.clampPanOffset(HOUR, doses, NOW), 0)
  assert.equal(caffeine.clampPanOffset(0, doses, NOW), 0)
  assert.equal(caffeine.clampPanOffset(-DAY, doses, NOW), -DAY)
})

test("the pan stops at the day of the oldest dose going back", () => {
  // A dose 50 hours ago needs the window two days back: centred there it
  // spans 36 to 60 hours ago, and three days back would span 60 to 84 and
  // miss it entirely.
  const doses = [at(50, 125), at(2, 95)]
  assert.equal(caffeine.panDaysAvailable(doses, NOW), 2)
  assert.equal(caffeine.clampPanOffset(-2 * DAY, doses, NOW), -2 * DAY)
  assert.equal(caffeine.clampPanOffset(-9 * DAY, doses, NOW), -2 * DAY)

  // The property, rather than the number — this is D64's actual promise, and
  // pinning it as an assertion is what stops the clamp drifting off it again.
  // The furthest-back window must *contain* the oldest dose; a stop one step
  // beyond it is a chart of nothing, which is the record of empty days D64
  // refuses to pan into.
  const halfWindow = caffeine.CURVE_WINDOW_HOURS * HOUR
  for (const hoursAgo of [13, 24, 25, 35, 36, 50, 71, 72, 73, 100, 240]) {
    const log = [at(hoursAgo, 125)]
    const floor = caffeine.clampPanOffset(-99 * DAY, log, NOW)
    const centre = NOW + floor
    const oldest = NOW - hoursAgo * HOUR
    assert.ok(oldest >= centre - halfWindow && oldest <= centre + halfWindow,
      `${hoursAgo}h back fell outside the furthest window`)
    // And it is the *furthest* such window: one more day back would lose it.
    assert.ok(oldest < centre - halfWindow + DAY || floor === 0,
      `${hoursAgo}h back stopped a day early`)
  }
})

// ------------------------------------------------- D105: the three framings

test("the three framings are three windows, and only one of them is about now", () => {
  const start = "07:00", end = "00:00"
  const at3pm = caffeine.previousClockSeconds(NOW, "15:00") // a fixed local 15:00

  const rolling = caffeine.frameWindowAt("rolling", at3pm, start, end)
  assert.equal(rolling.to - rolling.from, 24 * HOUR)
  assert.equal(rolling.anchor, at3pm)
  // The one property that makes it the rolling window: now is the middle.
  assert.equal(at3pm - rolling.from, rolling.to - at3pm)

  const day = caffeine.frameWindowAt("day", at3pm, start, end)
  assert.equal(day.to - day.from, 24 * HOUR)
  assert.equal(day.anchor, day.from)
  assert.equal(new Date(day.from * 1000).getHours(), 7)
  assert.ok(day.from <= at3pm && at3pm < day.to)

  const hours = caffeine.frameWindowAt("hours", at3pm, start, end)
  assert.equal(hours.anchor, hours.from)
  assert.equal(hours.from, day.from)
  assert.equal(hours.to - hours.from, 17 * HOUR)   // 07:00 to midnight

  // Junk is the rolling window, because that is the framing that is always
  // readable whatever else is wrong with the file.
  for (const junk of [undefined, null, "", "DAY-ish", 7, {}]) {
    assert.equal(caffeine.sanitizeFrame(junk), caffeine.FRAME_ROLLING, String(junk))
  }
  assert.equal(caffeine.sanitizeFrame("DAY"), caffeine.FRAME_DAY)
})

test("home is the window that contains now, which before the start time is yesterday's", () => {
  // The 3am case, and it is the one that decides whether `t` lands on a window
  // three quarters of which has not happened yet.
  const at3am = caffeine.previousClockSeconds(NOW, "03:00")
  const day = caffeine.frameWindowAt("day", at3am, "07:00", "00:00")
  assert.equal(new Date(day.from * 1000).getHours(), 7)
  assert.ok(day.from < at3am, "the day you are in began before you looked at it")
  assert.ok(at3am < day.to)
  assert.equal(caffeine.daysApartLocal(day.from, at3am), 1)   // it began yesterday

  // A start time late enough that the window's *centre* is the next day, which
  // is the case the anchor exists for: at 20:00 the middle is 08:00 tomorrow,
  // and a note written from this window must not be filed under tomorrow.
  const evening = caffeine.frameWindowAt("day", at3am, "20:00", "00:00")
  const centre = (evening.from + evening.to) / 2
  assert.notEqual(caffeine.dayKeyOf(centre), caffeine.dayKeyOf(evening.anchor))
  assert.equal(caffeine.dayKeyOf(evening.anchor), caffeine.dayKeyOf(evening.from))

  // And the third framing's gap: at 03:00 with 07:00-midnight the present is
  // on no chart at all, so home is the window that most recently *started* —
  // the day you have just finished, with now off its right-hand edge.
  const gap = caffeine.frameWindowAt("hours", at3am, "07:00", "00:00")
  assert.ok(gap.to < at3am, "the window you have just finished has ended")
  assert.equal(caffeine.daysApartLocal(gap.from, at3am), 1)
})

test("the span is the two clocks, and equal clocks mean a whole day", () => {
  const span = (s, e) => caffeine.frameSpanSeconds("hours", s, e) / HOUR
  assert.equal(span("07:00", "00:00"), 17)
  assert.equal(span("07:00", "23:00"), 16)
  assert.equal(span("20:00", "06:00"), 10)      // over midnight
  assert.equal(span("07:00", "07:00"), 24)      // "all of it"
  // The floor, which is about the axis being drawn in whole hours rather than
  // about what a sensible day is.
  assert.equal(span("07:00", "07:30"), caffeine.FRAME_MIN_SPAN_HOURS)
  // The other two framings are a day whatever the clocks say.
  assert.equal(caffeine.frameSpanSeconds("rolling", "07:00", "09:00"), 24 * HOUR)
  assert.equal(caffeine.frameSpanSeconds("day", "07:00", "09:00"), 24 * HOUR)
})

test("the key cycles the framings and the cycle comes back round", () => {
  assert.deepEqual(Array.from(caffeine.FRAMES), ["rolling", "day", "hours"])
  let frame = caffeine.FRAME_ROLLING
  const walk = []
  for (let i = 0; i < 4; i++) { frame = caffeine.nextFrame(frame, 1); walk.push(frame) }
  assert.deepEqual(walk, ["day", "hours", "rolling", "day"])
  assert.equal(caffeine.nextFrame("rolling", -1), "hours")
  assert.equal(caffeine.nextFrame("junk", 1), "day")
  // Every framing has a name, and no two share one.
  const names = Array.from(caffeine.FRAMES, (f) => caffeine.frameName(f))
  assert.equal(new Set(names).size, names.length)
  for (const name of names) assert.ok(name.length > 0)
})

test("the pan floor reaches the oldest dose in every framing", () => {
  // D64's promise, re-asserted against the arithmetic that has now been
  // written for it twice: the furthest window back must *contain* the oldest
  // dose. In an anchored framing "contain" means its start is at or before
  // that dose, because the window does not reach behind its own start.
  for (const hoursAgo of [13, 24, 25, 35, 50, 71, 73, 100, 240]) {
    const log = [at(hoursAgo, 125)]
    const oldest = NOW - hoursAgo * HOUR
    for (const frame of ["day", "hours"]) {
      const floor = caffeine.clampPanOffset(-99 * DAY, log, NOW, frame, "07:00")
      const window = caffeine.frameWindowAt(frame, NOW + floor, "07:00", "00:00")
      assert.ok(window.from <= oldest,
        `${frame}: ${hoursAgo}h back fell before the furthest window's start`)
      // And it is the furthest such window: one more day back would overshoot.
      const beyond = caffeine.frameWindowAt(frame, NOW + floor - DAY, "07:00", "00:00")
      assert.ok(beyond.from < oldest - DAY + HOUR || floor === 0,
        `${frame}: ${hoursAgo}h back stopped a day early`)
    }
  }
  // An absent frame is the rolling one, so nothing that already called this
  // with two arguments changed behaviour.
  const doses = [at(50, 125), at(2, 95)]
  assert.equal(caffeine.panDaysAvailable(doses, NOW),
    caffeine.panDaysAvailable(doses, NOW, "rolling", "07:00"))
})

test("the caption's total is the window on screen once the user has said what a day is", () => {
  // A coffee at 02:00 belongs to the calendar day it falls in and to the
  // *window* that opened at 07:00 the morning before. dayTotalMg answers the
  // first question and totalInRange the second, and the caption asks the
  // second one in an anchored framing because that is the chart it sits above.
  const twoAm = caffeine.previousClockSeconds(NOW, "02:00")
  const doses = [{ ts: twoAm, mg: 125 }, { ts: twoAm - 8 * HOUR, mg: 95 }]
  const window = caffeine.frameWindowAt("day", twoAm, "07:00", "00:00")

  assert.equal(caffeine.totalInRange(doses, window.from, window.to), 220)
  // The calendar day the window is anchored on holds only the earlier drink,
  // because the 02:00 one is the next date.
  assert.equal(caffeine.dayTotalMg(doses, window.anchor), 95)
  assert.equal(caffeine.totalInRange(doses, 0, 0), 0)
  assert.equal(caffeine.totalInRange(null, window.from, window.to), 0)
})

test("RECENT lists the drinks in the window it is handed, with the log's own indices", () => {
  // The whole point of the pair: `x` and the nudge chevrons act on
  // `entry.index`, so a row's index has to address the caller's array. A
  // helper that sorted, filtered or de-duplicated on the way out would delete
  // the wrong drink.
  const doses = [at(1, 95, "flat white"), at(30, 125, "cold brew"), at(31, 60, "tea")]
  const rows = caffeine.dosesInRange(doses, NOW - 24 * HOUR, null, 10)
  assert.deepEqual(Array.from(rows, (row) => row.index), [0])
  assert.equal(rows[0].dose, doses[0])

  // A window with both bounds is the panned case: yesterday's two drinks, and
  // not the one logged an hour ago.
  const yesterday = caffeine.dosesInRange(doses, NOW - 32 * HOUR, NOW - 24 * HOUR, 10)
  assert.deepEqual(Array.from(yesterday, (row) => row.index), [1, 2])
  assert.deepEqual(Array.from(yesterday, (row) => row.dose.label), ["cold brew", "tea"])

  // Half open at the top, the same as totalInRange: a drink at the instant a
  // window ends belongs to the next one, so a day step cannot show it twice.
  const edge = [{ ts: NOW - 24 * HOUR, mg: 95 }]
  assert.equal(caffeine.dosesInRange(edge, NOW - 32 * HOUR, NOW - 24 * HOUR, 10).length, 0)
  assert.equal(caffeine.dosesInRange(edge, NOW - 24 * HOUR, NOW, 10).length, 1)
})

test("RECENT's open right-hand end is what keeps a planned drink editable", () => {
  // D20 puts a dose in the future; the list is the only place it can be
  // nudged back or deleted. A null upper bound is that, and it is the home
  // case rather than a special case.
  const doses = [at(-3, 95, "planned"), at(2, 125, "drunk")]
  const rows = caffeine.dosesInRange(doses, NOW - 24 * HOUR, null, 10)
  assert.deepEqual(Array.from(rows, (row) => row.dose.label), ["planned", "drunk"])
  // Undefined reads as null, so a caller that simply omits the bound gets the
  // same list rather than an empty one.
  assert.equal(caffeine.dosesInRange(doses, NOW - 24 * HOUR, undefined, 10).length, 2)
})

test("RECENT stops at RECENT_ROWS rather than growing a scrolling region", () => {
  const doses = []
  for (let i = 0; i < 20; i++) doses.push(at(i, 95))
  assert.equal(caffeine.dosesInRange(doses, NOW - 24 * HOUR, null).length, caffeine.RECENT_ROWS)
  assert.equal(caffeine.dosesInRange(doses, NOW - 24 * HOUR, null, 3).length, 3)
  // The cap counts rows kept, not rows walked: a limit cannot be spent on
  // doses outside the window.
  const mixed = [at(-1, 95), at(40, 125), at(41, 60), at(2, 80)]
  assert.deepEqual(
    Array.from(caffeine.dosesInRange(mixed, NOW - 24 * HOUR, null, 2), (row) => row.index),
    [0, 3])
})

test("a calendar day is midnight to the next midnight, not 86400 seconds", () => {
  // Rounding the epoch to a multiple of 86400 is the version that is wrong on
  // the two days a year a local day is 23 or 25 hours long. Asserted as a
  // property rather than against a fixed zone, so it holds on any machine.
  for (const hoursAgo of [0, 5, 30, 200, 4000]) {
    const range = caffeine.dayRangeAt(NOW - hoursAgo * HOUR)
    const from = new Date(range.from * 1000)
    const to = new Date(range.to * 1000)
    assert.equal(from.getHours(), 0)
    assert.equal(to.getHours(), 0)
    assert.equal(from.getMinutes() + from.getSeconds(), 0)
    // One date later, whatever that cost in seconds.
    assert.equal(to.getDate(), new Date(from.getTime() + 26 * HOUR * 1000).getDate())
    assert.ok(Math.abs(range.to - range.from - DAY) <= HOUR)
  }
})

test("RECENT's rows and the caption's total are one statement about one day", () => {
  // The rolling caption reports the calendar day its window is centred on, so
  // the rows have to be that day's too. Read off the *window* instead and a
  // drink before the window opens is counted in the heading and missing from
  // the list underneath it — which is what this pins.
  const nine = localTs(2025, 8, 1, 9, 0)
  const doses = [
    { ts: nine + 5 * HOUR, mg: 125 },   // 14:00, inside a window centred at 21:00
    { ts: nine, mg: 100 },              // 09:00, on the window's very edge
    { ts: nine - 2 * HOUR, mg: 80 }     // 07:00, before it opens, same calendar day
  ]
  const centre = nine + 12 * HOUR
  const window = caffeine.frameWindowAt("rolling", centre, "07:00", "00:00")
  const range = caffeine.dayRangeAt(window.anchor)

  const rows = caffeine.dosesInRange(doses, range.from, range.to, 10)
  const listed = Array.from(rows, (row) => row.dose.mg).reduce((a, b) => a + b, 0)
  assert.equal(rows.length, 3)
  assert.equal(listed, caffeine.dayTotalMg(doses, window.anchor))

  // The window on its own opens at 09:00 and so drops the 07:00 drink: two
  // rows under a heading that says 305.
  assert.equal(caffeine.dosesInRange(doses, window.from, window.to, 10).length, 2)
})

test("RECENT survives a log it was handed junk in", () => {
  assert.equal(caffeine.dosesInRange(null, 0, null, 10).length, 0)
  assert.equal(caffeine.dosesInRange(undefined, 0, null, 10).length, 0)
  const doses = [null, { ts: "x", mg: 95 }, { ts: NOW, mg: 0 }, at(1, 95)]
  assert.deepEqual(
    Array.from(caffeine.dosesInRange(doses, NOW - 24 * HOUR, null, 10), (row) => row.index),
    [3])
})

test("the floor is a whole number of days, so a clamped pan stays on its grid", () => {
  const doses = [at(50, 125)]
  const floor = caffeine.clampPanOffset(-99 * DAY, doses, NOW)
  assert.equal(Math.abs(floor % DAY), 0)
})

test("an empty log cannot be panned at all", () => {
  assert.equal(caffeine.panDaysAvailable([], NOW), 0)
  assert.equal(caffeine.clampPanOffset(-DAY, [], NOW), 0)
  // Nor can one whose only dose is in the future, which D20 allows.
  assert.equal(caffeine.panDaysAvailable([at(-3, 125)], NOW), 0)
})

test("the pan never goes further back than retention keeps", () => {
  assert.equal(caffeine.panDaysAvailable([at(400 * 24, 125)], NOW),
    caffeine.RETENTION_DAYS)
})

test("junk offsets clamp rather than propagate", () => {
  const doses = [at(50, 125)]
  assert.equal(caffeine.clampPanOffset(NaN, doses, NOW), 0)
  assert.equal(caffeine.clampPanOffset(undefined, doses, NOW), 0)
  // An offset that is not a number means "no pan", not "pan as far as the
  // record goes" — a junk value must never be able to move the view.
  assert.equal(caffeine.clampPanOffset(-Infinity, doses, NOW), 0)
  assert.equal(caffeine.clampPanOffset("yesterday", doses, NOW), 0)
})

test("the day the window is centred on is what the caption names", () => {
  assert.equal(caffeine.formatDayOffset(NOW, NOW), "Today")
  assert.equal(caffeine.formatDayOffset(NOW + HOUR, NOW), "Today")
  assert.equal(caffeine.formatDayOffset(NOW - DAY, NOW), "Yesterday")
  assert.equal(caffeine.formatDayOffset(NOW - 3 * DAY, NOW), "3 days ago")
  // Local calendar days, not elapsed hours: a window centred six hours back
  // may or may not still be today, and the phrase follows the calendar.
  assert.equal(caffeine.daysApartLocal(NOW - DAY, NOW), 1)
  assert.equal(caffeine.daysApartLocal(NOW, NOW), 0)
})

test("a ghost is the same samples, moved by the shift", () => {
  const doses = [at(30, 125), at(26, 95)]
  const from = NOW - DAY - 12 * HOUR
  const to = NOW - DAY + 12 * HOUR
  const plain = caffeine.levelOverRange(doses, from, to, 5, 40)
  const moved = caffeine.levelOverRangeShifted(doses, from, to, 5, 40, DAY)

  assert.equal(moved.length, plain.length)
  for (let i = 0; i < moved.length; i++) {
    assert.equal(moved[i].ts, plain[i].ts + DAY)
    assert.equal(moved[i].mg, plain[i].mg)
  }
  // And it lands on the live window, which is the whole point of the shift.
  assert.ok(moved[0].ts >= NOW - 12 * HOUR - 1)
  assert.ok(moved[moved.length - 1].ts <= NOW + 12 * HOUR + 1)
})

test("a panned window still sums the doses from the days before it", () => {
  // The compute window is 96h and applies per sample, not per view. A dose
  // three days before the sample must still contribute to it, or panning back
  // would draw days that start from zero every midnight.
  const doses = [at(72, 400), at(30, 125)]
  const yesterday = NOW - DAY
  const withTail = caffeine.levelAt(doses, yesterday, 16)
  const alone = caffeine.levelAt([at(30, 125)], yesterday, 16)
  assert.ok(withTail > alone,
    "the 400mg dose two days earlier vanished from yesterday's level")
  assert.equal(caffeine.COMPUTE_WINDOW_HOURS, 96)
})

test("the day total is the local day the moment falls in", () => {
  const start = new Date(NOW * 1000)
  start.setHours(9, 0, 0, 0)
  const nine = Math.floor(start.getTime() / 1000)
  const doses = [
    { ts: nine, mg: 100, label: "in" },
    { ts: nine + 3 * HOUR, mg: 50, label: "in" },
    { ts: nine - 24 * HOUR, mg: 999, label: "out" },
    { ts: nine + 24 * HOUR, mg: 999, label: "out" }
  ]
  assert.equal(caffeine.dayTotalMg(doses, nine), 150)
  assert.equal(caffeine.dayTotalMg(doses, nine + 3 * HOUR), 150)
  assert.equal(caffeine.dayTotalMg(doses, nine - 24 * HOUR), 999)
  assert.equal(caffeine.dayTotalMg([], nine), 0)
})

test("a step is a day and a jump is a week", () => {
  assert.equal(caffeine.PAN_STEP_SECONDS, DAY)
  assert.equal(caffeine.PAN_JUMP_SECONDS, 7 * DAY)
})

test("the footer names the timeline keys once there is a curve to pan", () => {
  assert.ok(caffeine.formatKeyHint(true, 5).includes("[ ] days"))
  // Nothing to pan on a fresh install, and the line is at its limit already.
  assert.ok(!caffeine.formatKeyHint(false, 5).includes("[ ]"))
  // The failure this swap existed to fix was "? keys" falling off the end.
  // D94 removed the failure mode rather than the item: the pointer is a corner
  // now, so this line ends on the last thing that is actually a key.
  assert.ok(caffeine.formatKeyHint(true, 5).endsWith("s settings"))
  assert.ok(!caffeine.formatKeyHint(true, 5).includes("arrows move"))
})

// ------------------------------------------------------------------- notes
//
// D48/D65. The day key is the one piece of this that can be wrong in a way
// nobody notices for a month, so it is tested hardest: a note written at 23:30
// has to land on the day whose curve was on screen, which is the local day.

test("a day key is the local calendar day, not the UTC one", () => {
  const late = localTs(2026, 8, 2, 23, 30)   // 2 Sep 2026, 23:30 local
  assert.equal(caffeine.dayKeyOf(late), "2026-09-02")
  const early = localTs(2026, 8, 3, 0, 30)   // half an hour later
  assert.equal(caffeine.dayKeyOf(early), "2026-09-03")
  // Zero-padded both ends, because the keys are sorted as strings.
  assert.equal(caffeine.dayKeyOf(localTs(2026, 0, 5, 12, 0)), "2026-01-05")
})

test("a day key round-trips through noon", () => {
  for (const key of ["2026-09-02", "2026-01-01", "2026-12-31", "2026-03-29"]) {
    const ts = caffeine.dayKeyTs(key)
    assert.ok(ts !== null, key)
    assert.equal(caffeine.dayKeyOf(ts), key)
    // Noon: the one hour that survives every DST transition on earth, so a
    // key cannot come back as the day before.
    assert.equal(new Date(ts * 1000).getHours(), 12)
  }
})

test("a day key that is not a day is refused", () => {
  for (const junk of ["", "2026-13-01", "2026-02-31", "2026-00-10", "20260902",
                      "2026-09-2", "yesterday", null, undefined, 17, "2026-09-32"])
    assert.equal(caffeine.dayKeyTs(junk), null, String(junk))
  assert.equal(caffeine.isDayKey("2026-09-02"), true)
  assert.equal(caffeine.isDayKey("2026-02-30"), false)
})

test("a note is sanitised on the way in, and junk degrades to no notes", () => {
  const clean = caffeine.sanitizeNotes({
    "2026-09-02": { flagged: true, text: "  Two cold brews.  ", updated: 1788383549 },
    "2026-09-01": { flagged: true, text: "", updated: 1 },
    "2026-08-31": { flagged: false, text: "", updated: 1 },   // neither: dropped
    "2026-08-30": { text: "words but no flag" },              // text implies the mark
    "not-a-day": { flagged: true, text: "x" },
    "2026-08-29": "a string",
    "2026-08-28": null
  })
  assert.deepEqual(Object.keys(clean).sort(),
    ["2026-08-30", "2026-09-01", "2026-09-02"])
  assert.equal(clean["2026-09-02"].text, "Two cold brews.")
  assert.equal(clean["2026-09-01"].flagged, true)
  assert.equal(clean["2026-08-30"].flagged, true)

  // Anything that is not an object of days is no notes, with the shell alive.
  for (const junk of [null, undefined, 17, "text", [1, 2, 3], []])
    assert.deepEqual(Object.keys(caffeine.sanitizeNotes(junk)), [])
})

test("a note's text is capped rather than refused", () => {
  const long = "x".repeat(caffeine.NOTE_TEXT_MAX + 250)
  const clean = caffeine.sanitizeNotes({ "2026-09-02": { flagged: true, text: long } })
  assert.equal(clean["2026-09-02"].text.length, caffeine.NOTE_TEXT_MAX)
})

test("writing a note marks the day, and empty text still marks it", () => {
  const now = NOW
  let notes = caffeine.writeNote({}, "2026-09-02", "Slept fine.", now)
  assert.equal(notes["2026-09-02"].text, "Slept fine.")
  assert.equal(notes["2026-09-02"].updated, now)

  // D65: pressing the key on a day is the marking gesture, so committing
  // nothing marks the day without words rather than deleting it. Removing one
  // is x on the notes page, which is where the drinks are removed too.
  notes = caffeine.writeNote(notes, "2026-09-01", "   ", now)
  assert.equal(notes["2026-09-01"].flagged, true)
  assert.equal(notes["2026-09-01"].text, "")
  assert.equal(Object.keys(notes).length, 2)

  // Rewriting replaces rather than appends.
  notes = caffeine.writeNote(notes, "2026-09-02", "Actually slept badly.", now + 60)
  assert.equal(notes["2026-09-02"].text, "Actually slept badly.")
  assert.equal(Object.keys(notes).length, 2)

  // A key that is not a day changes nothing.
  assert.deepEqual(Object.keys(caffeine.writeNote(notes, "nope", "x", now)).sort(),
    ["2026-09-01", "2026-09-02"])

  notes = caffeine.removeNote(notes, "2026-09-01")
  assert.deepEqual(Object.keys(notes), ["2026-09-02"])
  // Removing one that is not there is not an error.
  assert.deepEqual(Object.keys(caffeine.removeNote(notes, "2026-01-01")), ["2026-09-02"])
})

test("the noted days come back newest first", () => {
  const notes = {
    "2026-08-30": { flagged: true, text: "c" },
    "2026-09-02": { flagged: true, text: "a" },
    "2026-09-01": { flagged: true, text: "b" }
  }
  const entries = caffeine.noteEntries(notes)
  assert.deepEqual(Array.from(entries, (e) => e.day),
    ["2026-09-02", "2026-09-01", "2026-08-30"])
  assert.deepEqual(Array.from(entries, (e) => e.text), ["a", "b", "c"])
  assert.equal(caffeine.dayKeyOf(entries[0].ts), "2026-09-02")
  assert.equal(caffeine.noteFor(notes, "2026-09-01").text, "b")
  assert.equal(caffeine.noteFor(notes, "2026-01-01"), null)
})

test("a note outlives its doses, and the row says so instead of inventing one", () => {
  // The reason notes.json is its own file: doses.json is pruned to 30 days
  // and the note is not. A day before the oldest dose on file has no total and
  // no verdict to state, and stating them anyway would print "0 mg · clear for
  // sleep" about a day the plugin threw away.
  const doses = [at(24, 125), at(20 * 24, 95)]
  const oldest = NOW - 20 * 24 * HOUR
  assert.equal(caffeine.dayRecordKept(doses, NOW - 24 * HOUR), true)
  assert.equal(caffeine.dayRecordKept(doses, oldest), true)
  assert.equal(caffeine.dayRecordKept(doses, oldest - DAY), false)
  // An empty log knows nothing about any day.
  assert.equal(caffeine.dayRecordKept([], NOW), false)
  assert.ok(caffeine.formatNoteExpired().includes(String(caffeine.RETENTION_DAYS)))
})

test("a noted day's verdict is that day's bedtime, not tonight's", () => {
  const nine = localTs(2026, 8, 2, 9, 0)      // 2 Sep, 9am
  const doses = [{ ts: nine, mg: 400, label: "big" }]
  const day = caffeine.dayKeyTs("2026-09-02")
  const bed = caffeine.dayBedtime(doses, day, 5, "23:00", 30)
  // The night that day started, not the next occurrence from now.
  assert.equal(bed.at, localTs(2026, 8, 2, 23, 0))
  assert.ok(bed.mg > 0)
  assert.equal(bed.band, caffeine.bedtimeBand(bed.mg, 30))

  // A day with nothing on it is clear, and that is a true statement about a
  // day inside the record.
  const quiet = caffeine.dayBedtime(doses, caffeine.dayKeyTs("2026-09-01"), 5, "23:00", 30)
  assert.equal(quiet.band, "clear")
})

test("a noted day's summary states the record and never interprets it", () => {
  const line = caffeine.formatNoteSummary("467 mg", "27 mg", "11:00 PM",
    caffeine.verdictFor("clear", false))
  assert.equal(line, "467 mg logged  ·  27 mg at 11:00 PM, clear for sleep")
  // D13's limit, held as a test rather than as a comment: nothing in this
  // feature's copy advises, scores or draws a conclusion.
  const copy = [line, caffeine.formatNoteExpired(), caffeine.formatNotesHint(),
                caffeine.NOTE_EMPTY_TEXT, caffeine.NOTE_PLACEHOLDER,
                caffeine.formatNoteText("anything")].join(" ").toLowerCase()
  for (const claim of ["suggest", "should", "try ", "avoid", "recommend",
                       "average", "trend", "score", "better", "worse"])
    assert.ok(!copy.includes(claim), "the notes copy says '" + claim + "'")
})

test("a note is quoted so the plugin's words and yours are apart", () => {
  assert.equal(caffeine.formatNoteText("Slept fine."), "“Slept fine.”")
  assert.equal(caffeine.formatNoteText("   "), "")
  assert.equal(caffeine.formatNoteText(undefined), "")
})

test("a noted day is named the way the chart's caption names it", () => {
  const today = caffeine.dayKeyOf(NOW)
  assert.equal(caffeine.formatNoteOffset(today, NOW), "Today")
  assert.equal(caffeine.formatNoteOffset(caffeine.dayKeyOf(NOW - DAY), NOW), "Yesterday")
  assert.equal(caffeine.formatNoteOffset(caffeine.dayKeyOf(NOW - 5 * DAY), NOW), "5 days ago")
  assert.equal(caffeine.formatNoteOffset("junk", NOW), "")
})

test("the notes legend does not offer rows that are not there", () => {
  // D40's rule, applied to the fifth page: the empty state's line must not
  // offer to walk, enter and remove a list that has nothing in it.
  const full = caffeine.formatNotesHint(true)
  for (const item of ["↑ ↓ move", "↵ go to that day", "x remove", "Esc back"])
    assert.ok(full.includes(item), item)
  assert.ok(full.endsWith("Esc back"))

  const empty = caffeine.formatNotesHint(false)
  for (const gone of ["move", "that day", "remove"]) assert.ok(!empty.includes(gone))
  assert.ok(empty.includes("Esc back"))
  // On an empty page the way out is the whole line, and since D94 it is also
  // the whole line's last item.
  assert.equal(empty, "Esc back")
})

// ----------------------------------------------- D88: the drink grid
//
// D81's tests, amended in place rather than added beside — the walk they were
// written for no longer exists. The screen these assertions are about: the
// Grid is six columns wide and **every cell of it is a cell of the cursor's
// grid too**, so slot 5 is the "+ More" toggle, slots 0–4 are the main row and
// slots 6+ are the overflow. A shut grid is six cells (five drinks and the
// toggle); thirteen drinks open is fourteen cells, seventeen is eighteen —
// exactly three full rows, which is where CATALOG_MAX comes from.
//
// **The gain is the special case this deletes.** D81's walk took a
// `mainRowSize` as well as a `columns` because its first row was one narrower
// than the rest; there is no such row now, and `drinkGridCell` is one divide.
const MAIN = 5
const WIDE = 6
const step = (count, slot, dx, dy) => presets.drinkGridMove(count, slot, dx, dy, WIDE)
const cell = slot => presets.drinkGridCell(slot, WIDE)
// Cells, not drinks: what the panel hands the walk.
const CELLS_11 = presets.drinkSlotCount(MAIN, 6, true)    // 12
const CELLS_15 = presets.drinkSlotCount(MAIN, 10, true)   // 16
const CELLS_17 = presets.drinkSlotCount(MAIN, 12, true)   // 18

test("every row of the grid is the same width, which is D88's whole gain", () => {
  assert.deepEqual(plain(cell(0)), { row: 0, column: 0 })
  assert.deepEqual(plain(cell(4)), { row: 0, column: 4 })
  // (0, 5) is the "+", and it is a cell like any other now.
  assert.deepEqual(plain(cell(5)), { row: 0, column: 5 })
  assert.deepEqual(plain(cell(6)), { row: 1, column: 0 })
  assert.deepEqual(plain(cell(11)), { row: 1, column: 5 })
  assert.deepEqual(plain(cell(12)), { row: 2, column: 0 })
  assert.deepEqual(plain(cell(17)), { row: 2, column: 5 })
})

test("a slot is a cell and a catalog position is a drink, and they differ past the +", () => {
  assert.equal(presets.catalogIndexForSlot(0, MAIN), 0)
  assert.equal(presets.catalogIndexForSlot(4, MAIN), 4)
  assert.equal(presets.catalogIndexForSlot(5, MAIN), null)   // the toggle
  assert.equal(presets.catalogIndexForSlot(6, MAIN), 5)
  assert.equal(presets.catalogIndexForSlot(17, MAIN), 16)
  assert.ok(presets.drinkSlotIsToggle(5, MAIN))
  assert.ok(!presets.drinkSlotIsToggle(4, MAIN))
  assert.ok(!presets.drinkSlotIsToggle(6, MAIN))
  // Round-trips, which is the property that keeps the digits and the cursor
  // from drifting apart.
  for (let i = 0; i < 17; i++)
    assert.equal(presets.catalogIndexForSlot(presets.slotForCatalogIndex(i, MAIN), MAIN), i)
  // Junk is refused rather than answered with zero (correction 20).
  assert.equal(presets.catalogIndexForSlot(null, MAIN), null)
  assert.equal(presets.slotForCatalogIndex(null, MAIN), null)
  // A short catalog puts the toggle wherever the main row ends.
  assert.ok(presets.drinkSlotIsToggle(3, 3))
  assert.equal(presets.catalogIndexForSlot(4, 3), 3)
})

test("the grid is the main row, the toggle, and the overflow when it is open", () => {
  assert.equal(presets.drinkSlotCount(MAIN, 8, false), 6)
  assert.equal(presets.drinkSlotCount(MAIN, 8, true), 14)
  assert.equal(presets.drinkSlotCount(3, 0, true), 4)
  assert.equal(presets.drinkSlotCount(null, null, true), 1)
})

test("right from the last drink of the main row reaches the +, which is D88's ask", () => {
  // The user's own case: → off Tea, the fifth pill, lands on "+ More".
  assert.equal(step(6, 4, 1, 0), 5)
  assert.ok(presets.drinkSlotIsToggle(step(6, 4, 1, 0), MAIN))
  // And with the overflow open it carries on into the first overflow drink.
  assert.equal(step(CELLS_11, 5, 1, 0), 6)
  assert.equal(step(CELLS_11, 6, -1, 0), 5)
  // With the overflow shut the "+" is the end of the grid and stops it.
  assert.equal(step(6, 5, 1, 0), 5)
})

test("up from the last drink of the second row reaches − Less, not the last drink", () => {
  // The user's other case: Matcha is the sixth of the second row at thirteen
  // drinks — slot 11 — and above it is the toggle, not slot 4.
  assert.equal(step(CELLS_11, 11, 0, -1), 5)
  assert.ok(presets.drinkSlotIsToggle(step(CELLS_11, 11, 0, -1), MAIN))
  // Down off the toggle goes back to it, which is the same fact read forwards.
  assert.equal(step(CELLS_11, 5, 0, 1), 11)
})

test("down from a drink keeps its column instead of going home", () => {
  // D81's reported defect, and the numbers move by one because the "+" is now
  // in the count: Tea is the fourth pill, and down is the fourth of row two.
  assert.equal(step(CELLS_11, 3, 0, 1), 9)
  assert.equal(step(CELLS_11, 0, 0, 1), 6)
  assert.equal(step(CELLS_11, 4, 0, 1), 10)
  assert.equal(step(CELLS_11, 9, 0, -1), 3)
  assert.equal(step(CELLS_11, 6, 0, -1), 0)
})

test("down inside the overflow moves down a row, which it never did", () => {
  assert.equal(step(CELLS_15, 6, 0, 1), 12)
  assert.equal(step(CELLS_15, 7, 0, 1), 13)
  assert.equal(step(CELLS_15, 9, 0, 1), 15)
  assert.equal(step(CELLS_15, 12, 0, -1), 6)
})

test("every cell of a full seventeen-drink catalog is reachable downward", () => {
  const seen = new Set()
  for (let start = 0; start < CELLS_17; start++) {
    let at = start
    seen.add(at)
    for (let guard = 0; guard < 8 && at !== null; guard++) {
      at = step(CELLS_17, at, 0, 1)
      if (at !== null) seen.add(at)
    }
  }
  assert.equal(seen.size, CELLS_17)
  // Seventeen drinks is exactly three rows of six with the toggle in them,
  // which is the whole reason the cap is seventeen.
  assert.equal(CELLS_17, 18)
  assert.equal(cell(CELLS_17 - 1).row, 2)
})

test("a column past the end of a ragged last row lands on its last cell", () => {
  // Fifteen drinks open is sixteen cells: the third row holds four (12..15),
  // so columns 4 and 5 have no cell there.
  assert.equal(step(CELLS_15, 11, 0, 1), 15)
  assert.equal(step(CELLS_15, 10, 0, 1), 15)
  assert.equal(step(CELLS_15, 9, 0, 1), 15)
})

test("leaving the grid is null, and only at the two edges", () => {
  assert.equal(step(CELLS_11, 2, 0, -1), null)
  assert.equal(step(CELLS_11, 7, 0, 1), null)
  assert.equal(step(CELLS_15, 14, 0, 1), null)
  // With the overflow shut there is one row, and down leaves it at once —
  // including from the "+" itself.
  assert.equal(step(6, 2, 0, 1), null)
  assert.equal(step(6, 5, 0, 1), null)
  assert.equal(step(6, 2, 0, -1), null)
})

test("across walks the whole grid in the order it is drawn", () => {
  assert.equal(step(CELLS_11, 11, 1, 0), 11)
  assert.equal(step(CELLS_11, 0, -1, 0), 0)
})

test("the grid walk refuses junk rather than answering zero", () => {
  assert.equal(step(0, 0, 0, 1), null)
  assert.equal(step(CELLS_11, null, 1, 0), 1)
  assert.equal(step(CELLS_11, 3, null, null), 3)
  // A slot past the end clamps into the grid rather than escaping it.
  assert.equal(step(CELLS_11, 99, 0, -1), 5)
  assert.equal(presets.drinkGridMove("x", 0, 0, 1, WIDE), null)
})

test("the cursor's grid is the one the panel draws", () => {
  // D39, and D88: six columns, and the "+" is the sixth cell of the first row
  // — which is only true while the main row is five. If either moves, this
  // walk is describing a screen that is no longer there.
  assert.equal(presets.MAIN_ROW_SIZE, MAIN)
  assert.equal(presets.MAIN_ROW_SIZE + 1, WIDE)
  assert.ok(presets.drinkSlotIsToggle(WIDE - 1, presets.MAIN_ROW_SIZE))
  // D88's cap is arithmetic about that grid rather than a round number, and
  // D97 moved it a row at a time: three rows was seventeen, five is 29.
  assert.equal(presets.CATALOG_MAX, 29)
  assert.equal(presets.CATALOG_MAX, WIDE * 5 - 1)
  // The shipped catalog is seventeen since D96, so a new install fills exactly
  // three rows and the walk has to be right about it out of the box — this is
  // the state the ragged one used to be, and the last row is now the full one.
  assert.equal(presets.DEFAULTS.length, 17)
  const shipped = presets.drinkSlotCount(MAIN, presets.DEFAULTS.length - MAIN, true)
  assert.equal(shipped, 18)
  assert.equal(cell(shipped - 1).row, 2)
  assert.equal(cell(shipped - 1).column, WIDE - 1)
  // Down from the last cell of the middle row lands under it rather than
  // clamping, because the third row is full now.
  assert.equal(step(shipped, 11, 0, 1), 17)
})

test("coming up into the drinks lands on the row they end on", () => {
  // Six cells is one row; twelve is two; sixteen is three.
  assert.equal(presets.drinkGridLastRowStart(6, WIDE), 0)
  assert.equal(presets.drinkGridLastRowStart(CELLS_11, WIDE), 6)
  assert.equal(presets.drinkGridLastRowStart(CELLS_15, WIDE), 12)
  assert.equal(presets.drinkGridLastRowStart(0, WIDE), 0)
})

test("the only definition of a cup there is says what it is and not how big", () => {
  // D84 retired the volume. The estimate note is the whole of what the panel
  // says a cup is, so this is the copy that carries the definition — and in
  // milligrams there is nothing to define.
  const note = (units, cup) => caffeine.formatEstimateNote(5, units, cup)
  assert.equal(note("mg"), "Estimated from a half-life of 5 hours — yours may differ.")
  assert.match(note("cups"), /A cup here is 100 mg\.$/)
  assert.match(note("cups", 145), /A cup here is 145 mg\.$/)
  assert.match(note("cups", 9000), new RegExp(`A cup here is ${caffeine.CUP_MAX_MG} mg\\.$`))
  // No volume anywhere in it, in either unit: naming one invites the
  // comparison the unit cannot win.
  for (const units of ["mg", "cups"]) assert.doesNotMatch(note(units), /ml|fl oz/)
})

test("the about card carries a build and the two addresses, in that order", () => {
  // The card's Repeater reads `label` and `value` off each row, so the shape
  // is load-bearing in a way the strings are not. tests/run pins the strings
  // to manifest.json and the README; this pins what the QML destructures.
  const rows = caffeine.aboutRows()
  assert.deepEqual(Array.from(rows, (row) => row.label), ["version", "updates", "source"])
  for (const row of rows) assert.ok(row.value.length > 0, `${row.label} has no value`)
  assert.equal(rows[0].value, caffeine.VERSION)
  assert.equal(rows[1].value, caffeine.AUTHOR_URL)
  assert.equal(rows[2].value, caffeine.SHARE_URL)

  // The note is the only thing on the card that says why there are two
  // addresses rather than one, so it has to distinguish them.
  const note = caffeine.formatAboutNote()
  assert.match(note, /feed/)
  assert.match(note, /repo/i)
})

test("a share lands beside the shell's own screenshots and sorts with them", () => {
  // Omarchy writes `screenshot-YYYY-MM-DD_HH-MM-SS.png` into the same
  // directory, so ours takes the same shape with its own stem: the two sort
  // together by name, and a glance tells them apart.
  const at = localTs(2025, 8, 1, 7, 5)
  assert.equal(caffeine.shareFileName(at), "caffeine-curve-2025-09-01_07-05-00.png")
  // Every field zero-padded, including the one that is only ever wrong at
  // single digits.
  assert.match(caffeine.shareFileName(localTs(2025, 11, 9, 0, 0)),
    /^caffeine-curve-2025-12-09_00-00-00\.png$/)
})

test("the week is seven calendar days ending today, oldest first", () => {
  const days = caffeine.weekDays(NOW)
  assert.equal(days.length, 7)
  // Today is the most right: the last entry holds now.
  const today = days[days.length - 1]
  assert.ok(today.from <= NOW && NOW < today.to)
  // The most left is today minus six days.
  assert.equal(caffeine.daysApartLocal(days[0].ts, NOW), 6)
  // Each day is midnight to midnight, contiguous, in order.
  for (let i = 0; i < days.length; i++) {
    const from = new Date(days[i].from * 1000)
    assert.equal(from.getHours(), 0)
    assert.ok(days[i].from < days[i].to)
    if (i > 0) assert.equal(days[i].from, days[i - 1].to)
    if (i > 0) assert.ok(days[i].ts > days[i - 1].ts)
  }
  // Junk degrades rather than throwing inside the shell process.
  assert.equal(caffeine.weekDays(undefined).length, 7)
})

test("each weekly bar holds that day's drinks in order, plus its total", () => {
  const noon = localTs(2025, 8, 3, 12, 0)
  const dayOf = (y, m, d, h, min, mg) =>
    ({ ts: localTs(y, m, d, h, min), mg, label: "test" })
  const doses = [
    dayOf(2025, 8, 3, 8, 0, 95),    // today, earliest
    dayOf(2025, 8, 3, 15, 30, 125), // today, latest
    dayOf(2025, 8, 2, 23, 59, 60),  // yesterday, still yesterday
    dayOf(2025, 8, 2, 0, 0, 40),    // yesterday at midnight opens the day
    dayOf(2025, 7, 28, 9, 0, 200),  // six days back: the first bar
    dayOf(2025, 7, 27, 9, 0, 999),  // seven days back: off the left edge
  ]
  const week = caffeine.weekDayDoses(doses, noon)
  assert.equal(week.length, 7)
  // Oldest first, today last.
  assert.equal(caffeine.daysApartLocal(week[0].ts, noon), 6)
  assert.ok(week[6].from <= noon && noon < week[6].to)
  // Today: two drinks oldest first, totalling both.
  assert.deepEqual(Array.from(week[6].doses, (d) => d.mg), [95, 125])
  assert.equal(week[6].total, 220)
  // Yesterday: midnight belongs to the day it starts.
  assert.deepEqual(Array.from(week[5].doses, (d) => d.mg), [40, 60])
  assert.equal(week[5].total, 100)
  // The first bar is six days back; anything older is not on the chart.
  assert.equal(week[0].total, 200)
  assert.deepEqual(Array.from(week[0].doses, (d) => d.mg), [200])
  // A quiet day in the middle is a real empty day, not a missing one.
  assert.equal(week[3].total, 0)
  assert.deepEqual(Array.from(week[3].doses), [])
  // The week total is the seven bars added up, and junk is an empty week.
  assert.equal(caffeine.weekTotalMg(doses, noon), 520)
  assert.equal(caffeine.weekTotalMg([], noon), 0)
  assert.equal(caffeine.weekDayDoses(null, noon).length, 7)
})

test("the weekly bars pan back to the oldest dose's week and no further", () => {
  const noon = localTs(2025, 8, 3, 12, 0)
  const dayOf = (y, m, d, h, min, mg) =>
    ({ ts: localTs(y, m, d, h, min), mg, label: "test" })

  // Nothing to go back to: an empty log, a log of only today, or only future.
  assert.equal(caffeine.weekPanDaysAvailable([], noon), 0)
  assert.equal(caffeine.weekPanDaysAvailable([dayOf(2025, 8, 3, 8, 0, 95)], noon), 0)
  assert.equal(caffeine.weekPanDaysAvailable(
    [{ ts: noon + HOUR, mg: 95, label: "planned" }], noon), 0)

  // Six calendar days back means six days of pan: a day step per press.
  const doses = [dayOf(2025, 7, 28, 9, 0, 200)]
  assert.equal(caffeine.weekPanDaysAvailable(doses, noon), 6)

  // The furthest week back still holds the oldest dose, on its last bar.
  const far = noon - 6 * DAY
  const farWeek = caffeine.weekDayDoses(doses, far)
  assert.deepEqual(Array.from(farWeek[6].doses, (d) => d.mg), [200])
  assert.equal(caffeine.weekTotalMg(doses, far), 200)
  // And a week past that is out of the record entirely.
  assert.equal(caffeine.weekTotalMg(doses, noon - 13 * DAY), 0)

  // The floor is a whole number of days, so a panned week stays on its
  // weekday grid, and it never reaches past what retention keeps.
  assert.equal(caffeine.weekPanDaysAvailable([dayOf(2025, 7, 28, 9, 0, 200)], noon) % 1, 0)
  assert.equal(caffeine.weekPanDaysAvailable(
    [{ ts: noon - 400 * DAY, mg: 125, label: "old" }], noon),
    caffeine.RETENTION_DAYS)
})

test("weekly offsets clamp rather than propagate", () => {
  const noon = localTs(2025, 8, 3, 12, 0)
  const doses = [{ ts: localTs(2025, 7, 28, 9, 0), mg: 200, label: "test" }]
  // Forward stops at today, whatever was asked for.
  assert.equal(caffeine.clampWeekOffset(DAY, doses, noon), 0)
  assert.equal(caffeine.clampWeekOffset(0, doses, noon), 0)
  // Inside the record the offset passes through untouched.
  assert.equal(caffeine.clampWeekOffset(-3 * DAY, doses, noon), -3 * DAY)
  // Past the oldest dose's week it stops at that week.
  assert.equal(caffeine.clampWeekOffset(-99 * DAY, doses, noon), -6 * DAY)
  // An empty log cannot be panned at all, and junk means no pan.
  assert.equal(caffeine.clampWeekOffset(-DAY, [], noon), 0)
  assert.equal(caffeine.clampWeekOffset(NaN, doses, noon), 0)
  assert.equal(caffeine.clampWeekOffset(undefined, doses, noon), 0)
  assert.equal(caffeine.clampWeekOffset(-Infinity, doses, noon), 0)
  assert.equal(caffeine.clampWeekOffset("yesterday", doses, noon), 0)
})

test("a share is stamped in local time, like everything else on the card", () => {
  // The file sits beside a curve labelled in wall-clock hours. A UTC stamp
  // would be the one thing in the picture disagreeing with the rest of it —
  // and would file a European evening under tomorrow, which is dayKeyOf's own
  // argument, reused here rather than restated.
  const evening = localTs(2025, 8, 1, 23, 30)
  assert.match(caffeine.shareFileName(evening), /^caffeine-curve-2025-09-01_23-30-00\.png$/)
  assert.equal(caffeine.shareFileName(evening).slice("caffeine-curve-".length, -"_23-30-00.png".length),
    caffeine.dayKeyOf(evening))
})
