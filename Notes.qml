import QtQuick
import Quickshell
import Quickshell.Io
import "Caffeine.js" as Caffeine

// The notes: one JSON object on disk, keyed by local calendar day.
//
//   { "2026-09-02": { "flagged": true, "text": "…", "updated": 1788383549 } }
//
// D48 settled where this lives and why it is not a field on doses.json, and
// both halves of that argument are load bearing:
//
//   - It is DATA, not a setting. It is user-authored, it is the half of the
//     plugin someone would be upset to lose, and sitting beside doses.json and
//     archive.json is what puts it inside D44's backup recipe for free.
//     Settings under .local/state are machine-local and disposable; this is
//     the opposite of both.
//   - It is its OWN file. doses.json is pruned to 30 days and rewritten on
//     every log, delete and nudge — a note whose whole point is "look what
//     happened in March" cannot live in the file that forgets March, and
//     months of writing must not ride on every tap of a preset pill.
//
// Keyed by day rather than listed, because the timeline asks "does this day
// have a note?" on every pan step and that has to be a lookup rather than a
// scan.
//
// Same discipline as Store.qml has had since Phase 1: sanitised on read, size
// capped, atomic writes, and a malformed file degrading to "no notes" with the
// shell alive rather than a torn parse taking the whole desktop down.
Item {
  id: root
  visible: false

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string dataDir:
    (Quickshell.env("XDG_DATA_HOME") || home + "/.local/share") + "/omarchy/caffeine-curve"
  readonly property string path: dataDir + "/notes.json"

  // Sanitised on every read and always reassigned rather than mutated, so
  // bindings see the change.
  property var notes: ({})

  // False until the first read settles, one way or the other. Guards every
  // write: writing before the load lands would replace the file with whatever
  // this session has typed so far.
  property bool loaded: false

  // A note is capped at 500 characters and a day is one entry, so even a
  // decade of daily notes is a few hundred KB. Anything past this is not our
  // file, so refuse to parse it rather than handing an unknown megabyte to
  // JSON.parse inside the shell process.
  readonly property int maxBytes: 1048576

  // Set when the file is there and cannot be read. This is the one place in
  // the plugin where "treat it as empty" is not enough, and the archive
  // already made the argument: notes are prose nobody can regenerate, so the
  // next write must not replace months of them with one sentence. Reading
  // degrades to no notes exactly as the brief requires; *writing* stops, and
  // the panel says so rather than leaving a key that silently does nothing.
  //
  // An empty or absent file is not blocked — that is the ordinary first-run
  // state. Nor is a file that parses to an object and loses entries to the
  // sanitiser: that is a hand edit we understood and corrected.
  property bool blocked: false
  readonly property string lastError: root.blocked
    ? "notes.json could not be read. Nothing will be written over it until it is fixed or removed."
    : ""

  // The list form, newest day first, for the review page.
  readonly property var entries: Caffeine.noteEntries(root.notes)
  readonly property int count: root.entries.length

  function nowSeconds() {
    return Math.floor(Date.now() / 1000)
  }

  function parse(raw) {
    if (typeof raw !== "string") return ({})
    if (raw.length > root.maxBytes) {
      console.warn("caffeine-curve: notes file is", raw.length, "bytes; refusing to parse")
      root.blocked = true
      return ({})
    }
    var text = raw.trim()
    if (text === "") return ({})
    try {
      var parsed = JSON.parse(text)
      // An array, a number or a string is a file we did not write, and the
      // sanitiser's "no notes" answer would be indistinguishable from an empty
      // one. Same treatment as a parse error.
      if (!parsed || typeof parsed !== "object" || parsed.length !== undefined) {
        console.warn("caffeine-curve: notes file is not an object of days")
        root.blocked = true
        return ({})
      }
      return Caffeine.sanitizeNotes(parsed)
    } catch (error) {
      console.warn("caffeine-curve: ignoring unreadable notes:", error)
      root.blocked = true
      return ({})
    }
  }

  function load(raw) {
    root.blocked = false
    root.notes = root.parse(raw)
    root.loaded = true
  }

  function persist(next) {
    root.notes = Caffeine.sanitizeNotes(next)
    file.setText(JSON.stringify(root.notes, null, 2) + "\n")
  }

  // What is written on a day, or null. The panel asks this on every pan step.
  function noteFor(dayKey) {
    return Caffeine.noteFor(root.notes, dayKey)
  }

  function noteAt(tsSeconds) {
    return root.noteFor(Caffeine.dayKeyOf(tsSeconds))
  }

  // Empty text is not a deletion — it marks the day without words (D65).
  // Removing a note is remove(), which the review page's ✕ and x key call.
  function write(dayKey, text) {
    if (!root.loaded || root.blocked) return false
    if (!Caffeine.isDayKey(dayKey)) return false
    root.persist(Caffeine.writeNote(root.notes, dayKey, text, root.nowSeconds()))
    return true
  }

  function writeAt(tsSeconds, text) {
    return root.write(Caffeine.dayKeyOf(tsSeconds), text)
  }

  function remove(dayKey) {
    if (!root.loaded || root.blocked) return false
    if (root.noteFor(dayKey) === null) return false
    root.persist(Caffeine.removeNote(root.notes, dayKey))
    return true
  }

  FileView {
    id: file
    path: root.path
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root.load(text())
    // No file yet is the ordinary state — the first note creates it. Same
    // outcome as an empty one, and the same outcome as an unreadable one.
    onLoadFailed: root.load("")
    onFileChanged: reload()
  }

  // FileView cannot create the directory it writes into. The dose Store makes
  // the same directory on its own Component.onCompleted, but this component
  // must not depend on that having happened first: a fresh install where the
  // first thing anyone does is write a note would otherwise fail its write.
  Process {
    id: ensureDirProc
    command: ["mkdir", "-p", root.dataDir]
    running: false
  }

  Component.onCompleted: {
    ensureDirProc.running = true
    Qt.callLater(function() { file.reload() })
  }
}
