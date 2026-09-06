// The log-a-drink table.
//
// Values follow USDA FoodData Central where it has a figure, and the measured
// literature where it doesn't. Sourced in plan/caffeine-curve-science.md.
// Kept free of QML types for the same reason as Caffeine.js.
//
// Since D31 this table is the *default* catalog and not the catalog: the user
// can add, re-price, remove and reorder drinks, and what they end up with is
// stored as the `drinks` key of the settings file. Everything below the table
// is therefore written as a pure function over a supplied catalog, so the
// panel can hand it the user's list and the tests can hand it anything at all.
//
// The order is the catalog order, and that order is the UI: the main row is
// its first `MAIN_ROW_SIZE`, the overflow is the rest, and the number keys
// count down it. So the table is written in the order the panel shows it
// rather than in the order it was researched.
var DEFAULTS = [
  // **D102. This table is one person's list, and that is the rule now.**
  //
  // Three arguments built it and all three are still why these seventeen
  // drinks are the seventeen drinks. D6 chose by **spread**: each preset named
  // a category the others would misreport by 50 mg or more. D86 amended that
  // to **frequency** for the five pills a user sees first, because a row of
  // accurate drinks nobody orders goes unused. D96 added the tail on
  // **recognition**: a drink earns a cell if people order it by name and its
  // absence makes them log something else. Every "why is this here" comment
  // below is one of those three, and they are all still live.
  //
  // **The order is none of them.** It is the order the author's own catalog
  // ended up in after using the plugin, and since the order *is* the UI (the
  // main row is the first five, the digits count down the list) that means the
  // screen is a preference rather than a derivation. This is a legitimate kind
  // of justification and a different kind: a shipped default is a starting
  // point, not a claim, and it is the author's plugin. **So read what follows
  // as saying why a drink is on the list, never as deciding where it sits** —
  // there is no rule left to appeal to, and moving a row needs the author
  // rather than an argument.
  //
  // What that costs, said out loud because the alternative is a future reader
  // finding it: the main row now spans **29-125 mg** and shares two cups of
  // very nearly the same size (Latte and Mocha at 80). D6 would have refused
  // that row outright and D86 would have queried the pair. Both would have
  // been reasoning about a generic user, and this row is not for one.
  //
  // **Two rows are re-priced and both keep both figures.** Latte 75 -> 80 and
  // Americano 125 -> 100 are the author's numbers; the sourced medians they
  // replace are named on the rows themselves, because D96's "nothing invented"
  // was a rule about the citations, and a citation left sitting above a number
  // it has stopped describing is worse than no citation at all. See
  // plan/caffeine-curve-science.md, "The shipped table is the author's own
  // list".
  //
  // Icons on every row since D86. Twelve glyphs and seventeen drinks, so
  // several share one, and that is correct rather than a shortage: an icon is
  // a thing you recognise, not an identity. Coffee and Large coffee wear the
  // same cup because the second is the first, bigger; the two teas and the
  // matcha wear the same leaf because they are leaves.
  //
  // **D101 swapped the two vessels and the reason is size, which is the only
  // thing that decides a glyph.** `\uf0f4` draws the larger mark and
  // `U+F0176` the smaller, and until that phase the big drinks wore the small
  // one: the espressos had the cup-and-saucer and the two coffees had the
  // little mug. They are the other way round now, both espressos and both
  // coffees together, because the pair only reads as a pair when both halves
  // move. Nothing migrates — no codepoint left ICONS, so correction 37 does
  // not fire — but see the warning there: a stored catalog keeps whatever it
  // has, so this table is not what a machine with a `drinks` key renders.
  //
  // Cafes serve doppios, so this is the espresso button people actually want;
  // a single-shot default undercounts the most-logged category outright.
  { id: "espresso-double", label: "Espresso", detail: "Double", mg: 125, icon: "\udb80\udd76" },
  // **Re-priced and re-labelled by the author, 125 mg Double -> 100 mg Single
  // (D102).** D96 sourced it at 125 and that reasoning stands on its own
  // terms: espresso and hot water, so the only question is how many shots, and
  // the four brand readings split rather than scatter — 71-77 is one shot,
  // 160-200 is two of the larger sizes. The cafe doppio is what set it equal
  // to Espresso (Double).
  //
  // 100 mg is what the author pours. **Asked rather than repaired**, because
  // at `Double` the figure sat between one measured shot and two and one of
  // the pair had to move: the answer was that the drink is a single, so the
  // detail moved and the figure stayed. It still reads above the measured
  // 63-77 for one shot, which is a description of a real cup rather than a
  // correction of the source.
  { id: "americano", label: "Americano", detail: "Single", mg: 100, icon: "\uf0f4" },
  // **Re-priced by the author, 75 -> 80 (D102).** D86 sourced 75 before the
  // table moved (D7): a latte's caffeine is entirely its shots, and three
  // independent readings land there — USDA's single espresso is 63 mg, CSPI's
  // 16 oz two-shot chain latte is 150, and the median of the four brand
  // measurements in drink_types.txt is 74. 80 rounds that up and lines the
  // latte up with the mocha beside it, which is what the author drinks.
  { id: "latte", label: "Latte", detail: "240 ml", mg: 80, icon: "\udb80\udea6" },
  // A latte with chocolate: the coffee half is the latte's sourced 75 and
  // cocoa is a real if small second source. 80 is the shot plus a little, and
  // the increment is a rounding rather than a measurement - which is the
  // honest precision for this whole table (science notes s4). Unchanged by
  // D102; the latte moved *to* it rather than the other way round.
  { id: "mocha", label: "Mocha", detail: "240 ml", mg: 80, icon: "\udb80\udea6" },
  // The bottom of the main row, and the only drink on it under 60 mg. D6 would
  // have put the black tea here for spread; this is the author's list.
  { id: "tea-green", label: "Green tea", detail: "", mg: 29, icon: "\uf06c" },
  { id: "espresso-single", label: "Espresso", detail: "Single", mg: 63, icon: "\udb80\udd76" },
  { id: "large-coffee", label: "Large coffee", detail: "355 ml", mg: 150, icon: "\uf0f4" },
  // One shot with steamed milk and foam, which is the latte's arithmetic
  // exactly. The four brand readings' raw median is 110 and is rejected: one
  // is named as a double and one is Costa's, whose whole column runs ~1.6x
  // everyone else's. Normalised per shot they median at 71.5, against USDA's
  // 63 single. The small cup, because that is what it comes in. **75 and not
  // 80** — D96 set it to the latte's figure and the latte has since moved, so
  // the two are no longer pinned together. That is the author's list rather
  // than an oversight.
  { id: "cappuccino", label: "Cappuccino", detail: "240 ml", mg: 75, icon: "\udb80\udd76" },
  // **Ninth, so `9` logs a plain coffee.** It got here by a swap the author
  // made when the question was put to them: this row was Iced coffee and
  // Coffee was fifteenth, which left the one drink the whole plugin is named
  // after with no key on it. Trading the two puts the digit on the commoner
  // drink and takes it off the rarer one, which is what the ten slots are for.
  // 95 mg is USDA's drip figure and is unchanged; it is still what a cup is
  // measured against on the settings page.
  { id: "coffee", label: "Coffee", detail: "240 ml", mg: 95, icon: "\uf0f4" },
  // The last drink with a digit on it: `0` logs this one.
  { id: "tea-black", label: "Tea", detail: "Black", mg: 47, icon: "\uf06c" },
  { id: "matcha", label: "Matcha", detail: "1 tsp", mg: 70, icon: "\uf06c" },
  { id: "energy-drink", label: "Energy drink", detail: "250 ml", mg: 80, icon: "\uf0e7" },
  // A droplet rather than the "Glass", which is a stemmed cocktail glass at
  // the size this actually renders — judged from the pill, not from the name
  // in the picker. The drop is the one glyph that says "a drink, and not a
  // coffee", which is the whole of what this row needs to say.
  { id: "cola", label: "Cola", detail: "355 ml", mg: 35, icon: "\uf043" },
  // Logging this as a large coffee is off by 50mg, which is what earned it the
  // main row under D6 until D86 traded spread for frequency. It did not leave,
  // and under D102 it is fourteenth.
  { id: "cold-brew", label: "Cold brew", detail: "240 ml", mg: 200, icon: "\uf2dc" },
  // Brewed hot and poured over ice, which is what separates it from cold brew
  // above — and it is brewed a little stronger to survive the melt, so it sits
  // just above drip rather than below it. CSPI's 16 oz chain iced coffee is
  // 185 mg, or 92 per 8 oz; the measured range for iced coffee is 80-150.
  // Fifteenth, so it ships with no digit: it traded places with Coffee, which
  // is the commoner drink and now holds the `9`.
  { id: "iced-coffee", label: "Iced coffee", detail: "240 ml", mg: 100, icon: "\uf2dc" },
  // The one category here with a flat USDA figure (57), bracketed by Nescafe
  // Classic 75 and Gold 44 - whose median is 57 as well. The brand spread is
  // the product rather than the serving.
  { id: "instant-coffee", label: "Instant", detail: "240 ml", mg: 57, icon: "\udb80\udd76" },
  // Not zero, so that logging a decaf honestly is still possible. The moon
  // because it is the one you have at night, which is the whole of why the
  // preset exists. Last, and it has stayed last through every reordering.
  { id: "decaf", label: "Decaf", detail: "", mg: 2, icon: "\uf186" }
]

