// Pharmacokinetics for Caffeine Curve.
//
// Deliberately free of QML types so the maths can be exercised under plain
// `node --test` — tests/caffeine.test.mjs loads this file into a vm context.
// Nothing in here may reach for Qt, Quickshell, or console.

// Absorption rate, /hour. Puts Tmax at ~48 min, which is where the literature
// puts oral caffeine.
var ABSORPTION_RATE = 4.5

// Half-life bounds exposed in settings. 2h is a fast metaboliser who smokes;
// the ceiling has to hold the largest figure the science notes actually
// measure, which is late pregnancy at "15h+ late" - so 16h, widened from 12
// at Phase 10 when the profile started deriving numbers the old ceiling
// silently swallowed. The profile still reaches it and clamps rather than
// pretending to model what is above it: slow clearance, the pill, the third
// trimester and heavy drinking together derive 60 hours.
var HALF_LIFE_MIN_HOURS = 2
var HALF_LIFE_MAX_HOURS = 16
var HALF_LIFE_DEFAULT_HOURS = 5

// Sum over four days of doses even though only 12h is ever drawn. At a 12h
// half-life a 24h window silently discards a quarter of yesterday's coffee.
//
// The number here is a function of the ceiling above and was written when the
// ceiling was 12h, where 72h left 1.6% behind. At 16h that same 72h leaves
// 4.4%, so the window moved with the ceiling: 96h at 16h is 1.6% again, which
// is the guarantee the comment was actually making. RETENTION_DAYS (30) is far
// wider than either, so this costs a few dozen more numbers and nothing else.
var COMPUTE_WINDOW_HOURS = 96

// Dose log retention.
var RETENTION_DAYS = 30

// Bedtime bands, in mg still on board at bedtime. Derived in
// plan/caffeine-curve-science.md from dose x hours-before-bed trials: the two
// independent safe-cutoff figures converge at ~31-35mg, and the 400mg-at-12h
// condition that still disrupted sleep sits at 76mg.
//
// Since Phase 8 the lower figure is a setting - the one number the whole
// verdict pivots on, and the one a person who sleeps badly on half a cup has
// every reason to move. The upper band is derived from it rather than settable
// separately: two numbers would let someone order them backwards, and the
// shipped pair is 30/60 either way.
var BEDTIME_CLEAR_MG = 30
var BEDTIME_MARGINAL_MULTIPLE = 2
var BEDTIME_MARGINAL_MG = BEDTIME_CLEAR_MG * BEDTIME_MARGINAL_MULTIPLE

// The bounds the threshold is clamped to. 10mg is below anything the trials
// could measure and 100mg is the dose the studies themselves call strong, so
// the range spans "I notice a decaf" to "only a real coffee counts".
var SLEEP_THRESHOLD_MIN_MG = 10
var SLEEP_THRESHOLD_MAX_MG = 100
var SLEEP_THRESHOLD_STEP_MG = 5

// The line the studies actually measured, as opposed to the residual estimate.
var STRONG_DOSE_MG = 100

// ------------------------------------------------------------------- sharing
//
// What the share card signs itself with. A capture that travels off this
// machine is the one thing the plugin produces that has to say what it is —
// everywhere else the panel is already inside a bar that identifies it, and a
// PNG on someone else's timeline is not.
//
// Both are the manifest's own fields, restated here because a JS resource
// cannot read the manifest and a card that names the plugin something else is
// worse than one that names it nothing. tests/run asserts the pair still
// matches manifest.json, so the duplication cannot rot.
var SHARE_NAME = "Caffeine Curve"
var SHARE_URL = "github.com/latecompile/omarchy-caffeine-curve"

// The saved file's name. Omarchy's own screenshots are
// `screenshot-YYYY-MM-DD_HH-MM-SS.png` and these land in the same directory,
// so they take the same shape with our own stem: sorted together, told apart
// at a glance, and never colliding with a capture taken in the same second by
// the shell.
//
// Local time, not UTC. It sits beside a curve labelled in wall-clock hours,
// and a file stamped an hour off the evening it is about would be the one
// thing on the card that disagrees with the rest of it.
function shareFileName(atSeconds) {
  var when = new Date(toSeconds(atSeconds) * 1000)
  var pad = function(n) { return (n < 10 ? "0" : "") + n }
  // dayKeyOf and not a third hand-rolled calendar date: it is this file's one
  // answer to "which local day is this timestamp", DST reasoning included.
  return "caffeine-curve-" + dayKeyOf(atSeconds)
    + "_" + pad(when.getHours()) + "-" + pad(when.getMinutes())
    + "-" + pad(when.getSeconds())
    + ".png"
}

// How long after the bedtime clock a dose is still "tonight". Past this the
// dose belongs to the day that has started rather than to the night that has
// not ended, and the panel goes back to counting down to the next bedtime.
// Four hours, because at 3am with a 23:00 bedtime "4h after bedtime" is still
// the useful reading and at 5am "18h before bed" has become one.
var LATE_DOSE_HOURS = 4

// The bedtime a fresh install starts from, and what an unreadable one falls
// back to. Stated as the string that goes in the file rather than as an hour,
// because that is the form both the helper script and the README quote.
var BEDTIME_DEFAULT = "23:00"

// Purely a visual cue for the bar mark. No claim attached to it.
var DIM_THRESHOLD_MG = 20

// The cup reads full at the peak of one large coffee. Anything bigger raises
// the scale rather than overflowing.
var REFERENCE_DOSE_MG = 150

// How much of the day the panel draws, each side of now. Also the forward
// limit on a dose nudge: past this the dose is off the chart, and a control
// that keeps responding while nothing on screen changes reads as broken.
var CURVE_WINDOW_HOURS = 12

// =============================================================== motion
//
// Phase 13 audited every animation in the plugin as one system rather than as
// five decisions taken four phases apart. What it found was three durations
// within 160ms of each other — 400 for the bar mark's acknowledgement, 420 for
// the hero cup, 560 for the curve's entrance — reached separately, and two
// more (60 and 90) that were the same idea at two numbers. Nothing was wrong;
// nothing was decided either.
//
// So there are five durations and each one names a *kind* of change, not a
// place. A new animation picks the kind it is and takes that number; if it is
// none of these five, that is the argument for a sixth and it gets written
// down here beside the others.
//
//   TINT    a colour changing under the cursor. Short enough that the eye
//           reads a state rather than a movement — the point is only that a
//           highlight does not snap.
//   REVEAL  something appearing or leaving on hover: the dose row's chevrons,
//           the hero's units hairline. One frame longer than TINT, because an
//           opacity that crosses zero is a thing arriving rather than a thing
//           changing.
//   PAGE    one page of the panel replacing another. The only motion in the
//           plugin that is about the panel rather than about the coffee, and
//           so the only one that is deliberately faster than it could be: a
//           page you asked for should already be there.
//   POUR    liquid moving in a cup, at either scale — the bar mark's and the
//           hero's, which is what makes them read as one object seen twice
//           (D52). Also what the bar mark's dose acknowledgement takes, since
//           that *is* a cup changing level.
//   ENTRANCE the curve drawing itself in (D25). The longest, and the only one
//           that draws the eye on purpose: it is the panel saying "here is
//           your day" once, on open, and never again while you look at it.
//
// The easing is the shell's own throughout — Easing.OutCubic, which is what
// SpeedTestOverlay uses for all four of its animations — except where a thing
// is falling, where OutCubic would be a lie (see POUR_FALL_MS).
var MOTION_TINT_MS = 60
var MOTION_REVEAL_MS = 90
var MOTION_PAGE_MS = 140
var MOTION_POUR_MS = 420
var MOTION_ENTRANCE_MS = 560

// How long the panel says it saved something. Long enough to be read after the
// keystroke that caused it, short enough that it is gone before it becomes
// part of the furniture — and deliberately longer than any other motion here,
// because this one is a sentence rather than a movement.
var MOTION_TOAST_MS = 2400

// D52's pour, in three parts. The stream falls from the rim, runs, and stops;
// the numbers are shares of MOTION_POUR_MS so the pour cannot drift out of the
// ladder above by editing one of them.
//
// The fall accelerates (Easing.InQuad) and the stop does too, because both are
// the same liquid leaving the same lip under the same gravity. This is the one
// place in the plugin that does not take the shell's OutCubic, and the reason
// is that a stream which eases *out* as it falls reads as a bar chart growing.
var POUR_FALL_MS = Math.round(MOTION_POUR_MS * 0.38)
var POUR_RUN_MS = Math.round(MOTION_POUR_MS * 0.24)
var POUR_STOP_MS = MOTION_POUR_MS - POUR_FALL_MS - POUR_RUN_MS

// One step of the dose-time nudge, in minutes. Signed at the call site.
var NUDGE_MINUTES = 15

// The definition behind the "cups" unit.
//
// D84, and it is a change of kind rather than of value. It used to be the
// 240 ml coffee preset — D27 pinned the two together so that two of our own
// numbers could not disagree about what a cup is, and the volume rode along to
// make the unit picturable. But a cup here is a unit of *caffeine*, not of
// liquid: an americano is larger than an espresso and may carry the same dose,
// so naming a volume invites a comparison the unit cannot win. It is an
// arbitrary round figure the user owns, the volume is out of the copy
// entirely, and the Coffee preset stays at its sourced 95 mg — a serving and a
// unit stop pretending to be one number.
//
// That deliberately breaks D27's pin, and the reason it is safe is the reason
// the pin existed: it protected against the panel contradicting itself while
// the cup claimed to *be* a preset. Once no preset defines it, the copy that
// says what a cup is stops being a convenience and becomes the only definition
// there is — which is why the estimate note still prints it.
var CUP_MG_DEFAULT = 100

// Bounds, in both implementations as every other numeric setting is: the
// engine clamps silently because it cannot afford to crash the shell, the
// helper script refuses out loud because a person at a terminal deserves a
// message, and a test pins the two together. Fifty is half a cup of coffee and
// three hundred is a large chain serving; outside that the word "cup" stops
// meaning anything a reader could picture.
var CUP_MIN_MG = 50
var CUP_MAX_MG = 300

// Every conversion below takes the setting, so there is no route to a cups
// figure that quietly used the default instead. An unreadable one falls back
// rather than throwing, the way every other stored value does.
function cupSize(cupMg) {
  var amount = Number(cupMg)
  if (!isFinite(amount) || amount <= 0) return CUP_MG_DEFAULT
  return Math.max(CUP_MIN_MG, Math.min(CUP_MAX_MG, Math.round(amount)))
}

// The daily cap. Informational only and off by default (D13) - this is a
// threshold below which no harm is expected, not a target.
var DAILY_CAP_DEFAULT_MG = 400
var DAILY_CAP_MIN_MG = 50
var DAILY_CAP_MAX_MG = 1000

// The plain-language half-life picker, and the hours each option means.
//
// A bare "half-life (hours)" spinner asks a question almost nobody can answer
// about themselves, and the answer matters: at 12h a 24h window silently
// discards a quarter of yesterday's coffee. So the setting asks something
// answerable instead and does the conversion here. The raw integer stays for
// people who know their number, behind the last option.
//
// `label` is the value persisted, because the shell used to render an enum's
// options as their own labels. Matching is on the hours in the string, so
// rewording an option cannot silently move an existing user's curve.
//
// Since D43 nothing writes this key: the panel's own control sets halfLifeHours
// directly and halfLifeSetting prefers it. The picker stays readable until
// Phase 10's profile supersedes it (D34), so a file carrying one still works.
var METABOLISM_CUSTOM = "Custom - use the hours below"

var METABOLISM_OPTIONS = [
  { label: "Pregnancy or the pill (10 hours)", hours: 10 },
  { label: "Coffee keeps me up all night (8 hours)", hours: 8 },
  { label: "Typical (5 hours)", hours: 5 },
  { label: "I smoke (3 hours)", hours: 3 },
  { label: METABOLISM_CUSTOM, hours: 0 }
]

// ---------------------------------------------------------------- the profile
//
// D34, and the reason this plugin has a science notes file. The half-life is
// the one big input to everything the panel says, and a bare "hours" spinner
// asks a question nobody can answer about themselves. D26's picker was the
// first attempt: five plain-language options, each carrying its own number.
// This is the second and it supersedes it - the same idea taken apart into the
// factors the literature actually measures, so the number is *derived* and the
// arithmetic can be shown.
//
// Every coefficient below comes from the table in
// plan/caffeine-curve-science.md, and every one carries the source it came
// from. Nothing here is a guess; where the source has no number, there is no
// question (see the three that were left out, below).
//
// The chain is deliberately the simplest thing that could work: independent
// multipliers on a 5h base, applied in order. Real CYP1A2 induction and
// inhibition do not compose that cleanly, and the model says "estimated"
// everywhere for exactly that reason.
//
// **Three factors in the source table are deliberately not asked about.**
//   - *Age and sex.* The table prices neither. The phase brief listed them as
//     minor modifiers; the source does not carry a coefficient for either, and
//     a question whose answer moves nothing is the opposite of what this page
//     is for. Sex is answered functionally by the two rows that do carry
//     coefficients (pregnancy, oral contraceptives).
//   - *Luteal phase* ("slows it further") and *liver impairment*
//     ("prolonged"). Both are in the table with words instead of numbers.
//   - *Drug interactions, all of them, since D100.* The source prices exactly
//     one (fluvoxamine, ~5h -> ~31h) and the phase brief named a second
//     (ciprofloxacin) that it prices nowhere. The fluvoxamine row was built and
//     then removed at the user's request; inventing a coefficient for the
//     weaker inhibitors to replace it is the one thing this model must not do,
//     so what the page says instead is that medication is not modelled.
var PROFILE_BASE_HOURS = 5

