import QtQuick
import Quickshell
import Quickshell.Io
import "Caffeine.js" as Caffeine
import "Presets.js" as Presets

// The settings store: one JSON object at
// ~/.local/state/omarchy/settings/caffeine-curve.json, read here and written
// by the helper script beside this file.
//
// This is the weather panel's mechanism rather than an invention (D43). The
// first-party precedent is exact — weather keeps the user's location in the
// same directory, reads it with a watching FileView, and writes it through a
// CLI helper — and it is the shape that makes the two things this plugin needs
// cheap: restore-defaults is `rm`, and a value the panel edits is not also a
// value the shell believes it owns.
//
// **`omarchy bar set` is inert for this widget from here on.** Its inline
// settings on the shell.json entry are no longer read by anything, and the
// manifest declares no schema precisely so that a settings form landing in a
// later Omarchy cannot write somewhere we would ignore.
//
// The helper is shipped in the plugin directory and resolved off this file's
// own URL, which is Radio Atlas's pattern: weather's helper lives in
// /usr/share/omarchy/bin, where a plugin cannot put one.
Item {
  id: root
  visible: false

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string settingsDir:
    (Quickshell.env("XDG_STATE_HOME") || home + "/.local/state") + "/omarchy/settings"
  readonly property string path: settingsDir + "/caffeine-curve.json"

  readonly property string helperPath:
    Qt.resolvedUrl("caffeine-curve-settings").toString().replace(/^file:\/\//, "")

  // The raw object off disk. Every reader below goes through a sanitiser, so a
  // hand-edited file degrades exactly the way a corrupt doses.json does rather
  // than reaching a binding as NaN.
  property var values: ({})

  // False until the first read settles either way. An absent file is the
  // ordinary first-run state and settles as an empty object, not an error.
  property bool loaded: false

  // What the last helper run said when it failed. The panel shows it rather
  // than leaving a control that silently did nothing.
  property string lastError: ""

  readonly property string bedtime: Caffeine.sanitizeBedtime(root.values.bedtime)

  // D105. Which of the three framings the curve is drawn in, and the two
  // clocks the anchored ones are built from. Read exactly like the bedtime
  // above: untrusted text through a sanitiser, absent means the shipped
  // default, and the panel never sees a raw value.
  readonly property string chartFrame: Caffeine.sanitizeFrame(root.values.chartFrame)
  readonly property string dayStart:
    Caffeine.sanitizeClock(root.values.dayStart, Caffeine.DAY_START_DEFAULT)
  readonly property string dayEnd:
    Caffeine.sanitizeClock(root.values.dayEnd, Caffeine.DAY_END_DEFAULT)
  readonly property real halfLifeHours: Caffeine.halfLifeSetting(root.values)
  readonly property real sleepThresholdMg: Caffeine.sanitizeThreshold(root.values.sleepThresholdMg)
  readonly property string units: Caffeine.sanitizeUnits(root.values.units)

  // D84. A cup is a unit the user sets, not a serving we picked, so every
  // cups conversion in the panel takes this rather than a constant.
  readonly property real cupMg: Caffeine.cupSize(root.values.cupMg)
  readonly property bool capEnabled: Caffeine.truthy(root.values.dailyCapEnabled)
  readonly property real capMg: Caffeine.sanitizeCap(root.values.dailyCapMg)

  // D51. The one setting that is about the panel rather than about caffeine,
  // and the only one whose default is load-bearing: it ships off, because the
  // estimate line it hides is D13's framing and hiding it is only defensible
  // for the person who has read it and said so.
  readonly property bool quietPanel: Caffeine.truthy(root.values.quietPanel)

  // D89. The other setting that is about how a surface looks rather than what
  // it computes — "always", "moving" or "never" — and the only one the *bar*
  // reads for itself rather than the panel.
  readonly property string barNumber: Caffeine.sanitizeBarNumber(root.values.barNumber)

  // D31. The drink catalog is the one setting that is not a scalar, and it is
  // read exactly like the rest of them: absent means the shipped table, and a
  // stored list is untrusted text until Presets has been through it.
  readonly property var drinks: Presets.catalogOf(root.values)

  // D34. The second non-scalar setting, read exactly like the first: absent
  // means an empty profile, an empty profile derives the 5-hour default, and
  // an answer this version does not recognise falls back to the neutral one.
  readonly property var profile: Caffeine.profileOf(root.values)

  // Which of the two half-lives is live, "custom" or "profile", and what the
  // other one would be. The settings row prints the first and names the
  // second, so both numbers are on screen at once and the offer to swap is
  // never a number you have to go and look up.
  readonly property string halfLifeSource: Caffeine.halfLifeSource(root.values)
  readonly property real halfLifeDerived: Caffeine.deriveHalfLife(root.values.profile)

  // Whether the profile has been touched at all. Same reasoning as
  // drinksCustomised: a stored profile whose answers are all neutral is still
  // a stored profile, and forgetting it is still a change.
  readonly property bool profileCustomised: root.values.profile !== undefined

  // Whether the catalog has been touched at all, which is what decides if the
  // editor offers to put the shipped table back. Deliberately not
  // `!isDefaultCatalog(drinks)`: a stored list that happens to equal the
  // shipped one is still a stored list, and forgetting it is still a change.
  readonly property bool drinksCustomised: root.values.drinks !== undefined

  // True when there is anything to restore: the file exists and has a key in
  // it. Drives whether "Restore defaults" is offered at all.
  readonly property bool customised: {
    for (var key in root.values) return true
    return false
  }

  // 8KB of scalars, and the same reasoning as the dose log: anything past this
  // is not our file, so refuse to parse it rather than handing an unknown
  // megabyte to JSON.parse inside the shell process.
  readonly property int maxBytes: 65536

  function parse(raw) {
    if (typeof raw !== "string") return ({})
    if (raw.length > root.maxBytes) {
      console.warn("caffeine-curve: settings file is", raw.length, "bytes; refusing to parse")
      return ({})
    }
    var text = raw.trim()
    if (text === "") return ({})
    try {
      var parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== "object" || parsed.length !== undefined) return ({})
      return parsed
    } catch (error) {
      console.warn("caffeine-curve: ignoring unreadable settings:", error)
      return ({})
    }
  }

  function load(raw) {
    root.values = root.parse(raw)
    root.loaded = true
  }

  // ------------------------------------------------------------- writing
  //
  // Optimistic, then corrected by the file. A settings control that waits for
  // a subprocess and a file watcher before it moves feels broken, so the value
  // is assigned here and the helper's own write lands on top of it a moment
  // later. If the helper refuses, the reload puts the old value back — which
  // is the whole reason the failure path re-reads rather than doing nothing.

  // One process, a queue behind it: two keys changed in the same second are
  // two runs, and the second must not clobber the first's read-modify-write.
  // (The script locks as well; this keeps the ordering ours.)
  property var queue: []

  function set(key, value) {
    var next = {}
    for (var existing in root.values) next[existing] = root.values[existing]
    next[key] = value
    root.values = next
    root.run(["--set", key, String(value)])
  }

  // The structured half of set(). Same optimism, same correction from the file
  // a moment later; the helper takes the object as one argument rather than as
  // a stream, because a full catalog is about two kilobytes and the
  // queue below already guarantees the ordering.
  function setJson(key, value) {
    var next = {}
    for (var existing in root.values) next[existing] = root.values[existing]
    next[key] = value
    root.values = next
    root.run(["--set-json", key, JSON.stringify(value)])
  }

  // Forget one key, which for `drinks` is how the catalog editor restores the
  // shipped table: absent means defaults, so there is no copy to write back.
  function unset(key) {
    var next = {}
    for (var existing in root.values) if (existing !== key) next[existing] = root.values[existing]
    root.values = next
    root.run(["--unset", key])
  }

  // One answer changed, as the whole object. Same shape as a catalog edit: the
  // page never holds a half-applied profile, because the file is the state.
  function setProfile(next) {
    root.setJson("profile", next)
  }

  function clear() {
    root.values = ({})
    root.run(["--clear"])
  }

  function run(args) {
    root.queue = root.queue.concat([args])
    root.pump()
  }

  function pump() {
    if (helper.running || root.queue.length === 0) return
    var next = root.queue[0]
    root.queue = root.queue.slice(1)
    helper.command = [root.helperPath].concat(next)
    helper.running = true
  }

  Process {
    id: helper
    running: false

    stderr: StdioCollector {
      onStreamFinished: if (text.trim() !== "") root.lastError = text.trim()
    }

    onExited: function(exitCode, exitStatus) {
      if (exitCode === 0) root.lastError = ""
      else {
        console.warn("caffeine-curve: settings helper exited", exitCode, root.lastError)
        // Put the file's truth back over the optimistic value, so a refused
        // write does not leave the panel showing something that was not saved.
        file.reload()
      }
      Qt.callLater(root.pump)
    }
  }

  // The one reader, the same shape as the dose Store's. watchChanges is what
  // makes a `caffeine-curve-settings --set` from a terminal reach an open
  // panel with no restart — and what makes the helper's own writes land.
  FileView {
    id: file
    path: root.path
    watchChanges: true
    printErrors: false
    onLoaded: root.load(text())
    // No file is the ordinary first-run state: absent means defaults.
    onLoadFailed: root.load("")
    onFileChanged: reload()
  }

  // FileView cannot watch a path whose directory does not exist, and on a fresh
  // install this one does not: the helper creates it on its first write, which
  // is far too late. Without this the initial reload fails, `watchChanges`
  // never establishes a watch, and it never recovers — so for the whole of that
  // session an external `caffeine-curve-settings --set` is silently ignored,
  // *including* after the panel's own first write has created the file. The
  // dose Store and the note store have both done this since they were written
  // (their comments say why); this one was missed because every machine the
  // plugin had run on already had ~/.local/state/omarchy/settings from another
  // widget. A fresh install is the only place it shows.
  Process {
    id: ensureDirProc
    command: ["mkdir", "-p", root.settingsDir]
    running: false
  }

  Component.onCompleted: {
    ensureDirProc.running = true
    Qt.callLater(function() { file.reload() })
  }
}