// D30: five, because people count in fives.
//
// **Since D102 this is a person's five and not a rule's.** D6 chose the first
// four by spread, so that each named a category the others would misreport by
// 50 mg or more, and the fifth by the same rule applied to what was left. D86
// amended that to frequency and recorded the trade: cold brew came off the row
// it had earned by spread, and the row went from spanning 47-200 to 47-125.
//
// The row is now **espresso double, americano, latte, mocha, green tea** —
// 29-125, with two of the five within 5 mg of each other. Neither of the old
// rules produces it and neither is being appealed to: the order is the
// author's catalog, and the main row is whatever the first five of that are.
// Both earlier rules still decide the *overflow's contents*, which is where
// cold brew and large coffee went and where they stayed.
//
// Since D31 this is the shipped *order* rather than a separate selection: the
// main row is the catalog's first five, and these are the five the shipped
// catalog starts with. The list stays so a test can pin the two together.
var MAIN_ROW_IDS = ["espresso-double", "americano", "latte", "mocha", "tea-green"]
var MAIN_ROW_SIZE = 5

// D32: the digits address catalog positions, so a drink's key is a property of
// where it sits and not of whether the overflow happens to be open. Ten is all
// a keyboard has, `1`-`9` then `0`, so anything past the tenth has no digit and
// says so by not painting one. Since D96 the shipped table is seventeen, so
// **seven pills ship with no number on them** — the seven least often reached
// for. That is the rule holding rather than a gap in it, and it is the state
// D88 staged and nobody had shipped.
var DIGIT_SLOTS = 10