var PROFILE_QUESTIONS = [
  {
    // The CYP1A2 rs762551 row, asked as behaviour rather than as genotype:
    // "~2-4h" for a fast metaboliser and "~6-8h+" for a slow one is a real and
    // large effect, and "do you know your rs762551 genotype" is precisely the
    // question this page exists to stop asking. The two wordings are D26's own
    // - which is what makes the migration honest, because the hours they
    // advertised (3h and 8h) are the hours these factors derive.
    // Source: caffeine-curve-science.md s2, CYP1A2 fast/slow rows.
    // The answers are one word each and not the sentences D26 used, and that
    // is a layout decision the first render forced: every row on this page
    // shares one value column, measured off the widest answer, so "Keeps me up
    // all night" in this pill cost all six descriptions a third of their
    // width. The plain language moved into the description, where every other
    // row's explanation already lives, and the pill says where you sit on the
    // axis the label names.
    key: "clearance",
    fallback: "typical",
    label: "How fast you clear caffeine",
    description: "Slow if coffee keeps you up all night; fast if you can drink it after dinner and sleep fine. The spread between people is two- to threefold.",
    answers: [
      { value: "typical", label: "Typical", effect: "", factor: 1 },
      { value: "slow", label: "Slow", effect: "slow to clear it", factor: 1.6 },
      { value: "fast", label: "Fast", effect: "quick to clear it", factor: 0.6 }
    ]
  },
  {
    // "Roughly halves it (PAHs induce CYP1A2)".
    // Source: caffeine-curve-science.md s2, smoking row; Grosso 2005.
    key: "smoker",
    fallback: "no",
    label: "You smoke",
    description: "Tobacco smoke induces the enzyme that clears caffeine, roughly halving how long it lasts.",
    answers: [
      { value: "no", label: "No", effect: "", factor: 1 },
      { value: "yes", label: "Yes", effect: "smoking", factor: 0.5 }
    ]
  },
  {
    // 7.88h against 5.37h in matched controls - a measured ratio of 1.47,
    // rather than the "roughly doubles" the same row also offers, because the
    // measurement is the defensible half of that sentence.
    // Source: caffeine-curve-science.md s2; Abernethy & Todd 1985.
    key: "contraceptives",
    fallback: "no",
    label: "Hormonal birth control",
    description: "Oestrogen slows the same enzyme. Measured at 7.9 hours against 5.4 in matched controls.",
    answers: [
      { value: "no", label: "No", effect: "", factor: 1 },
      { value: "yes", label: "Yes", effect: "oral contraceptives", factor: 1.47 }
    ]
  },
  {
    // "10h+ at 17 weeks; 15h+ late" - two anchors, at 2.0x and 3.0x the base.
    // The first trimester is interpolated between the base and the 17-week
    // figure and is marked as such here, because the source has no number for
    // it and the rise it describes is progressive rather than stepped.
    // Source: caffeine-curve-science.md s2, pregnancy row; Grosso 2005.
    key: "pregnancy",
    fallback: "no",
    label: "Pregnant",
    description: "Clearance slows through pregnancy and keeps slowing. The daily figure changes too — see the cap in settings.",
    answers: [
      { value: "no", label: "No", effect: "", factor: 1 },
      // Interpolated, not measured: the source's first anchor is at 17 weeks.
      { value: "first", label: "First trimester", effect: "first trimester", factor: 1.4 },
      { value: "second", label: "Second trimester", effect: "second trimester", factor: 2 },
      { value: "third", label: "Third trimester", effect: "third trimester", factor: 3 }
    ]
  },
  {
    // "+72%" at around 50g of alcohol a day.
    // Source: caffeine-curve-science.md s2, heavy alcohol row.
    key: "alcohol",
    fallback: "no",
    label: "Heavy drinking",
    description: "Around 50 g a day — three or four drinks — lengthens caffeine's half-life by about 72%.",
    answers: [
      { value: "no", label: "No", effect: "", factor: 1 },
      { value: "yes", label: "Yes", effect: "heavy drinking", factor: 1.72 }
    ]
  }
]

// **D100 removed the sixth question and this is where it was.** `medication`
// asked about fluvoxamine and carried x6.2, by a wide margin the largest
// coefficient in the table. The user asked for it to go, and the profile is a
// handful of questions asked of one person about their own body, so which of
// them are worth answering is theirs to decide.
//
// Two things follow and both were checked rather than assumed.
//
// **The ceiling is still reachable**, so the clamp and its rendering are live
// code rather than a branch nothing can enter: slow clearance x hormonal birth
// control x third trimester x heavy drinking is x12.1, which is 60.7 hours on
// the 5-hour base. Even slow x the pill x the second trimester is x4.7 and
// clamps. HALF_LIFE_MAX_HOURS stays at 16 and COMPUTE_WINDOW_HOURS at 96.
//
// **A stored `medication: "yes"` is simply never read again.** deriveHalfLife
// walks this list, so the answer is ignored and the estimate drops with
// nothing on screen saying why. That is the right degradation and the same
// rule an unknown icon follows — but unlike an icon it needs no alias, because
// there is nothing for the old value to migrate *to*. The helper refuses the
// key out loud for the same reason: correction 37's "a person re-setting their
// own dump is not making a mistake" bought an alias where a right answer
// existed, and here the right answer is that the key is gone.
//
// This was the only modelled drug interaction, so the plugin now
// under-estimates for anyone on a strong CYP1A2 inhibitor. That is said once,
// in the README and on the page itself, and it does not come back as a row:
// the ask was for the entry to go, not for a replacement question.

// EFSA's figure for pregnancy, and the reason the pregnancy row's note lands
// next to the daily cap rather than only next to the half-life: the two are
// compounded, since a 200mg day sits on top of a 10-15h half-life.
// Source: caffeine-curve-science.md s5; EFSA 2015.
var PREGNANCY_CAP_MG = 200

// The meta-analysis's own safe cutoff, which is where the science notes'
// bedtime thresholds are derived from: 107mg of coffee needs at least 8.8h
// before bed to avoid measurable total-sleep-time loss.
// Source: caffeine-curve-science.md s3; Gardiner 2023.
var SAFE_CUTOFF_MG = 107
var SAFE_CUTOFF_HOURS = 8.8

// The one sentence that justifies this plugin existing, and the science notes
// say so in as many words: Drake's subjects lost over an hour of measured
// sleep to caffeine taken six hours before bed *and their own sleep diaries
// did not register it*. The 2025 crossover trial found the same gap. "You
// probably will not notice this" is the only thing here a person cannot work
// out by paying attention.
// Source: caffeine-curve-science.md s3, s7; Drake 2013.
//
// The number in it does not go through amountTextOf, and that is D27's own
// exemption rather than a hole in it: this is a line that quotes a study, the
// figure is a duration rather than an amount, and no control on the panel
// converts hours. D58's brackets do not apply either — they are for a cited
// figure sitting beside the same number shown in a converted unit, and there
// is no such control anywhere near this.
var TRIAL_NOTE = "Caffeine six hours before bed measurably reduced sleep in trials, "
  + "without people noticing."

var UNITS_MG = "mg"
var UNITS_CUPS = "cups"

var SECONDS_PER_HOUR = 3600
var SECONDS_PER_DAY = 86400

// ---------------------------------------------------------------- sanitising

function finiteNumber(value, fallback) {
  var number = Number(value)
  return isFinite(number) ? number : fallback
}

function toSeconds(value) {
  return Math.floor(finiteNumber(value, 0))
}

// Out-of-range and junk half-lives are clamped rather than rejected: this runs
// unsandboxed inside the shell process, and a settings value nobody validated
// must not be able to put Infinity into a binding.
function sanitizeHalfLife(hours) {
  var value = finiteNumber(hours, HALF_LIFE_DEFAULT_HOURS)
  if (value < HALF_LIFE_MIN_HOURS) return HALF_LIFE_MIN_HOURS
  if (value > HALF_LIFE_MAX_HOURS) return HALF_LIFE_MAX_HOURS
  return value
}

function eliminationRate(halfLifeHours) {
  return Math.LN2 / sanitizeHalfLife(halfLifeHours)
}

// ---------------------------------------------------------------- settings
//
// Everything below reads values out of ~/.local/state/omarchy/settings/
// caffeine-curve.json, which means they may be strings, absent, or something a
// hand edit put there. Each one clamps or falls back rather than rejecting:
// this code runs unsandboxed inside the shell process, and a settings value
// nobody validated must not be able to reach a binding as NaN.
//
// The file is ours (D43) and an absent file means defaults, so the fallback
// inside each sanitiser below IS the shipped default. SETTINGS_DEFAULTS states
// the same set as one object - what the helper script prints for a fresh
// install, and what the README documents - and a test pins the two together so
// the stated default and the applied one cannot drift.

// The picker's hours, or the raw override when the picker says custom.
// An option we don't recognise falls back to the default rather than to the
// custom field, so an option reworded in a later version still reads sanely
// against a settings file written by an older one.
function halfLifeFor(metabolism, customHours) {
  var text = String(metabolism === undefined || metabolism === null ? "" : metabolism)
  for (var i = 0; i < METABOLISM_OPTIONS.length; i++) {
    if (METABOLISM_OPTIONS[i].label !== text) continue
    if (METABOLISM_OPTIONS[i].hours > 0) return METABOLISM_OPTIONS[i].hours
    return sanitizeHalfLife(customHours)
  }
  // Reworded, or hand-edited: take the hours out of the string if they are
  // still in it, so an option renamed between versions keeps working.
  var match = /(\d+(?:\.\d+)?)\s*hour/i.exec(text)
  if (match) return sanitizeHalfLife(Number(match[1]))
  if (text === "") return HALF_LIFE_DEFAULT_HOURS
  return HALF_LIFE_DEFAULT_HOURS
}

// "mg" or "cups". Matched on the leading word rather than on the whole option
// string, so the manifest can reword the label without orphaning a setting.
function sanitizeUnits(units) {
  var text = String(units === undefined || units === null ? "" : units).toLowerCase()
  return text.indexOf("cup") === 0 ? UNITS_CUPS : UNITS_MG
}

// ---------------------------------------------- D89: the bar's number
//
// The mark is a cup and a reading, and the reading is a setting now: *"sometimes
// for some users it might be nicer to just see the cup in the bar without the
// 56 mg."* Three answers, and the third is the reason to build it.
//
// **"Moving" is the reading being present exactly while it has something to
// say.** Phase 3's charm is that the reading climbs continuously as the
// caffeine is absorbed (D80 made the panel agree with it), and that charm has
// a natural lifetime: it is over once the curve stops rising. So the window is
// **Tmax** — `timeToPeak` for the user's own half-life, which is ~48 minutes
// at the 5-hour default, 40 at a smoker's 2.5 and 62 at 16. It is not a
// constant this file had to invent: it is the number the whole curve is
// already shaped by, and it moves with the person the way everything else on
// this page does.
//
// **The rejected candidate was "while the level is actually rising", and it
// was rejected from measurement rather than from the argument.** It needs no
// window at all, which made it the more honest of the two — and it is a strict
// subset of the Tmax window, because a dose's own contribution only climbs
// until its own Tmax, so it can never surprise anyone in a place a timer
// would not. What it can be is **empty**: on a 200 mg board a 2 mg decaf never
// lifts the total at all, so the number would never appear for a drink you
// just logged, and a 35 mg cola on a 400 mg day would hold it for 15 minutes
// instead of 48. The ask was *"when the number moves up just after a drink it
// is nice if it is there"*, and a rule that answers "not for that drink" is
// answering a different question.
var BAR_NUMBER_ALWAYS = "always"
var BAR_NUMBER_MOVING = "moving"
var BAR_NUMBER_NEVER = "never"
var BAR_NUMBER_MODES = [BAR_NUMBER_ALWAYS, BAR_NUMBER_MOVING, BAR_NUMBER_NEVER]

function sanitizeBarNumber(mode) {
  var text = String(mode === undefined || mode === null ? "" : mode).toLowerCase()
  for (var i = 0; i < BAR_NUMBER_MODES.length; i++)
    if (BAR_NUMBER_MODES[i] === text) return BAR_NUMBER_MODES[i]
  // **D99 moved this with the default, deliberately rather than to satisfy a
  // test.** The old comment here said "shown, like every other unrecognised
  // answer in this file falls back to the one that says more" — which is a
  // real rule, and it is outranked by a more basic one that SETTINGS_DEFAULTS
  // states in its own header: every value there *is* the fallback its own
  // sanitiser applies. A garbled value is not a different question from an
  // absent one, and a plugin whose fresh install and whose corrupted install
  // look different is one more state nobody will ever render.
  return BAR_NUMBER_MOVING
}

// One word each, in the pill — Phase 10 paid for that lesson, where a long
// answer cost every row on the page a third of its description width.
function barNumberName(mode) {
  var how = sanitizeBarNumber(mode)
  if (how === BAR_NUMBER_MOVING) return "Moving"
  if (how === BAR_NUMBER_NEVER) return "Never"
  return "Always"
}

// The window, in seconds. Derived, not chosen.
function barNumberWindowSeconds(halfLifeHours) {
  return Math.round(timeToPeak(halfLifeHours) * SECONDS_PER_HOUR)
}

// Whether the mark paints its reading. `doses` is the log; a dose in the
// future has not happened yet and does not open the window (D20 makes that a
// real state), and the newest dose is the only one that can — the list is
// sorted newest first, so this stops at the first one that counts.
function barNumberShown(mode, doses, atSeconds, halfLifeHours) {
  var how = sanitizeBarNumber(mode)
  if (how === BAR_NUMBER_ALWAYS) return true
  if (how === BAR_NUMBER_NEVER) return false
  var now = toSeconds(atSeconds)
  var window = barNumberWindowSeconds(halfLifeHours)
  var list = sanitizeDoses(doses)
  for (var i = 0; i < list.length; i++) {
    if (list[i].ts > now) continue
    return now - list[i].ts <= window
  }
  return false
}

// Booleans arrive as real booleans from the panel's own writes and as strings
// from a hand-edited file - which the settings file explicitly invites, since
// the helper script documents it as editable.
function truthy(value) {
  if (value === true) return true
  if (typeof value === "string") return value.toLowerCase() === "true"
  return Number(value) === 1
}

