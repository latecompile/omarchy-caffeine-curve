import QtQuick
import Quickshell
import Quickshell.Io
import "Caffeine.js" as Caffeine

// The dose log: one JSON array on disk, newest entry first.
//
// This is user-authored data someone would want in a backup, not derived
// state, so it lives under ~/.local/share rather than ~/.local/state. Every
// read is defensive and every write is atomic, because a torn parse here
// happens inside the shell process and takes the whole desktop down with it,
// not just one log entry.
Item {
  id: root
  visible: false

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string dataDir:
    (Quickshell.env("XDG_DATA_HOME") || home + "/.local/share") + "/omarchy/caffeine-curve"
  readonly property string path: dataDir + "/doses.json"

  // D44. Doses falling off the retention window are appended here rather than
  // dropped: doses.json is the panel's working set, but the log as a whole is
  // user-authored data someone would want in a backup, and data that deletes
  // itself after a month is not that. Append-only — nothing in the plugin ever
  // reads it back into the curve, and the panel does not know it exists.
  readonly property string archivePath: dataDir + "/archive.json"

  // Sanitised and sorted newest-first, always reassigned rather than mutated
  // so bindings see the change.
  property var doses: []

  // False until the first read settles, one way or the other. Guards every
  // write: appending before the load lands would overwrite the file with an
  // empty array.
  property bool loaded: false

  property int retentionDays: 30

  // 30 days of heavy logging is a couple of hundred entries, well under 20KB.
  // Anything past this is not our file, so refuse to parse it rather than
  // handing a megabyte of unknown text to JSON.parse.
  readonly property int maxBytes: 262144

  // The archive grows for the life of the install rather than rolling, so it
  // gets its own ceiling — sixteen times the working set is a couple of
  // decades of heavy logging.
  readonly property int archiveMaxBytes: 4194304

  signal logged(var dose)

  function nowSeconds() {
    return Math.floor(Date.now() / 1000)
  }

  // A missing file is the ordinary first-run state, not an error, and has to
  // reach the same empty-list outcome as an empty one.
  function parse(raw, limit) {
    if (typeof raw !== "string") return []
    var ceiling = Number(limit) > 0 ? Number(limit) : root.maxBytes
    if (raw.length > ceiling) {
      console.warn("caffeine-curve: dose log is", raw.length, "bytes; refusing to parse")
      return []
    }
    var text = raw.trim()
    if (text === "") return []
    try {
      return Caffeine.sanitizeDoses(JSON.parse(text))
    } catch (error) {
      console.warn("caffeine-curve: ignoring unreadable dose log:", error)
      return []
    }
  }

  function load(raw) {
    root.doses = root.parse(raw)
    root.loaded = true
  }

  function persist(list) {
    var split = Caffeine.prune(list, root.nowSeconds(), root.retentionDays)
    root.doses = split.kept
    if (split.expired.length > 0) root.archive(split.expired)
    file.setText(JSON.stringify(root.doses, null, 2) + "\n")
  }

  // ------------------------------------------------------------- the archive

  // Held in memory so an append does not have to read the file back first.
  property var archived: []
  property bool archiveLoaded: false
  // Doses that expired before the archive's own first read settled. Rare —
  // it takes a write in the first tick of a session — but the alternative to
  // holding them is writing the archive from an empty list and erasing it.
  property var archivePending: []

  // Set if the archive on disk is there but unreadable. An append-only file is
  // the one place a "treat it as empty" fallback is wrong: the next write would
  // replace years of history with this month's expiry. Stop writing instead,
  // and leave the doses in doses.json where they are still visible.
  property bool archiveBlocked: false

  function archive(expired) {
    if (root.archiveBlocked) return
    if (!root.archiveLoaded) {
      root.archivePending = root.archivePending.concat(expired)
      return
    }
    // Newest first, the same order doses.json is in, so the two files read the
    // same way if anyone ever concatenates them.
    root.archived = expired.concat(root.archived)
    archiveFile.setText(JSON.stringify(root.archived, null, 2) + "\n")
  }

  function loadArchive(raw) {
    var text = typeof raw === "string" ? raw.trim() : ""
    if (text !== "") {
      var parsed = root.parse(raw, root.archiveMaxBytes)
      if (parsed.length === 0) {
        console.warn("caffeine-curve: archive.json is unreadable; not archiving over it")
        root.archiveBlocked = true
        root.archivePending = []
        return
      }
      root.archived = parsed
    } else {
      root.archived = []
    }
    root.archiveLoaded = true
    if (root.archivePending.length > 0) {
      var pending = root.archivePending
      root.archivePending = []
      root.archive(pending)
    }
  }

  function add(mg, label, tsSeconds) {
    if (!root.loaded) return null
    var amount = Number(mg)
    if (!isFinite(amount) || amount <= 0) return null

    var dose = {
      ts: Math.floor(isFinite(Number(tsSeconds)) ? Number(tsSeconds) : root.nowSeconds()),
      mg: amount,
      label: typeof label === "string" ? label : ""
    }
    root.persist([dose].concat(root.doses))
    root.logged(dose)
    return dose
  }

  // By index rather than by timestamp: two drinks logged in the same second
  // are indistinguishable by ts, and the panel's list already has the index.
  //
  // D113: what comes out goes on the undo stack on the way. Both routes to a
  // deletion — the `x` key and the ✕ on the row — come through here, so
  // capturing it at this one point is what makes `u` cover the whole gesture
  // rather than the keyboard half of it.
  function removeAt(index) {
    if (!root.loaded) return false
    if (!(index >= 0 && index < root.doses.length)) return false
    var next = root.doses.slice()
    var gone = next.splice(index, 1)[0]
    root.persist(next)
    root.undoStack = Caffeine.pushUndo(root.undoStack, gone)
    return true
  }

  // ---------------------------------------------------------------- undo

  // D113. The deletions this session can still take back, newest first.
  //
  // **In memory, and only for this session.** It is not in doses.json and it
  // does not get a file of its own: undo is the tail of a gesture you are
  // still in the middle of — you deleted the wrong row and you noticed — and a
  // stack that survived a reboot would offer to resurrect a coffee from last
  // Tuesday, which is not undo, it is a second archive nobody asked for. The
  // one that already exists is append-only for exactly that reason (D44).
  property var undoStack: []

  // Puts the last deleted dose back and returns it, or null if there is
  // nothing left to put back.
  //
  // It goes in through `persist` like any other write, so the log re-sorts and
  // the restored dose lands at its own timestamp rather than at the top: a
  // dose put back is a dose that was never gone, and it must not read as one
  // logged just now. `logged` is deliberately *not* emitted — that signal
  // pours the cup on the bar (BarWidget), and nothing was poured here.
  function undoDelete() {
    if (!root.loaded) return null
    var step = Caffeine.popUndo(root.undoStack)
    if (!step.dose) return null
    root.undoStack = step.rest
    root.persist([step.dose].concat(root.doses))
    return step.dose
  }

  // The panel's "I actually drank that earlier" affordance — tapping the
  // timestamp walks a dose back in 15-minute steps. No date picker, ever.
  function nudgeAt(index, minutes) {
    if (!root.loaded) return false
    if (!(index >= 0 && index < root.doses.length)) return false
    var delta = Number(minutes)
    if (!isFinite(delta) || delta === 0) return false

    var next = root.doses.slice()
    next[index] = {
      ts: next[index].ts + Math.round(delta * 60),
      mg: next[index].mg,
      label: next[index].label
    }
    root.persist(next)
    return true
  }

  function clear() {
    if (!root.loaded) return
    root.persist([])
    // D113. The stack goes with it. `clear` is the IPC wipe, not a row being
    // removed, and after it the doses on the stack no longer relate to
    // anything on screen — putting twenty-five of them back into an emptied
    // log would be a partial restore wearing an undo's clothes, which is worse
    // than the honest nothing.
    root.undoStack = []
  }

  function levelNow(halfLifeHours) {
    return Caffeine.levelAt(root.doses, root.nowSeconds(), halfLifeHours)
  }

  FileView {
    id: file
    path: root.path
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root.load(text())
    // First run, or the directory was wiped. Same outcome as an empty file.
    onLoadFailed: root.load("")
    onFileChanged: reload()
  }

  // No watchChanges: nothing in the plugin renders the archive, so a change to
  // it is not something to react to. It is read exactly once, to know what to
  // append to.
  FileView {
    id: archiveFile
    path: root.archivePath
    atomicWrites: true
    printErrors: false
    onLoaded: root.loadArchive(text())
    // No archive yet is the ordinary state — the first expiry creates it.
    onLoadFailed: root.loadArchive("")
  }

  // FileView cannot create the directory it writes into, so the first write on
  // a fresh install would fail without this. Same shape as the notification
  // service's ensureDirsProc.
  Process {
    id: ensureDirProc
    command: ["mkdir", "-p", root.dataDir]
    running: false
  }

  // The IpcHandler that used to live here moved to BarWidget.qml at Phase 4.
  // It kept a harness in the data layer and could only ever reach half the
  // plugin; the widget is the one scope that holds both this store and the
  // panel, so `log` and `toggle` can sit on one target there (D16).

  Component.onCompleted: {
    ensureDirProc.running = true
    // Give mkdir a tick before the first read, so a fresh install reads the
    // directory it is about to write into rather than one that isn't there.
    Qt.callLater(function() {
      file.reload()
      archiveFile.reload()
    })
  }
}