// D31's cap, and the user's own number: a 30-drink catalog was explicitly
// rejected. **A fact about the grid rather than a round number since D88** —
// the grid is six wide, one cell of it is the "+ More" toggle, so the cap is
// whole rows minus that one cell. The comment this replaces said "fifteen is
// three grid rows of five", and the grid has been six wide since Phase 7: it
// had been describing a screen that does not exist for six phases.
//
// **Twenty-nine since D97: five rows, by the same arithmetic that made it
// seventeen at three.** And it was forced rather than chosen. D96 ships
// seventeen drinks, so a cap of seventeen makes `canAdd` false on a fresh
// install — an Add row that is dead on arrival, on a page whose whole purpose
// is that the list is the user's own. A catalog that ships full is not a
// catalog.
//
// What it costs is written down where it was paid: **this panel had no
// scroll-into-view at all**, so at twenty-nine the cursor walks below the fold
// with nothing following it. See `Panel.followCursor`. D31's own reason for
// having a cap — "a full catalog is still a list you can see all of at
// once" — is false at 29 without that and true with it, which is why the two
// halves are one decision.
var CATALOG_MAX = 29

// A drink is at least a milligram - zero is not a drink, and Decaf is in the
// shipped table at 2mg precisely so that logging one honestly is possible -
// and at most 500, which is more than any single serving is sold at.
var MG_MIN = 1
var MG_MAX = 500