function sanitizeCap(mg) {
  var value = Math.round(finiteNumber(mg, DAILY_CAP_DEFAULT_MG))
  if (value < DAILY_CAP_MIN_MG) return DAILY_CAP_MIN_MG
  if (value > DAILY_CAP_MAX_MG) return DAILY_CAP_MAX_MG
  return value
}

// The mg the bedtime verdict pivots on. Same clamp-don't-reject contract as
// every other setting: this is the number three quarters of the panel's copy
// is a function of, so it must not be able to arrive as NaN.
function sanitizeThreshold(mg) {
  var value = Math.round(finiteNumber(mg, BEDTIME_CLEAR_MG))
  if (value < SLEEP_THRESHOLD_MIN_MG) return SLEEP_THRESHOLD_MIN_MG
  if (value > SLEEP_THRESHOLD_MAX_MG) return SLEEP_THRESHOLD_MAX_MG
  return value
}

// ------------------------------------------------- deriving the half-life
//
// Everything below is a pure function of the profile object stored under the
// `profile` key. Absent means an empty profile, which derives exactly the
// 5-hour default - so a fresh install and an untouched profile are the same
// curve, and the questionnaire can never make the shipped behaviour worse by
// existing.

function profileQuestion(key) {
  for (var i = 0; i < PROFILE_QUESTIONS.length; i++)
    if (PROFILE_QUESTIONS[i].key === String(key)) return PROFILE_QUESTIONS[i]
  return null
}

function profileAnswerFor(question, value) {
  if (!question) return null
  var text = String(value === undefined || value === null ? "" : value)
  for (var i = 0; i < question.answers.length; i++)
    if (question.answers[i].value === text) return question.answers[i]
  return null
}

// The neutral answer, which is always the one with no effect. Reached by
// value rather than by position so that reordering the answers cannot quietly
// change what an unset question means.
function profileFallback(question) {
  return profileAnswerFor(question, question.fallback) || question.answers[0]
}

// The stored object, made safe. Same clamp-don't-reject contract as every
// other setting: an answer we do not recognise - a hand edit, a value from a
// version that asked a question this one does not - falls back to the neutral
// one rather than to a factor nobody chose.
function sanitizeProfile(profile) {
  var raw = profile && typeof profile === "object" && profile.length === undefined
    ? profile : {}
  var out = {}
  for (var i = 0; i < PROFILE_QUESTIONS.length; i++) {
    var question = PROFILE_QUESTIONS[i]
    var answer = profileAnswerFor(question, raw[question.key])
    out[question.key] = (answer || profileFallback(question)).value
  }
  return out
}

function profileOf(values) {
  var raw = values && typeof values === "object" ? values : {}
  return sanitizeProfile(raw.profile)
}

// How many questions are answered as something other than the neutral value.
// This is what the settings page's profile row counts, and what decides
// whether the profile is offering anything at all.
function profileAnswered(profile) {
  var clean = sanitizeProfile(profile)
  var count = 0
  for (var i = 0; i < PROFILE_QUESTIONS.length; i++) {
    var question = PROFILE_QUESTIONS[i]
    if (clean[question.key] !== profileFallback(question).value) count++
  }
  return count
}

// The next answer along, for a control that steps rather than opens a menu.
// Wraps, because every question here is short and a two-answer question with
// a non-wrapping control answers half its presses with nothing.
function cycleProfile(profile, key, direction) {
  var question = profileQuestion(key)
  var clean = sanitizeProfile(profile)
  if (!question) return clean
  var at = 0
  for (var i = 0; i < question.answers.length; i++)
    if (question.answers[i].value === clean[question.key]) at = i
  var step = finiteNumber(direction, 1) < 0 ? -1 : 1
  var next = (at + step + question.answers.length) % question.answers.length
  var out = {}
  for (var existing in clean) out[existing] = clean[existing]
  out[question.key] = question.answers[next].value
  return out
}

// The arithmetic, as the list of things it is made of - which is the whole
// point of D34. The page renders this rather than a number, so a user can see
// that "10 hours" is 5 x 2.0 and which answer put the 2.0 there.
//
// Only the factors that actually move the number are steps. A page of "x 1.0
// (not pregnant)" lines is the derivation buried in the questions it already
// asked; the questions are three inches above and each states its own answer.
function deriveSteps(profile) {
  var clean = sanitizeProfile(profile)
  var steps = []
  var raw = PROFILE_BASE_HOURS
  for (var i = 0; i < PROFILE_QUESTIONS.length; i++) {
    var question = PROFILE_QUESTIONS[i]
    var answer = profileAnswerFor(question, clean[question.key])
    if (!answer || answer.factor === 1) continue
    raw = raw * answer.factor
    steps.push({ key: question.key, effect: answer.effect, factor: answer.factor })
  }
  var hours = sanitizeHalfLife(raw)
  return {
    base: PROFILE_BASE_HOURS,
    steps: steps,
    raw: Math.round(raw * 10) / 10,
    hours: Math.round(hours * 10) / 10,
    clamped: sanitizeHalfLife(raw) !== raw
  }
}

// The number itself. An empty profile is exactly HALF_LIFE_DEFAULT_HOURS, and
// a test pins that: the questionnaire may not move a curve nobody has answered
// a question about.
function deriveHalfLife(profile) {
  return deriveSteps(profile).hours
}

// What a dose taken `hoursBefore` bedtime leaves on board at bedtime. This is
// the conversion the science notes perform on every trial in the literature,
// because the literature measures dose x hours-before-bed and never residual
// mg; a test reproduces all five rows of that table from this function.
function residualAtBedtime(doseMg, hoursBefore, halfLifeHours) {
  return finiteNumber(doseMg, 0)
    * Math.pow(0.5, finiteNumber(hoursBefore, 0) / sanitizeHalfLife(halfLifeHours))
}

// The sleep threshold the science notes' derivation section implies at a given
// half-life: the meta-analysis's safe cutoff (107mg, >= 8.8h before bed), read
// as a residual for someone who clears caffeine at this rate.
//
// **The panel does not apply this, and that is a decision rather than an
// omission.** It reproduces the published derivation exactly at 5h (31.6mg,
// which is where the shipped 30mg threshold comes from), and it is the right
// implementation of what the notes describe. It is the wrong number to hand a
// user, for two reasons the same notes give:
//
//   - Clearance speed and sleep sensitivity are separate genes (ADORA2A
//     rs5751876, Retey 2007). The notes say so explicitly and draw the
//     conclusion that the thresholds should be nudgeable independently - which
//     is what the Phase 8 setting already is.
//   - The direction is wrong where it matters most. This function rises with
//     the half-life, so at the 16h ceiling it would call 73mg "clear" - three
//     milligrams under the 75.8mg residual the same table records as *still
//     disrupting sleep*. A slow metaboliser also decays less overnight, so if
//     anything the threshold should fall with the half-life, and nothing in
//     the sources prices that.
//
// So it stays here, tested against the published table, as the thing the
// profile page says it is not doing.
function deriveThreshold(halfLifeHours) {
  return sanitizeThreshold(residualAtBedtime(SAFE_CUTOFF_MG, SAFE_CUTOFF_HOURS, halfLifeHours))
}

// Which of the two numbers is live, as a word. Two states and not four: a
// half-life is either one this user chose or one the profile worked out.
//
// D26's `metabolism` enum counts as chosen, which is the whole of the
// migration. Every option in that picker carried its hours in its own label
// and halfLifeFor still reads them, so an existing file resolves to exactly
// the number it resolved to before this phase - and it resolves as *custom*,
// which is the state that survives a profile edit untouched. Mapping those
// options onto profile answers instead was the other candidate and it loses on
// D26's own rule: "I smoke (3 hours)" would derive 2.5h from the sourced 0.5
// coefficient, silently moving a curve by half an hour, and "Pregnancy or the
// pill (10 hours)" names two profile answers that derive different numbers and
// gives no way to tell which one the user meant.
function halfLifeSource(values) {
  var raw = values && typeof values === "object" ? values : {}
  if (raw.halfLifeHours !== undefined && raw.halfLifeHours !== null
      && String(raw.halfLifeHours) !== "") return "custom"
  if (raw.metabolism !== undefined && raw.metabolism !== null
      && String(raw.metabolism) !== "") return "custom"
  return "profile"
}

// The half-life the panel actually uses, out of the settings object.
//
// Three sources, in the order D34 fixed and Phase 8 half-built:
//
//   1. `halfLifeHours` - a number this user set by hand. Always wins, and is
//      never overwritten by anything on the profile page: the profile offers,
//      it does not impose.
//   2. `metabolism` - D26's superseded picker, still readable, still applying
//      the hours its own option label advertises. This is the migration; see
//      halfLifeSource for why it resolves as a custom value rather than as a
//      set of profile answers.
//   3. `profile` - D34's questionnaire, derived. An absent profile is an empty
//      one, which derives exactly HALF_LIFE_DEFAULT_HOURS, so this is also the
//      fresh-install path and there is no fourth branch.
function halfLifeSetting(values) {
  var raw = values && typeof values === "object" ? values : {}
  if (raw.halfLifeHours !== undefined && raw.halfLifeHours !== null
      && String(raw.halfLifeHours) !== "") {
    return sanitizeHalfLife(raw.halfLifeHours)
  }
  if (raw.metabolism !== undefined && raw.metabolism !== null
      && String(raw.metabolism) !== "") {
    return halfLifeFor(raw.metabolism, HALF_LIFE_DEFAULT_HOURS)
  }
  return deriveHalfLife(raw.profile)
}

// What ships when the settings file is absent. Every value here is the
// fallback its own sanitiser applies, stated once so the README, the helper
// script's `--defaults` and the engine cannot disagree; the test asserts the
// agreement rather than trusting this comment.
var SETTINGS_DEFAULTS = {
  bedtime: "23:00",
  // D105's three, and the framing's own default is a free choice rather than
  // an inheritance — D99 is why: "a setting that changes what a surface looks
  // like must default to what people already have" is void while there are no
  // installs. Rolling because it is the framing that always contains now, and
  // because it is what every capture in this project has been of.
  chartFrame: "rolling",
  dayStart: "07:00",
  dayEnd: "00:00",
  halfLifeHours: 5,
  sleepThresholdMg: 30,
  units: "mg",
  cupMg: 100,
  dailyCapEnabled: false,
  dailyCapMg: 400,
  quietPanel: false,
  // **D99, overturning D89 in the phase after it shipped**, and D89's reason is
  // void rather than outweighed. It defaulted to `always` because "a setting
  // that changes what a bar looks like must default to the bar people already
  // have" — a good rule with **no installs to be true of**. The plugin is
  // unreleased, the repo is private, and the only person with it is the person
  // who asked for this.
  //
  // The argument that replaces it is D89's own. The reason the third answer
  // was built at all is that the climbing reading has a natural lifetime: the
  // number is present exactly while it has something to say, which is D19's
  // dim-threshold rule applied to the digits. That is the answer the decision
  // argued for and then did not ship.
  //
  // What makes it defensible is unchanged and is D89's requirement: the mark's
  // tooltip and this panel's first line always state the number, so nothing is
  // ever only in the digits.
  barNumber: "moving"
}

// The whole settings object, sanitised. Every field goes through the same
// function the individual reader would, so a caller cannot accidentally take
// one of these raw.
function sanitizeSettings(values) {
  var raw = values && typeof values === "object" ? values : {}
  return {
    bedtime: sanitizeBedtime(raw.bedtime),
    // Both clocks go through sanitizeBedtime, which is the bedtime row's
    // parser and not a bedtime-specific one — the fallback is the only part
    // that differs, so each names its own.
    chartFrame: sanitizeFrame(raw.chartFrame),
    dayStart: sanitizeClock(raw.dayStart, DAY_START_DEFAULT),
    dayEnd: sanitizeClock(raw.dayEnd, DAY_END_DEFAULT),
    halfLifeHours: halfLifeSetting(raw),
    sleepThresholdMg: sanitizeThreshold(raw.sleepThresholdMg),
    units: sanitizeUnits(raw.units),
    // D84. cupSize is the sanitiser as well as the reader, because the two
    // are the same question: what is a cup, given whatever is on file.
    cupMg: cupSize(raw.cupMg),
    dailyCapEnabled: truthy(raw.dailyCapEnabled),
    dailyCapMg: sanitizeCap(raw.dailyCapMg),
    // D51. Off is the shipped state and the only state a fresh install can be
    // in, which is the whole of what makes hiding the estimate line defensible
    // under D13: the person it is hidden from is the person who hid it.
    // `truthy` rather than a three-way, so a hand-edited "maybe" is shown-not-
    // hidden, which is the safe direction for a disclaimer.
    quietPanel: truthy(raw.quietPanel),
    barNumber: sanitizeBarNumber(raw.barNumber)
  }
}

// How far a dose may actually move. Backward is unbounded - walking a dose
// back changes the level now, so the chart answers every press. Forward stops
// at the right edge of the window, and refuses the whole step rather than
// truncating it, so the clock stays on the 15-minute grid it started on.
function nudgeMinutes(ts, minutes, nowSeconds, limitHours) {
  var delta = Math.round(finiteNumber(minutes, 0))
  if (delta <= 0) return delta
  var limit = toSeconds(nowSeconds) + finiteNumber(limitHours, CURVE_WINDOW_HOURS) * SECONDS_PER_HOUR
  return toSeconds(ts) + delta * 60 <= limit ? delta : 0
}

// One dose entry, or null. Anything malformed is treated as absent rather than
// as a zero, so a corrupt line can't drag the curve down.
function sanitizeDose(entry) {
  if (!entry || typeof entry !== "object") return null
  var ts = Number(entry.ts)
  var mg = Number(entry.mg)
  if (!isFinite(ts) || !isFinite(mg)) return null
  if (mg <= 0) return null
  return {
    ts: Math.floor(ts),
    mg: mg,
    label: typeof entry.label === "string" ? entry.label : ""
  }
}