// ------------------------------------------------------------- the icons
//
// D53. A drink can carry a glyph, chosen from this list and from nothing else.
//
// A closed vocabulary rather than free text, and that is the decision rather
// than a shortcut. The value is stored in a JSON file a hand edit can reach
// and rendered inside the shell process, so "any character the user types" is
// a font-coverage question the plugin cannot answer: a codepoint the shell's
// font does not have paints a tofu box, which is a drink whose icon looks
// broken with nothing to say why. Everything below is in JetBrainsMono Nerd
// Font, which is what the shell resolves "monospace" to and the same source
// the gear on the footer line (\uf013) already comes from.
//
// Twelve, because twelve is a grid four wide and three deep, and a picker the
// cursor has to walk should be walkable in three presses. The first is "no
// icon", which is the shipped state of every drink and the way back out of a
// choice — a picker with no way to un-choose is a one-way door.
//
// They are named, and the names are shown under the grid, because a wall of
// glyphs is a rebus. The names are also what the README documents, since the
// stored value is a codepoint nobody can type from memory.
var ICON_NONE = ""
var ICONS = [
  { icon: ICON_NONE, name: "No icon" },
  { icon: "\uf0f4", name: "Cup" },
  // D91. The old `Mug` was a steaming cup on a stand whose strokes are one
  // pixel wide, and at pill size it read as a smudge — correction 36 firing a
  // second time in the phase that wrote it, on a glyph that had been looked at
  // and judged legible enough. `U+F0176` is a clean outlined cup with a handle
  // at the same size, and it keeps D75's twelve rather than buying a
  // thirteenth. Written as its surrogate pair because it is a plane-15
  // codepoint and a five-digit escape parses as four digits and a "6" — the
  // same pair the helper's jq array and the README's table carry.
  { icon: "\udb80\udd76", name: "Mug" },
  // D101. `\uf0fc` was Font Awesome's `beer-mug-empty` and read as exactly
  // that: a ribbed stein with a handle, on the Latte. What was asked for is
  // the shape of the plugin's own drawn cup (D3) — tall, tapered, one
  // handle — and that shape cannot be *drawn* here, because ICONS is a list
  // of codepoints precisely so a stored value survives a hand edit (D53).
  // So the font was probed and judged at pill size (correction 36): of the
  // handled vessels JetBrainsMono Nerd Font actually carries,
  // `U+F02A6` is the only tall one. `fa-mug_hot` (U+EF59) is round and its
  // steam is the loudest thing about it at eleven pixels; `md-glass_mug_variant`
  // has foam on it. The name is still true — it is the tall one of the three.
  { icon: "\udb80\udea6", name: "Tall mug" },
  { icon: "\uf06c", name: "Leaf" },
  { icon: "\uf2dc", name: "Iced" },
  { icon: "\uf0e7", name: "Bolt" },
  { icon: "\uf043", name: "Drop" },
  { icon: "\uf000", name: "Glass" },
  { icon: "\uf1b3", name: "Cubes" },
  { icon: "\uf185", name: "Sun" },
  { icon: "\uf186", name: "Moon" }
]

var ICON_COLUMNS = 4

// A stored icon, or "" — which is both the default and the thing an unknown
// glyph degrades to, exactly the way an unreadable answer in the profile falls
// back to the neutral one. A drink whose icon this version does not know still
// logs coffee.
// A glyph this list has *replaced*, mapped to the one that replaced it.
//
// **D91 needed this and finding out cost a render.** Swapping the mug's
// codepoint in `ICONS` is the whole of the change for a fresh install, and for
// everyone else it is a silent regression: a stored catalog holds the old
// codepoint, `sanitizeIcon` no longer recognises it, and Coffee and Large
// coffee quietly lose their icons — which is exactly what the user's own panel
// did, two renders after the swap. Degrading an unknown glyph to none is right
// for a codepoint nobody here has ever drawn (a hand edit, a later version);
// it is wrong for one this file drew last week.
//
// The drink meant *mug*, and the mug moved. So the stored value follows it,
// and the entry stays out of `ICONS` so the picker still offers twelve. That
// is the rule for every entry here: an alias is a codepoint this file used to
// draw, never a thirteenth choice.
var ICON_ALIASES = {
  "\ue256": "\udb80\udd76",
  // D101, and correction 37 firing exactly as it says it will: `\uf0fc` was
  // the Tall mug for two phases and it is the Latte's stored icon on every
  // catalog on disk. The mark moved, so the stored value follows it.
  "\uf0fc": "\udb80\udea6"
}

function sanitizeIcon(icon) {
  if (icon === undefined || icon === null || typeof icon === "object") return ICON_NONE
  var value = String(icon)
  if (ICON_ALIASES.hasOwnProperty(value)) value = ICON_ALIASES[value]
  for (var i = 0; i < ICONS.length; i++) if (ICONS[i].icon === value) return value
  return ICON_NONE
}

function iconIndexOf(icon) {
  var value = sanitizeIcon(icon)
  for (var i = 0; i < ICONS.length; i++) if (ICONS[i].icon === value) return i
  return 0
}