// Newest first — the order the panel's recent-doses list wants, and the order
// the window walk below relies on to stop early.
function sanitizeDoses(doses) {
  if (!doses || typeof doses.length !== "number") return []
  var list = []
  for (var i = 0; i < doses.length; i++) {
    var dose = sanitizeDose(doses[i])
    if (dose) list.push(dose)
  }
  list.sort(function(a, b) { return b.ts - a.ts })
  return list
}

// Splits the log at the retention cutoff instead of dropping the far side.
//
// D44: doses.json is the panel's working set, but the log is user-authored
// data someone would want backed up, and data that silently deletes itself
// after a month is not that. So the caller gets both halves and writes both
// files - the archive is append-only and nothing ever reads it back.
function prune(doses, nowSeconds, days) {
  var now = toSeconds(nowSeconds)
  var keepDays = finiteNumber(days, RETENTION_DAYS)
  var cutoff = now - keepDays * SECONDS_PER_DAY
  var list = sanitizeDoses(doses)
  var kept = []
  var expired = []
  for (var i = 0; i < list.length; i++) {
    if (list[i].ts >= cutoff) kept.push(list[i])
    else expired.push(list[i])
  }
  return { kept: kept, expired: expired }
}

// ------------------------------------------------------------ the model

// Bateman one-compartment: what is left of `mg` taken `dtHours` ago.
function contribution(mg, dtHours, ke) {
  var elapsed = finiteNumber(dtHours, -1)
  if (elapsed < 0) return 0

  var amount = finiteNumber(mg, 0)
  if (amount <= 0) return 0

  var rate = finiteNumber(ke, 0)
  var denominator = ABSORPTION_RATE - rate

  // ka - ke never approaches zero across the 2-12h half-life range, but a
  // settings value that escaped clamping must not divide by ~0. The limit as
  // ke -> ka is the flat-denominator form, so use it rather than bailing.
  if (Math.abs(denominator) < 1e-9) {
    return amount * ABSORPTION_RATE * elapsed * Math.exp(-ABSORPTION_RATE * elapsed)
  }

  var value = amount * (ABSORPTION_RATE / denominator)
    * (Math.exp(-rate * elapsed) - Math.exp(-ABSORPTION_RATE * elapsed))
  return isFinite(value) && value > 0 ? value : 0
}

// Assumes a list already through sanitizeDoses, i.e. newest first.
function levelOfSorted(sorted, ke, atSeconds) {
  var windowStart = atSeconds - COMPUTE_WINDOW_HOURS * SECONDS_PER_HOUR
  var total = 0
  for (var i = 0; i < sorted.length; i++) {
    var dose = sorted[i]
    if (dose.ts > atSeconds) continue
    if (dose.ts < windowStart) break
    total += contribution(dose.mg, (atSeconds - dose.ts) / SECONDS_PER_HOUR, ke)
  }
  return isFinite(total) ? total : 0
}

function levelAt(doses, atSeconds, halfLifeHours) {
  return levelOfSorted(sanitizeDoses(doses), eliminationRate(halfLifeHours), toSeconds(atSeconds))
}

// `count` evenly spaced samples spanning [fromSeconds, toSeconds] inclusive.
// Sanitises once and reuses the sorted list, because the panel asks for ~100
// of these every time it opens.
function levelOverRange(doses, fromSeconds, toSeconds_, halfLifeHours, count) {
  var from = toSeconds(fromSeconds)
  var to = toSeconds(toSeconds_)
  var samples = Math.max(2, Math.floor(finiteNumber(count, 100)))
  var sorted = sanitizeDoses(doses)
  var ke = eliminationRate(halfLifeHours)
  var step = (to - from) / (samples - 1)
  var out = []
  for (var i = 0; i < samples; i++) {
    var at = Math.round(from + step * i)
    out.push({ ts: at, mg: levelOfSorted(sorted, ke, at) })
  }
  return out
}

// Tmax, in hours after a dose.
function timeToPeak(halfLifeHours) {
  var ke = eliminationRate(halfLifeHours)
  var denominator = ABSORPTION_RATE - ke
  if (Math.abs(denominator) < 1e-9) return 1 / ABSORPTION_RATE
  return Math.log(ABSORPTION_RATE / ke) / denominator
}

// The fraction of a dose that is ever on board at once — ~0.90 at defaults.
// The cup's fill scale has to use this, or a fresh espresso never fills it.
function peakFraction(halfLifeHours) {
  return contribution(1, timeToPeak(halfLifeHours), eliminationRate(halfLifeHours))
}

function peakLevel(mg, halfLifeHours) {
  return finiteNumber(mg, 0) * peakFraction(halfLifeHours)
}

// Highest level reached anywhere in [fromSeconds, toSeconds].
function maxLevel(doses, fromSeconds, toSeconds_, halfLifeHours, count) {
  var samples = levelOverRange(doses, fromSeconds, toSeconds_, halfLifeHours, count)
  var highest = 0
  for (var i = 0; i < samples.length; i++) {
    if (samples[i].mg > highest) highest = samples[i].mg
  }
  return highest
}

// The denominator behind the cup's fill. One large coffee fills it; a bigger
// day stretches the scale instead of clipping, so the mark never lies about
// being "as full as it goes".
function fillScale(doses, nowSeconds, halfLifeHours, referenceDoseMg) {
  var now = toSeconds(nowSeconds)
  var reference = peakLevel(finiteNumber(referenceDoseMg, REFERENCE_DOSE_MG), halfLifeHours)
  var attained = maxLevel(doses, now - 12 * SECONDS_PER_HOUR, now + 12 * SECONDS_PER_HOUR, halfLifeHours, 97)
  var scale = Math.max(reference, attained)
  return scale > 0 ? scale : 1
}

function cupFill(doses, nowSeconds, halfLifeHours, referenceDoseMg) {
  var level = levelAt(doses, nowSeconds, halfLifeHours)
  var fraction = level / fillScale(doses, nowSeconds, halfLifeHours, referenceDoseMg)
  if (!isFinite(fraction) || fraction < 0) return 0
  return fraction > 1 ? 1 : fraction
}

// ------------------------------------------------------------ bedtime

// "23:00" -> { hours: 23, minutes: 0 }. Junk falls back to 23:00 rather than
// throwing, since this string comes straight out of user settings.
//
// A 12-hour suffix is accepted, and the minutes are optional, because the
// bedtime setting is a free text field and half this machine's clocks render
// as "11:00 PM". Silently reading "10:30pm" as 23:00 would be wrong by half an
// hour in the one number the whole panel is about.
// The same parse, but null rather than a fallback for anything it cannot read.
// Reading a bedtime is a place to degrade quietly; *writing* one is not, and
// the settings field needs to know the difference so it can refuse to commit
// junk instead of storing 23:00 behind your back.
function parseClockStrict(text) {
  var match = /^\s*(\d{1,2})(?:\s*:\s*(\d{1,2}))?\s*([AaPp])\.?[Mm]?\.?\s*$/.exec(String(text || ""))
  if (match) {
    var clockHour = Number(match[1])
    var pastHour = match[2] === undefined ? 0 : Number(match[2])
    if (clockHour < 1 || clockHour > 12 || pastHour > 59) return null
    var pm = match[3].toLowerCase() === "p"
    return { hours: clockHour % 12 + (pm ? 12 : 0), minutes: pastHour }
  }

  match = /^\s*(\d{1,2})\s*:\s*(\d{1,2})\s*$/.exec(String(text || ""))
  if (!match) return null
  var hours = Number(match[1])
  var minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return { hours: hours, minutes: minutes }
}

function parseClock(text) {
  var clock = parseClockStrict(text)
  return clock ? clock : { hours: 23, minutes: 0 }
}

// Zero-padded 24-hour, which is what goes in the settings file: the store has
// to be unambiguous whatever clock the machine renders, and the panel formats
// it back through Qt's locale wherever it shows it. A hand edit that says
// "10:30 pm" still reads correctly - parseClock takes it - it just is not what
// we write.
function formatClock24(clock) {
  var hours = clock && isFinite(Number(clock.hours)) ? Number(clock.hours) : 23
  var minutes = clock && isFinite(Number(clock.minutes)) ? Number(clock.minutes) : 0
  return (hours < 10 ? "0" : "") + hours + ":" + (minutes < 10 ? "0" : "") + minutes
}

function sanitizeBedtime(text) {
  return sanitizeClock(text, BEDTIME_DEFAULT)
}

// The same read with the fallback named by the caller. D105 added two more
// clocks to this file and neither of them falls back to a bedtime, so the
// fallback stopped being part of the parse.
function sanitizeClock(text, fallback) {
  var clock = parseClockStrict(text)
  if (clock) return formatClock24(clock)
  var backstop = parseClockStrict(fallback)
  return backstop ? formatClock24(backstop) : BEDTIME_DEFAULT
}

// Bedtime by the chevrons, so the setting is reachable without typing. Wraps
// around midnight rather than clamping at it: 00:00 is a bedtime people
// actually have, and a control that stops dead there would make the hour
// either side of it unreachable from one direction.
function shiftClock(text, minutes) {
  var clock = parseClock(text)
  var step = Math.round(finiteNumber(minutes, 0))
  var total = clock.hours * 60 + clock.minutes + step
  total = ((total % 1440) + 1440) % 1440
  return formatClock24({ hours: Math.floor(total / 60), minutes: total % 60 })
}

// The next occurrence of the bedtime clock, as unix seconds. Rolls forward by
// calendar day rather than by 86400s so a DST change doesn't move bedtime.
function bedtimeSeconds(nowSeconds, bedtimeText) {
  var now = toSeconds(nowSeconds)
  var clock = parseClock(bedtimeText)
  var date = new Date(now * 1000)
  date.setHours(clock.hours, clock.minutes, 0, 0)
  if (Math.floor(date.getTime() / 1000) <= now) {
    date.setDate(date.getDate() + 1)
    date.setHours(clock.hours, clock.minutes, 0, 0)
  }
  return Math.floor(date.getTime() / 1000)
}

// The other side of the same clock: the most recent occurrence of a clock time
// at or before `atSeconds`. Same calendar-day roll as bedtimeSeconds, for the
// same DST reason.
//
// **Written for bedtime and general since D105**, which needs exactly this
// shape for a different clock: "the day you are in began at 07:00, and at
// 03:00 that was yesterday" is the same roll as "the bedtime you have most
// recently passed". The bedtime name is kept as the caller below because that
// is what forty lines of this file mean by it.
function previousClockSeconds(atSeconds, clockText) {
  var at = toSeconds(atSeconds)
  var clock = parseClock(clockText)
  var date = new Date(at * 1000)
  date.setHours(clock.hours, clock.minutes, 0, 0)
  if (Math.floor(date.getTime() / 1000) > at) {
    date.setDate(date.getDate() - 1)
    date.setHours(clock.hours, clock.minutes, 0, 0)
  }
  return Math.floor(date.getTime() / 1000)
}

function previousBedtimeSeconds(atSeconds, bedtimeText) {
  return previousClockSeconds(atSeconds, bedtimeText)
}

// The threshold is a setting from Phase 8; the upper band is derived from it,
// so the shipped 30 still splits at 30 and 60. Absent falls back to the
// shipped figure rather than to zero, which would read every state as
// disruptive.
function bedtimeBand(mg, thresholdMg) {
  var level = finiteNumber(mg, 0)
  var threshold = sanitizeThreshold(thresholdMg)
  if (level < threshold) return "clear"
  if (level <= threshold * BEDTIME_MARGINAL_MULTIPLE) return "marginal"
  return "disruptive"
}

// What the hero states: the level at bedtime, and the verdict on it.
//
// D42, and it is the answer to a real defect rather than a refinement. Aiming
// at the *next* occurrence of the bedtime clock is right all day and wrong for
// the few hours that matter most: at 23:30 with a 23:00 bedtime the next one
// is 23.5 hours out, a five-hour half-life has taken essentially everything by
// then, and a double espresso drunk ten minutes ago renders as "5 mg at
// 11:00 PM - CLEAR FOR SLEEP". The number was never wrong; it was about the
// wrong night.
//
// So within LATE_DOSE_HOURS after the bedtime clock - the same window D41
// already uses to decide a dose is "after bedtime" rather than a very long way
// before the next one - the projection stops projecting and reports now.
// `bedtimeAt` stays the bedtime clock either way, so the curve's hairline has
// somewhere on the chart to be: ahead of now normally, and behind it here.
function bedtimeProjection(doses, nowSeconds, halfLifeHours, bedtimeText, thresholdMg) {
  var now = toSeconds(nowSeconds)
  var previous = previousBedtimeSeconds(now, bedtimeText)
  var hoursAfterBed = (now - previous) / SECONDS_PER_HOUR
  var afterBedtime = hoursAfterBed <= LATE_DOSE_HOURS

  var at = afterBedtime ? now : bedtimeSeconds(now, bedtimeText)
  var mg = levelAt(doses, at, halfLifeHours)
  return {
    at: at,
    bedtimeAt: afterBedtime ? previous : at,
    afterBedtime: afterBedtime,
    hoursAfterBed: hoursAfterBed,
    hoursAway: (at - now) / SECONDS_PER_HOUR,
    mg: mg,
    rounded: roundDisplay(mg),
    band: bedtimeBand(mg, thresholdMg)
  }
}

// The most recent dose at or above the threshold that has actually been taken.
// Null when there isn't one — the caller shows nothing rather than a zero.
function lastStrongDose(doses, nowSeconds, thresholdMg) {
  var now = toSeconds(nowSeconds)
  var threshold = finiteNumber(thresholdMg, STRONG_DOSE_MG)
  var sorted = sanitizeDoses(doses)
  for (var i = 0; i < sorted.length; i++) {
    if (sorted[i].ts > now) continue
    if (sorted[i].mg >= threshold) return sorted[i]
  }
  return null
}

function hoursSinceLastStrongDose(doses, nowSeconds, thresholdMg) {
  var dose = lastStrongDose(doses, nowSeconds, thresholdMg)
  if (!dose) return null
  return (toSeconds(nowSeconds) - dose.ts) / SECONDS_PER_HOUR
}

// "last dose over 100mg: 7h before bed" — the figure the trials measured, as
// opposed to the residual-mg estimate, which is derived.
// Both durations here are measured about the *dose's* own bedtimes and not
// about now's, and that symmetry is the fix for defect #5 (Phase 13).
//
// `hoursAfterBed` always was: it counts from the bedtime preceding the dose.
// `hoursBeforeBed` counted to the bedtime following *now*, which is the same
// bedtime right up until the moment tonight's passes — and then it silently
// becomes tomorrow's. A 200 mg cold brew at 22:12 read at 23:52 rendered
// "24h 48m before bed": true of tomorrow night, and the exact sentence D41
// was written to stop, arriving from the other direction. It is 48 minutes
// before the bedtime it was drunk before, whatever time you read it.
//
// `bedtimePassed` is what the copy needs on top of the number, because "48m
// before bedtime" under a hero saying PAST BEDTIME has to say which bedtime
// it means (D41 + D42 meeting, resolved at Phase 13 as D72).
function strongDoseLead(doses, nowSeconds, halfLifeHours, bedtimeText, thresholdMg) {
  var now = toSeconds(nowSeconds)
  var dose = lastStrongDose(doses, now, thresholdMg)
  if (!dose) return null
  var bedtime = bedtimeSeconds(dose.ts, bedtimeText)
  var hoursAfterBed = (dose.ts - previousBedtimeSeconds(dose.ts, bedtimeText)) / SECONDS_PER_HOUR
  return {
    dose: dose,
    hoursBeforeBed: (bedtime - dose.ts) / SECONDS_PER_HOUR,
    hoursAfterBed: hoursAfterBed,
    // A dose drunk after you said you would be asleep is not "23h 29m before
    // bed", even though the arithmetic says so: bedtime has rolled to
    // tomorrow, and counting to it describes a night that is not the one
    // being ruined.
    afterBedtime: hoursAfterBed <= LATE_DOSE_HOURS,
    // Whether the bedtime this dose is being measured against is already
    // behind you. Nothing about the dose changes when it passes; what the
    // sentence has to say about it does.
    bedtimeAt: bedtime,
    bedtimePassed: bedtime <= now,
    hoursAgo: (now - dose.ts) / SECONDS_PER_HOUR
  }
}

// ------------------------------------------------------------ formatting

// 97 commercial espresso shots measured 25-214mg, so a precise integer above
// about 50mg is false precision. Round to the nearest 5 up there and leave
// small numbers alone, where 1mg is a meaningful share of the reading.
function roundDisplay(mg) {
  var level = finiteNumber(mg, 0)
  if (level < 0) return 0
  if (level < 50) return Math.round(level)
  return Math.round(level / 5) * 5
}

function formatMg(mg) {
  return roundDisplay(mg) + " mg"
}

// For the panel, where the estimate is being asserted rather than glanced at.
function formatMgApprox(mg) {
  var rounded = roundDisplay(mg)
  return (rounded >= 50 ? "~" : "") + rounded + " mg"
}

// ------------------------------------------------------------------- units
//
// Milligrams are the honest unit and the default. Cups are the one people
// think in, and the conversion is pinned to a single preset rather than to an
// average of the table, so the definition the panel prints is checkable.
//
// One decimal throughout: a tenth of a cup is 9.5mg, which is finer than the
// model's own error, and two decimals would be false precision dressed up.
// Everything that renders cups goes through cupsValue, so the floor below
// cannot be applied in one place and forgotten in another.

function cupsOf(mg, cupMg) {
  return finiteNumber(mg, 0) / cupSize(cupMg)
}

function roundCups(mg, cupMg) {
  var cups = cupsOf(mg, cupMg)
  if (cups < 0) return 0
  return Math.round(cups * 10) / 10
}

// A decaf is 2mg on purpose — the preset is in the table so that logging one
// honestly is still possible — and at one decimal it rounds to "0 cups",
// which says the opposite of the thing it was put there to say. Anything
// above zero that rounds to zero is floored rather than rounded.
function cupsValue(mg, cupMg) {
  var amount = finiteNumber(mg, 0)
  if (amount <= 0) return "0"
  var cups = roundCups(amount, cupMg)
  return cups === 0 ? "<0.1" : String(cups)
}

function formatCups(mg, cupMg) {
  var value = cupsValue(mg, cupMg)
  return value + (value === "1" ? " cup" : " cups")
}

function formatAmount(mg, units, cupMg) {
  return sanitizeUnits(units) === UNITS_CUPS ? formatCups(mg, cupMg) : formatMg(mg)
}

function formatAmountApprox(mg, units, cupMg) {
  if (sanitizeUnits(units) !== UNITS_CUPS) return formatMgApprox(mg)
  return (roundCups(mg, cupMg) >= 0.5 ? "~" : "") + formatCups(mg, cupMg)
}

// A number you logged, rather than one the model estimated: the dose on a
// preset pill or a row, the running total for the day. Stated exactly,
// because roundDisplay's nearest-5 exists to stop false precision in a
// projection and there is none to stop in a figure you got by tapping a pill.
function formatLoggedValue(mg, units, cupMg) {
  return sanitizeUnits(units) === UNITS_CUPS
    ? cupsValue(mg, cupMg)
    : String(Math.round(finiteNumber(mg, 0)))
}

function formatLogged(mg, units, cupMg) {
  return sanitizeUnits(units) === UNITS_CUPS
    ? formatCups(mg, cupMg)
    : formatLoggedValue(mg, units, cupMg) + " mg"
}

function unitName(units) {
  return sanitizeUnits(units) === UNITS_CUPS ? "cups" : "mg"
}

// ------------------------------------------------- editing a dose, in units
//
// D46 in its sharpest form. The catalog's mg is a number the panel shows you
// on a preset pill, so it converts - and a control that steps it therefore has
// to step it in the unit it is being *shown* in, or half the presses appear to
// do nothing. That was the finding at Phase 8: 5 mg is right in milligrams and
// invisible in cups, where one decimal of a 95 mg cup is 9.5 mg.
//
// So the step is 5 mg in milligrams and a tenth of a cup in cups, and the
// guarantee is stated as a test rather than as a comment: every press moves
// the rendered string, in either unit, anywhere inside the range.

var AMOUNT_STEP_MG = 5
var AMOUNT_STEP_CUPS = 0.1

function stepAmount(mg, direction, units, minMg, maxMg, cupMg) {
  var current = finiteNumber(mg, 0)
  var way = finiteNumber(direction, 0) >= 0 ? 1 : -1
  var low = finiteNumber(minMg, 1)
  var high = finiteNumber(maxMg, 100000)
  var next

  if (sanitizeUnits(units) === UNITS_CUPS) {
    // Snapped to the tenth that is on screen before stepping, so a drink that
    // was typed in milligrams still moves one visible notch per press.
    var cups = Math.round(cupsOf(current, cupMg) * 10) / 10
    next = Math.round((cups + way * AMOUNT_STEP_CUPS) * cupSize(cupMg))
  } else {
    var snapped = Math.round(current / AMOUNT_STEP_MG) * AMOUNT_STEP_MG
    next = snapped + way * AMOUNT_STEP_MG
  }
  return Math.max(low, Math.min(high, Math.round(next)))
}

// What the editor starts with, in the unit on screen, and typeable: cupsValue
// renders "<0.1" for a decaf, which is the right thing to read and the wrong
// thing to hand a text field. Below a tenth it seeds two decimals instead, so
// the value you were shown is the value that comes back when you press Enter.
function amountSeed(mg, units, cupMg) {
  var amount = Math.max(0, finiteNumber(mg, 0))
  if (sanitizeUnits(units) !== UNITS_CUPS) return String(Math.round(amount))
  var cups = roundCups(amount, cupMg)
  if (cups >= 0.1) return String(cups)
  return String(Math.round(cupsOf(amount, cupMg) * 100) / 100)
}

// The typed value, in milligrams, or null when it does not parse. An explicit
// unit wins over the setting, so "200mg" is 200mg on a panel showing cups.
function parseAmountText(text, units, cupMg) {
  var line = String(text === undefined || text === null ? "" : text).trim()
  var match = /^([0-9]+(?:\.[0-9]+)?)\s*(mg|cups?)?$/i.exec(line)
  if (!match) return null
  var amount = Number(match[1])
  if (!isFinite(amount)) return null
  var unit = (match[2] || "").toLowerCase()
  var inCups = unit === "cup" || unit === "cups"
    || (unit === "" && sanitizeUnits(units) === UNITS_CUPS)
  return inCups ? amount * cupSize(cupMg) : amount
}

// "4h 20m", "45m", "now". Used for both elapsed and remaining spans.
function formatDuration(hours) {
  var total = Math.round(Math.abs(finiteNumber(hours, 0)) * 60)
  if (total < 1) return "now"
  var wholeHours = Math.floor(total / 60)
  var minutes = total % 60
  if (wholeHours === 0) return minutes + "m"
  if (minutes === 0) return wholeHours + "h"
  return wholeHours + "h " + minutes + "m"
}

// Elapsed, but signed: a dose an hour ahead is "in 1h", not "1h". Since D20 a
// dose can be placed in the future, and formatDuration takes an absolute value
// - correctly, for every other caller - so a planned coffee would otherwise be
// indistinguishable in the list from one already drunk.
function formatOffset(hours) {
  var text = formatDuration(hours)
  if (text === "now") return text
  return finiteNumber(hours, 0) > 0 ? "in " + text : text
}

// The drink digits, as a range, from how many of them are live. **The line
// said "1–5" from Phase 1 until here, and five was never the number** — it is
// the main row's size, and D32 put the digits on catalog positions precisely
// so that a drink's key does not appear and disappear with the overflow. On
// the shipped seventeen, `6`-`0` log the next five drinks with the row
// collapsed and the legend said they did not exist.
//
// So the range is a fact about the catalog, and the caller passes the count
// (`Presets.digitCount`) rather than the toggle: a legend that changed when
// "+ More" opened would be describing a mode this panel deliberately does not
// have. It reads "0–9" at the ceiling and not "1–0", which is the order the
// pills carry but not the order anyone scans a range in.
function digitRangeLabel(count) {
  var digits = Math.max(0, Math.floor(finiteNumber(count, 0)))
  if (digits < 1) return ""
  if (digits === 1) return "1"
  if (digits >= 10) return "0–9"
  return "1–" + digits
}

// The footer legend. Here rather than in the QML for the same reason every
// other line with a number in it is: the nudge step is a constant, and a hint
// that says "15m" because someone typed 15 is a hint that goes stale silently.
//
// With nothing logged, the four keys that act on a dose are left out — the
// empty state says "tap a drink to start the curve", and a legend offering to
// delete and shift the doses you do not have argues with it.
function formatKeyHint(hasDoses, drinkCount) {
  var parts = []
  var digits = digitRangeLabel(drinkCount)
  if (digits !== "") parts.push(digits + " log")
  if (hasDoses) {
    // "arrows move" was here until Phase 11 and lost its slot to "[ ] days",
    // for the same reason "m more" lost its to "s settings" at Phase 8: the
    // line elides at seven items and the item that falls off is "? keys",
    // which is the one D40 put last so the line advertises its own overflow.
    // Of everything on the line the arrows are the most discoverable — every
    // panel in the shell walks with them, and this is the only one that pans.
    // They are still in the "?" card, with the rest.
    parts.push("↵ log")
    // "x delete" was here until Phase 12 and lost its slot to "n note" — the
    // third time this line has cost an item to gain one, and the same rule
    // decided it all three times: **the item that leaves is the one with a
    // control on screen already doing its job.** "m more" had the "+ More"
    // button (Phase 8), the arrows are taught by every panel in the shell
    // (Phase 11), and every dose row paints a ✕ at its trailing edge. All
    // three are still in the "?" card.
    parts.push("‹ › shift " + NUDGE_MINUTES + "m")
  }
  // "m more" was here until Phase 8 and lost its slot to "s settings", which
  // is the swap the render forced: eight items elided the last one, and the
  // last one is "? keys" — the item D40 put there so the line advertises its
  // own overflow. The one that left is the one with a labelled button on
  // screen ("+ More"), where the settings page has nothing but this line and
  // the mark beside it. "m" is still in the ? card, and since D95 it also has
  // "+" and "-", which is the button's own label made into keys.
  // The timeline earns a slot on the line because it is the one thing on this
  // panel you cannot discover by looking at it — every other key here has a
  // pill, a row or a mark on screen for it to be about. "[ ]" is the pair, and
  // "t" and "p" are behind "?" with the rest.
  if (hasDoses) parts.push("[ ] days")
  // The note key earns a slot on the argument the timeline earned one on: it
  // is the second thing on this panel you cannot discover by looking at it.
  // Every drink has a pill, every dose has a row, the settings have a bean —
  // a note has a line that is not there until you have written one.
  parts.push("n note")
  parts.push("s settings")
  // **"? keys" was here until D94 and it has not been evicted — it has been
  // promoted.** D40 put it last so the line advertised its own overflow, and
  // D67's rule then cost this line four donors to keep it there. The corner of
  // the footer is a fixed slot now, on every page and in both states, so the
  // pointer lives there instead of at the end of a line that elides.
  //
  // **This is the first time in this plugin's life the legend has got
  // shorter, and the slot it hands back stays empty.** All four evicted items
  // ("m more", the arrows, "x delete", "J K reorder") will look like
  // candidates to restore; the line was last balanced against a corner that
  // did not exist, so a key arriving after this has to make its own case.
  return parts.join("  ·  ")
}