function iconNameOf(icon) {
  return ICONS[iconIndexOf(icon)].name
}

// The pill is about 88px wide and elides, so these are not the width that
// matters; they are the length past which a name is not a name. Long enough
// for a drink name and its serving detail, short enough that a paste accident cannot put a
// paragraph in the settings file.
var LABEL_MAX = 24
var DETAIL_MAX = 24

// ------------------------------------------------------------- sanitising
//
// Everything here is read back out of a JSON file a hand edit can reach, and
// it is parsed inside the shell process. Same contract as the dose log and the
// settings: clamp, drop, and never throw. A catalog that survives none of this
// degrades to the shipped table rather than to an empty panel.

function finiteOrNull(value) {
  var number = Number(value)
  return isFinite(number) ? number : null
}

// Number() says 0 to null, "" and false, which is a real answer to a question
// nobody asked: an index that is not a number must not silently become the
// first row. Used everywhere a caller could hand in something that is not one.
function intOrNull(value) {
  if (value === "" || value === null || value === undefined || typeof value === "boolean")
    return null
  var number = finiteOrNull(value)
  return number === null ? null : Math.round(number)
}

// Integer milligrams inside the range, or null for anything that is not a
// number at all. Out of range clamps (a stored 900 is a typo with an obvious
// intention); unreadable drops (a drink whose dose cannot be read is not a
// drink).
function sanitizeMg(mg) {
  if (mg === "" || mg === null || mg === undefined || typeof mg === "boolean") return null
  var amount = finiteOrNull(mg)
  if (amount === null) return null
  return Math.max(MG_MIN, Math.min(MG_MAX, Math.round(amount)))
}

// One line of plain text: no control characters, no runs of whitespace,
// capped. The cap is a slice rather than a refusal, because what a too-long
// name needs is to be shorter.
function sanitizeText(text, max) {
  if (text === undefined || text === null || typeof text === "object") return ""
  var value = String(text).replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim()
  var limit = Number(max) > 0 ? Number(max) : LABEL_MAX
  return value.length > limit ? value.slice(0, limit).trim() : value
}

// The id is never shown; it exists so that an edit and a reorder cannot be
// confused for each other. Derived from the label when a stored entry has none.
function slug(text) {
  return String(text === undefined || text === null ? "" : text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32)
    .replace(/-+$/, "")
}

function uniqueId(base, taken) {
  var stem = base || "drink"
  if (!taken || !taken[stem]) return stem
  for (var n = 2; n < 1000; n++) {
    var candidate = stem + "-" + n
    if (!taken[candidate]) return candidate
  }
  return stem + "-x"
}

// One entry, or null if there is no drink in it. `taken` is the set of ids
// already used, so a file with two "coffee"s comes back as two distinct drinks
// rather than one that shadows the other.
//
// Unknown fields are dropped rather than carried: the object that reaches the
// panel has exactly five keys, whatever was in the file.
function sanitizeEntry(entry, taken) {
  if (!entry || typeof entry !== "object" || typeof entry.length === "number") return null
  var label = sanitizeText(entry.label, LABEL_MAX)
  if (label === "") return null
  var mg = sanitizeMg(entry.mg)
  if (mg === null) return null
  return {
    id: uniqueId(slug(entry.id) || slug(label) || "drink", taken || {}),
    label: label,
    detail: sanitizeText(entry.detail, DETAIL_MAX),
    mg: mg,
    // D53. Always present and always one of the twelve, so nothing downstream
    // has to ask whether the key is there before drawing it.
    icon: sanitizeIcon(entry.icon)
  }
}

function copyOf(catalog) {
  var out = []
  for (var i = 0; i < catalog.length; i++) {
    out.push({ id: catalog[i].id, label: catalog[i].label,
               detail: catalog[i].detail, mg: catalog[i].mg,
               icon: sanitizeIcon(catalog[i].icon) })
  }
  return out
}

// The user's catalog, or the shipped one. Absent means defaults - which is
// what makes "restore the shipped drinks" a delete rather than a copy - and so
// does a stored value with no readable drink left in it.
function sanitizeCatalog(list) {
  if (!list || typeof list !== "object" || typeof list.length !== "number")
    return copyOf(DEFAULTS)
  var out = []
  var taken = {}
  for (var i = 0; i < list.length && out.length < CATALOG_MAX; i++) {
    var entry = sanitizeEntry(list[i], taken)
    if (entry) {
      taken[entry.id] = true
      out.push(entry)
    }
  }
  return out.length > 0 ? out : copyOf(DEFAULTS)
}