// D13's line, and since D51 it is rendered in two places — under the panel,
// and inside the "?" card when the panel has been asked to go quiet. That is
// the reason it moved out of the QML and into here: a disclaimer that exists
// twice must exist once.
//
// The cup definition rides along in cups, because in that unit the line is
// also the only statement of what a cup is, and the quiet state must not be
// the only place a reader could have learned it (D27/D51).
//
// The number goes last so the article never has to be special-cased: "a
// 8-hour half-life" is what the obvious phrasing produces once the half-life
// is settable, and 8 and 11 are both reachable.
function formatEstimateNote(halfLifeHours, units, cupMg) {
  var line = "Estimated from a half-life of " + formatHalfLife(halfLifeHours)
    + " — yours may differ."
  if (sanitizeUnits(units) !== UNITS_CUPS) return line
  // D84: no volume. A cup is a round figure you set, not a serving we picked,
  // and this is now the only place the panel says what it is.
  return line + "  A cup here is " + cupSize(cupMg) + " mg."
}

// The word beside the bean in the footer's corner, on every page and in both
// states. **D94, and it deletes D51's rule rather than keeping it.**
//
// D51 had the word track what is behind the key: "keys" loud, because the card
// holds the keys, and "help" quiet, because the card also holds the estimate
// line folded into it. That was written when the item was the *last item of a
// variable line*, where a wording that changes with the contents costs
// nothing. In a fixed corner slot the same rule is a word that wobbles under a
// mark that does not — and the quiet setting's own description already
// promises this one by name ("? help stays on the line…"), so keeping D51
// would have meant rewriting that description instead.
//
// One word, one key, one card, in the same place on all five pages. Two of
// them gain a pointer they have never had: formatSettingsHint and
// formatProfileHint have no "?" item at all and never did, and both pages have
// had a "?" card since Phase 8.
function formatHelpHint() {
  return "? help"
}

// D105's card entry, and it is built rather than typed because it has a clock
// in it — this plugin's rule is that copy carrying a number goes through a
// formatter here, the way formatKeyHint prints NUDGE_MINUTES, so the line
// follows the setting when the setting moves.
//
// **It names the framing you are in rather than the one the key would give
// you**, which is a departure from every other row on that card and is the
// same departure `pinWording` already makes. The reason is that there is
// nothing else on the main page that says which of three framings the chart is
// drawn in: the axis labels carry it if you read them, and a cycle key with a
// static label would leave the card unable to answer the question it raises.
//
// The clocks arrive already rendered, because Qt owns the 12-hour question and
// this file owns the sentence — correction 9's rule, that the convention is
// read off what was drawn rather than derived a second time.
function formatFrameHint(frame, startLabel, endLabel) {
  var how = sanitizeFrame(frame)
  if (how === FRAME_DAY) return "the framing: a day from " + startLabel
  if (how === FRAME_HOURS) return "the framing: " + startLabel + " to " + endLabel
  return "the framing: now in the middle"
}

// D108. The same fact at settings-row length.
//
// The row used to print all three answers in one sentence — a menu underneath
// a control whose own pill already names the choice, and the only row on that
// page that described the options rather than the setting. This describes the
// setting as it stands, like every other row.
//
// **A second function rather than a width argument on the one above.** The
// card's line has to fit a legend cell beside eight other rows; this one may
// run to a sentence and has room to say what the framing is *for*. One
// function serving both would be a compromise at both ends, and the two are
// allowed to disagree about how much to say because they are answering in
// different amounts of space.
//
// **What the row gives up is the menu, so the tail names the key instead.**
// A description that only covers the current answer stops advertising that
// there are two others; `‹ ›` walks them and the pill names each as you go,
// but nothing would say so. Six words buy that back.
function formatFrameDescription(frame, startLabel, endLabel) {
  var how = sanitizeFrame(frame)
  var tail = " \u201cd\u201d cycles the three, \u201cD\u201d the other way."
  if (how === FRAME_DAY) {
    return "A whole day, twenty-four hours from " + startLabel + " to " + startLabel
      + " the next morning." + tail
  }
  if (how === FRAME_HOURS) {
    return "Just the hours you keep: " + startLabel + " to " + endLabel
      + ". The only framing that is not a whole day, and the only one that can"
      + " leave the present off the chart." + tail
  }
  return "Now in the middle, with twelve hours behind and twelve ahead."
    + " Always contains the present, which is what the verdict above is about."
    + tail
}

// The footer while the settings view is up. A different page needs a different
// legend: none of the drink keys reach it, and the two things you need to know
// are that a value is edited in place and that Esc goes back rather than
// closing the panel.
function formatSettingsHint() {
  return "↑ ↓ move  ·  ‹ › adjust  ·  ↵ edit  ·  Esc back"
}

// ============================================ D109: the settings page's
//                                                    first-letter jumps
//
// Nine keys that put the cursor straight on a row, and **they are deliberately
// undocumented** — not on the footer line, not on the `?` card, not in the
// README. That is the user's own decision, taken with the collision named:
// D40's arrangement is that the card is where keys that do not fit the footer
// get written down, so a card listing five keys on a page that answers to
// fourteen is a lie by omission. They were offered one line that would teach
// all nine without naming any ("the first letter of a row jumps to it") and
// chose the whole surprise instead. It is their plugin and the cost is a card
// that is incomplete rather than wrong.
//
// **The map lives here rather than in the panel because the two things that
// can go wrong with it are testable and neither is visible in QML.** A letter
// used twice, and a letter the stock PanelKeyCatcher eats before the panel
// sees it. Both were in the request as written: `b` was asked for twice (for
// Bedtime and for the bar's number) and `l` was asked for at all, and `l` is
// how the catcher moves the cursor right. The test below is the thing that
// would have caught both.
//
// The two substitutions, confirmed by the user rather than assumed: **`b` is
// Bedtime**, which is the row people actually go to, and the bar's number
// takes `n`. **The half-life takes `L`** — shifted, because the catcher
// consumes bare `h j k l x` and forking it was refused at D50; the shift keeps
// the mnemonic exactly, and it is the route `J`, `K` and `N` already arrive by.
//
// The letters the catcher takes, so the test has something to check against.
// `x` is here as well as its shifted form, which is the one difference from
// the cursor keys: the catcher matches "x" or "X" for delete and only the
// lower-case h/j/k/l for movement.
var CATCHER_KEYS = ["h", "j", "k", "l", "x", "X"]

// And the two this page already spends: `s` leaves it, `?` opens the card.
var SETTINGS_PAGE_KEYS = ["s", "S", "?", "/"]

var SETTINGS_JUMPS = [
  { key: "d", row: "drinks" },
  { key: "b", row: "bedtime" },
  { key: "t", row: "sleepThresholdMg" },
  { key: "L", row: "halfLifeHours" },
  { key: "p", row: "profile" },
  { key: "u", row: "units" },
  { key: "n", row: "barNumber" },
  { key: "c", row: "dailyCapEnabled" },
  { key: "q", row: "quietPanel" }
]

// Which row a keystroke wants, or "" for one that wants none. The panel does
// the finding, because it is the panel that knows which rows are on screen —
// `cupMg` exists only in cups and `dailyCapMg` only once the cap is on, so a
// jump to a row that is not currently in the list has to do nothing rather
// than land on an index of -1.
function settingsJumpFor(text) {
  var key = String(text === undefined || text === null ? "" : text)
  for (var i = 0; i < SETTINGS_JUMPS.length; i++) {
    if (SETTINGS_JUMPS[i].key === key) return SETTINGS_JUMPS[i].row
  }
  return ""
}

// A number of hours, as words, at the precision the model actually claims: one
// decimal, and never a trailing ".0". A tenth of an hour is six minutes, which
// is already finer than an estimate built on a population mean.
//
// It exists apart from formatHalfLife because the derivation has to be able to
// print the figure it was clamped *from*, which by definition is outside the
// clamp formatHalfLife applies.
function formatHours(hours) {
  var value = Math.round(finiteNumber(hours, 0) * 10) / 10
  return (value === Math.round(value) ? String(Math.round(value)) : String(value)) + " hours"
}

// A half-life, as words. The custom value is a whole number and the derived
// one has a decimal in it, and "7.35000000000001 hours" is what happens if a
// binding concatenates the second kind.
function formatHalfLife(hours) {
  return formatHours(sanitizeHalfLife(hours))
}

// A multiplier, as it is printed in the derivation. Two decimals only when the
// second one is doing something: 1.47 is a measured ratio and 2.0 is not 2.
function formatFactor(factor) {
  var text = finiteNumber(factor, 1).toFixed(2)
  return text.charAt(text.length - 1) === "0" ? text.slice(0, -1) : text
}

// One line of the shown arithmetic: "x 1.47  oral contraceptives".
function formatDerivationStep(step) {
  if (!step) return ""
  return "× " + formatFactor(step.factor) + "   " + step.effect
}

// The arithmetic is printed as two columns - what is being multiplied, and
// what put it there - so the three kinds of line below all agree on where the
// numbers start. The panel concatenates none of it.
//
// The base. 5 hours is a population mean, not this user's number, and the
// caption is where that gets said once rather than in a disclaimer.
function formatDerivationBase() {
  return formatHours(PROFILE_BASE_HOURS)
}

function formatDerivationBaseNote() {
  return "a typical adult"
}

// The total's left column: the number the page exists to produce.
function formatDerivationMark(derivation) {
  if (!derivation) return ""
  // No "=" when nothing was multiplied. An unanswered profile has no steps, so
  // the block was printing the base and the total as two adjacent lines
  // carrying the same number, with a rule between them — which is a sum with
  // one term in it, and the same "one figure twice, inches apart" shape D57
  // and D61 each threw a build away for. With no steps the page shows the one
  // line, and it is the total, because the total is the number the page
  // exists to produce.
  if (!derivation.steps || derivation.steps.length === 0)
    return formatHalfLife(derivation.hours)
  return "= " + formatHalfLife(derivation.hours)
}

// Whether the block has any working to show. The base line and the rule under
// it are the working; with nothing multiplied there is none, and a rule under
// a single number is a total of itself.
function derivationHasSteps(derivation) {
  return !!(derivation && derivation.steps && derivation.steps.length > 0)
}

// And its right column. "estimated" is not decoration - D13, and the science
// notes' own copy section: everything the panel asserts about a number it
// worked out says so in the sentence that asserts it.
//
// A clamp that is not shown is a coefficient the user answered for and never
// saw applied. Late pregnancy stacked on anything lands there — and since D100
// took the one drug row off the page, that is the whole of what reaches the
// ceiling, which is why it was computed rather than assumed.
//
// `liveHalfLife` is the number the panel is actually using, and it is passed
// only when that is NOT this one. The first render of this page is why it
// exists: with a half-life set by hand the block still ended on "= 4 hours
// estimated", in bold, at the top of the page - the loudest assertion on
// screen, about a number nothing was using, three inches under a hero computed
// from 9. D34's precedence was correct and invisible. The offer to swap is six
// rows further down; the total has to carry it too.
function formatDerivationNote(derivation, liveHalfLife) {
  if (!derivation) return ""
  var note = derivation.clamped
    ? "estimated (the model's limit, from " + formatHours(derivation.raw) + ")"
    : "estimated"
  if (liveHalfLife === undefined || liveHalfLife === null) return note
  return note + " — " + formatHalfLife(liveHalfLife) + " is in use"
}

// The whole last line as one string, for anywhere that has one line to spend.
function formatDerivationTotal(derivation, liveHalfLife) {
  if (!derivation) return ""
  return formatHalfLife(derivation.hours) + " "
    + formatDerivationNote(derivation, liveHalfLife)
}

// The footer while the profile is up. Same five-item shape as the other three
// legends; the only key this page adds is that <> cycles an answer rather than
// stepping a number, which is why it says "answer" and not "adjust".
function formatProfileHint() {
  return "↑ ↓ move  ·  ‹ › answer  ·  ↵ next answer  ·  Esc back"
}

// The pregnancy note, next to the daily cap rather than only next to the
// half-life. The two compound - a 200mg day sits on top of a 10-15h half-life
// - and the cap is the setting a person would otherwise never think to change
// after answering a question about their metabolism.
//
// It takes the units, and that is D23's pattern in a shape neither D27 nor D46
// had yet. D27 exempts a line that quotes a study from converting, and D46
// says a number the panel shows elsewhere must read in the same unit there and
// here. Both are right and they meet on this one row, because for the first
// time the cited figure and the shown value are *the same number*: in cups the
// row's pill read "2.1 cups" over a description citing "200 mg a day", one
// quantity rendered twice with nothing saying so.
//
// The resolution is D27's own device, the one the strong-dose line already
// uses ("over 100 mg (125 mg)"): the figure converts, because the pill beside
// it does, and the source's own number follows it in brackets so the
// attribution stays true. In milligrams the two agree and the bracket does not
// appear at all.
function formatPregnancyCapNote(units, cupMg) {
  var stated = PREGNANCY_CAP_MG + " mg"
  var shown = formatAmount(PREGNANCY_CAP_MG, units, cupMg)
  if (shown === stated)
    return "In pregnancy the figure health authorities use is " + stated + " a day."
  return "In pregnancy the figure health authorities use is " + shown
    + " a day (they state it as " + stated + ")."
}

// The footer while the drink catalog is up. The page with the most keys on it
// of the five, and the only one whose keys are all new, so it is also the one
// that most needs the "?" pointer - which since D94 is a fixed corner rather
// than the last item of this line, and is therefore the one thing on it that
// can no longer be squeezed off the end.
//
// It names the unit it steps, and that is D46 again, from a third direction:
// the first render of this line said "‹ › mg" over a page of rows reading
// "2.1 cups", because the legend was written while the panel happened to be in
// milligrams. A legend that names a unit has to be told which one is in force,
// exactly like every other number on the panel.
// D53 put a seventh item's worth of keys on this page and the line was
// already the longest of the four. What left is what the rule that has
// decided this line three times says leaves (D67): the item with a control on
// screen already doing its job. "J K reorder" had the ⌃ ⌄ pair painted on the
// highlighted row — the same argument the ✕ made for "x delete" at Phase 12
// and the "+ More" button made for "m more" at Phase 8 — and "i icon" has
// nothing on the page for it to be about until it has been pressed once.
// Both are in the "?" card.
function formatCatalogHint(units) {
  // D94: no "? keys" item. The corner carries it now, on every page.
  return ["↑ ↓ move", "‹ › " + unitName(units), "↵ edit", "i icon",
          "Esc back"].join("  ·  ")
}

// The verdict, in words. Hedged on purpose: this is an estimate from a
// population half-life, and D13 keeps every line here descriptive rather than
// medical or instructive.
//
// Past bedtime it needs a second wording. "Likely to disrupt sleep" is about a
// night you have not started; at half past bedtime you have, and the sentence
// has to be about the state you are in rather than one you are heading for.
function verdictFor(band, afterBedtime) {
  if (band === "clear") return afterBedtime ? "Clear to sleep now" : "Clear for sleep"
  if (band === "marginal") return afterBedtime ? "Borderline to sleep on" : "Borderline for sleep"
  return afterBedtime ? "Likely to keep you up" : "Likely to disrupt sleep"
}

// The hero's right-hand pair of lines, and D42's answer decided from renders.
//
// Before bedtime the headline is the second number — what will still be in you
// when you lie down — and the caption is the verdict on it. That is D4, and it
// is unchanged.
//
// Past bedtime there is no second number: the projection reports now, and now
// is already stated on the hero's left at full weight. Four candidates were
// built and rendered in all three bands. Restating it ("~115 mg now") put the
// same figure on screen twice, three inches apart, in two colours. Naming the
// gap ("27m past bedtime") collided with D41's line immediately below, which
// says "15m after bedtime" about the dose rather than about now — two
// durations, both true, nothing on screen to reconcile them. Naming the clock
// ("Bedtime was 10:14 PM") gave the whole right column over to a time the BED
// hairline already marks.
//
// So the verdict itself takes the headline. Which is the same rule D4 applied
// in the first place — the right side of the hero states the assertion and the
// line under it qualifies the assertion — read correctly for a moment when the
// assertion is no longer a number. `clock` is still taken, because before
// bedtime the headline is still a clock.
function projectionHeadline(projection, units, clock, cupMg) {
  if (!projection) return ""
  if (projection.afterBedtime) return verdictFor(projection.band, true)
  return formatAmountApprox(projection.mg, units, cupMg) + " at " + clock
}

// Past bedtime the caption says why the frame changed, and deliberately says
// it without a number: a duration here is the one that collides with D41's.
function projectionCaption(projection) {
  if (!projection) return ""
  return projection.afterBedtime ? "Past bedtime" : verdictFor(projection.band, false)
}

// Where the strong dose sits relative to bedtime, as the words for it. The
// panel concatenates nothing: this is the branch that keeps a 23:30 espresso
// from reading "23h 29m before bed" once bedtime has rolled to tomorrow.
// D72, and the second half of defect #5: once the bedtime the dose was drunk
// before is behind you, the number is right but the sentence is not. "48m
// before bed" three inches under a hero reading PAST BEDTIME reads as a
// bedtime still ahead, and a reader has no way to tell the two apart.
//
// Five wordings were built and rendered with the hero in the same capture, in
// the window they apply to. The bare one is the one above. "tonight's bedtime"
// is tight and correct inside D42's four-hour window and quietly wrong outside
// it — at five the next morning "tonight" is the night to come, and the dose
// was measured against the one that went. Naming the clock ("48m before
// 6:21 PM") is always true and reads as a time nothing on the line accounts
// for. "before bed, which has now passed" is unambiguous and hangs its clause
// off "bed", which has not passed — bedtime has.
//
// So: the clause hangs off "bedtime", and it drops "now", which is what made
// it read as a restatement of the hero's caption rather than as a fact about
// the dose. What is left is true in every window this line can be read in.
// The head of the strong-dose line, and it exists because "over" was a lie at
// exactly one dose: `lastStrongDose` takes doses **at or above** 100 mg — which
// is right, 100 mg is the figure the trials themselves call strong — so a
// 100 mg americano rendered "Last dose over 100 mg (100 mg)", a sentence that
// contradicts itself inside eight words. Found on a fresh install, because the
// shipped catalog's Americano is exactly 100 and no staged day had ever used it.
//
// The bracket is D27's device, the one formatPregnancyCapNote already uses:
// when the cited figure and the shown value are the same number, quoting both
// says nothing twice, so the bracket drops and the sentence names the one
// number there is. Above the threshold nothing changes — "over 100 mg (125 mg)"
// was always right and is what the line still says.
function formatStrongDoseHead(doseMg, thresholdMg) {
  var threshold = finiteNumber(thresholdMg, STRONG_DOSE_MG)
  var mg = Math.round(finiteNumber(doseMg, 0))
  if (mg <= threshold) return "Last dose of " + threshold + " mg"
  return "Last dose over " + threshold + " mg (" + mg + " mg)"
}

function formatLead(lead) {
  if (!lead) return ""
  if (lead.afterBedtime) {
    var after = formatDuration(lead.hoursAfterBed)
    return after === "now" ? "at bedtime" : after + " after bedtime"
  }
  var before = formatDuration(lead.hoursBeforeBed)
  return before + (lead.bedtimePassed ? " before bedtime, which has passed"
                                      : " before bed")
}

// =========================================================== the timeline
//
// Phase 11. The curve stops being a fixed window on now and becomes a window
// that pans: `viewOffsetSeconds` moves its centre back through the record,
// and a pinned day is resampled over its own window and drawn under today's.
//
// Everything here is offsets and clamps rather than dates-as-strings — the
// panel formats, this decides. `levelOverRange` already sampled an arbitrary
// range, so the engine needed no new sampler, only the bounds and the shift.

// One pan step, in seconds. The small step and the big one, transposed from
// the Clock panel's month/year onto a chart whose window is a day wide.
var PAN_STEP_SECONDS = SECONDS_PER_DAY
var PAN_JUMP_SECONDS = 7 * SECONDS_PER_DAY

// ====================================================== D105: how the chart
//                                                             is framed
//
// **Three answers to "what stretch of time is this chart about", and they are
// three answers rather than one setting with a number in it.**
//
// - `rolling` — now in the middle, twelve hours each way. The framing every
//   capture in this project has been of, and the one that always contains the
//   present. It answers *where am I now*, which is what the bedtime verdict
//   above the chart is about.
// - `day` — twenty-four hours from a clock time you set, running to the same
//   time tomorrow. It answers *what did this day look like*, which is the
//   question the timeline keys, the pin and the notes were all built for, and
//   it is the only framing in which two days are comparable on one axis. The
//   pinned ghost has wanted it since D64: a day laid over a day is a
//   comparison, a day laid over a rolling window is an alignment accident.
// - `hours` — from one clock time to another, defaulting 07:00 to midnight.
//   The waking day rather than the calendar one, and the only framing whose
//   span is not twenty-four hours.
//
// **`hours` is the one with a hole in it, and that is the point of it rather
// than a flaw.** Between the end time and the next start time there is no
// window, so at 03:00 with 07:00-00:00 the present is not on any chart. The
// answer, taken from the user rather than assumed: home is **the window that
// most recently started**, so at 03:00 you are looking at the day you have
// just finished with your last coffee on it, and `now` sits off the right edge
// where the seam simply is not drawn. The alternative — a chart of the day
// ahead, entirely empty — is honest about the framing and useless.
//
// Everything funnels through `frameWindowAt`, which is what makes this
// tractable: `fromTs` and `toTs` are the whole window on the panel, and the
// axis marks, the samples, the seam at now, the record's left edge, the empty
// predicate and the ghost all read them.
//
// **What does not funnel through it is the day's identity, and that is the
// hard half.** A rolling window is *about* its middle; an anchored one is
// about its **start**. The centre of a window that opens at 07:00 is 19:00 the
// same day, which is right by luck — set the start to 20:00 and the centre is
// 08:00 the *next* day, so the note `n` writes, the caption's "Yesterday", the
// day's total and that day's bedtime would every one of them name a day the
// window mostly is not. So the window carries an `anchor`, every one of those
// readers takes it, and `viewCentreTs` is gone from all of them.
var FRAME_ROLLING = "rolling"
var FRAME_DAY = "day"
var FRAME_HOURS = "hours"

// The order the key cycles them in, and the order the settings row steps
// through: the framing that needs no settings first, then the one that needs a
// start, then the one that needs both. A user pressing `d` walks from simplest
// to most specified rather than at random.
var FRAMES = [FRAME_ROLLING, FRAME_DAY, FRAME_HOURS]

// 07:00 because it is about the earliest people start drinking coffee, and
// midnight because the third framing is the waking day. Both are clocks, and
// they go through the bedtime row's own machinery — parseClockStrict,
// sanitizeBedtime's shape, formatClock24 — so "7am" and "12 AM" are accepted
// exactly where "11:00 PM" already is (D29).
var DAY_START_DEFAULT = "07:00"
var DAY_END_DEFAULT = "00:00"

// A floor on the third framing's span. Two clock times a quarter of an hour
// apart are a chart with one axis mark on it, and the axis is drawn in whole
// hours — so this is the size below which the chart stops being one, not a
// judgement about what a useful day is. Silent, like every other clamp in this
// file: the helper script validates each clock on its own and cannot see the
// pair, so there is nowhere else this could be refused out loud.
var FRAME_MIN_SPAN_HOURS = 2

function sanitizeFrame(frame) {
  var text = String(frame === undefined || frame === null ? "" : frame).toLowerCase()
  for (var i = 0; i < FRAMES.length; i++) if (FRAMES[i] === text) return FRAMES[i]
  return FRAME_ROLLING
}

// What the settings row's pill says. Short enough for the pill and different
// enough from each other to be told apart at a glance; the times themselves
// are in the two rows underneath, which is why no number appears here.
function frameName(frame) {
  var how = sanitizeFrame(frame)
  if (how === FRAME_DAY) return "A whole day"
  if (how === FRAME_HOURS) return "Chosen hours"
  return "Now in the middle"
}

// The next framing along. Wraps, because the key is a cycle through three and
// a cycle that stops is a key that dies on the last answer; the settings row
// steps with the same function for the same reason (the pair `‹ ›` on a
// three-answer row is the barNumber shape, and that one stops — this one does
// not, because `d` and the row have to agree about what "next" is).
function nextFrame(frame, direction) {
  var at = FRAMES.indexOf(sanitizeFrame(frame))
  var step = finiteNumber(direction, 1) < 0 ? -1 : 1
  return FRAMES[(at + step + FRAMES.length) % FRAMES.length]
}

// How wide the window is. Twenty-four hours for both of the first two; for the
// third, the forward distance from one clock to the other.
//
// **Equal clocks mean a whole day, not a zero-width chart.** Setting the end
// to the start is the natural way to ask for "all of it", and it makes the
// third framing degrade into the second rather than into nothing.
function frameSpanSeconds(frame, dayStartText, dayEndText) {
  if (sanitizeFrame(frame) !== FRAME_HOURS) return SECONDS_PER_DAY
  var start = parseClock(dayStartText)
  var end = parseClock(dayEndText)
  var minutes = (end.hours * 60 + end.minutes) - (start.hours * 60 + start.minutes)
  if (minutes <= 0) minutes += 24 * 60
  return Math.max(FRAME_MIN_SPAN_HOURS * SECONDS_PER_HOUR, minutes * 60)
}

// The window a moment falls in: `{ from, to, anchor }`.
//
// `anchor` is the window's identity — its centre when the window is about now,
// its start when it is about a day — and it is what every reader that used to
// take `viewCentreTs` now takes. The two are the same value in the rolling
// framing, which is why nothing changes there.
//
// The start is found by rolling *back* to the most recent occurrence of the
// clock, never forward. That is the whole of "home is the window that contains
// now, not today's date at the start time": at 03:00 with a 07:00 start, the
// day you are in began at 07:00 yesterday.
function frameWindowAt(frame, atSeconds, dayStartText, dayEndText) {
  var how = sanitizeFrame(frame)
  var at = toSeconds(atSeconds)
  if (how === FRAME_ROLLING) {
    var half = CURVE_WINDOW_HOURS * SECONDS_PER_HOUR
    return { from: at - half, to: at + half, anchor: at }
  }
  var start = previousClockSeconds(at, dayStartText)
  return {
    from: start,
    to: start + frameSpanSeconds(how, dayStartText, dayEndText),
    anchor: start
  }
}

// The total logged inside an arbitrary window.
//
// The caption's figure used to be `dayTotalMg`, the calendar day the window is
// centred on — which is the right answer while a day means midnight to
// midnight and the wrong one the moment the user has said what a day is. In an
// anchored framing the caption is about the window on screen, so its total is
// the window's: a coffee at 02:00 belongs to the window that opened at 07:00
// yesterday, and it is drawn at the right-hand end of that window rather than
// at the left-hand end of this one.
//
// The *note* stays keyed to the calendar day (`dayKeyOf` of the anchor),
// because a note is filed by date and a date is a calendar thing. With a 07:00
// start the two describe the same day for all but the small hours; with a
// 20:00 start they deliberately do not, and the anchor is what keeps the note
// on the day the caption names.
function totalInRange(doses, fromSeconds, toSeconds_) {
  var from = toSeconds(fromSeconds)
  var to = toSeconds(toSeconds_)
  var list = sanitizeDoses(doses)
  var total = 0
  for (var i = 0; i < list.length; i++) {
    if (list[i].ts >= from && list[i].ts < to) total += list[i].mg
  }
  return total
}