// The catalog as read off the whole settings object, which is how the panel
// asks for it: `drinks` absent is the ordinary state, not an error.
function catalogOf(values) {
  var raw = values && typeof values === "object" ? values : {}
  return sanitizeCatalog(raw.drinks)
}

// -------------------------------------------------------------- the editor
//
// Every one of these takes a catalog and returns a new one, so the panel hands
// the result straight to the settings writer and nothing holds a half-applied
// edit. A refused edit returns a catalog equal to the one it was given.

function indexOfId(catalog, id) {
  var list = sanitizeCatalog(catalog)
  for (var i = 0; i < list.length; i++) if (list[i].id === String(id)) return i
  return -1
}

function canAdd(catalog) {
  return sanitizeCatalog(catalog).length < CATALOG_MAX
}

function addDrink(catalog, entry) {
  var list = sanitizeCatalog(catalog)
  if (list.length >= CATALOG_MAX) return list
  var taken = {}
  for (var i = 0; i < list.length; i++) taken[list[i].id] = true
  var added = sanitizeEntry(entry, taken)
  if (!added) return list
  return list.concat([added])
}

// Only the fields given are touched, and the id never is: a drink you have
// logged keeps the identity it was logged under even when its dose changes.
// History is untouched either way - a dose snapshots {mg, label} at log time -
// so this changes what the *next* press of that pill logs, and nothing else.
function updateDrink(catalog, id, patch) {
  var list = sanitizeCatalog(catalog)
  var at = indexOfId(list, id)
  if (at < 0 || !patch || typeof patch !== "object") return list
  var current = list[at]
  var label = patch.label === undefined ? current.label : sanitizeText(patch.label, LABEL_MAX)
  var mg = patch.mg === undefined ? current.mg : sanitizeMg(patch.mg)
  if (label === "" || mg === null) return list
  var out = copyOf(list)
  out[at] = {
    id: current.id,
    label: label,
    detail: patch.detail === undefined ? current.detail : sanitizeText(patch.detail, DETAIL_MAX),
    mg: mg,
    icon: patch.icon === undefined ? current.icon : sanitizeIcon(patch.icon)
  }
  return out
}

// The last drink cannot be removed. An empty catalog reads back as the shipped
// table (absent means defaults), so emptying the list would silently restore
// it - which is the opposite of what the last press of x is asking for.
function removeDrink(catalog, id) {
  var list = sanitizeCatalog(catalog)
  if (list.length <= 1) return list
  var at = indexOfId(list, id)
  if (at < 0) return list
  var out = copyOf(list)
  out.splice(at, 1)
  return out
}

// Move one drink up or down the list, which is also what moves it on and off
// the main row and renumbers its key (D32). Swaps with its neighbour rather
// than sliding, so a press is always undone by the opposite press.
function moveDrink(catalog, index, delta) {
  var list = sanitizeCatalog(catalog)
  var from = intOrNull(index)
  var step = intOrNull(delta)
  if (from === null || step === null) return list
  var to = from + step
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return list
  var out = copyOf(list)
  var moved = out[from]
  out[from] = out[to]
  out[to] = moved
  return out
}

function isDefaultCatalog(catalog) {
  var list = sanitizeCatalog(catalog)
  if (list.length !== DEFAULTS.length) return false
  for (var i = 0; i < list.length; i++) {
    if (list[i].id !== DEFAULTS[i].id || list[i].label !== DEFAULTS[i].label
        || list[i].detail !== DEFAULTS[i].detail || list[i].mg !== DEFAULTS[i].mg) return false
  }
  return true
}