// How far back the timeline goes, in whole days: to the day of the oldest
// dose on file and no further. Retention prunes at RETENTION_DAYS, so this is
// never more than that. Whole days rather than raw seconds so that a day step
// stays on its grid at the boundary — a clamp to an arbitrary second would
// leave every later step half a day out of phase with the axis.
function panDaysAvailable(doses, nowSeconds, frame, dayStartText) {
  var sorted = sanitizeDoses(doses)
  if (sorted.length === 0) return 0
  var oldest = sorted[sorted.length - 1].ts
  var now = toSeconds(nowSeconds)
  if (oldest >= now) return 0
  // How many whole days back the *window* has to move for the oldest dose to
  // be inside it — not how many days ago the dose was, which is the same
  // number only when the dose happens to sit within twelve hours of now's
  // clock time.
  //
  // The difference is D64 being broken by the arithmetic written to enforce
  // it. "Back stops at the oldest dose", and the last step back was landing on
  // a window that ended before that dose: a 200 mg cold brew five days and
  // nine hours old, read at eight in the evening, made the furthest-back view
  // a completely empty chart — which is precisely the "record of empty days"
  // D64 refuses to let anyone pan into.
  //
  // Subtracting the window's own half-width is what fixes it, and it fixes it
  // in seconds, so nothing here depends on which side of a midnight the two
  // moments fall. Still a whole number of days, because the step grid is what
  // keeps a pan aligned with the axis.
  // **And since D105 the half-width is not always the half-width**, which is
  // this same line being broken a second time by arithmetic written for one
  // shape of window. An anchored window does not extend behind its own start
  // at all, so what has to reach the oldest dose is the *start*, and the
  // distance to cover is from today's start rather than from now. Rolling is
  // unchanged and is still what an absent frame means.
  var reach = sanitizeFrame(frame) === FRAME_ROLLING
    ? now - oldest - CURVE_WINDOW_HOURS * SECONDS_PER_HOUR
    : previousClockSeconds(now, dayStartText) - oldest
  var days = Math.ceil(reach / SECONDS_PER_DAY)
  if (days < 0) days = 0
  return days > RETENTION_DAYS ? RETENTION_DAYS : days
}

// Forward stops at now. The panel already draws twelve hours of projection to
// the right of the seam, and a window entirely to the right of that is a chart
// of one decaying exponential with nothing on it to read.
function clampPanOffset(offsetSeconds, doses, nowSeconds, frame, dayStartText) {
  var offset = finiteNumber(offsetSeconds, 0)
  if (offset >= 0) return 0
  var days = panDaysAvailable(doses, nowSeconds, frame, dayStartText)
  if (days === 0) return 0
  var floor = -days * SECONDS_PER_DAY
  return offset < floor ? floor : offset
}

// Whole local days between two instants, rounded — so a DST night is one day
// apart and not 0.958 of one.
function daysApartLocal(fromSeconds, toSeconds_) {
  var a = new Date(toSeconds(fromSeconds) * 1000)
  var b = new Date(toSeconds(toSeconds_) * 1000)
  a.setHours(0, 0, 0, 0)
  b.setHours(0, 0, 0, 0)
  return Math.round((b.getTime() - a.getTime()) / (SECONDS_PER_DAY * 1000))
}

// What the axis calls where you are. Read off the calendar day the window is
// centred on rather than off the offset, so a part-day pan says the day it is
// actually showing.
function formatDayOffset(centreSeconds, nowSeconds) {
  var days = daysApartLocal(centreSeconds, nowSeconds)
  if (days <= 0) return "Today"
  if (days === 1) return "Yesterday"
  return days + " days ago"
}

// Samples over a past window, each stamped as though it had happened today, so
// the ghost lines up with the live curve by time of day instead of running off
// the left of the chart.
function levelOverRangeShifted(doses, fromSeconds, toSeconds_, halfLifeHours, count, shiftSeconds) {
  var shift = toSeconds(shiftSeconds)
  var out = levelOverRange(doses, fromSeconds, toSeconds_, halfLifeHours, count)
  for (var i = 0; i < out.length; i++) out[i].ts += shift
  return out
}

// The total logged on the local day a moment falls in. The pinned day's label
// wants a figure, and it is the one number that says whether the comparison is
// worth looking at.
function dayTotalMg(doses, atSeconds) {
  var start = new Date(toSeconds(atSeconds) * 1000)
  start.setHours(0, 0, 0, 0)
  var from = Math.floor(start.getTime() / 1000)
  var to = from + SECONDS_PER_DAY
  var list = sanitizeDoses(doses)
  var total = 0
  for (var i = 0; i < list.length; i++) {
    if (list[i].ts >= from && list[i].ts < to) total += list[i].mg
  }
  return total
}

// ------------------------------------------------------------------- notes
//
// D48/D65. A day you have scrolled to can be written on, and the written days
// are a list you can walk back into. Everything here is the parsing, the
// sanitising and the copy; the file is Notes.qml's and the panel does the
// drawing.
//
// The vocabulary matters more than the code does, so it is stated once here
// and nowhere contradicted: **a pin is a view and a note is a record.** The
// pin (D62) is where you are looking — one at a time, in a QML property,
// cleared by pressing `p` again. A note is something you wrote down — as many
// as you like, on disk, removed only deliberately. Nothing in this plugin is
// called a bookmark, because "bookmark" and "pin" are the same word twice.

// A note is a sentence or two. The cap keeps the file small and the review
// list renderable, and it is enforced on the way in rather than on the way
// out, so a hand-edited file cannot put a novel on a row.
var NOTE_TEXT_MAX = 500

// And a ceiling on how many days can be in the file at all. Thirty years of
// noting every day is under this; anything past it is not a file we wrote.
var NOTE_DAYS_MAX = 5000

// The key a note is filed under: the local calendar day, as YYYY-MM-DD.
//
// Local and not UTC, and that is the whole of D42's deferred question
// answered. "Which day is 23:30 in?" is answered by which day the timeline
// has you on, and the timeline is drawn in local time — so a note written at
// 23:30 lands on the day whose curve is on screen, which is the day the user
// is looking at. A UTC key would file a European evening under tomorrow.
function dayKeyOf(tsSeconds) {
  var date = new Date(toSeconds(tsSeconds) * 1000)
  var month = date.getMonth() + 1
  var day = date.getDate()
  return date.getFullYear() + "-" + (month < 10 ? "0" : "") + month
    + "-" + (day < 10 ? "0" : "") + day
}

// The reverse, landing at local noon rather than at midnight. Noon is the one
// hour of the day that survives every DST transition on earth, so a day key
// round-trips through this and dayKeyOf unchanged wherever the clock jumps.
function dayKeyTs(dayKey) {
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dayKey || ""))
  if (!match) return null
  var year = Number(match[1])
  var month = Number(match[2])
  var day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  var date = new Date(year, month - 1, day, 12, 0, 0, 0)
  // Rejects the 31st of a 30-day month rather than accepting the rollover
  // Date hands back for it.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1
      || date.getDate() !== day) return null
  return Math.floor(date.getTime() / 1000)
}

function isDayKey(dayKey) {
  return dayKeyTs(dayKey) !== null
}

// One entry, from whatever the file held. A note is (flagged, text, updated),
// and a day with neither a flag nor a word on it is not a note — returning
// null here is what drops it on read rather than carrying an empty row into
// the list.
function sanitizeNoteEntry(entry) {
  if (!entry || typeof entry !== "object") return null
  var text = typeof entry.text === "string" ? entry.text.trim() : ""
  if (text.length > NOTE_TEXT_MAX) text = text.slice(0, NOTE_TEXT_MAX).trim()
  var flagged = truthy(entry.flagged)
  // Text implies the mark: a day with words on it is in the list whatever the
  // flag says, so the two cannot disagree.
  if (text !== "") flagged = true
  if (!flagged) return null
  var updated = Math.floor(finiteNumber(entry.updated, 0))
  return { flagged: true, text: text, updated: updated > 0 ? updated : 0 }
}

// The whole file. Same discipline as sanitizeDoses: this is untrusted text
// that a hand edit can reach, read inside the shell process, so anything that
// is not exactly what we write is dropped rather than propagated.
function sanitizeNotes(raw) {
  var out = {}
  if (!raw || typeof raw !== "object" || raw.length !== undefined) return out
  var keys = []
  for (var key in raw) if (isDayKey(key)) keys.push(key)
  // Newest first before the cap bites, so a file over the ceiling loses its
  // oldest days rather than an arbitrary slice of them.
  keys.sort()
  keys.reverse()
  if (keys.length > NOTE_DAYS_MAX) keys = keys.slice(0, NOTE_DAYS_MAX)
  for (var i = 0; i < keys.length; i++) {
    var entry = sanitizeNoteEntry(raw[keys[i]])
    if (entry !== null) out[keys[i]] = entry
  }
  return out
}

// The file as a list, newest day first — the order doses.json and archive.json
// are both in, so nothing in this plugin has two ideas of which end is new.
function noteEntries(notes) {
  var clean = sanitizeNotes(notes)
  var keys = []
  for (var key in clean) keys.push(key)
  keys.sort()
  keys.reverse()
  var out = []
  for (var i = 0; i < keys.length; i++) {
    out.push({ day: keys[i], ts: dayKeyTs(keys[i]),
               flagged: clean[keys[i]].flagged,
               text: clean[keys[i]].text,
               updated: clean[keys[i]].updated })
  }
  return out
}

function noteFor(notes, dayKey) {
  var clean = sanitizeNotes(notes)
  return clean[dayKey] === undefined ? null : clean[dayKey]
}

// A note written, as the whole file back. The store writes what this returns
// and nothing else, so there is one place where a note's shape is decided.
// Empty text is not a deletion: pressing the key on a day is the marking
// gesture, and committing nothing marks the day without words (D65). Removing
// one is `x` on the notes page, which is where the drinks are removed too.
function writeNote(notes, dayKey, text, nowSeconds) {
  var clean = sanitizeNotes(notes)
  if (!isDayKey(dayKey)) return clean
  var out = {}
  for (var key in clean) out[key] = clean[key]
  var entry = sanitizeNoteEntry({ flagged: true, text: text,
                                  updated: toSeconds(nowSeconds) })
  if (entry !== null) out[dayKey] = entry
  return out
}

function removeNote(notes, dayKey) {
  var clean = sanitizeNotes(notes)
  var out = {}
  for (var key in clean) if (key !== dayKey) out[key] = clean[key]
  return out
}

// ------------------------------------------------- what a noted day says
//
// D66. The review list states the day, the day's total, that day's bedtime
// verdict and the note — and nothing else. It does not correlate, score,
// average or rank, and there is no line anywhere that reads "your data
// suggests". That is D13's limit and this is the feature that walks up to it:
// the plugin shows what you wrote beside what you logged and lets you draw
// your own conclusion.

// The oldest dose still on file, or null. The retention prune moves doses into
// archive.json (D44) and nothing reads them back, so this is the real floor of
// what the panel can say anything about.
function oldestDoseTs(doses) {
  var sorted = sanitizeDoses(doses)
  if (sorted.length === 0) return null
  return sorted[sorted.length - 1].ts
}

// Whether a day's drinks are still on file. A note outlives its doses — that
// is the entire reason notes.json is not a field on doses.json — so a review
// list that computed a total and a verdict for a day whose record has aged
// into the archive would print "0 mg · clear for sleep" about a day it knows
// nothing about. This is D64's argument moved from the axis to a row: an empty
// day inside the record is a real empty day; one before it is a day that was
// thrown away.
function dayRecordKept(doses, dayTs) {
  var oldest = oldestDoseTs(doses)
  if (oldest === null) return false
  return daysApartLocal(oldest, dayTs) >= 0
}

// The bedtime that day was heading for, and what the level would have been on
// reaching it. `bedtimeSeconds` from that day's noon gives the night the day
// started — 23:00 the same evening, or a 01:00 bedtime early the next morning.
function dayBedtime(doses, dayTs, halfLifeHours, bedtimeText, thresholdMg) {
  var at = bedtimeSeconds(dayTs, bedtimeText)
  var mg = levelAt(doses, at, halfLifeHours)
  return { at: at, mg: mg, rounded: roundDisplay(mg),
           band: bedtimeBand(mg, thresholdMg) }
}

// "Today", "Yesterday", "5 days ago" — formatDayOffset over a day key, so the
// review list and the chart's caption cannot disagree about what to call a
// day.
function formatNoteOffset(dayKey, nowSeconds) {
  var ts = dayKeyTs(dayKey)
  if (ts === null) return ""
  return formatDayOffset(ts, nowSeconds)
}

// The user's own words, marked as theirs. The quotes are not decoration: this
// is the one line in the plugin that is not the plugin talking, and the review
// list puts it directly under a sentence the plugin wrote about the same day.
function formatNoteText(text) {
  var trimmed = String(text || "").trim()
  return trimmed === "" ? "" : "“" + trimmed + "”"
}

// What a day with no words on it says instead. It is still a note — you
// pressed the key on that day deliberately — and the numbers beside it are
// the thing you marked it for.
var NOTE_EMPTY_TEXT = "Marked, no note"

// The footer while the notes page is up. Same shape as the catalog's and the
// settings': what moves, what the keys do, and how to get back.
//
// And the same rule as formatKeyHint's empty state, which is D40's: a legend
// offering to walk, enter and remove the rows you do not have argues with the
// line above it saying there are none. On an empty page only the way out is
// true.
function formatNotesHint(hasNotes) {
  var parts = []
  if (hasNotes) parts.push("↑ ↓ move", "↵ go to that day", "x remove")
  // D94: the "?" pointer is in the corner now, not at the end of this line.
  parts.push("Esc back")
  return parts.join("  ·  ")
}

// The line above the curve that says what is written on the day you are
// standing on, and the placeholder in the field that writes it.
var NOTE_PLACEHOLDER = "How did this day go?"

// The plugin's own sentence about a noted day: what was logged on it, and what
// that came to at that day's bedtime. Stated, never interpreted — this is the
// line that sits closest to D13, and it is the reason the note beneath it is
// quoted: one of the two is the plugin talking and the other is not.
function formatNoteSummary(totalText, bedtimeText_, clockText, verdict) {
  var said = String(verdict || "")
  return totalText + " logged  ·  " + bedtimeText_ + " at " + clockText
    + ", " + said.charAt(0).toLowerCase() + said.slice(1)
}

// And what it says instead when the drinks are gone. A note is never pruned
// and a dose is, so this row is reachable by design rather than by accident.
function formatNoteExpired() {
  return "No drinks on file — this day is past the " + RETENTION_DAYS + "-day record"
}