// What the "add a drink" field means. One field rather than three, because the
// panel's whole editing idiom is one pill you type into, and three tab stops on
// a keyboard-driven page is a form. The serving detail rides in brackets, which
// is how the shipped table already prints it: "Espresso (Double)".
//
//   Flat white 130                ->  Flat white, 130 mg
//   Flat white 130mg              ->  the same
//   Flat white (small) 130 mg     ->  with a serving detail
//   Cortado 1.4 cups              ->  in cups, whatever the unit in force
//
// The unit is the one the panel is showing (D46): a number typed where cups are
// displayed is cups, and an explicit "mg" or "cups" wins over both. Null for
// anything with no name or no number in it - the field then stays open and says
// so, rather than storing a drink nobody described.
function parseDrinkEntry(text, cupMg, unitsAreCups) {
  var line = sanitizeText(text, LABEL_MAX + DETAIL_MAX + 24)
  if (line === "") return null

  // The number is the last word, and it has to be a word: "Coffee -5" is not a
  // drink called "Coffee -", and "Monster 500ml 160mg" is a 160mg drink whose
  // name has a number in it.
  var match = /^(.*\S)\s+([0-9]+(?:\.[0-9]+)?)\s*(mg|cups?)?$/i.exec(line)
  if (!match) return null

  var rest = match[1].trim()
  var amount = Number(match[2])
  var unit = (match[3] || "").toLowerCase()
  if (!isFinite(amount)) return null

  var perCup = finiteOrNull(cupMg)
  var inCups = unit === "cup" || unit === "cups" || (unit === "" && unitsAreCups === true)
  if (inCups && perCup !== null && perCup > 0) amount = amount * perCup

  var mg = sanitizeMg(amount)
  if (mg === null) return null

  var detail = ""
  var bracketed = /^(.*?)\s*\(([^()]*)\)$/.exec(rest)
  if (bracketed) {
    rest = bracketed[1].trim()
    detail = bracketed[2].trim()
  }
  if (rest === "") return null

  return { label: sanitizeText(rest, LABEL_MAX), detail: sanitizeText(detail, DETAIL_MAX), mg: mg }
}

// --------------------------------------------------------------- the table

function byId(id, catalog) {
  var list = catalog ? sanitizeCatalog(catalog) : DEFAULTS
  var key = String(id || "")
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === key) return list[i]
  }
  return null
}

// The name a dose is logged under: the pill's name plus the serving detail the
// pill has no room to paint. Taken from the entry in hand rather than looked
// up, because since D31 the catalog is the user's and the entry is the truth.
function labelOf(entry) {
  if (!entry) return ""
  return entry.detail ? entry.label + " (" + entry.detail + ")" : entry.label
}

function labelFor(id, catalog) {
  return labelOf(byId(id, catalog))
}

function mgFor(id, catalog) {
  var preset = byId(id, catalog)
  return preset ? preset.mg : 0
}

// The first five of the catalog order, and the rest. D31: which drinks are on
// the main row is not a separate choice any more, it is where they sit.
function mainRow(catalog) {
  return sanitizeCatalog(catalog).slice(0, MAIN_ROW_SIZE)
}

function overflow(catalog) {
  return sanitizeCatalog(catalog).slice(MAIN_ROW_SIZE)
}

// The digit painted on the pill at catalog position `index`, or "" past the
// tenth. Written here rather than in the QML so the key that logs a drink and
// the key printed on it come from one function and cannot disagree.
function digitFor(index) {
  var slot = Number(index)
  if (!isFinite(slot) || slot < 0 || slot >= DIGIT_SLOTS) return ""
  return String((slot + 1) % 10)
}

// How many drinks have a digit on them: the catalog's length, capped at the
// ten keys a keyboard has. Here beside `digitFor` for the reason `digitFor` is
// here at all — the footer legend states the *range* of live digits and the
// pills paint the individual ones, and two places counting to ten separately
// is how the legend came to say "1-5" while `6`-`0` were live (D32: the digit
// is a property of where a drink sits, not of whether the overflow is open).
function digitCount(catalog) {
  var length = sanitizeCatalog(catalog).length
  return length < DIGIT_SLOTS ? length : DIGIT_SLOTS
}

// The inverse: which catalog position a typed digit means. -1 for anything
// else, so the caller can pass every text key through it.
function indexForDigit(text) {
  if (!/^[0-9]$/.test(String(text))) return -1
  var digit = Number(text)
  return digit === 0 ? 9 : digit - 1
}

// ------------------------------------------------- walking the drink grid
//
// D88, amending D81. The drinks are one grid and the cursor walks it as one —
// and since D88 the "+ More" toggle is a cell of that grid rather than a
// control outside it. *"Effectively we should be presented with a 3 × 6 grid
// when we press more; it just happens that position (1,6) is the More/Less
// button, but from the point of view of navigation it should make no
// difference."*
//
// **That deletes the special case, which is the tell that it is right.** D81's
// walk carried "the first row is `MAIN_ROW_SIZE` drinks and the spare cell,
// and every row under it is a full `columns`" precisely because one cell of
// the visible grid was missing from the cursor's. Put it back and every row is
// `columns` wide with no exception: the whole of the arithmetic below is
// `row = floor(slot / columns)`.
//
// **A slot is a cell of the grid, not a catalog position**, and the two differ
// by one past the toggle. `catalogIndexForSlot` and `slotForCatalogIndex` are
// the only places that conversion is written; the digits still count down the
// *catalog* (D32), which is why they are not the same number.
//
// The answer to a move is a slot back, or `null` when the move leaves the grid
// altogether and the caller has to hand the cursor to the next section.

// Correction 20's guard, because every argument below is an index or a count
// and Number() answers 0 to null, "" and false.
function gridInt(value, fallback) {
  var number = intOrNull(value)
  return number === null ? fallback : number
}

// How many cells the grid draws: the main row, the toggle, and the overflow
// when it is open. The toggle is always there, which is why a shut grid is
// still one cell wider than the main row.
function drinkSlotCount(mainCount, overflowCount, expanded) {
  var main = Math.max(0, gridInt(mainCount, 0))
  var extra = Math.max(0, gridInt(overflowCount, 0))
  return main + 1 + (expanded ? extra : 0)
}

// Slot `mainCount` is the "+" — the sixth cell of the first row on the shipped
// five-drink main row, and the cell that makes every row below it line up.
function drinkSlotIsToggle(slot, mainCount) {
  return gridInt(slot, -1) === Math.max(0, gridInt(mainCount, 0))
}

// The catalog position a slot logs, or `null` for the toggle — which is the
// caller's cue to flip the overflow rather than to log something.
function catalogIndexForSlot(slot, mainCount) {
  var at = gridInt(slot, -1)
  var main = Math.max(0, gridInt(mainCount, 0))
  if (at < 0 || at === main) return null
  return at < main ? at : at - 1
}

// The inverse: which cell a catalog position is drawn in.
function slotForCatalogIndex(index, mainCount) {
  var at = gridInt(index, -1)
  var main = Math.max(0, gridInt(mainCount, 0))
  if (at < 0) return null
  return at < main ? at : at + 1
}

// Which row and column a slot is drawn at. Every row is `columns` wide, with
// no exception — that is D88's whole gain over D81.
function drinkGridCell(slot, columns) {
  var at = Math.max(0, gridInt(slot, 0))
  var wide = Math.max(1, gridInt(columns, 1))
  return { row: Math.floor(at / wide), column: at % wide }
}

function drinkGridRowStart(row, columns) {
  return Math.max(0, gridInt(row, 0)) * Math.max(1, gridInt(columns, 1))
}

// The first cell of the bottom row, which is where the cursor arrives when it
// comes up out of the dose list below. Entering a grid at its first cell would
// skip every row but one — the same complaint D81 makes about leaving one.
function drinkGridLastRowStart(count, columns) {
  var total = Math.max(0, gridInt(count, 0))
  if (total <= 0) return 0
  var wide = Math.max(1, gridInt(columns, 1))
  return Math.floor((total - 1) / wide) * wide
}

function drinkGridMove(count, slot, dx, dy, columns) {
  var total = Math.max(0, gridInt(count, 0))
  if (total <= 0) return null
  var wide = Math.max(1, gridInt(columns, 1))
  var at = Math.max(0, Math.min(total - 1, gridInt(slot, 0)))
  var acrossBy = gridInt(dx, 0)
  var downBy = gridInt(dy, 0)

  // Along the row, and on into the next one at the end of it: the grid is one
  // list of cells in one order, and a cursor that stopped at a row edge would
  // be claiming a boundary the screen does not have. Both ends of the *grid*
  // stop, because there is nothing past them.
  if (acrossBy !== 0) {
    var along = at + acrossBy
    return along < 0 || along >= total ? at : along
  }
  if (downBy === 0) return at

  var cell = drinkGridCell(at, wide)
  var row = cell.row + (downBy > 0 ? 1 : -1)
  if (row < 0) return null
  var start = drinkGridRowStart(row, wide)
  if (start >= total) return null
  // The last row can be ragged, and a column past its end lands on the last
  // cell in it rather than refusing the press: the row is there, you moved
  // into it, and the nearest cell is the one you meant.
  var end = Math.min(start + wide, total) - 1
  return Math.max(start, Math.min(end, start + cell.column))
}
