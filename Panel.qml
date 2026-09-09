import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

import "Caffeine.js" as Caffeine
import "Presets.js" as Presets

// The popup: what is in you now, what will still be in you at bedtime, and
// the one tap that logs the next one.
//
// The lifecycle here is weather's, copied rather than reinvented —
// Bar.findPanelWidget identifies a popout by the exact names
// opened/open/close/closeForPopoutSwitch on the *bar widget*, and the widget
// forwards each one to the functions below.
Panel {
  id: root
  moduleName: "latecompile.caffeine-curve"
  ipcTarget: "caffeine-curve"
  // BarWidget owns the IPC surface, because that is the one place where both
  // the store and this panel are in scope. See D16.
  manageIpc: false

  property var anchorItem: null
  property bool openedFromHotkey: false

  // The bar tracks the widget mounted in its slot, not this nested panel, so
  // everything that identifies a popout has to be that widget.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root

  // Injected by BarWidget so there is exactly one FileView over doses.json.
  property var store: null

  // And one over notes.json, beside it in the data directory (D48). Data, not
  // a setting: never pruned, its own file, and inside D44's backup recipe.
  property var notes: null

  // ------------------------------------------------------------- settings
  //
  // Injected by BarWidget, which owns the one FileView over
  // ~/.local/state/omarchy/settings/caffeine-curve.json — the same
  // arrangement as the dose Store, and for the same reason (D43). Not the
  // bar's `settings`: `omarchy bar set` is inert for this widget, and nothing
  // here reads the shell.json entry.
  //
  // Every value has already been through a sanitiser by the time it arrives,
  // because Settings.qml exposes sanitised properties rather than the raw
  // object. The panel writes through config.set(), never to the file.
  property var config: null

  readonly property real halfLifeHours:
    config ? config.halfLifeHours : Caffeine.HALF_LIFE_DEFAULT_HOURS
  readonly property string bedtimeText: config ? config.bedtime : Caffeine.BEDTIME_DEFAULT
  readonly property real sleepThresholdMg:
    config ? config.sleepThresholdMg : Caffeine.BEDTIME_CLEAR_MG

  readonly property string units: config ? config.units : Caffeine.UNITS_MG

  // D84. Every cups conversion in this file takes this rather than a constant,
  // which is what stops one of them quietly using the default.
  readonly property real cupMg: config ? config.cupMg : Caffeine.CUP_MG_DEFAULT
  readonly property bool capShown: config ? config.capEnabled : false

  // D51, and it only ever hides. See the settings row for why the default and
  // the direction are both part of the decision rather than a preference.
  readonly property bool quiet: config ? config.quietPanel : false

  // D89. Read here as well as on the bar, because the row that sets it is on
  // this page and a value pill has to say what the file says.
  readonly property string barNumber:
    config ? config.barNumber : Caffeine.BAR_NUMBER_ALWAYS
  readonly property real capMg: config ? config.capMg : Caffeine.DAILY_CAP_DEFAULT_MG

  // D34's profile, and the two facts every row that mentions the half-life
  // needs: which of the two numbers is live, and what the other one is.
  readonly property var profileAnswers: config ? config.profile : Caffeine.sanitizeProfile({})
  readonly property string halfLifeSource: config ? config.halfLifeSource : "profile"
  readonly property bool halfLifeIsCustom: root.halfLifeSource === "custom"
  readonly property var derivation: Caffeine.deriveSteps(root.profileAnswers)
  readonly property bool isPregnant: root.profileAnswers.pregnancy !== "no"
  readonly property int profileAnswered: Caffeine.profileAnswered(root.profileAnswers)

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color accent: Color.accent
  readonly property color dim: Qt.darker(foreground, 1.45)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  // ------------------------------------------------------------ lifecycle

  function open() {
    openedFromHotkey = false
    setCenterHoverRevealSuppressed(false)
    root.controller.show()
  }

  function openFromHotkey() {
    openedFromHotkey = true
    root.controller.show()
    // Set after showing: showing hands the popout coordinator over, and that
    // handoff closes whichever panel was open, which clears the shared flag.
    Qt.callLater(function() {
      if (root.opened) setCenterHoverRevealSuppressed(true)
    })
  }

  function close() {
    setCenterHoverRevealSuppressed(false)
    root.showAllPresets = false
    // D97, and the same rule as the four below it: the panel is a glance at
    // now, and reopening it half-way down a page is the panel remembering
    // something you did not ask it to.
    root.scrollHome()
    // The settings page does not survive a close: the panel is opened to
    // answer "can I have this?", and reopening it onto a form is the wrong
    // answer to that question however recently you were editing one.
    if (root.showSettings) root.closeSettings()
    // Nor does the notes page, for the same reason and D64's: the panel is a
    // glance at now, and reopening it onto a list of last month is the panel
    // remembering something you did not ask it to.
    if (root.showNotes) root.closeNotes()
    // Nor may an overlay: the "?" card's own persistence across a close is an
    // old question nobody has settled (it is deliberate for a legend), but a
    // picker aimed at one row of a page that does not survive the close is
    // not a legend, and it goes with the page.
    root.closeIconPicker()
    // And nothing may be left owning the keyboard. Both closes above end
    // their own editor, but the note line is on the main page and would
    // otherwise survive the close with PanelKeyCatcher still blocked — every
    // key dead on the next open, including the one that would fix it.
    if (root.editingSetting) root.endEditing()
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.openFromHotkey()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  // ------------------------------------------------------------ the model

  // Read instead of Date.now() everywhere below, so a panel left open keeps
  // telling the truth rather than freezing at the moment it was opened.
  //
  // D80, and defect #6. This ticks at 1 Hz, because the hero leads with the
  // reading at full typographic weight (D4) and the bar mark glides its own
  // copy of the same number every frame — a panel clock that stepped once a
  // minute put a figure up to 59 seconds stale beside a bar that had moved on,
  // and `open()` reassigning this is exactly why closing and reopening looked
  // like a fix.
  property double nowSeconds: Math.floor(Date.now() / 1000)

  // The other half of pulling those two jobs apart. A *reading* wants a fine
  // clock; a twelve-hour window, a twenty-four-hour cutoff and the hundred
  // samples under them do not, and rebuilding a list sixty times a minute to
  // fix a number would be the wrong trade twice over — it costs three path
  // pairs, and it recreates every delegate in RECENT once a second under
  // whatever the pointer is resting on (D82).
  //
  // So everything window-shaped or list-shaped reads this instead, and
  // `resample()` is the only thing that moves it: the window and the samples
  // drawn in it therefore change together by construction, which is the one
  // property the single 60-second tick used to give for free.
  property double windowSeconds: Math.floor(Date.now() / 1000)

  readonly property var doses: store && store.doses ? store.doses : []
  readonly property bool hasDoses: doses.length > 0
  // A day you have panned to with nothing on it. Reachable on purpose: D64
  // stops the pan at the oldest dose, and every day between then and now is a
  // real day — including the ones you drank nothing on.
  //
  // Gated on `panned`, and that gate was bought by rendering the line against
  // the user's own log rather than against a staged one. At home a window with
  // no doses in it is the ordinary state of any evening whose last coffee was
  // over twelve hours ago — and "Nothing logged" then sits over a decaying
  // tail, three inches above "375 mg today" and four rows of RECENT, flatly
  // contradicting both. Panned, the same window is a claim about a day you
  // went looking at; at home it is a claim about the last twelve hours, which
  // is not what the sentence says and not a thing worth saying.
  readonly property bool viewDayEmpty: root.panned && root.windowEmpty

  readonly property bool windowEmpty: {
    for (var i = 0; i < root.doses.length; i++) {
      var ts = root.doses[i].ts
      if (ts >= root.fromTs && ts <= root.toTs) return false
    }
    return true
  }

  readonly property double oldestDoseTs: {
    var oldest = Caffeine.oldestDoseTs(root.doses)
    return oldest === null ? 0 : oldest
  }

  readonly property real level: Caffeine.levelAt(doses, nowSeconds, halfLifeHours)
  readonly property real fill: Caffeine.cupFill(doses, nowSeconds, halfLifeHours)
  readonly property var projection: Caffeine.bedtimeProjection(
    doses, nowSeconds, halfLifeHours, bedtimeText, sleepThresholdMg)
  readonly property var lead: Caffeine.strongDoseLead(doses, nowSeconds, halfLifeHours, bedtimeText)

  // ------------------------------------------------------------ the timeline
  //
  // D35. The window is no longer nailed to now: `viewOffsetSeconds` slides its
  // centre back through the record, clamped forward at now and back at the
  // oldest dose on file. Zero is home, and every key that moves it goes
  // through `panBy` so the clamp cannot be bypassed.
  property double viewOffsetSeconds: 0
  readonly property bool panned: root.viewOffsetSeconds < 0

  // D60: a step is a day and a jump is a week. Six-hour nudges were built and
  // rendered against day steps and lost — four presses to reach the day the
  // feature exists for, and every intermediate window still says "Today" with
  // the "now" hairline on it, so a pan you have made does not look like one.
  readonly property double panStep: Caffeine.PAN_STEP_SECONDS
  readonly property double panJump: Caffeine.PAN_JUMP_SECONDS

  // The moment the timeline has been walked to. Zero offset is now.
  readonly property double viewAtTs: root.windowSeconds + root.viewOffsetSeconds

  // ------------------------------------------------------------- D105
  //
  // **The window, and the day it is.** Three framings (rolling, day, hours)
  // and one function that turns any of them plus a moment into
  // `{ from, to, anchor }` — so this is still two bindings, and the axis
  // marks, the samples, the seam at now, the record's left edge, the empty
  // predicate and the ghost all go on reading exactly the two they always did.
  //
  // **`anchor` is the part that is new, and it is the part the phase was
  // about.** A rolling window is about its middle; an anchored one is about
  // its start. With a 07:00 start the middle is 19:00 the same day and the two
  // agree by luck; set the start to 20:00 and the middle is 08:00 the *next*
  // day, so the note `n` writes, the caption's "Yesterday", the day's total
  // and that day's bedtime would every one of them name a day the window
  // mostly is not. Everything below that used to read the centre reads this.
  //
  // The pan is applied to the *moment* rather than to the window's edges, so
  // the anchor is re-derived by rolling back to the clock rather than by
  // adding 86400 to yesterday's — which is what keeps a panned day on its
  // start time across a DST change, the same reason bedtimeSeconds rolls by
  // calendar day.
  readonly property string frame: root.config ? root.config.chartFrame : Caffeine.FRAME_ROLLING
  readonly property string dayStartText: root.config ? root.config.dayStart : Caffeine.DAY_START_DEFAULT
  readonly property string dayEndText: root.config ? root.config.dayEnd : Caffeine.DAY_END_DEFAULT
  readonly property bool anchoredFrame: root.frame !== Caffeine.FRAME_ROLLING

  readonly property var viewWindow: Caffeine.frameWindowAt(
    root.frame, root.viewAtTs, root.dayStartText, root.dayEndText)

  readonly property double fromTs: root.viewWindow.from
  readonly property double toTs: root.viewWindow.to
  readonly property double viewAnchorTs: root.viewWindow.anchor
  property var samples: []

  // A pinned day is resampled over its own window and drawn under the live
  // one, time-shifted so the two line up by clock rather than by date. Zero is
  // "nothing pinned"; the value is the **anchor** of the window that was
  // pinned — its centre while the chart is framed on now, its start once the
  // user has said where a day begins. It was `pinnedCentreTs` until D105, and
  // the rename is the whole of why the comparison lines up: restamping a
  // pinned day onto a centre ± twelve hours draws it half a day out of phase
  // with an anchored live window, which is the one thing this mode exists to
  // make possible.
  property double pinnedAnchorTs: 0
  readonly property bool hasPin: root.pinnedAnchorTs > 0
  property var ghostSamples: []

  // The ghost is only a comparison while you can see the thing it is being
  // compared against, so it is drawn on the window it was pinned *from* — not
  // wherever you have panned to since. Pin yesterday, come home, and it is
  // under today; pan away again and it stops competing with the day you are
  // reading.
  readonly property bool ghostVisible:
    root.hasPin && root.hasDoses && Math.abs(root.viewOffsetSeconds) < 3600

  function panBy(deltaSeconds) {
    // D64's floor, and it has to know the framing: an anchored window does not
    // reach behind its own start, so "back stops at the oldest dose" is a
    // different sum. That line has now been written twice for two shapes of
    // window and broken once; the property it has to keep is asserted in the
    // tests rather than re-derived here.
    var next = Caffeine.clampPanOffset(
      root.viewOffsetSeconds + deltaSeconds, root.doses, root.nowSeconds,
      root.frame, root.dayStartText)
    if (next === root.viewOffsetSeconds) return false
    root.viewOffsetSeconds = next
    root.resample()
    return true
  }

  // **D105's one key, and it is a cycle rather than a toggle.** `d` for day.
  // Free: the letters this panel takes are a c d i m n p s t u and their
  // shifted forms, plus h j k l x which the stock PanelKeyCatcher eats before
  // we see them — so `d` arrives through `handleTextKey` like every other
  // letter here and needs no modifier handling and no fork of the component.
  // (The list is kept current as keys land — `c` at D112, `u` at D113 — because
  // the next person to pick a letter reads it to find out what is free.)
  //
  // Panning is deliberately kept across the change. The framings are three
  // answers about the same stretch of time, so `d` on yesterday should leave
  // you on yesterday; the offset is a whole number of days and every framing
  // re-derives its own anchor from the moment, so it survives without
  // arithmetic. The clamp is re-run because the floor is not the same in all
  // three (D64), and a pan that was legal in one framing can be a day too far
  // in another.
  function stepFrame(direction) {
    if (!root.config) return
    root.config.set("chartFrame", Caffeine.nextFrame(root.frame, direction))
    Qt.callLater(function() {
      root.viewOffsetSeconds = Caffeine.clampPanOffset(
        root.viewOffsetSeconds, root.doses, root.nowSeconds,
        root.frame, root.dayStartText)
      root.resample()
    })
  }

  function panHome() {
    if (root.viewOffsetSeconds === 0) return false
    root.viewOffsetSeconds = 0
    root.resample()
    return true
  }

  // Pinning the day you are standing on, and pressing it again to let it go.
  // Pinning today is not a comparison, so it clears instead — that is what
  // makes "p" at home the way out of an overlay you have finished with.
  function togglePin() {
    if (root.hasPin && Math.abs(root.pinnedAnchorTs - root.viewAnchorTs) < 3600) {
      root.pinnedAnchorTs = 0
    } else if (!root.panned) {
      root.pinnedAnchorTs = 0
    } else {
      root.pinnedAnchorTs = root.viewAnchorTs
    }
    root.resampleGhost()
  }

  // Autoscaled to the window with a little headroom, floored so that a single
  // green tea does not render as a bender. This is the chart's scale and is
  // deliberately not the cup's — Caffeine.fillScale answers a different
  // question (D17), and sharing one would make the curve clip.
  readonly property real curveMax: {
    var highest = 0
    for (var i = 0; i < samples.length; i++)
      if (samples[i].mg > highest) highest = samples[i].mg
    // The ghost shares the scale, or a heavier yesterday would be drawn
    // clipped flat along the top and the comparison would read as a tie.
    if (root.ghostVisible) {
      for (var j = 0; j < ghostSamples.length; j++)
        if (ghostSamples[j].mg > highest) highest = ghostSamples[j].mg
    }
    return Math.max(50, highest * 1.12)
  }

  // Curve.qml rebuilds its path imperatively, so nothing here may assume a
  // binding will do it: resample on open, on a dose change, and on the tick.
  function resample() {
    if (!root.opened) {
      root.samples = []
      return
    }
    // Before fromTs/toTs are read, so the window this cuts and the samples
    // drawn in it are the same instant. Every path that resamples — open, a
    // pan, a dose, a half-life, the 60-second tick — comes through here, so
    // there is nowhere else the window can move from.
    root.windowSeconds = root.nowSeconds
    root.samples = Caffeine.levelOverRange(doses, root.fromTs, root.toTs, root.halfLifeHours, 100)
    curve.rebuild()
    root.resampleGhost()
  }

  // The pinned day, over its own window, stamped as though it were today. The
  // same ~100-sample budget: a pan costs one more pass over the same doses,
  // not an accumulating list.
  function resampleGhost() {
    if (!root.opened || !root.hasPin) {
      root.ghostSamples = []
      curve.rebuild()
      return
    }
    // The pinned day gets **its own framing's window**, not a centre and
    // twelve hours each way. In the rolling framing those are the same thing
    // and nothing changes; in the other two, this is what makes the ghost a
    // comparison rather than an alignment accident — two days on one axis is
    // the thing a rolling window cannot do (D64's original want).
    //
    // And the shift is measured edge to edge rather than centre to centre, so
    // it is right for a window of any width: line the pinned window's start up
    // with the live one's and the two days sit on the same axis by construction.
    var window = Caffeine.frameWindowAt(
      root.frame, root.pinnedAnchorTs, root.dayStartText, root.dayEndText)
    root.ghostSamples = Caffeine.levelOverRangeShifted(
      doses, window.from, window.to, root.halfLifeHours, 100,
      root.fromTs - window.from)
    curve.rebuild()
  }

  onOpenedChanged: {
    if (root.opened) {
      root.nowSeconds = Math.floor(Date.now() / 1000)
      // The whole panel arrives under wherever the pointer is resting, which
      // is a mouse nobody touched having a row appear beneath it (D82). The
      // cursor is placed below, deliberately; the pointer does not get to
      // move it until it moves.
      root.disarmPointer()
      root.setCursor("drinks", 0)
      // Home every time. The panel is a glance at now — reopening it onto
      // wherever you had panned to last week would be the panel remembering
      // something you did not ask it to.
      root.viewOffsetSeconds = 0
      root.resample()
      // After the resample, so the wipe reveals the curve it is about to draw
      // rather than the one from last time.
      curve.playEntrance()
      // An IPC share opened this panel; the capture waits for the curve it is
      // about to draw. See captureShare.
      if (root.sharePending) sharePendingTimer.restart()
    }
  }
  onDosesChanged: {
    // A dose logged over IPC or an external write to doses.json moves RECENT
    // under whatever the pointer is resting on, and no key was pressed to
    // disarm it (D82).
    root.disarmPointer()
    root.resample()
  }

  // Until Phase 6 nothing could change the half-life, so nothing had to
  // resample on one. The samples are a function of it, and Curve rebuilds its
  // path imperatively, so a settings change that nobody resampled for would
  // leave the old curve on screen under a hero that had already moved.
  //
  // Bedtime needs no resample: the marker and the projection are bindings on
  // it, and the sample list does not depend on it.
  onHalfLifeHoursChanged: root.resample()

  // D80, and defect #6. One timer used to do both of these jobs at 60s, and
  // only one of them wanted that rate: the hero leads with the reading at full
  // typographic weight (D4) while the bar mark glides its own copy of the same
  // number every frame, so between two ticks the panel was showing a figure up
  // to 59 seconds stale beside a bar that had moved on. `open()` reassigning
  // nowSeconds is exactly why closing and reopening looked like a fix.
  //
  // So they are two timers now. The clock is the cheap half — levelAt over a
  // few dozen doses and the bindings that hang off it — and it runs at 1 Hz,
  // which is finer than the reading can render and therefore always agrees
  // with the bar. The samples are the expensive half — a hundred points and
  // three path pairs through Curve.rebuild — and nothing about a twelve-hour
  // window changes meaningfully in a second, so it stays at 60.
  //
  // The panel steps rather than glides, deliberately. The bar glides because
  // it aims one tick ahead and has a whole minute to cover; at 1 Hz the step
  // is a sixtieth of that and invisible, so the hero cup keeps its Behavior
  // (a Behavior layered over a glide is the lag Cup.qml's header warns about,
  // and this is not a glide).
  Timer {
    // Only while open — the whole point of gating the sampling is that a
    // closed panel costs nothing.
    id: clockTimer
    running: root.opened
    interval: 1000
    repeat: true
    onTriggered: root.nowSeconds = Math.floor(Date.now() / 1000)
  }

  Timer {
    id: sampleTimer
    running: root.opened
    interval: 60000
    repeat: true
    onTriggered: root.resample()
  }

  // -------------------------------------------------------------- sharing
  //
  // D112. The one thing this plugin makes that leaves the machine.
  //
  // **It is a render, not a screenshot.** The panel is drawn inside a
  // full-screen layer surface — `hyprctl layers` shows one 1692x1128
  // `omarchy-keyboard-panel` with the card painted somewhere inside it — so
  // nothing that picks a *window* can pick this panel out. `omarchy screenshot`
  // in smart or window mode captures whatever is behind us; the only mode that
  // works is a hand-drawn region around a card with a rounded border, and the
  // crop is eyeballed every time. `grabToImage` sidesteps the whole problem:
  // exact bounds, no region to draw, no screen freeze, no dependency on a
  // capture stack, and it cannot catch a notification that happened to be up.
  //
  // Two things about it were proved with a render before this was written,
  // because both decide the design:
  //
  // 1. **An item off the side of the surface still grabs.** `shareStage` sits
  //    at a negative offset so it is never composited, and Qt renders it into
  //    the FBO anyway. If it did not, the card would have to flash on screen.
  // 2. **`targetSize` re-rasterises rather than upscaling.** The card is built
  //    at panel scale, where every `Style` token means what it means everywhere
  //    else in this plugin, and grabbed at 1600x900 — and the glyphs come out
  //    sharp at 2.67x, not resampled. That is the whole reason ShareCard.qml
  //    can be ordinary panel QML instead of a second type scale.
  //
  // The saved file lands where the shell's own screenshots land, under the
  // same directory rules, resolved by the same shell expression rather than
  // guessed at: `user-dirs.dirs` is a file bash sources, not an environment
  // variable, so reading `XDG_PICTURES_DIR` off the process would be right on
  // the machines that happen to export it and silently wrong on the rest.
  // 16:9 at a width the timelines do not have to resample. The card itself is
  // drawn at panel scale; this is only how large it is captured.
  readonly property int shareWidth: 1600
  readonly property int shareHeight: 900

  // Resolved once, on first use rather than at load: a panel that never shares
  // should not spawn a shell, and the answer cannot change under us in a way
  // that matters within a session.
  property string shareDir: ""
  property bool shareBusy: false

  // True when the share was accepted, so the IPC caller learns the difference
  // between "saved" and "there was nothing to save".
  function captureShare() {
    // Nothing to be a picture of. The empty state is a real state — a fresh
    // install before the first drink — and a card of it would be a wordmark
    // over an empty box.
    if (!root.hasDoses || root.shareBusy) return false
    root.shareBusy = true

    // **A closed panel has no scene graph, so there is nothing to grab.**
    // KeyboardPanel's surface is `visible: open || …`, and an unmapped window
    // renders nothing — the stage included. The keyboard route never meets
    // this (you pressed `c` on an open panel); the IPC route always does, and
    // it is the route that exists precisely so you can share without opening
    // anything.
    //
    // So it opens. Not as a fallback but as the honest thing: the card is a
    // picture of a reading, the panel is where that reading lives, and a
    // hotkey that silently wrote a file about a chart you cannot see would be
    // the plugin doing something you have no way to check. It stays open
    // afterwards for the same reason.
    if (!root.opened) {
      root.sharePending = true
      root.openFromHotkey()
      return true
    }
    root.beginShare()
    return true
  }

  property bool sharePending: false

  function beginShare() {
    if (root.shareDir === "") shareDirProc.running = true
    else root.grabShare()
  }

  // One frame is not enough: the Curve rebuilds its path imperatively when the
  // panel opens (`playEntrance` above), so a grab on the tick the surface maps
  // catches the card with an empty chart in it. This waits for the entrance to
  // have run, which is the same length the curve itself animates for.
  Timer {
    id: sharePendingTimer
    interval: Caffeine.MOTION_ENTRANCE_MS
    onTriggered: {
      root.sharePending = false
      root.beginShare()
    }
  }

  function grabShare() {
    var target = root.shareDir + "/" + Caffeine.shareFileName(Date.now() / 1000)
    // The grab is asynchronous and the callback is the only place that knows
    // whether it worked, so every exit from here goes through shareFinished.
    var started = shareStage.grabToImage(function(result) {
      if (!result || !result.saveToFile(target)) {
        root.shareFailed("could not write " + target)
        return
      }
      root.sharePath = target
      shareCopyProc.running = true
    }, Qt.size(root.shareWidth, root.shareHeight))
    if (!started) root.shareFailed("could not render the card")
  }

  property string sharePath: ""

  function shareFailed(why) {
    console.warn("caffeine-curve: share failed —", why)
    root.shareBusy = false
    root.shareToast = "Could not save the image"
    shareToastTimer.restart()
  }

  // Said on the panel rather than only in a notification, because the panel is
  // where the key was pressed and it is still open. The notification is for
  // the file — it carries the thumbnail and outlives the panel — and this is
  // the acknowledgement that the keystroke did something, which is the part a
  // notification arriving a moment later does badly.
  property string shareToast: ""

  Timer {
    id: shareToastTimer
    interval: Caffeine.MOTION_TOAST_MS
    onTriggered: root.shareToast = ""
  }

  // The shell's own rule for where a capture goes, run as the shell runs it.
  Process {
    id: shareDirProc
    running: false
    command: ["bash", "-c",
      "[[ -f ~/.config/user-dirs.dirs ]] && source ~/.config/user-dirs.dirs; "
      + "dir=\"${OMARCHY_SCREENSHOT_DIR:-${XDG_PICTURES_DIR:-$HOME/Pictures}}\"; "
      + "mkdir -p \"$dir\" && printf %s \"$dir\""]

    stdout: StdioCollector {
      onStreamFinished: root.shareDir = text.trim()
    }

    onExited: function(exitCode) {
      if (exitCode !== 0 || root.shareDir === "") {
        root.shareFailed("no directory to write into")
        return
      }
      root.grabShare()
    }
  }

  // Clipboard first, notification second, and the notification is
  // best-effort: by the time it runs the image is already saved and already
  // pasteable, so a notification daemon that is not up must not report the
  // share as failed. That is the shell's own reasoning in
  // omarchy-capture-screenshot, and this is the same sequence.
  Process {
    id: shareCopyProc
    running: false
    // wl-copy reads the image on stdin — it has no file argument, and its
    // positional arguments are text to copy, so passing the path there would
    // put the *filename* on the clipboard. Hence the redirect, and hence bash.
    command: ["bash", "-c", "wl-copy --type image/png < \"$1\"", "wl-copy",
      root.sharePath]

    onExited: function(exitCode) {
      root.shareBusy = false
      root.shareToast = exitCode === 0 ? "Image copied" : "Image saved"
      shareToastTimer.restart()
      shareNotifyProc.running = true
    }
  }

  Process {
    id: shareNotifyProc
    running: false
    command: ["omarchy-notification-send",
      "Caffeine Curve copied to clipboard and file", root.sharePath,
      "--image", root.sharePath]
  }

  // ------------------------------------------------------------ the verdict
  //
  // D18, decided at Phase 4 from renders. `clear` maps to Color.accent and
  // `disruptive` to Color.urgent, both real palette roles. `marginal` has
  // none — a theme guarantees two — and the midpoint of those two is nearly
  // invisible on Gruvbox, so the blend was never a candidate.
  //
  // The answer is that marginal makes no colour claim at all: it takes the
  // plain foreground, and "Borderline for sleep" carries the distinction.
  // That yields three genuinely distinct hero states out of two guaranteed
  // roles, verified on Gruvbox (teal / cream / red), Catppuccin Latte and
  // Flexoki Light (blue / near-black / red).
  //
  // The alternative — marginal in the urgent hue, separated from disruptive
  // by a hollow bedtime dot — was built and lost on the captures, for the
  // same structural reason the Phase 3 liquid dim lost: the distinguishing
  // feature is smaller than the distinction it has to carry. At 7px the
  // hollow dot is a ring you have to already know about, and meanwhile the
  // hero goes fully red, so a 55mg residual shouts exactly as loudly as a
  // 190mg one. The band whose whole job is "notice, but do not panic" was
  // the one that panicked.
  function bandColor(band) {
    if (band === "clear") return root.accent
    if (band === "disruptive") return root.urgent
    return root.foreground
  }

  // The wording lives in Caffeine.verdictFor, which also owns the branch for
  // the D42 late window — a verdict about the state you are in now cannot use
  // the future tense a verdict about bedtime does.

  // D111's press, reachable from the dev IPC because nothing on this machine
  // can click. Two lines, and the only reason they are on the root rather than
  // inside the delegate is that the knob cannot reach into a Column.
  function replayCup() { heroCup.replay() }

  function clockOf(tsSeconds) {
    return Qt.formatTime(new Date(tsSeconds * 1000), Qt.locale().timeFormat(Locale.ShortFormat))
  }

  // The two clocks as the axis would print them — "7AM" rather than "7:00 AM"
  // — because they go in a legend cell beside eight other rows and the minutes
  // are always zero at a setting you stepped in quarter hours. Rendered
  // through the same hourLabel the axis uses, so the card and the chart cannot
  // disagree about which convention is in force.
  readonly property string dayStartLabel:
    root.hourLabel(Caffeine.previousClockSeconds(root.nowSeconds, root.dayStartText))
  readonly property string dayEndLabel:
    root.hourLabel(Caffeine.previousClockSeconds(root.nowSeconds, root.dayEndText))

  // The axis is tight — eight labels across 440px — so a 12-hour clock drops
  // its minutes: "3PM", not "3:00 PM". Read off the rendered string rather
  // than off the locale's format pattern, so the axis can never disagree with
  // the clocks elsewhere in the panel about which convention is in force.
  function hourLabel(tsSeconds) {
    var full = root.clockOf(tsSeconds)
    if (!/[AaPp][Mm]/.test(full)) return full
    return full.replace(":00", "").replace(/\s+/g, "")
  }

  // Where the window is, as a calendar date. Printed on the axis at the
  // midnight tick rather than in the caption: "Yesterday" is unambiguous for
  // one day and useless for nine, and the two say different things — one is
  // how far you have come, the other is which day is which on the chart.
  function dayNameOf(tsSeconds) {
    return Qt.formatDate(new Date(tsSeconds * 1000), "ddd d MMM")
  }

  // D61's caption. Panned it is about the window; home with a ghost under the
  // curve it is about the pinned day, because otherwise the one state the
  // whole feature builds towards is the one state with nothing on screen
  // saying which day the dotted line is.
  // **The one state where the chart is not about now and nothing said so.**
  //
  // The `hours` framing can leave the present in its gap: at 03:00 with a
  // 07:00-midnight day, home is the window that ended three hours ago. The
  // caption is drawn only when panned or pinned, so that window arrived with
  // no title, the "now" hairline absent, and a hero above it talking about the
  // present — which reads as a chart that has stopped updating rather than as
  // a day you have finished.
  //
  // Decided from the render rather than argued: the axis labels alone do carry
  // it in the `day` framing, where the window contains now and only the far
  // edges have moved, and they do not carry it here, where every hour on the
  // axis is in the past. So the rule is not "anchored framings get a caption",
  // it is **the caption appears when the window does not contain now** — which
  // is exactly the state it is needed in and no wider.
  readonly property bool windowHasNow:
    root.nowSeconds >= root.fromTs && root.nowSeconds <= root.toTs
  readonly property bool captionForced:
    root.anchoredFrame && !root.windowHasNow

  readonly property double captionAnchorTs:
    (root.panned || root.captionForced) ? root.viewAnchorTs : root.pinnedAnchorTs

  // The window the caption is about, which is the live one when it is about
  // where you have panned to and the pinned one when it is about the ghost.
  readonly property var captionWindow: Caffeine.frameWindowAt(
    root.frame, root.captionAnchorTs, root.dayStartText, root.dayEndText)

  // **The figure follows the framing (D105).** While a day means midnight to
  // midnight, the calendar day is the right answer and `dayTotalMg` gives it.
  // Once the user has said where their day begins, the caption sits above a
  // window and its total is that window's — otherwise a 02:00 coffee is drawn
  // at the right-hand end of the chart and counted at the left-hand end of the
  // next one. The *note* stays keyed to the calendar day of the anchor, below,
  // because a note is filed by date.
  readonly property string viewDayLine:
    Caffeine.formatDayOffset(root.captionAnchorTs, root.nowSeconds) + "  ·  "
    + root.amountTextOf(root.anchoredFrame
      ? Caffeine.totalInRange(root.doses, root.captionWindow.from, root.captionWindow.to)
      : Caffeine.dayTotalMg(root.doses, root.captionAnchorTs))

  // The same line as the caption above, anchored where the card needs it:
  // always the window you are looking at, never the pinned one. The two
  // differ only at home with a pin, and there the panel's caption is
  // deliberately about the ghost while the card is a picture of the live
  // curve — so this is the same sentence about a different day, not a second
  // opinion about the same one.
  readonly property string shareDayLine:
    Caffeine.formatDayOffset(root.viewAnchorTs, root.nowSeconds) + "  ·  "
    + root.amountTextOf(root.anchoredFrame
      ? Caffeine.totalInRange(root.doses, root.viewWindow.from, root.viewWindow.to)
      : Caffeine.dayTotalMg(root.doses, root.viewAnchorTs))

  // ------------------------------------------------------------- D90: the pin
  //
  // **What was missing was never the whole of it, and reading the code said
  // so.** At home with a ghost the caption already read "Pinned:  21 days ago
  // · 295 mg", because D61 pointed it at the pinned day for exactly that
  // reason. The state with no feedback at all is the one D90 named as the hard
  // half: **a pin on one day and the timeline panned to another.** The ghost is
  // gated on being near home so it is not drawn, the caption is about the
  // window you are reading, and nothing anywhere says a pin exists — so `p`
  // silently replaces it with the day you are standing on.
  //
  // **One rule, three renderings: the mark is attached to the pinned day,
  // wherever the pinned day is named.** When the caption is about the pinned
  // day the mark leads it, and the word "Pinned:" comes off — a glyph and a
  // label saying one thing is D61's own complaint at eight pixels instead of
  // eighty. When the caption is about some other day, the pinned day is named
  // at the line's other end with the mark on it. And with no pin there is no
  // mark, which is the state a fresh install is in.
  readonly property bool captionIsPinnedDay: root.hasPin
    && Math.abs(root.pinnedAnchorTs - root.captionAnchorTs) < 3600

  readonly property bool pinElsewhere: root.hasPin && !root.captionIsPinnedDay

  readonly property string pinnedDayLine:
    Caffeine.formatDayOffset(root.pinnedAnchorTs, root.nowSeconds)

  // D61's second half: once the window is not today, the midnight tick prints
  // the date the day starts instead of "12AM". The window always straddles a
  // midnight, so "Yesterday" alone leaves the left third of the chart
  // unlabelled — and panned far enough back, this is the only absolute date
  // anywhere on the chart. It costs no new furniture: the tick and its label
  // were both already there.
  function axisLabelOf(tsSeconds) {
    if (root.panned && new Date(tsSeconds * 1000).getHours() === 0)
      return root.dayNameOf(tsSeconds)
    return root.hourLabel(tsSeconds)
  }

  // What the bedtime hairline is called on the curve. The clock is already in
  // the hero and readable off the axis, so the label names the line rather
  // than restating a number — a bare "2:30AM" beside a red rule leaves you to
  // work out why it is there.
  // The bedtime the *window* contains, not the next one. Panned back three
  // days, `projection.bedtimeAt` is off the right-hand edge and the marker
  // simply vanishes — which loses the one line that says what a past day was
  // heading for. At home the two are the same value, so nothing about D42
  // changes.
  readonly property double viewBedtimeTs: root.panned
    ? Caffeine.bedtimeSeconds(root.viewAnchorTs, root.bedtimeText)
    : root.projection.bedtimeAt

  // ------------------------------------------------------------- the notes
  //
  // D48, and D65 settles what it is called. A note is written on the day the
  // timeline has you on — the window's anchor day — which is what answers
  // D42's deferred "which day is a note written at 23:30 about?" without
  // inventing a second calendar. The day is on screen with a caption naming
  // it; that is the answer, and it needed no machinery.
  // **The anchor and not the centre since D105.** The centre of a window that
  // opens at 20:00 is 08:00 the next day, so a note written from it would be
  // filed under a date the chart barely shows. The anchor is the window's
  // start in both anchored framings and is the centre in the rolling one, so
  // this is unchanged for anybody who has not touched the setting.
  readonly property string viewDayKey: Caffeine.dayKeyOf(root.viewAnchorTs)
  readonly property var viewNote:
    root.notes ? root.notes.noteFor(root.viewDayKey) : null
  readonly property bool hasViewNote: root.viewNote !== null
  readonly property var noteEntries: root.notes ? root.notes.entries : []
  readonly property bool hasNotes: root.noteEntries.length > 0

  // The file is there and unreadable. Reading degrades to no notes, as
  // everything in this plugin does — but writing stops, because the next write
  // would replace months of prose with one sentence, and that is the argument
  // the archive already made for itself (Store.archiveBlocked). It is stated
  // on screen rather than left as a key that does nothing: a note is the one
  // thing here nobody can reconstruct.
  readonly property string noteError: root.notes ? root.notes.lastError : ""
  readonly property bool notesBlocked: root.noteError !== ""

  // The note line normally carries no day of its own, for D61's reason: the
  // caption above says which day is on screen, and the same string twice
  // eighty pixels apart is the build D61 threw away.
  //
  // There is exactly one state where they are about DIFFERENT days, and it is
  // the state the whole timeline builds towards — home with a pin, where the
  // caption reads "Pinned: 21 days ago · 295 mg" about the ghost and the note
  // line, eight pixels under it, is about today. Two true captions about two
  // days, adjacent, with nothing saying which is which. That is D23's pattern
  // yet again, found the same way every time: by rendering the change in a
  // state it is not the subject of. Here the note line says its day, because
  // here it is not the same day.
  readonly property bool noteDayAmbiguous: !root.panned && root.ghostVisible

  // What the line above the curve reads while nothing is being typed into it.
  readonly property string viewNoteText: !root.hasViewNote
    ? ""
    : (root.noteDayAmbiguous
       ? Caffeine.formatDayOffset(root.viewAnchorTs, root.nowSeconds) + "  ·  "
       : "")
      + (root.viewNote.text === ""
         ? Caffeine.NOTE_EMPTY_TEXT
         : Caffeine.formatNoteText(root.viewNote.text))

  // `n` on the day you are standing on. It opens the field seeded with
  // whatever is already written there, so writing and rewriting are one
  // gesture — there is no second key for "edit".
  function startNote() {
    if (!root.notes || !root.notes.loaded || root.notes.blocked) return
    root.startEditing("note", 0)
  }

  function commitNote(text) {
    if (!root.notes) return false
    return root.notes.write(root.viewDayKey, text)
  }

  readonly property string bedtimeCaption: "BED"

  // ------------------------------------------------------------ logging

  property bool showAllPresets: false

  // One height for the whole log row, so the "+" is the same object as the
  // pills beside it rather than a control that happens to sit near them.
  readonly property real presetHeight:
    Style.font.body + Style.font.caption + Style.spacing.xxs + Style.spacing.controlPaddingY * 2

  // D31. The drinks are the user's data now, not a constant: the settings file
  // holds an ordered list and Presets sanitises it, so an absent, empty or
  // hand-mangled `drinks` key comes back as the shipped seventeen rather than as
  // an empty log row. Everything below still reads the catalog's *order* as
  // the UI — which drinks are on the main row, and which key logs which drink —
  // so a reorder needs no other machinery to show up.
  readonly property var catalogPresets: root.config ? root.config.drinks : Presets.DEFAULTS

  // D6 and D30 live in Presets.js so the table and the row can never disagree.
  readonly property var mainPresets: Presets.mainRow(root.catalogPresets)
  readonly property var overflowPresets: Presets.overflow(root.catalogPresets)

  // Six columns: the five drinks of D30 plus the "+" in its own trailing
  // slot. That is logged defect #3 — the main row used to subtract the "+"
  // button's width from four cells while the overflow divided the full width
  // by four, so the two grids never sat on the same columns — and it settles
  // the ragged last row in the same stroke: five-and-the-plus is exactly one
  // row, and every row under it is a clean six. **Since D96 the shipped table
  // is seventeen, so all three rows are full** — which is what D96 was for.
  // A short last row is still a state the cursor has to walk correctly rather
  // than a state to design away (D81); it is one a user reaches now instead of
  // one that ships.
  readonly property int presetColumns: Presets.MAIN_ROW_SIZE + 1

  // The dose takes a copy of the drink, not a reference to it: {mg, label} is
  // snapshotted here and the curve is drawn from that, so re-pricing a drink
  // tomorrow cannot rewrite what today's coffee was. That has been true since
  // Phase 1 and it is what makes the catalog safe to edit at all; a test pins
  // it, because it is the kind of thing a refactor quietly breaks.
  // **D104. The cursor follows the drink you logged, onto the dose it became.**
  //
  // Three of the four things people do next are operations on the *dose* —
  // delete it, walk it back, walk it forward — and the fourth, looking at the
  // curve, needs no cursor at all. Only "log another" wanted the cursor left
  // where it was, and that is the one the digits already serve from anywhere
  // on the page.
  //
  // `followDose` rather than `setCursor("doses", 0)`, and by the dose
  // `store.add` hands back rather than by re-deriving one: **identity, not
  // index.** A dose planned into the future (D20) sorts above one logged now,
  // so `recentDoses[0]` is not reliably the drink that was just poured. This
  // is the same function and the same reason the nudge uses it.
  //
  // Two states this lands in that are not the ordinary one. **The first drink
  // ever** creates the `doses` cursor section, so the cursor is being sent
  // into a section that did not exist an instant earlier and
  // `onCursorSectionsChanged` runs in the same turn — it finds `doses` present
  // by then, because the store persists synchronously and the section list is
  // a binding over the same doses. And **logging from a panned timeline**
  // comes home first, below.
  //
  // **What this costs, stated rather than discovered: `↵` on a dose row does
  // nothing.** `activateCursor` has no `doses` branch, so the key that logged
  // a drink a second ago is a silent no-op on its second press. That is
  // deliberate and it is left that way — a dose row's controls are `‹ ›`, `x`
  // and its amount pill, and inventing an Enter action for it is a new
  // decision rather than the consequence of this one. What is not acceptable
  // is nobody having noticed.
  //
  // **Logging comes home, and that is this phase's doing rather than a
  // flourish.** The note above used to end "the cursor lands on a dose that is
  // not on the chart you are reading, which is correct" — true only while
  // RECENT was always today's. Now that the list follows the window, a drink
  // logged from Saturday would land in neither half of the panel: not on the
  // curve, which is Saturday's, and not in the rows, which are Saturday's too.
  // The press would do nothing you could see. A drink is logged at now, so the
  // panel goes to now — the same `t` the user would have pressed themselves,
  // and the resample lands before `followDose` looks for the row.
  function logPreset(preset) {
    if (!store || !preset) return
    root.panHome()
    var dose = store.add(preset.mg, Presets.labelOf(preset))
    root.showAllPresets = false
    if (dose) root.followDose(dose.ts, dose.mg)
  }

  // D32. The digit logs the drink at that catalog position from anywhere in
  // the panel, whether or not the overflow is open — the mapping is a
  // property of the catalog, and one that appeared and disappeared with the
  // overflow would be a mode rather than a shortcut. A digit past the end of
  // a short catalog does nothing, silently: there is no pill to have meant.
  function logDigit(text) {
    var slot = Presets.indexForDigit(text)
    if (slot < 0) return false
    var preset = root.catalogPresets[slot]
    if (preset) root.logPreset(preset)
    return true
  }

  // The list under "Recent" — **the drinks on the chart you are reading**,
  // newest first. At home that is the last day's worth; panned, it is the day
  // you have walked back to.
  //
  // It was the last day's worth unconditionally until here, and the note at
  // D104 called that correct — "RECENT is always the last day, whatever the
  // curve is showing". Reading it as a report rather than as a design, it is
  // the panel freezing: you pan to Saturday, the caption says Saturday, the
  // curve is Saturday's, and the ten rows underneath are still today's, with
  // today's `x` and today's chevrons on them. There is no way to correct a
  // drink you logged yesterday, which is exactly the correction people want,
  // and the list gives no sign that it is not about the day above it.
  //
  // So the list follows the window, and the two halves of the panel are about
  // one day again. What that buys, beyond the list being true: `x` and `‹ ›`
  // reach a past day's doses, because the rows they act on are that day's.
  //
  // **Home keeps its own bounds rather than the window's**, and deliberately.
  // A rolling frame is twelve hours each side of now, and handing RECENT that
  // `from` would drop this morning's coffee off the list at teatime — the list
  // is "the last day", which is a longer memory than the chart's left edge on
  // purpose, and its open right-hand end is what keeps a dose planned into the
  // future (D20) somewhere you can still nudge or delete it.
  //
  // **And panned, "which day" is the caption's question, already answered.**
  // `viewDayLine` splits on `anchoredFrame` for a reason that applies here
  // word for word: an anchored window *is* a day, so the window is the answer;
  // a rolling one is twelve hours either side of a moment and is not a day at
  // all, so the caption reports the calendar day it is centred on. Written the
  // other way round — the window in both framings — the rolling caption would
  // read "2 days ago · 305 mg" over three rows totalling 225, because a coffee
  // at 08:52 falls outside a window that opens at 11:08. The heading, the
  // total and the rows have to be one statement about one day, so this reads
  // the same `anchoredFrame` the caption does.
  readonly property var recentWindow: {
    if (!root.panned)
      return { from: root.windowSeconds - Caffeine.SECONDS_PER_DAY, to: null }
    if (root.anchoredFrame) return { from: root.fromTs, to: root.toTs }
    return Caffeine.dayRangeAt(root.viewAnchorTs)
  }

  readonly property var recentDoses: Caffeine.dosesInRange(
    root.doses, root.recentWindow.from, root.recentWindow.to, Caffeine.RECENT_ROWS)

  // Panning shortens RECENT without changing the *section* list, so
  // `onCursorSectionsChanged` never fires and its clamp cannot help: the same
  // shape as `onDrinkSlotCountChanged` and the same one-line answer. Walk to
  // the eighth row of a busy day, press `[`, and without this the cursor is
  // pointing past the end of a quiet one — where `x` and the nudge read an
  // undefined entry and silently do nothing.
  onRecentDosesChanged: {
    if (root.cursorSection === "doses" && root.cursorIndex >= root.recentDoses.length)
      root.setCursor("doses", root.recentDoses.length - 1)
  }

  // The list's own name for the day it is about. "RECENT" is true at home and
  // wrong one press of `[` later, and this header is the only label that sits
  // *with* the rows — the caption that names the day is up beside the chart,
  // half a panel away, which is far enough that the rows read as unlabelled.
  // Same words as the caption, so the two are recognisably one statement.
  readonly property string recentHeading: root.panned
    ? Caffeine.formatDayOffset(root.viewAnchorTs, root.nowSeconds).toUpperCase()
    : "RECENT"

  // **"how long ago" is a column about now, so it goes when the list is not.**
  // On a day you have walked back to it reads "76h" — arithmetic that is
  // correct, useless, and the widest thing in the row, sized by
  // `columnSamples` so it pushes the clock and the amount along with it. The
  // header now says which day this is and the clock says when in it; the hours
  // between then and now are not a third opinion anybody asked for. Emptied
  // rather than hidden: the width is measured off the same strings, so an
  // empty column measures zero and the row closes up on its own.
  function elapsedColumnOf(ts) {
    return root.panned ? "" : root.elapsedTextOf(ts)
  }

  // **There is no line about the doses the list is not showing (D110).** There
  // was, and D106 is why it went rather than why it stayed: measured against a
  // real log it was worth 0.005 mg at a 2-hour half-life, and *exactly* zero
  // for anything past COMPUTE_WINDOW_HOURS at any half-life, because that is
  // where levelOfSorted stops summing while retention keeps thirty days.
  // Making it state its own figure — which D106 did — left a line that is
  // never on screen at the settings its reporter actually uses, and the honest
  // end of that is that it has no job. A count nobody can act on is furniture
  // (D40).
  //
  // What went with it: `olderCount`, `olderMg`, `olderWorthSaying`,
  // `Caffeine.olderContributionMg`, `Caffeine.olderWorthShowing` and their
  // tests. **The measurement stays in plan/03-design-decisions.md**, because
  // the next person to notice that RECENT stops at a day will otherwise add
  // the line back. The route to the older doses is the timeline: D64's floor
  // already guarantees a pan reaches the oldest dose on file.

  // D13: informational, and off unless asked for. No budget framing, no scold
  // copy, and no colour change on crossing it — 400mg is a threshold below
  // which no harm is expected, not a target you failed to hit.
  readonly property string todayText: {
    if (!root.capShown)
      return Caffeine.formatLogged(root.todayTotal, root.units, root.cupMg) + " today"
    return Caffeine.formatLoggedValue(root.todayTotal, root.units, root.cupMg) + " / "
      + Caffeine.formatLoggedValue(root.capMg, root.units, root.cupMg) + " "
      + Caffeine.unitName(root.units) + " today"
  }

  // The day past the cap the user set. D28 built the cap as "a second number
  // on a line that already existed — no meter, no colour, nothing on crossing
  // it", and the third of those was the one clause nobody had ever rendered.
  //
  // Three states were built. Adding the word "over" tells you what the two
  // numbers beside it already say, costs the line width, and is the only one
  // of the three that reads as a remark rather than as a reading. Changing
  // nothing leaves a line you switched on in order to watch at exactly the
  // weight it has when there is nothing to watch — so you compare the two
  // figures yourself, every time you open the panel, which is the work the
  // setting was supposed to do for you.
  //
  // So the line stops receding, and nothing else about it changes. That is
  // D19's rule read backwards and it is the same rule: the bar mark dims
  // below 20 mg because it has nothing to say, and this undims because it has
  // started to. No meter, no colour, no new word — D28 keeps all three of the
  // things it actually asked for.
  readonly property bool overCap: root.capShown && root.todayTotal > root.capMg

  readonly property real todayTotal: {
    var start = new Date(root.nowSeconds * 1000)
    start.setHours(0, 0, 0, 0)
    var from = Math.floor(start.getTime() / 1000)
    var total = 0
    for (var i = 0; i < doses.length; i++)
      if (doses[i].ts >= from && doses[i].ts <= root.nowSeconds) total += doses[i].mg
    return total
  }

  // ------------------------------------------------------- the dose rows

  // Every quantity of caffeine on the panel goes through here, so the units
  // setting is applied in exactly one place and the rows and the preset pills
  // cannot disagree about it. The two exceptions are deliberate and commented
  // where they are: the strong-dose line, which quotes a measured threshold,
  // and the curve, which has no value axis to label.
  function amountTextOf(mg) {
    return Caffeine.formatLogged(mg, root.units, root.cupMg)
  }

  // Signed, because since D20 a dose can sit in the future: a coffee an hour
  // ahead is "in 1h", not "1h". Caffeine.formatDuration takes an absolute
  // value — correctly, for every other caller — so without this a planned
  // drink is indistinguishable in the list from one already drunk.
  function elapsedTextOf(ts) {
    return Caffeine.formatOffset((ts - root.nowSeconds) / 3600)
  }

  // One width per column, measured off the widest row rather than left to
  // each row's own text. This is logged defect #1/#2, and it is what D20's
  // chevrons had to wait for: the clock pill's width hugged its text and that
  // text changed on hover, so pointing at a row moved it, and the mg column —
  // anchored to the pill — sat at a different x on every row. Chevrons would
  // have been a third width on the same element.
  //
  // Widest is taken by character count and then measured, rather than by
  // measuring every candidate: across digits in one font the two orders agree
  // to within a pixel, against the tens of pixels this replaces.
  readonly property var columnSamples: {
    var amount = ""
    var clock = ""
    var ago = ""
    for (var i = 0; i < root.recentDoses.length; i++) {
      var dose = root.recentDoses[i].dose
      var candidate = root.amountTextOf(dose.mg)
      if (candidate.length > amount.length) amount = candidate
      candidate = root.clockOf(dose.ts)
      if (candidate.length > clock.length) clock = candidate
      candidate = root.elapsedColumnOf(dose.ts)
      if (candidate.length > ago.length) ago = candidate
    }
    return { amount: amount, clock: clock, ago: ago }
  }

  TextMetrics {
    id: amountMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
    text: root.columnSamples.amount
  }

  TextMetrics {
    id: clockMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
    text: root.columnSamples.clock
  }

  TextMetrics {
    id: elapsedMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
    text: root.columnSamples.ago
  }

  // One width for every setting's value, measured off the widest, so the pills
  // form a column instead of ragging in from the right edge — the same fix,
  // and the same reason, as the dose rows' fixed columns.
  readonly property string settingValueSample: {
    // "Confirm" is in the running because the restore row swaps to it, and a
    // pill that grew when armed would move the row you are confirming.
    var widest = "Confirm"
    for (var i = 0; i < root.settingRows.length; i++) {
      var candidate = root.settingValueText(root.settingRows[i])
      if (candidate.length > widest.length) widest = candidate
    }
    return widest
  }

  // The catalog's value column, measured the same way off its own widest: the
  // amounts, and the words the two non-drink rows put in the same pill.
  readonly property string catalogValueSample: {
    var widest = "Restore"
    for (var i = 0; i < root.catalogRows.length; i++) {
      var candidate = root.rowValueText(root.catalogRows[i])
      if (candidate.length > widest.length) widest = candidate
    }
    return widest
  }

  TextMetrics {
    id: catalogValueMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
    text: root.catalogValueSample
  }

  TextMetrics {
    id: settingValueMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
    text: root.settingValueSample
  }

  // The notes page's value column: how far back each day is. Measured off the
  // widest the retention window can produce rather than off the rows on
  // screen, so removing the oldest note does not re-lay-out the rows above it.
  readonly property string noteValueSample: Caffeine.RETENTION_DAYS + " days ago"

  TextMetrics {
    id: noteValueMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
    text: root.noteValueSample
  }

  // The profile page's value column: the answers, which are sentences rather
  // than numbers ("Keeps me up all night"), plus the two action rows' words.
  readonly property string profileValueSample: {
    var widest = "Confirm"
    for (var i = 0; i < root.profileRows.length; i++) {
      var candidate = root.rowValueText(root.profileRows[i])
      if (candidate.length > widest.length) widest = candidate
    }
    return widest
  }

  TextMetrics {
    id: profileValueMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
    text: root.profileValueSample
  }

  // The derivation's left column, measured off the widest thing it can hold —
  // which is the total ("= 14.7 hours"), not one of the multipliers.
  readonly property string derivationMarkSample: {
    var widest = Caffeine.formatDerivationMark(root.derivation)
    var base = Caffeine.formatDerivationBase()
    if (base.length > widest.length) widest = base
    for (var i = 0; i < root.derivation.steps.length; i++) {
      var candidate = "× " + Caffeine.formatFactor(root.derivation.steps[i].factor)
      if (candidate.length > widest.length) widest = candidate
    }
    return widest
  }

  TextMetrics {
    id: derivationMarkMetrics
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    text: root.derivationMarkSample
  }

  // D20. Store.nudgeAt has always taken a signed value; what was missing was
  // an affordance for the other direction and a limit on it.
  //
  // A dose nudged past its neighbour reorders the list under the cursor,
  // because sanitizeDoses sorts newest first and recentDoses is built from
  // that order. So the identity is held across the reorder by re-finding the
  // row at its new timestamp — otherwise the second press of › moves a
  // different drink.
  function nudgeDose(index, minutes) {
    if (!root.store) return
    var dose = root.doses[index]
    if (!dose) return
    // **Deliberately not the framing's window, and this is the note that says
    // so (D105).** `nudgeMinutes` limits a forward nudge to
    // CURVE_WINDOW_HOURS, and it is left reading that constant on purpose: how
    // far ahead you may plan a coffee is a fact about planning coffee, not
    // about how you have chosen to frame a chart. Reaching for `root.toTs`
    // here would make the limit twelve hours, seventeen or a whole day
    // depending on a display setting, and would let a dose be planned into
    // tomorrow by pressing `d`. Anyone tidying this into a binding is
    // introducing that.
    var delta = Caffeine.nudgeMinutes(dose.ts, minutes, root.nowSeconds)
    if (delta === 0) return
    var movedTs = dose.ts + delta * 60
    if (root.store.nudgeAt(index, delta)) root.followDose(movedTs, dose.mg)
  }

  // The store persists synchronously, so recentDoses has already re-sorted by
  // the time this runs.
  function followDose(ts, mg) {
    for (var i = 0; i < root.recentDoses.length; i++) {
      var dose = root.recentDoses[i].dose
      if (dose.ts === ts && dose.mg === mg) {
        root.setCursor("doses", i)
        return
      }
    }
  }

  // ------------------------------------------------------- the settings view
  //
  // A second page of the same panel rather than a window of its own: `s` or
  // the bean in the corner swaps the body for the list below, Esc swaps it
  // back, and the one cursor walks it exactly as it walks the drinks. The
  // hero stays on top, which is the point of a settings page inside the
  // panel — you move the sleep threshold and watch the verdict change under
  // it, rather than changing a number somewhere else and coming back to see
  // what it did.
  //
  // Every write goes through Settings.set, which is optimistic and then
  // corrected by the file; nothing here touches the file directly.
  property bool showSettings: false

  // -1 when nothing is being typed into. While it is not, PanelKeyCatcher is
  // blocked and the field owns the keyboard — the gallery's contract for a
  // panel with an inline editor.
  //
  // Two pages have editable rows now, so the index alone no longer says which
  // row is open: it is an index into whichever list `editingSection` names.
  property string editingSection: ""
  property int editingIndex: -1
  property string editingText: ""
  readonly property bool editingSetting: root.editingIndex >= 0
  // The note line above the curve is the third thing that can own the
  // keyboard, and it is not a row in a list — so it is named apart even
  // though it goes through the same editingSection machinery.
  readonly property bool editingNote: root.editingSection === "note"

  // Which destructive row is waiting for its second press, by key, rather than
  // one boolean per row: there are two of them now (restore the settings,
  // restore the drinks) and they live on different pages, so at most one can
  // ever be armed and the state is naturally a name.
  property string armedKey: ""

  // The rows, in the order you came to change them (D85).
  //
  // Your drinks first, because that is the errand: it is the thing people most
  // want to play with, and "s" then Space now lands straight in the drinks
  // editor — a two-keystroke route to the page the settings are usually opened
  // for. Then the three numbers the verdict is computed from, in the order the
  // verdict uses them, with the profile directly under the half-life it
  // derives (which is where D34 already put it). Then the two rows that are
  // about how the panel *looks* rather than what it computes. Then the
  // destructive one, last, where it has always been.
  //
  // Reordering this list is safe and must stay safe: closeCatalog and
  // closeProfile find the row to return the cursor to **by key**, not by
  // index. Do not "fix" those searches into a constant.
  readonly property var settingRows: {
    var rows = [
      { key: "drinks", kind: "page",
        label: "Your drinks",
        description: "Add, re-price, remove and reorder the drinks you log. The first "
          + Presets.MAIN_ROW_SIZE + " are the row on the panel, and the numbers follow the order." },
      { key: "bedtime", kind: "clock",
        label: "Bedtime",
        description: "Everything the panel says about sleep is measured back from this. 23:00 or 11:00 PM both work." },
      { key: "sleepThresholdMg", kind: "number",
        min: Caffeine.SLEEP_THRESHOLD_MIN_MG, max: Caffeine.SLEEP_THRESHOLD_MAX_MG,
        step: Caffeine.SLEEP_THRESHOLD_STEP_MG,
        // D109 renames it. "below" described the comparison and left the noun
        // out, so the row read as a fragment beside "Bedtime" and "Daily cap";
        // it is also the row `t` jumps to, and a first-letter shortcut wants
        // the first letter to be on a word that means something.
        label: "Sleep-friendly threshold",
        description: "What counts as clear at bedtime. Twice this is the borderline band. Stated in milligrams, like the trials it comes from." },
      { key: "halfLifeHours", kind: "number",
        min: Caffeine.HALF_LIFE_MIN_HOURS, max: Caffeine.HALF_LIFE_MAX_HOURS, step: 1,
        label: "How long caffeine lasts in you",
        // Which of the two numbers is live, in the line that already explains
        // the row — and naming the other one, so the offer to swap is never a
        // figure you have to open another page to find out. The value pill
        // shows hours and nothing else: "7.4 hours · profile" is a unit and a
        // provenance in one control, and the pill is measured off its widest
        // value.
        description: root.halfLifeIsCustom
          ? "The half-life the whole estimate rests on. Set by hand — your profile estimates "
            + Caffeine.formatHalfLife(root.derivation.hours) + "."
          : "The half-life the whole estimate rests on. Estimated from your profile; ‹ › or ↵ sets it by hand instead." },
      // D34, and D49's rule about where a long list of rows goes: five
      // questions plus the arithmetic they produce is a page, not five more
      // rows on this one. It sits directly under the half-life it derives,
      // because that is the number it is about and the row above is where you
      // would look.
      { key: "profile", kind: "page",
        label: "Your profile",
        description: "Five questions that estimate the half-life above. Clearance, smoking, the pill, pregnancy, heavy drinking." },
      { key: "units", kind: "choice",
        // D109. "Show amounts in" needed the sentence under it to finish the
        // phrase; this one is a whole label, and it is what `u` jumps to.
        label: "Show units as",
        // "of a size you set" rather than "you set below", because the row
        // that sets it is only on screen while this one says cups — the same
        // shape as the cap and its value row, and the same trap.
        description: "Milligrams, or cups of a size you set. Clicking any number on the panel flips this too." }
    ]
    // D84's cup, **directly under the unit it defines** and only while that
    // unit is showing — the precedent is dailyCapMg, which appears only once
    // its switch is on. A control for a unit you are not using is a question
    // nobody asked, and it would also be the only row on the page whose value
    // pill contradicts every other one.
    //
    // **D98 is what makes "directly" true.** This comment has claimed it since
    // D84 and it was not: D89 landed `barNumber` between the two, correctly by
    // D85's ordering rule and without noticing that "beside the unit row" had
    // an occupant. The rule worth stating is that **a row that only exists
    // because of the row above it is part of that row**, so it is pushed
    // before anything else that merely belongs nearby.
    if (root.units === Caffeine.UNITS_CUPS) {
      rows.push({ key: "cupMg", kind: "number",
        min: Caffeine.CUP_MIN_MG, max: Caffeine.CUP_MAX_MG, step: 5,
        label: "A cup is",
        // No volume, on purpose: a cup here is a unit of caffeine and naming
        // a millilitre figure invites the comparison it cannot win. The
        // Coffee preset is named because it is the number this used to be,
        // and because saying they differ is the point of the change.
        description: "An arbitrary round figure for the unit rather than a measured serving — the shipped Coffee preset is "
          + Presets.mgFor("coffee") + " mg and stays there." })
    }
    // D89, and D85's order puts it here: it is about how a surface *looks*
    // rather than what the panel computes, so it belongs near the unit row and
    // not among the three numbers the verdict is built from. **Near, and not
    // beside** — since D98 the cup row is what sits beside the unit, because
    // the unit is what spawns it.
    //
    // The description has to say where the number still is when it is off,
    // because a user who hides a number and then cannot find it has been
    // given a worse panel rather than a quieter one — and it is in two
    // places already, the mark's tooltip and this panel's own first line.
    rows.push({ key: "barNumber", kind: "choice",
      label: "The number on the bar",
      description: "Beside the cup: always, never, or while it is still climbing after a drink"
        + " (about " + Math.round(Caffeine.barNumberWindowSeconds(root.halfLifeHours) / 60)
        + " minutes at your half-life). The bar's tooltip and this panel's"
        + " first line always state it." })
    rows.push({ key: "dailyCapEnabled", kind: "switch",
      label: "Show the day's total against a cap",
      // The pregnancy note lands here as well as on the cap's own row,
      // because the cap is off by default (D28) and a note on a row that
      // only exists once you have turned it on is a note nobody reads.
      description: "Informational only. Nothing changes when you cross it."
        + (root.isPregnant ? "  " + Caffeine.formatPregnancyCapNote(root.units, root.cupMg) : "") })
    if (root.capShown) {
      rows.push({ key: "dailyCapMg", kind: "number",
        min: Caffeine.DAILY_CAP_MIN_MG, max: Caffeine.DAILY_CAP_MAX_MG, step: 50,
        label: "Daily cap",
        // The one place a profile answer changes a *second* setting, and it is
        // a note rather than a write: the science notes say the two compound —
        // a 200 mg day sits on top of a 10-15h half-life — and D34's rule that
        // the profile offers rather than imposes covers this as much as it
        // covers the half-life.
        description: root.isPregnant
          ? Caffeine.formatPregnancyCapNote(root.units, root.cupMg)
            + " For other healthy adults it is " + root.amountTextOf(Caffeine.DAILY_CAP_DEFAULT_MG) + "."
          : "400 mg is the figure health authorities use for healthy adults." })
    }
    // D51. The only row on this page that is about the panel rather than
    // about caffeine, so it sits below everything that changes a number and
    // above the restore.
    rows.push({ key: "quietPanel", kind: "switch",
      label: "Quiet panel",
      description: "Folds the key line and the estimate note away under every page. "
        + "Both move into the ? card, and \u201c? help\u201d stays on the line so there is "
        + "always a way back to them." })
    // ------------------------------------------------------------- D105
    //
    // **Three rows where the user asked for one, and the extra two are the
    // argument rather than scope creep.** The literal ask was a start-time row
    // and a key, with the mode itself persisted and unnamed. But a mode
    // reachable only by a key nobody has met is a mode nobody finds; every
    // other "how a surface looks" answer on this page is a row (D85, D89); and
    // D98 gave the pair its shape one phase ago — **a row that only exists
    // because of the row above it is part of that row**, so it is pushed
    // directly under it rather than merely nearby. So the framing is a choice
    // row, the start time appears under it the moment a framing needs one, and
    // the end time appears under *that* only for the framing that has two.
    //
    // The page therefore grows by one row for anybody who leaves the setting
    // alone, which is the cost, and it is what buys the mode a way in that is
    // not "press an unlabelled letter".
    //
    // **Where they sit is a mild break with D85 and it is noted rather than
    // corrected.** D85 orders this page by errand — the drinks, then the three
    // numbers the verdict is computed from, then how the panel looks, then the
    // destructive row last. By that rule these three belong beside the unit
    // row and the bar's number, four rows further up, and by D51's own comment
    // ("the only row about the panel rather than about caffeine, so it sits
    // below everything that changes a number and above the restore") they
    // belong beside Quiet panel.
    //
    // They are **directly above Restore defaults**, which is where the user put
    // them, word for word — and the first build of this put them above Quiet
    // panel instead, which is the tidier reading and is not what was asked.
    // The render is what caught it. An ordering rule is a rule about where a
    // reader would look for something, which is exactly the kind of rule the
    // person who opens this page daily gets to overrule.
    rows.push({ key: "chartFrame", kind: "choice",
      label: "How the chart is framed",
      // D108. The answer you chose, not the menu — this was the one row on
      // the page describing its options rather than its value, under a pill
      // that already names the value.
      description: Caffeine.formatFrameDescription(
        root.frame, root.dayStartLabel, root.dayEndLabel) })
    if (root.anchoredFrame) {
      rows.push({ key: "dayStart", kind: "clock",
        label: "The chart starts at",
        description: "Where your day begins, and what the curve, the note key and the"
          + " day's total all count from. 7:00 or 7 AM both work." })
    }
    if (root.frame === Caffeine.FRAME_HOURS) {
      rows.push({ key: "dayEnd", kind: "clock",
        // Said here because it is the one framing that can leave the present
        // off the chart, and a user who meets that at 2am without having been
        // told will read it as the panel being broken.
        description: "Where it stops. Set it to the start time for a whole day. Between"
          + " this and the start time nothing is on the chart, so \u201ct\u201d then shows the"
          + " day you have just finished.",
        label: "The chart ends at" })
    }
    rows.push({ key: "restore", kind: "action",
      label: "Restore defaults",
      description: "Forgets every setting on this page, your profile, and every change to your drinks." })
    return rows
  }

  function settingRow(index) {
    return root.settingRows[index] || null
  }

  // D27's funnel applies here too — with one exception, and it is the same
  // exception D27 already carries for the strong-dose line rather than a new
  // one. The rule that separates them: **a number the panel shows you
  // somewhere else must read in the same unit there and here.**
  //
  // The daily cap is shown, on the "220 / 400 mg today" line, and it converts
  // there, so it converts here. The sleep threshold is never shown anywhere —
  // it is only ever implied, by which colour the verdict came out — and it is
  // a figure read off dose x hours-before-bed trials, like the 100 mg line.
  // So it stays in milligrams, and the render is what decided it: at one
  // decimal (D27) a cup is 95 mg, so a 5 mg step moves the displayed value on
  // roughly one press in two. Stepping 50 -> 55 -> 60 rendered
  // "0.5 -> 0.6 -> 0.6 cups", and a control that appears not to respond to
  // half its presses is worse than one number in an honest unit.
  function settingValueText(row) {
    if (!row) return ""
    if (row.key === "bedtime")
      return root.clockOf(Caffeine.bedtimeSeconds(root.nowSeconds, root.bedtimeText))
    // Through the formatter and not concatenated: the custom value is a whole
    // number and the derived one is not, and "7.350000000000001 hours" is what
    // a binding prints if it adds a string to the second kind.
    if (row.key === "halfLifeHours") return Caffeine.formatHalfLife(root.halfLifeHours)
    if (row.key === "sleepThresholdMg") return Caffeine.formatMg(root.sleepThresholdMg)
    if (row.key === "chartFrame") return Caffeine.frameName(root.frame)
    // Through the panel's own clock formatter, like the bedtime above it, so
    // all three clocks on this page read in whichever convention the machine
    // renders rather than in the 24-hour form the file stores.
    if (row.key === "dayStart")
      return root.clockOf(Caffeine.previousClockSeconds(root.nowSeconds, root.dayStartText))
    if (row.key === "dayEnd")
      return root.clockOf(Caffeine.previousClockSeconds(root.nowSeconds, root.dayEndText))
    if (row.key === "units") return Caffeine.unitName(root.units)
    if (row.key === "barNumber") return Caffeine.barNumberName(root.barNumber)
    if (row.key === "dailyCapEnabled") return root.capShown ? "On" : "Off"
    if (row.key === "quietPanel") return root.quiet ? "On" : "Off"
    if (row.key === "dailyCapMg") return root.amountTextOf(root.capMg)
    // D84, and it is the one number on this page that must NOT go through
    // amountTextOf: it is the definition of the cups unit, so rendering it in
    // cups would print "1 cup" for every possible value.
    if (row.key === "cupMg") return Caffeine.formatMg(root.cupMg)
    if (row.key === "drinks")
      return root.catalogPresets.length + (root.catalogPresets.length === 1 ? " drink" : " drinks")
    // The count and not the hours: the hours are in the pill immediately
    // above, and the same number twice on adjacent rows reads as one of them
    // being wrong.
    if (row.key === "profile")
      return root.profileAnswered === 0
        ? "Not set"
        : root.profileAnswered + (root.profileAnswered === 1 ? " answer" : " answers")
    if (row.key === "restore") return root.armedKey === "restore" ? "Confirm" : "Restore"
    return ""
  }

  // What the editor starts with. The clock seeds from the rendered value so
  // the field agrees with the line it replaced; a number seeds bare, because
  // "5 hours" is not something you would want to have to retype around.
  function settingEditSeed(row) {
    if (!row) return ""
    if (row.kind === "clock") return root.settingValueText(row)
    // Whole hours, because that is what the field will accept back: typing is
    // the gesture that makes the value custom, and a custom half-life is an
    // integer. A derived 7.4 seeds as 7 rather than as something the commit
    // would silently round.
    if (row.key === "halfLifeHours") return String(Math.round(root.halfLifeHours))
    if (row.key === "sleepThresholdMg") return String(root.sleepThresholdMg)
    if (row.key === "dailyCapMg") return String(root.capMg)
    if (row.key === "cupMg") return String(root.cupMg)
    return ""
  }

  // The typed value, or null if it does not parse. Null is what stops the
  // commit — a settings field that quietly stores 23:00 because it could not
  // read "quarter past" is worse than one that refuses.
  function settingParse(row, text) {
    if (!row) return null
    if (row.kind === "clock") {
      var clock = Caffeine.parseClockStrict(text)
      return clock === null ? null : Caffeine.sanitizeBedtime(text)
    }
    if (row.kind === "number") {
      var trimmed = String(text).trim()
      if (trimmed === "" || !/^[0-9]+(\.[0-9]+)?$/.test(trimmed)) return null
      var value = Math.round(Number(trimmed))
      if (value < row.min || value > row.max) return null
      return value
    }
    return null
  }

  function settingWrite(key, value) {
    if (root.config) root.config.set(key, value)
  }

  // ‹ › on any row. The clock steps by the same quarter hour the dose nudge
  // uses, so the two pages of this panel do not have two different ideas of
  // what one press of › is worth.
  function adjustSetting(index, direction) {
    var row = root.settingRow(index)
    if (!row) return
    if (row.kind === "clock") {
      // Every clock on this page steps by the same quarter hour, which is the
      // dose nudge's step — so the panel does not have two ideas of what one
      // press of a chevron is worth. Written over `row.key` rather than as
      // three branches because the three are the same control.
      var clock = row.key === "bedtime" ? root.bedtimeText
        : (row.key === "dayStart" ? root.dayStartText : root.dayEndText)
      root.settingWrite(row.key,
        Caffeine.shiftClock(clock, direction * Caffeine.NUDGE_MINUTES))
    } else if (row.key === "chartFrame") {
      // Three answers, so ‹ › steps the way it was pressed rather than
      // toggling — barNumber's shape. It wraps where barNumber stops, because
      // the `d` key is a cycle through the same three and a row that stopped
      // would disagree with the key about what "next" is.
      root.stepFrame(direction)
    } else if (row.kind === "number") {
      var current = row.key === "halfLifeHours" ? root.halfLifeHours
        : (row.key === "sleepThresholdMg" ? root.sleepThresholdMg
           : (row.key === "cupMg" ? root.cupMg : root.capMg))
      // Rounding toward the press rather than to nearest, because since Phase
      // 10 one of these three values can be fractional: a derived 7.4 stepped
      // down through Math.round lands on 6 and skips the 7 the arrow was
      // pointing at. This is D46's own complaint — a control that appears not
      // to answer a press — reaching a second control by a different route.
      var from = direction < 0 ? Math.ceil(current) : Math.floor(current)
      var next = Math.max(row.min, Math.min(row.max, from + direction * row.step))
      if (next !== current) root.settingWrite(row.key, next)
    } else if (row.key === "barNumber") {
      // Three answers, so ‹ › cannot be the toggle Enter is on a pair: it has
      // to step the way it was pressed. The profile page's `cycleAnswer` is
      // the same gesture on the same shape of value, and this stops at both
      // ends rather than wrapping into an answer nobody chose.
      root.stepBarNumber(direction)
    } else if (row.kind === "choice" || row.kind === "switch") {
      root.activateSetting(index)
    }
  }

  // ------------------------------------------------------------- D109
  //
  // **Nine letters, each landing the cursor on one row, and none of them
  // written down anywhere the user can see.** That is the ask, taken with its
  // collision with D40 stated (see `Caffeine.SETTINGS_JUMPS`).
  //
  // **By key, never by index** — the same rule `closeCatalog` and
  // `closeProfile` already follow, and the same comment applies: the row list
  // is deliberately reorderable, and a constant here would break silently the
  // next time somebody moves a row. It also handles the case that makes the
  // search necessary rather than merely tidy: `cupMg` is on the page only in
  // cups and `dailyCapMg` only once the cap is switched on, so **a jump whose
  // row is not currently on screen must do nothing** rather than land the
  // cursor on -1.
  //
  // **It guards against firing mid-edit itself, and the first version did not
  // — on the argument that it did not have to.** `PanelKeyCatcher` is
  // `blocked: root.editingSetting` and returns before emitting `textKey`, so
  // the real keyboard cannot reach this function while a field is open. That
  // is true, and it was still the wrong place to leave it, for two reasons the
  // check found rather than the reasoning:
  //
  // 1. **The dev IPC calls `handleTextKey` directly and the catcher is not in
  //    that path.** Typing "10:30pm" through it walked the cursor to the
  //    profile row on the "p" — the exact failure this was supposed to be
  //    immune to. The keyboard was safe; the *harness* was not, and the
  //    harness is how every check in this project drives the panel. A feature
  //    whose safety cannot be reproduced through the harness is one nobody
  //    can re-verify.
  // 2. Safety that lives in a property set seventeen hundred lines away is
  //    safety the next reader of this function cannot see.
  //
  // So the condition is here as well, and the cost is one line. Note what is
  // actually at stake: `parseClockStrict` accepts "10:30pm", so an unguarded
  // page would turn a perfectly ordinary bedtime into a page change.
  //
  // **Four letters now mean different things on the two pages** — `d` is the
  // framing here and Your drinks there, `p` is the pin and Your profile, `t`
  // is back-to-today and the threshold, `n` is write-a-note and the bar's
  // number. That is allowed by the rule this panel has always used, which is
  // that each page's own card is true of that page, and it is written down
  // once here rather than four times where the letters are.
  function jumpToSetting(text) {
    if (root.editingSetting) return false
    var wanted = Caffeine.settingsJumpFor(text)
    if (wanted === "") return false
    for (var i = 0; i < root.settingRows.length; i++) {
      if (root.settingRows[i].key === wanted) {
        root.setCursor("settings", i)
        // **The two page rows open, and the other seven only highlight**,
        // which is the ask read literally rather than made uniform: `b` was
        // asked for as "it goes to bedtime entry, so that entry gets
        // highlighted", and `d` and `p` as "takes you there" and "your profile
        // pane". The difference is in the rows, not in the keys — a row with a
        // value has something to do once you are on it (`‹ ›`, `↵`), and a
        // page row's only action is to open, so landing on one and stopping is
        // half a gesture.
        //
        // It costs nothing to be wrong about: `closeCatalog` and
        // `closeProfile` both return the cursor to the row that opened them,
        // so Esc puts you exactly where a highlight-only jump would have left
        // you. And it is what makes `s d` a two-keystroke route into the drink
        // editor, which is the thing D85 already claims for `s` then Space.
        if (root.settingRows[i].kind === "page") root.activateSetting(i)
        return true
      }
    }
    return false
  }

  function activateSetting(index) {
    var row = root.settingRow(index)
    if (!row) return
    if (row.kind === "clock" || row.kind === "number") {
      root.startEditing("settings", index)
    } else if (row.kind === "page") {
      if (row.key === "profile") root.openProfile()
      else root.openCatalog()
    } else if (row.key === "chartFrame") {
      root.stepFrame(1)
    } else if (row.key === "units") {
      root.toggleUnits()
    } else if (row.key === "barNumber") {
      // Enter is the next answer along, which is what it is on every other
      // short list in this plugin — the profile's questions, the units pair.
      root.stepBarNumber(1)
    } else if (row.key === "dailyCapEnabled") {
      root.settingWrite("dailyCapEnabled", !root.capShown)
    } else if (row.key === "quietPanel") {
      root.settingWrite("quietPanel", !root.quiet)
    } else if (row.key === "restore") {
      // Confirmed by pressing it again rather than by a dialog: there is
      // nothing a dialog would say that the row does not, and this page is
      // reachable by keyboard alone, where a dialog is another thing to
      // escape from. It disarms itself, so an armed row left alone is not a
      // trap for the next person who presses Enter.
      root.armAction("restore", function() { if (root.config) root.config.clear() })
    }
  }

  // Confirmed by pressing it again rather than by a dialog, and disarmed by a
  // timer so a row left armed is not a trap for the next person who presses
  // Enter. One function, because the catalog's restore has to behave exactly
  // like this one or the panel has two confirmation idioms.
  function armAction(key, action) {
    if (root.armedKey !== key) {
      root.armedKey = key
      restoreTimer.restart()
      return
    }
    root.armedKey = ""
    restoreTimer.stop()
    action()
  }

  Timer {
    id: restoreTimer
    interval: 4000
    onTriggered: root.armedKey = ""
  }

  function startEditing(section, index) {
    var row = root.rowAt(section, index)
    if (!row) return
    root.editingText = root.rowEditSeed(row)
    root.editingSection = section
    root.editingIndex = index
    Qt.callLater(function() {
      if (section === "note") {
        noteArea.focusEditor()
        return
      }
      var list = section === "catalog" ? catalogList
        : (section === "notes" ? notesList : settingsList)
      if (list) list.focusRow(index)
    })
  }

  function endEditing() {
    root.editingSection = ""
    root.editingIndex = -1
    root.editingText = ""
    Qt.callLater(function() { keyCatcher.forceActiveFocus() })
  }

  function commitEditing(text) {
    var row = root.rowAt(root.editingSection, root.editingIndex)
    if (!row) return
    // Refused rather than stored wrong. The field stays open in the urgent
    // colour, which is the only thing on screen that could tell you why.
    if (!root.rowCommit(row, text)) return
    root.endEditing()
  }

  // D36. Clicking any displayed amount flips the unit — the hero's number and
  // every dose row's. The settings row stays, because a setting you can only
  // reach by knowing a number is clickable is not a setting.
  function toggleUnits() {
    root.settingWrite("units",
      root.units === Caffeine.UNITS_CUPS ? Caffeine.UNITS_MG : Caffeine.UNITS_CUPS)
  }

  function stepBarNumber(direction) {
    var modes = Caffeine.BAR_NUMBER_MODES
    var at = modes.indexOf(root.barNumber)
    if (at < 0) at = 0
    var next = at + (direction < 0 ? -1 : 1)
    if (next < 0 || next >= modes.length) return
    root.settingWrite("barNumber", modes[next])
  }

  readonly property string unitsToggleHint:
    root.units === Caffeine.UNITS_CUPS ? "Show milligrams" : "Show cups"

  // ------------------------------------------------- the drink catalog (D31)
  //
  // A third page rather than more rows on the second one. The settings page is
  // seven rows and a hero already; a full catalog, an "add" row and a restore
  // put nearly forty rows on it, which is a scroll — and what scrolls off the
  // top is the hero, which is D47's whole argument for settings being in this
  // panel at all. So the catalog gets its own page, reached from the row that
  // counts the drinks, and the hero stays on top of that page too.
  //
  // Every edit here is a whole new catalog handed to the settings writer, so
  // nothing on this page holds a half-applied change: the file is the state,
  // the same way it is for every scalar setting.
  property bool showCatalog: false

  // What the add row is holding while it is being typed into. Kept apart from
  // the catalog so an unparseable line is never a drink.
  readonly property bool catalogFull: !Presets.canAdd(root.catalogPresets)

  readonly property var catalogRows: {
    var rows = []
    for (var i = 0; i < root.catalogPresets.length; i++) {
      rows.push({ key: "drink:" + root.catalogPresets[i].id, kind: "drink",
                  index: i, entry: root.catalogPresets[i] })
    }
    rows.push({ key: "add", kind: "add",
      label: root.catalogFull ? "That is the last slot" : "Add a drink",
      description: root.catalogFull
        ? Presets.CATALOG_MAX + " drinks is the most the list holds. Remove one to add another."
        : "A name and an amount: " + root.catalogAddExample
          + ". A serving detail goes in brackets." })
    if (root.config && root.config.drinksCustomised) {
      rows.push({ key: "drinks-restore", kind: "action",
        label: "Restore the shipped drinks",
        description: "Puts back the " + Presets.DEFAULTS.length
          + " drinks this plugin ships with, in their own order. Your log is not touched." })
    }
    return rows
  }

  // The example in the add row's description, in the unit the panel is showing
  // (D46): typing a bare number where cups are displayed means cups, so an
  // example in milligrams would be telling you to do the wrong thing.
  // D86 took the brand out of it. No shipped drink is branded, and an example
  // that names one reads as an endorsement in the one place the panel is
  // teaching you its own syntax — a flat white is the same lesson (a drink not
  // on the row, in two words) with nobody's name on it.
  //
  // Through amountTextOf rather than a second literal for cups, so the example
  // follows the cup size the user set (D84) instead of quoting a figure that
  // stopped being true when they moved it.
  readonly property string catalogAddExample:
    "Flat white " + root.amountTextOf(130)

  // ------------------------------------------------------ the icon picker
  //
  // D53's other half. Double-clicking a row was the ask, and this plugin has
  // been keyboard-reachable end to end since Phase 4 — and nothing on the
  // machine it is built on can click at all, which is why every render is
  // driven through the cursor. So the gesture is a key, and the picker is a
  // grid the same cursor walks.
  //
  // "i" rather than a second Enter on the row. Enter on a drink row opens the
  // amount editor, and a key whose meaning depends on how recently you last
  // pressed it is a key nobody can put in a legend — the catalog's footer
  // line would have had to say "↵ edit, ↵↵ icon", which is not a thing.
  //
  // It is a card over the panel and not a page, and that is D49 read the
  // right way round: a long list of rows gets a page, and twelve cells is not
  // a long list. It is also modal by nature — you are choosing *for* the row
  // the cursor is on, and a page would take that row off screen.
  property bool showIconPicker: false
  property int iconIndex: 0

  readonly property var iconChoices: Presets.ICONS
  readonly property int iconColumns: Presets.ICON_COLUMNS

  readonly property var iconTargetRow: root.showCatalog
    ? root.catalogRow(root.cursorIndex) : null
  readonly property bool canPickIcon:
    root.iconTargetRow !== null && root.iconTargetRow.kind === "drink"

  function openIconPicker() {
    if (!root.canPickIcon) return
    // Opens on the drink's own icon rather than at the top, so the card says
    // what this drink already carries before it offers to change it.
    root.iconIndex = Presets.iconIndexOf(root.iconTargetRow.entry.icon)
    root.showIconPicker = true
  }

  function closeIconPicker() {
    root.showIconPicker = false
  }

  function moveIconCursor(dx, dy) {
    var count = root.iconChoices.length
    var columns = root.iconColumns
    var at = root.iconIndex
    if (dx !== 0) {
      // Stops at the ends of a row rather than wrapping onto the next one: the
      // grid is a shape on screen, and a cursor that leaves the right edge and
      // reappears on the left has moved somewhere the eye did not follow.
      var column = at % columns
      var nextColumn = column + dx
      if (nextColumn < 0 || nextColumn >= columns) return
      var target = at + dx
      if (target >= 0 && target < count) root.iconIndex = target
      return
    }
    if (dy !== 0) {
      var down = at + dy * columns
      if (down >= 0 && down < count) root.iconIndex = down
    }
  }

  function chooseIcon() {
    if (!root.canPickIcon) { root.closeIconPicker(); return }
    var choice = root.iconChoices[root.iconIndex]
    root.writeCatalog(Presets.updateDrink(root.catalogPresets,
      root.iconTargetRow.entry.id, { icon: choice ? choice.icon : Presets.ICON_NONE }))
    root.closeIconPicker()
  }

  function catalogRow(index) {
    return root.catalogRows[index] || null
  }

  function writeCatalog(next) {
    if (!root.config) return
    root.config.setJson("drinks", next)
  }

  // ‹ › on a drink steps its amount — by 5 mg, or by a tenth of a cup when
  // cups are what the row is showing. That is D46 applied to a control this
  // phase invented: the amount is on screen here, so it converts here, and a
  // step finer than the display resolution is a control that looks broken.
  function stepDrink(index, direction) {
    var row = root.catalogRow(index)
    if (!row || row.kind !== "drink") return
    var next = Caffeine.stepAmount(row.entry.mg, direction, root.units,
      Presets.MG_MIN, Presets.MG_MAX, root.cupMg)
    if (next === row.entry.mg) return
    root.writeCatalog(Presets.updateDrink(root.catalogPresets, row.entry.id, { mg: next }))
  }

  // K and J, the same letters that move the cursor, shifted. They had to be
  // plain text keys through the stock PanelKeyCatcher (no modifiers, no fork),
  // and they had to not read as time: ‹ ›, - and + all mean "move this dose in
  // time" one page away, and "[ ]" and "{ }" are spoken for by the timeline.
  function moveDrink(index, direction) {
    var row = root.catalogRow(index)
    if (!row || row.kind !== "drink") return
    var to = row.index + direction
    if (to < 0 || to >= root.catalogPresets.length) return
    root.writeCatalog(Presets.moveDrink(root.catalogPresets, row.index, direction))
    // The cursor follows the drink rather than staying on the slot, or a
    // second press moves whichever drink has just been swapped into place.
    root.setCursor("catalog", to)
  }

  function removeDrink(index) {
    var row = root.catalogRow(index)
    if (!row || row.kind !== "drink") return
    if (root.catalogPresets.length <= 1) return
    if (root.editingSection === "catalog") root.endEditing()
    root.writeCatalog(Presets.removeDrink(root.catalogPresets, row.entry.id))
    root.setCursor("catalog", Math.max(0, Math.min(index, root.catalogRows.length - 2)))
  }

  function addDrink(text) {
    var parsed = Presets.parseDrinkEntry(text, root.cupMg,
      root.units === Caffeine.UNITS_CUPS)
    if (parsed === null) return false
    var next = Presets.addDrink(root.catalogPresets, parsed)
    if (next.length === root.catalogPresets.length) return false
    root.writeCatalog(next)
    // Land on what was just added, so the reorder keys act on it without
    // having to be aimed first.
    Qt.callLater(function() { root.setCursor("catalog", next.length - 1) })
    return true
  }

  function openCatalog() {
    root.showProfile = false
    root.showCatalog = true
    root.armedKey = ""
    restoreTimer.stop()
    root.setCursor("catalog", 0)
  }

  function closeCatalog() {
    if (root.editingSection === "catalog") root.endEditing()
    // Correction 28's rule, on the page that has just grown an overlay of its
    // own: a card left up here would reopen over a catalog whose cursor has
    // moved, pointed at a drink nobody chose it for.
    root.closeIconPicker()
    root.armedKey = ""
    restoreTimer.stop()
    root.showCatalog = false
    // Back to the settings page and onto the row that opened this one, rather
    // than to the top: Esc should put you where you were.
    var at = 0
    for (var i = 0; i < root.settingRows.length; i++)
      if (root.settingRows[i].key === "drinks") at = i
    root.setCursor("settings", at)
  }

  // ------------------------------------------------------- the profile (D34)
  //
  // A fourth page, for the same reason the catalog is a third one (D49): six
  // questions, each with a sentence of its own, plus the arithmetic they
  // produce, does not go inline under seven settings — and what would scroll
  // off the top is the hero, which is D47's whole argument for settings living
  // in this panel.
  //
  // What this page is for is the one input the whole model rests on. The
  // half-life was a bare 2-16 spinner asking a question almost nobody can
  // answer about themselves; this asks questions people can, and shows its
  // working. Every coefficient is in Caffeine.PROFILE_QUESTIONS with the row
  // of the science notes it came from cited beside it, and nothing here reads
  // as advice (D13) — the page states an estimate and says it is one.
  property bool showProfile: false

  // The questions are the engine's table, in the engine's order, so a factor
  // cannot exist in the model and be unaskable in the panel — or the reverse.
  readonly property var profileRows: {
    var rows = []
    for (var i = 0; i < Caffeine.PROFILE_QUESTIONS.length; i++) {
      var question = Caffeine.PROFILE_QUESTIONS[i]
      rows.push({ key: "profile:" + question.key, kind: "answer",
                  question: question,
                  label: question.label, description: question.description })
    }
    // The offer, and only when there is something to offer. D34: the profile
    // suggests and a value set by hand is never silently overwritten, so
    // swapping to the estimate is a row you press rather than a thing that
    // happens to you while you answer a question.
    if (root.halfLifeIsCustom) {
      rows.push({ key: "profile-apply", kind: "action",
        label: "Use this estimate",
        description: "Your half-life is set to " + Caffeine.formatHalfLife(root.halfLifeHours)
          + " by hand. This replaces it with the "
          + Caffeine.formatHalfLife(root.derivation.hours) + " above." })
    }
    if (root.config && root.config.profileCustomised) {
      rows.push({ key: "profile-restore", kind: "action",
        label: "Clear these answers",
        description: "Puts every question back to its neutral answer, which estimates "
          + Caffeine.formatHalfLife(Caffeine.HALF_LIFE_DEFAULT_HOURS) + "." })
    }
    return rows
  }

  function profileRow(index) {
    return root.profileRows[index] || null
  }

  // One answer changed, as a whole new profile handed to the settings writer —
  // the catalog's contract exactly, so no page of this panel ever holds a
  // half-applied edit.
  function cycleAnswer(index, direction) {
    var row = root.profileRow(index)
    if (!row || row.kind !== "answer" || !root.config) return
    root.config.setProfile(
      Caffeine.cycleProfile(root.profileAnswers, row.question.key, direction))
  }

  // The offer taken. It is an unset rather than a write: absent means the
  // profile is live, which is the same "absent means default" the whole
  // settings file runs on (D43) and the same delete that restores the drinks.
  function applyDerivedHalfLife() {
    if (!root.config) return
    root.config.unset("halfLifeHours")
    // D26's picker outranks the profile too, so a file still carrying one has
    // to give that up as well or the offer would appear to do nothing.
    if (root.config.values && root.config.values.metabolism !== undefined)
      root.config.unset("metabolism")
  }

  function openProfile() {
    root.showCatalog = false
    root.showProfile = true
    root.armedKey = ""
    restoreTimer.stop()
    root.setCursor("profile", 0)
  }

  function closeProfile() {
    root.armedKey = ""
    restoreTimer.stop()
    root.showProfile = false
    var at = 0
    for (var i = 0; i < root.settingRows.length; i++)
      if (root.settingRows[i].key === "profile") at = i
    root.setCursor("settings", at)
  }

  // ---------------------------------------------------- the noted days (D48)
  //
  // The review list, and it is the feature's payoff rather than a nice-to-
  // have: pressing Enter on a row takes the timeline to that day. That is what
  // makes this navigation instead of a diary, and it is why the page hangs off
  // the curve rather than off the settings — you land back on the chart with
  // the day drawn, not four Escs away from it.
  //
  // A page of its own for D49's reason, which the catalog settled a
  // phase-and-a-half ago: a long list of rows is a page, not more rows on
  // another one. It is the fifth, and it cost what Phase 10 said a fifth
  // costs — a model, a `kind`, and answers in the rowX() dispatchers. No new
  // QML file.
  property bool showNotes: false

  readonly property var notesRows: {
    var rows = []
    var list = root.noteEntries
    for (var i = 0; i < list.length; i++)
      rows.push({ key: "note:" + list[i].day, kind: "note", entry: list[i] })
    return rows
  }

  function notesRow(index) {
    return root.notesRows[index] || null
  }

  // What the plugin says about a noted day, and it says only what it logged.
  // D13 is the limit and it is not negotiable: no correlation, no score, no
  // average, no ranking, and nothing anywhere that reads "your data suggests".
  // The row states the day, what was logged on it, what that came to at that
  // day's bedtime, and then — quoted, and marked as not the plugin talking —
  // what you wrote.
  function noteSummary(entry) {
    if (!entry) return ""
    // A note outlives its doses; that is the whole reason notes.json is not a
    // field on doses.json. So a day whose drinks have aged into the archive
    // gets no total and no verdict, because computing them from a record that
    // has been thrown away would print "0 mg · clear for sleep" about a day
    // the plugin knows nothing about. D64's argument, moved to a row.
    if (!Caffeine.dayRecordKept(root.doses, entry.ts))
      return Caffeine.formatNoteExpired()
    var bed = Caffeine.dayBedtime(root.doses, entry.ts, root.halfLifeHours,
      root.bedtimeText, root.sleepThresholdMg)
    return Caffeine.formatNoteSummary(
      root.amountTextOf(Caffeine.dayTotalMg(root.doses, entry.ts)),
      root.amountTextOf(bed.mg), root.clockOf(bed.at),
      Caffeine.verdictFor(bed.band, false))
  }

  function noteDescription(entry) {
    if (!entry) return ""
    var written = entry.text === ""
      ? Caffeine.NOTE_EMPTY_TEXT
      : Caffeine.formatNoteText(entry.text)
    return root.noteSummary(entry) + "\n" + written
  }

  // The payoff. A pan and not a jump to an arbitrary second: the offset is a
  // whole number of days, which is D60's grid, so landing on a day leaves the
  // axis in exactly the positions it was in — and pinning what you land on is
  // then one more keypress, which is the whole "navigation, not a diary"
  // argument in D48.
  function goToNoteDay(index) {
    var row = root.notesRow(index)
    if (!row) return
    var days = Caffeine.daysApartLocal(row.entry.ts, root.nowSeconds)
    var wanted = -days * Caffeine.PAN_STEP_SECONDS
    var offset = Caffeine.clampPanOffset(wanted, root.doses, root.nowSeconds)
    // Clamped short means the day is past what the record can draw, and
    // landing somewhere near it would be the panel answering a different
    // question. The row already says why; doing nothing is the honest answer.
    if (offset !== wanted) return
    root.closeNotes()
    root.viewOffsetSeconds = offset
    root.resample()
  }

  function removeNoteRow(index) {
    var row = root.notesRow(index)
    if (!row || !root.notes) return
    root.notes.remove(row.entry.day)
    root.cursorIndex = Math.max(0, Math.min(root.cursorIndex, root.notesRows.length - 2))
  }

  function openNotes() {
    if (root.editingSetting) root.endEditing()
    root.showSettings = false
    root.showCatalog = false
    root.showProfile = false
    root.showNotes = true
    root.showAllPresets = false
    root.setCursor("notes", 0)
  }

  function closeNotes() {
    if (root.editingSetting) root.endEditing()
    root.showNotes = false
    root.setCursor("drinks", 0)
  }

  function toggleNotes() {
    if (root.showNotes) root.closeNotes()
    else root.openNotes()
  }

  // --------------------------------------------------- one row, either page
  //
  // The two editable pages render through the same list component, so a
  // setting and a drink are the same row with different answers to these
  // questions. Anything that reads `kind` is answering for both.

  function rowsOf(section) {
    if (section === "catalog") return root.catalogRows
    if (section === "profile") return root.profileRows
    if (section === "notes") return root.notesRows
    // The note line above the curve is not a list, but it owns the keyboard
    // the same way a row's editor does, so it answers to the same dispatchers
    // rather than growing a second editing mechanism beside them.
    if (section === "note") return [{ key: "note", kind: "note-edit" }]
    return root.settingRows
  }

  function rowAt(section, index) {
    var rows = root.rowsOf(section)
    return rows[index] || null
  }

  function rowLabel(row) {
    if (!row) return ""
    // D53. The glyph leads the name here and rides the *foot* of the pill on
    // the panel, and the asymmetry is the point: on an 88px pill the icon is
    // a mark you recognise instead of reading, so it goes where there is room;
    // on a full-width row it is the value you came here to change, so it goes
    // where you read.
    if (row.kind === "drink")
      return (row.entry.icon === Presets.ICON_NONE ? "" : row.entry.icon + "  ")
        + Presets.labelOf(row.entry)
    // The absolute date, because a review list is indexed by one: "Yesterday"
    // is unambiguous for one row and useless for the ninth. How far back it is
    // rides in the pill, where it is also what Enter is about to do (D61's
    // split, one page along — each mark says one thing).
    if (row.kind === "note") return root.dayNameOf(row.entry.ts)
    return row.label
  }

  // The line under the label. Most rows carry their own; a note's is built
  // from the record, so it is a function rather than a field.
  function rowDescription(row) {
    if (!row) return ""
    if (row.kind === "note") return root.noteDescription(row.entry)
    return row.description === undefined ? "" : row.description
  }

  function rowValueText(row) {
    if (!row) return ""
    if (row.kind === "drink") return root.amountTextOf(row.entry.mg)
    // The answer itself in the pill, not the multiplier: the multiplier is in
    // the arithmetic at the top of the page, where it is being added up, and
    // the pill is the control you are pointing at.
    if (row.kind === "answer") {
      var answer = Caffeine.profileAnswerFor(row.question,
        root.profileAnswers[row.question.key])
      return answer ? answer.label : ""
    }
    if (row.key === "profile-apply") return Caffeine.formatHalfLife(root.derivation.hours)
    if (row.key === "profile-restore") return root.armedKey === row.key ? "Confirm" : "Clear"
    if (row.kind === "add") return root.catalogFull ? Presets.CATALOG_MAX + " of " + Presets.CATALOG_MAX : "Add"
    if (row.key === "drinks-restore") return root.armedKey === row.key ? "Confirm" : "Restore"
    // Where Enter is about to take you, which is the one thing a note row's
    // control does. It is also the shortest true value the row has: the date
    // is already the label, and the two amounts are in the sentence under it.
    if (row.kind === "note")
      return Caffeine.formatDayOffset(row.entry.ts, root.nowSeconds)
    if (row.key === "notes")
      return root.noteEntries.length
        + (root.noteEntries.length === 1 ? " day" : " days")
    return root.settingValueText(row)
  }

  function rowEditSeed(row) {
    if (!row) return ""
    // Seeded with what is already written there, so writing a note and
    // rewriting one are the same gesture and there is no second key for edit.
    if (row.kind === "note-edit")
      return root.hasViewNote ? root.viewNote.text : ""
    // The amount seeds in the unit it is being shown in, and typeably: a 2 mg
    // decaf renders "<0.1 cups", which is the right thing to read and the
    // wrong thing to hand a text field.
    if (row.kind === "drink") return Caffeine.amountSeed(row.entry.mg, root.units, root.cupMg)
    if (row.kind === "add" || row.kind === "answer") return ""
    return root.settingEditSeed(row)
  }

  // Whether what is typed would be accepted, which is what draws the field in
  // the urgent colour while it would not be.
  function rowParses(row, text) {
    if (!row) return false
    // Nothing on the profile page is typed into: every question is a short
    // list of answers, and a text field would be a way to write one that is
    // not on the list.
    if (row.kind === "answer") return false
    // Anything is a valid note, including nothing: a day marked without words
    // is still a marked day (D65). The only thing that could be refused here
    // is length, and the sanitiser truncates rather than refusing, because a
    // field that will not accept your 501st character while you are still
    // typing is a control arguing with you.
    if (row.kind === "note-edit") return true
    if (row.kind === "drink") {
      var mg = Caffeine.parseAmountText(text, root.units, root.cupMg)
      return mg !== null && Presets.sanitizeMg(mg) !== null
        && Math.round(mg) >= Presets.MG_MIN && Math.round(mg) <= Presets.MG_MAX
    }
    if (row.kind === "add")
      return Presets.parseDrinkEntry(text, root.cupMg,
        root.units === Caffeine.UNITS_CUPS) !== null
    return root.settingParse(row, text) !== null
  }

  // True when the edit was taken. False leaves the field open, which is the
  // only thing on screen that can say the value was refused.
  function rowCommit(row, text) {
    if (!row) return false
    if (row.kind === "note-edit") return root.commitNote(text)
    if (row.kind === "drink") {
      if (!root.rowParses(row, text)) return false
      var mg = Caffeine.parseAmountText(text, root.units, root.cupMg)
      root.writeCatalog(Presets.updateDrink(root.catalogPresets, row.entry.id,
        { mg: Math.round(mg) }))
      return true
    }
    if (row.kind === "add") return root.addDrink(text)
    var value = root.settingParse(row, text)
    if (value === null) return false
    root.settingWrite(row.key, value)
    return true
  }

  function rowAdjust(section, index, direction) {
    var row = root.rowAt(section, index)
    if (!row) return
    if (row.kind === "drink") root.stepDrink(index, direction)
    else if (row.kind === "answer") root.cycleAnswer(index, direction)
    else if (row.kind === "note") return
    else if (section === "settings") root.adjustSetting(index, direction)
  }

  // D92. "a" opens the Add row's field, and the row is already reachable with
  // ↓ and ↵ — so this is a shortcut and not a capability, which is what makes
  // it cheap. It moves the cursor to the row and then activates it through the
  // row's own path (D40: a key and the control it drives are one function),
  // rather than calling startEditing itself and inventing a second way in that
  // would not know about a full catalog.
  //
  // Nothing collides: the catalog page takes ‹ › - + J K i s ?, and the drink
  // digits are deliberately not live there. While the field has the keyboard
  // PanelKeyCatcher.blocked is true and "a" types an "a", which is correct and
  // needs no guard.
  function startAddingDrink() {
    var at = root.catalogRowIndex("add")
    if (at < 0) return
    root.setCursor("catalog", at)
    root.rowActivate("catalog", at)
  }

  function catalogRowIndex(key) {
    for (var i = 0; i < root.catalogRows.length; i++)
      if (root.catalogRows[i].key === key) return i
    return -1
  }

  function rowActivate(section, index) {
    var row = root.rowAt(section, index)
    if (!row) return
    // Enter is the next answer along, which is the same thing › does. For a
    // two-answer question those are one gesture, and for the four-answer one
    // they are the same walk in the same direction — a page whose every row is
    // a short list has no second thing for Enter to mean.
    if (row.kind === "answer") {
      root.cycleAnswer(index, 1)
      return
    }
    if (row.kind === "note") {
      root.goToNoteDay(index)
      return
    }
    if (row.key === "profile-apply") {
      root.applyDerivedHalfLife()
      return
    }
    if (row.key === "profile-restore") {
      root.armAction(row.key, function() { if (root.config) root.config.unset("profile") })
      return
    }
    if (row.kind === "drink" || row.kind === "add") {
      if (row.kind === "add" && root.catalogFull) return
      root.startEditing(section, index)
    } else if (row.key === "drinks-restore") {
      root.armAction(row.key, function() { if (root.config) root.config.unset("drinks") })
    } else {
      root.activateSetting(index)
    }
  }

  function openSettings() {
    if (root.editingSetting) root.endEditing()
    root.showNotes = false
    root.showSettings = true
    root.showAllPresets = false
    root.showProfile = false
    root.setCursor("settings", 0)
  }

  function closeSettings() {
    if (root.editingSetting) root.endEditing()
    root.armedKey = ""
    restoreTimer.stop()
    root.showCatalog = false
    root.showProfile = false
    root.showSettings = false
    root.setCursor("drinks", 0)
  }

  function toggleSettings() {
    if (root.showCatalog) root.closeCatalog()
    else if (root.showProfile) root.closeProfile()
    else if (root.showSettings) root.closeSettings()
    else root.openSettings()
  }

  // ------------------------------------------------------- turning a page
  //
  // How far into the panel a page is, as one number, so the transition has a
  // direction rather than a list of special cases. The main page is the
  // surface; the settings and the noted days are one page in — the notes are
  // *not* two, because they hang off the curve rather than off the settings
  // (D49), and a page you reach with one key from the main page is one deep
  // whatever it is about. The catalog and the profile are two, because you
  // reach them through the settings page and Esc puts you back on it.
  readonly property int pageDepth: root.showCatalog || root.showProfile
    ? 2 : ((root.showSettings || root.showNotes) ? 1 : 0)

  // Which page is on screen, as one value. `pageDepth` cannot serve: the
  // catalog and the profile are both two deep, so a turn between them does not
  // change it. D97 needs the turn itself, because a page that arrives inside a
  // scrolled panel arrives scrolled — the offset belongs to the panel and not
  // to the page that left.
  readonly property string pageKey: root.showCatalog ? "catalog"
    : (root.showProfile ? "profile"
       : (root.showSettings ? "settings"
          : (root.showNotes ? "notes" : "main")))

  onPageKeyChanged: root.scrollHome()

  // The depth the stack was at last time, which is the only thing that says
  // which way it just went. Written by the transition, read by nothing else.
  property int lastPageDepth: 0

  // How far a page arrives from. Enough that the eye catches which way it
  // went, small enough that nothing on a 600px panel appears to travel — and
  // named here rather than written twice with a sign in front of it, because
  // the two directions are one distance.
  readonly property real pageTravel: Style.space(12)

  // ------------------------------------------------------------ the cursor
  //
  // One cursor, shared by mouse and keyboard, the way every first-party panel
  // does it: children paint from `hasCursor` and report hover upward rather
  // than painting their own, so there is never more than one highlight on
  // screen no matter which input is driving.
  //
  //   ← → / h l   walk the drink row          Enter / Space  log it
  //   ↑ ↓ / k j   move between sections       x              delete a dose
  //   - / +       move a dose back or on      m              more drinks
  //   Esc         close                       Tab            next panel

  // "drinks" | "doses" | "settings" | "catalog" | "profile" | "notes"
  //
  // D88 folded "presets" and "overflow" into one "drinks" section, because the
  // grid they draw is one grid and the "+ More" toggle is a cell of it. The
  // index of that section is a *slot* — a position in the grid — and not a
  // catalog position; `Presets.catalogIndexForSlot` is the only place the two
  // are converted, and it answers `null` for the toggle.
  property string cursorSection: "drinks"
  property int cursorIndex: 0

  // D82, and defect #8. The kit's answer to a problem this panel has had
  // since Phase 4 and could not see: every row reported hover upward, and a
  // row that *moves* under a stationary pointer reports it just as loudly as
  // a pointer that moves onto a row. So a K/J reorder, a delete, or anything
  // else that shifts a list would hand the cursor to whatever slid under the
  // mouse — with the pointer resting anywhere over the panel, the keyboard
  // could not keep hold of it.
  //
  // PointerMoveGate's own header names this symptom, and Clipboard.qml and
  // Menu.qml — both lists with a keyboard cursor, the same shape as this one
  // — already used it. Nothing on this machine can click and the pointer
  // cannot be moved from a script, which is why eleven phases of renders drove
  // the cursor from the keyboard and never had a pointer resting anywhere.
  //
  // The contract, from that header: reset() after any keyboard or list
  // mutation, then moved() before the cursor follows the pointer anywhere.
  PointerMoveGate {
    id: pointerGate
    // Something stationary that every row is inside, which is the whole
    // trick: row-local coordinates are exactly what a moving row changes, so
    // a parked pointer keeps one position *here* while the row under it
    // changes. The KeyboardPanel itself is not an Item, so this is the key
    // catcher that fills it — which also means a scroll of the page under a
    // resting pointer does not move the cursor either.
    referenceItem: keyCatcher
  }

  function disarmPointer() {
    pointerGate.reset()
  }

  function selectFromPointer(section, index, item, at) {
    if (!pointerGate.moved(item, at)) return
    root.setCursor(section, index)
  }

  function selectIconFromPointer(index, item, at) {
    if (!pointerGate.moved(item, at)) return
    root.iconIndex = index
  }

  // The settings page is a page, not a section of the main one: while it is up
  // it is the only thing the cursor can be in, so ↑↓ cannot walk out of it
  // into controls that are not on screen.
  readonly property var cursorSections: {
    if (root.showNotes) return ["notes"]
    if (root.showCatalog) return ["catalog"]
    if (root.showProfile) return ["profile"]
    if (root.showSettings) return ["settings"]
    // One section for the whole grid, open or shut: the overflow changes how
    // many *cells* it has, not how many sections there are.
    var out = ["drinks"]
    if (root.recentDoses.length > 0) out.push("doses")
    return out
  }

  function sectionLength(section) {
    if (section === "drinks") return root.drinkSlotCount
    if (section === "settings") return root.settingRows.length
    if (section === "catalog") return root.catalogRows.length
    if (section === "profile") return root.profileRows.length
    if (section === "notes") return root.notesRows.length
    return root.recentDoses.length
  }

  function setCursor(section, index) {
    var length = root.sectionLength(section)
    if (length <= 0) return
    root.cursorSection = section
    root.cursorIndex = Math.max(0, Math.min(length - 1, index))
  }

  function stepSection(delta) {
    root.stepFrom(root.cursorSection, delta)
  }

  // ------------------------------------------- keeping the cursor on screen
  //
  // **D97, and this is the half of that decision that is actually work.**
  // Until now this plugin had no scroll-into-view at all: `scroll` is a
  // Flickable with `interactive: contentHeight > height` and nothing anywhere
  // set `contentY`. It had never mattered, because the longest page there had
  // ever been was a thirteen-drink catalog that fits. Raising the cap to 29
  // makes it a defect the cap itself creates — `↓` walks the cursor below the
  // fold with nothing following it — so the number could not land without
  // this.
  //
  // The rule is the smallest one that works: **the view moves only when the
  // cursor would otherwise be off it**, and then only far enough. Centring the
  // cursor instead would move the page on every press, including the twenty
  // presses where nothing needed to move, and on a panel where the hero is the
  // thing you are watching change (D47) that is the wrong trade.
  //
  // A row reports itself when it *takes* the cursor rather than the panel
  // hunting for one: the delegates already know whether they have it
  // (`hasCursor: root.cursorOn(...)`), so this is one line per list and no
  // second model of where anything is. `Qt.callLater` because a cursor move
  // and the layout that answers it are not the same frame — a row that has
  // just appeared (the cap's value row, a page turn) has no geometry yet at
  // the moment its binding fires.
  readonly property real scrollY: scroll.contentY
  readonly property real scrollHeight: scroll.height
  readonly property real scrollContentHeight: scroll.contentHeight

  // Air above and below the row, so a followed cursor sits *on* the page
  // rather than welded to its edge — and so the row above or below it is
  // visible, which is what tells you there is more.
  readonly property real followMargin: Style.spacing.lg

  function followCursor(item) {
    if (!item) return
    Qt.callLater(function() { root.scrollInto(item) })
  }

  function scrollInto(item) {
    if (!item || !item.visible || scroll.height <= 0) return
    var slack = scroll.contentHeight - scroll.height
    if (slack <= 0) {
      scroll.contentY = 0
      return
    }
    // The first cell of the first section goes all the way home rather than
    // far enough, and **that is D47 rather than tidiness**. Minimal movement
    // leaves the top row welded to the top edge with the hero scrolled off
    // above it — and the hero is the whole argument for settings living in
    // this panel: you move the sleep threshold and watch the verdict change
    // under it. A page whose top row is on screen and whose hero is not has
    // taken that away. Nothing is above the first row but the hero and the
    // page's own header, so there is nothing to lose by showing them.
    if (root.cursorIndex === 0 && root.cursorSection === root.cursorSections[0]) {
      scroll.contentY = 0
      return
    }
    // And the last cell of the last section goes all the way to the end, for
    // the mirror of the same reason: what is below it is not another row, it
    // is the footer legend and the estimate note — the line that says how to
    // get out, and the disclaimer D13 requires. Minimal movement stops with
    // both of them a few pixels off the bottom, which is the one place they
    // are worth having.
    var sections = root.cursorSections
    if (root.cursorSection === sections[sections.length - 1]
        && root.cursorIndex === root.sectionLength(root.cursorSection) - 1) {
      scroll.contentY = slack
      return
    }
    // `pages` is the Flickable's own content item, so a position in it is a
    // position in `contentY`'s coordinates with no conversion.
    var top = item.mapToItem(pages, 0, 0).y - root.followMargin
    var bottom = top + item.height + root.followMargin * 2
    var target = scroll.contentY
    if (top < target) target = top
    else if (bottom > target + scroll.height) target = bottom - scroll.height
    scroll.contentY = Math.max(0, Math.min(slack, target))
  }

  // A page turn starts at the top of the new page. Without this a scrolled
  // drinks page hands the settings page its own offset, which is correction
  // 28's rule in the one place a page cannot reset for itself: the scroll
  // belongs to the panel, not to any page in it.
  function scrollHome() {
    scroll.contentY = 0
  }

  // D81's problem, and D88 dissolved it: leaving the drinks downward used to
  // have to leave from the *last* of two drink sections rather than from
  // whichever one the cursor was in, because stepping one section along from
  // "presets" meant "overflow" — a section that is not always on screen. There
  // is one drink section now, so a step out of it is a step out of the grid.
  function stepFrom(section, delta) {
    var sections = root.cursorSections
    var at = sections.indexOf(section)
    if (at < 0) at = 0
    var next = at + delta
    if (next < 0 || next >= sections.length) return
    root.setCursor(sections[next], 0)
  }

  // ---------------------------------------------------------- the drink grid
  //
  // D88, amending D81. One cursor section over one grid, and its index is the
  // *slot*: the cell the grid draws, counting row-major from the first drink,
  // with the "+ More" toggle sitting at `mainPresets.length`. Every row is
  // `presetColumns` wide with no exception, which is the special case D81 had
  // to carry and this deletes.
  //
  // The digits still count down the *catalog* (D32), so past the toggle a slot
  // and a catalog position differ by one. That conversion is written once, in
  // `Presets.catalogIndexForSlot`, and nowhere else.
  readonly property bool cursorInDrinks: root.cursorSection === "drinks"

  readonly property int drinkSlotCount: Presets.drinkSlotCount(
    root.mainPresets.length, root.overflowPresets.length, root.showAllPresets)

  // Shutting the overflow takes cells away underneath the cursor. The section
  // itself has not changed, so `onCursorSectionsChanged` never fires and the
  // clamp there cannot help — correction 16's shape, one binding along.
  onDrinkSlotCountChanged: {
    if (root.cursorSection === "drinks" && root.cursorIndex >= root.drinkSlotCount)
      root.setCursor("drinks", root.drinkSlotCount - 1)
  }

  function setDrinkCursor(slot) {
    root.setCursor("drinks", slot)
  }

  function moveDrinkCursor(dx, dy) {
    var next = Presets.drinkGridMove(root.drinkSlotCount, root.cursorIndex,
      dx, dy, root.presetColumns)
    if (next === null) root.stepFrom("drinks", dy > 0 ? 1 : -1)
    else root.setDrinkCursor(next)
  }

  function moveCursor(dx, dy) {
    // Every one of these five is the keyboard, or the IPC standing in for it.
    // Disarming here rather than at each mutation is what makes the rule
    // cheap to keep: a key was pressed, so the pointer is not driving.
    root.disarmPointer()
    if (root.showIconPicker) {
      root.moveIconCursor(dx, dy)
      return
    }
    // Settings are a column with a control on each row, so the two axes do
    // different jobs: ↑↓ picks the setting, ‹ › changes it. There is nowhere
    // to walk off to, so both ends stop rather than wrapping into a section
    // that is not on screen.
    if (root.cursorSection === "settings" || root.cursorSection === "catalog"
        || root.cursorSection === "profile" || root.cursorSection === "notes") {
      if (dy !== 0) {
        var target = root.cursorIndex + dy
        if (target >= 0 && target < root.sectionLength(root.cursorSection))
          root.cursorIndex = target
      } else if (dx !== 0) {
        root.rowAdjust(root.cursorSection, root.cursorIndex, dx > 0 ? 1 : -1)
      }
      return
    }
    // The drinks are one grid across two sections (D81), so they answer both
    // axes in one place rather than falling through to a section step that
    // threw the column away.
    if (root.cursorInDrinks) {
      root.moveDrinkCursor(dx, dy)
      return
    }
    // Doses are a column, so vertical movement walks the rows themselves and
    // only leaves the section once it runs off the top.
    if (root.cursorSection === "doses" && dy !== 0) {
      var target = root.cursorIndex + dy
      if (target >= 0 && target < root.recentDoses.length) root.cursorIndex = target
      // Into the drinks at the row they end on, not at the row they start on:
      // the grid is entered from the edge you arrived at, which is the same
      // rule D81 fixed for leaving it.
      else if (dy < 0) root.setDrinkCursor(
        Presets.drinkGridLastRowStart(root.drinkSlotCount, root.presetColumns))
      return
    }
    // Only the dose list reaches here, and only sideways: every other section
    // answered both axes above. Along a column ← → is the same walk ↑ ↓ is,
    // which is what makes h l and j k interchangeable there.
    if (dx !== 0) root.setCursor(root.cursorSection, root.cursorIndex + dx)
  }

  function activateCursor() {
    root.disarmPointer()
    if (root.showIconPicker) {
      root.chooseIcon()
      return
    }
    if (root.cursorSection === "settings" || root.cursorSection === "catalog"
        || root.cursorSection === "profile" || root.cursorSection === "notes")
      root.rowActivate(root.cursorSection, root.cursorIndex)
    else if (root.cursorSection === "drinks") {
      // D88: the toggle is a cell of the grid, so ↵ on it does what `m` does.
      // Same function, not a second path — D40's rule that a key and the
      // control it drives are one thing, applied to a control that now has
      // two ways in.
      var at = Presets.catalogIndexForSlot(root.cursorIndex, root.mainPresets.length)
      if (at === null) root.showAllPresets = !root.showAllPresets
      else root.logPreset(root.catalogPresets[at])
    }
  }

  function deleteCursor() {
    root.disarmPointer()
    // On the catalog page the same key removes the highlighted drink. It is
    // the same gesture on the same kind of list, and the ✕ at the row's
    // trailing edge is the same button the dose rows carry.
    if (root.cursorSection === "catalog") {
      root.removeDrink(root.cursorIndex)
      return
    }
    // And the same key removes a note. Curating the list is done on the page
    // that is the list — the catalog's arrangement exactly, so removal is one
    // gesture in one kind of place rather than a key that means something
    // different depending on which page is up.
    if (root.cursorSection === "notes") {
      root.removeNoteRow(root.cursorIndex)
      return
    }
    if (root.cursorSection !== "doses" || !root.store) return
    var entry = root.recentDoses[root.cursorIndex]
    if (!entry) return
    root.store.removeAt(entry.index)
    // The list shortens under the cursor, so pull it back rather than leaving
    // it pointing past the end.
    root.cursorIndex = Math.max(0, Math.min(root.cursorIndex, root.recentDoses.length - 2))
    if (root.recentDoses.length <= 1) root.setCursor("drinks", 0)
  }

  // ------------------------------------------------------------ D113
  //
  // **The other half of `x`, and it exists because the first half was shipped
  // without it.** The report: a drink logged, deleted, and then two more taken
  // by the same keypress held a beat too long — after which the only way back
  // was remembering when those two had been and typing them in again. Every
  // ingredient of that is this panel's own doing. `x` is one press with no
  // confirmation (correctly — a dialog on every delete is worse), the rows it
  // walks are eight pixels apart, and key repeat is the shell's, not ours.
  //
  // So the fix is not a guard on the delete. A confirmation would tax the
  // hundreds of correct deletions to catch the rare wrong one, and an
  // auto-repeat lockout would make a key that works feel broken. The fix is
  // that the mistake stops being expensive: `u`, as many times as `x` was
  // pressed, and the log is as it was.
  function undoDelete() {
    root.disarmPointer()
    if (!root.store) return
    var back = root.store.undoDelete()
    if (!back) return
    // Onto the row that came back, by the same re-find a nudge uses (D20).
    // The log re-sorted on the way in, so the restored dose is at its own
    // timestamp rather than at the top of the list, and a cursor left where it
    // was would now be pointing at whatever slid into the empty slot.
    //
    // It is also the only thing on screen that says the undo worked. There is
    // no toast in this plugin and this is not the phase to invent one — the
    // row reappearing under a cursor that moved to meet it is the panel
    // answering in the same register it answers a nudge in.
    root.followDose(back.ts, back.mg)
  }

  function nudgeCursor(minutes) {
    if (root.cursorSection !== "doses") return
    var entry = root.recentDoses[root.cursorIndex]
    if (entry) root.nudgeDose(entry.index, minutes)
  }

  function handleTextKey(text) {
    root.disarmPointer()
    // "<" and ">" beside "-" and "+", because the chevrons on the row are
    // drawn as ‹ › and a key that looks like the control it drives needs no
    // explaining. "-" and "+" are the pair that sit under one finger, "<" and
    // ">" are the pair that read as time.
    //
    // **D95 splits them on the main page and only there.** "+" opens More and
    // "-" closes it, which the button has been asking for in words since Phase
    // 8: it says "+ More" and "− Less". So the keys are not free — they were
    // the finger-pair's half of the nudge — and this is a swap rather than a
    // new binding. **What is given up is the alias, not the capability**: the
    // chevrons keep the nudge on their own, and the chevrons are what the
    // footer line, the "?" card and every dose row's own ‹ › controls all
    // show. "- +" has never been on the footer legend at all.
    //
    // The whole finger-pair goes or none of it: "+" to the toggle with "="
    // left on the nudge would leave the unshifted key under one finger doing
    // something the shifted one no longer does, which is worse than either
    // whole answer.
    //
    // Every other page keeps all four for adjusting the highlighted row —
    // none of them has a More — and each page's own card is true of that page,
    // which is the rule that makes a key meaning one thing per page legible.
    var fingerBack = text === "-" || text === "_"
    var fingerForward = text === "+" || text === "="
    var chevronBack = text === "<" || text === ","
    var chevronForward = text === ">" || text === "."
    var back = fingerBack || chevronBack
    var forward = fingerForward || chevronForward

    // On the settings page the same two keys adjust the highlighted setting,
    // and the drink digits are simply not live: there is no pill on screen for
    // a "3" to have meant, and logging a cold brew from the settings view
    // would be the panel doing something you cannot see.
    // The catalog page adds two keys and takes none away. "J" and "K" arrive
    // here as text — the stock PanelKeyCatcher takes lower-case j and k for
    // the cursor and passes anything else through, so a shifted letter needs
    // no modifier handling and no fork of the component.
    // The picker takes every key while it is up, the way the "?" card takes
    // Esc before the panel does. Nothing behind it is reachable, because
    // everything behind it is what you are choosing for.
    if (root.showIconPicker) {
      if (back) root.moveIconCursor(-1, 0)
      else if (forward) root.moveIconCursor(1, 0)
      else if (text === "i" || text === "I") root.closeIconPicker()
      return
    }

    if (root.showCatalog) {
      if (back) root.rowAdjust("catalog", root.cursorIndex, -1)
      else if (forward) root.rowAdjust("catalog", root.cursorIndex, 1)
      else if (text === "J") root.moveDrink(root.cursorIndex, 1)
      else if (text === "K") root.moveDrink(root.cursorIndex, -1)
      else if (text === "i" || text === "I") root.openIconPicker()
      else if (text === "a" || text === "A") root.startAddingDrink()
      else if (text === "s" || text === "S") root.closeCatalog()
      else if (text === "?" || text === "/") root.showKeys = !root.showKeys
      return
    }

    if (root.showProfile) {
      if (back) root.rowAdjust("profile", root.cursorIndex, -1)
      else if (forward) root.rowAdjust("profile", root.cursorIndex, 1)
      else if (text === "s" || text === "S") root.closeProfile()
      else if (text === "?" || text === "/") root.showKeys = !root.showKeys
      return
    }

    if (root.showSettings) {
      if (back) root.adjustSetting(root.cursorIndex, -1)
      else if (forward) root.adjustSetting(root.cursorIndex, 1)
      else if (text === "s" || text === "S") root.closeSettings()
      else if (text === "?" || text === "/") root.showKeys = !root.showKeys
      // D109, last, so it can never take a key this page already spends. It
      // answers or it does not; an unmapped letter falls through to nothing,
      // which is what every letter on this page did before.
      else root.jumpToSetting(text)
      return
    }

    // The noted days. Nothing here adjusts — a note is not a value with a
    // range — so the page takes only the keys that move, go, remove and leave,
    // and "N" toggles it back the way "s" toggles the settings page.
    if (root.showNotes) {
      if (text === "N") root.closeNotes()
      else if (text === "?" || text === "/") root.showKeys = !root.showKeys
      return
    }

    // The timeline, on the shell's own time-navigation keys (D35). Transposed
    // from the first-party Clock panel, which answers "how does keyboard time
    // travel feel here" with exactly these six: "[" and "]" step, "{" and "}"
    // jump, "t" goes home. All arrive through the stock PanelKeyCatcher as
    // text, so nothing is forked and no modifier is invented — and none of
    // them collides with a drink digit, which is why "t" can be "today"
    // rather than a letter nobody could guess.
    if (text === "[") root.panBy(-root.panStep)
    else if (text === "]") root.panBy(root.panStep)
    else if (text === "{") root.panBy(-root.panJump)
    else if (text === "}") root.panBy(root.panJump)
    else if (text === "t" || text === "T") root.panHome()
    else if (text === "p" || text === "P") root.togglePin()
    // D105. Beside the timeline keys because it is one: `[ ]` move the window
    // and `d` changes what a window is.
    //
    // **D107 splits the pair.** `d` walks rolling -> day -> hours and wraps;
    // `D` walks back. The engine took a signed direction from the start
    // (`nextFrame` is tested both ways), so what was missing was the key, and
    // the shifted letter arrives through `textKey` for the same reason `J`,
    // `K` and `N` do: the stock catcher matches the *lower-case* h/j/k/l and
    // passes everything else on. Three framings is where a one-way cycle
    // starts to cost — two presses to go back one — and it is the last size
    // at which nobody would notice.
    else if (text === "d") root.stepFrame(1)
    else if (text === "D") root.stepFrame(-1)
    // D65's pair, and they are one mnemonic rather than two: "n" writes on the
    // day you are standing on, "N" is every day you have written on. Neither
    // is a synonym for "p" — a pin is where you are looking, a note is
    // something you wrote down — and neither needs a modifier the stock
    // PanelKeyCatcher does not already deliver as text, which is the same
    // route Phase 9's "J" and "K" arrive by.
    else if (text === "n") root.startNote()
    else if (text === "N") root.toggleNotes()
    else if (chevronBack) root.nudgeCursor(-Caffeine.NUDGE_MINUTES)
    else if (chevronForward) root.nudgeCursor(Caffeine.NUDGE_MINUTES)
    // D113, beside the chevrons because these three are the keys that reach
    // into the dose list — `x` is the fourth and it is not here only because
    // the stock catcher eats it and hands it back as `onDeleteRequested`.
    //
    // The main page only, like `c` and for the same reason: every other page
    // has returned above this line, and on those pages `x` removes a drink or
    // a note, which are lists this stack knows nothing about. A `u` that
    // half-worked depending on which page was up would be worse than one that
    // is honestly absent from their cards.
    else if (text === "u" || text === "U") root.undoDelete()
    // D95. Open and close rather than toggle twice, because a key that matches
    // a printed label does what the label says — "+ More" opens whether or not
    // it is open, "− Less" closes. "m" stays the toggle it has always been.
    else if (fingerForward) root.showAllPresets = true
    else if (fingerBack) root.showAllPresets = false
    else if (text === "m" || text === "M") root.showAllPresets = !root.showAllPresets
    // The main page only, and on purpose. Every other page returns above this
    // line, so `c` keeps the settings page's jump to the cap row (D109) —
    // which is the same rule the rest of this function is built on: a key
    // means one thing per page, and each page's own card is true of that page.
    else if (text === "c" || text === "C") root.captureShare()
    else if (text === "s" || text === "S") root.openSettings()
    else if (text === "?" || text === "/") root.showKeys = !root.showKeys
    else root.logDigit(text)
  }

  // D90's mark, decided from a render of all three in all three states.
  //
  // The thumb-tack, and it is not close. `\uf276` is a map-pin — a lollipop on
  // a thin stem that says *a place* rather than *pinned*, and the stem is the
  // first thing to go at caption size. `\uf02e` is a bookmark, which is
  // legible and is the one with a claim, since Phase 12 nearly shipped that
  // word — but a bookmark says "saved to come back to", which is what a note
  // is (D65), and two marks on one panel competing for that meaning is worse
  // than a mark nobody has met.
  //
  // **The word came off, and that took a render too.** With the mark leading
  // it, "\uf08d Pinned:  3 days ago · 267 mg" is a glyph and a label saying
  // one thing eight pixels apart, which is D61's own finding at a smaller
  // scale. What teaches the mark is the panned-away state: "\uf08d 3 days ago"
  // sitting opposite "Yesterday · 267 mg" shows you what it points at.
  readonly property string pinGlyph: "\uf08d"

  // The camera, for the same kind of reason the thumb-tack won D90: the mark
  // has to name the verb, not the noun. `\uf1e0` is the share node — three
  // circles and two lines — which says *send somewhere* and is unreadable at
  // this size; `\uf03e` is a picture frame, which is what the file is rather
  // than what the button does. `\uf030` is a camera, and a camera on a chart
  // is the one mark nobody has to be taught.
  readonly property string shareGlyph: "\uf030"

  // D90's third question. `p pin this day under today` did not admit that "p"
  // also takes a pin off, or that at home it clears one (D64) — three
  // behaviours, one of which the legend named.
  //
  // Five wordings were rendered on the card. The user's own
  // `pin/unpin this day under today` is the longest row in its column and
  // widens the whole card for a slash that still does not cover the clear;
  // `pin this day under today, or clear` widens it further and reads as two
  // instructions. `pin or clear this day` is shorter than the column's widest
  // row and costs nothing, but "clear this day" is not what happens at home,
  // where the day being cleared is somewhere else.
  //
  // This one is the same width as `a week back, a week forward` — so the card
  // does not grow — and it is true of all three: you pin a day, and either
  // press it again or come home to clear the pin. What it drops is
  // "under today", and that was the only clause in the column doing any
  // explaining: nothing else here says what a key is *for* either
  // ("N the days you have noted" does not mention that it is a page).
  readonly property string pinWording: "pin a day, or clear the pin"

  function cursorOn(section, index) {
    return root.cursorSection === section && root.cursorIndex === index
  }

  // The bindings have existed since Phase 4 and nothing on screen has ever
  // mentioned them, which is the reason this phase exists. The footer states
  // the five that matter; "?" opens the full list over the panel.
  property bool showKeys: false

  // In the order you would need them: log, move, log the one you moved to,
  // correct a mistake, find the rest. Everything else is behind "?", which is
  // the last item so that the line advertises its own overflow.
  // The legend proper, and since D94 it is **empty** in the quiet state rather
  // than collapsing onto one item: the one item it used to collapse onto has
  // moved into the corner, where it is on every page and in both states.
  readonly property string keyHintText: root.quiet ? "" : root.loudKeyHintText

  // The corner's word, which does not change any more (D94, deleting D51's
  // rule that it tracked the card's contents).
  readonly property string helpHintText: Caffeine.formatHelpHint()

  // What a translucent fill actually looks like over this panel — source-over,
  // by hand, because the kit has no compositor helper and `Bean.qml` needs an
  // opaque colour to cut its seam with. D94's second way out; see the corner.
  function overPopup(fill) {
    var under = Color.popups.background
    var a = fill.a
    return Qt.rgba(fill.r * a + under.r * (1 - a),
                   fill.g * a + under.g * (1 - a),
                   fill.b * a + under.b * (1 - a), 1)
  }

  readonly property string loudKeyHintText: root.showCatalog
    ? Caffeine.formatCatalogHint(root.units)
    : (root.showProfile ? Caffeine.formatProfileHint()
       : (root.showNotes ? Caffeine.formatNotesHint(root.hasNotes)
          : (root.showSettings ? Caffeine.formatSettingsHint()
                               : Caffeine.formatKeyHint(root.hasDoses,
                                     Presets.digitCount(root.catalogPresets)))))

  // Three pages, three legends. The catalog's is where the keys this phase
  // invented are actually written down: the footer line has room for the five
  // you reach for and the "? keys" pointer, and this card is where the rest of
  // them are free — which is D40's arrangement working exactly as intended the
  // first time a page arrived with more keys than a line holds.
  // D83, and the shape is the ask: two named columns rather than a list, so
  // "[ ]" and "{ }" — a day and a week, the same gesture at two sizes — sit on
  // one row where you can see they are a pair.
  //
  // Written as two columns and *drawn* as two Columns. The Grid this replaced
  // was `columns: 2` with a comment claiming the list "reads down the left
  // column and then down the right", and a Grid fills row-major, so it did
  // nothing of the sort: the model alternated sides. A layout described per
  // column has to be built per column, or the comment and the code go on
  // disagreeing.
  //
  // Nothing says how to leave any more. The caption under every card used to
  // read "? or Esc to go back", and it was a line of prose repeating a key
  // that is already in the grid above it — "Esc" is in all five of these, so
  // no card loses its only statement of the way out. In the quiet state (D74)
  // the estimate line simply moves up under the rule, and the card still ends
  // where the panel ends.
  readonly property var keyBindings: root.showCatalog
    ? [[
      { keys: "↑ ↓ k j", what: "move between drinks" },
      { keys: "‹ ›  - +", what: "change the highlighted amount" },
      { keys: "↵  Space", what: "type an amount" },
      { keys: "a", what: "add a drink" },
      // D103, and D105 asks the same question of the main card: the way out is
      // the last thing you read down the *left* column now rather than the
      // last thing on the card. Both were the user's own placement and both
      // were rendered before they were kept — a legend is furniture you read
      // in a shape, not a list you look things up in, and the shape is theirs
      // to choose.
      { keys: "Esc", what: "back to settings" }
    ], [
      { keys: "K", what: "move this drink up the list" },
      { keys: "J", what: "move this drink down the list" },
      { keys: "x", what: "remove the highlighted drink" },
      // "s" leaves this page too and always has. It is off the card because
      // one way out is a statement and two is a quiz — and Esc is the one
      // every other card here names.
      { keys: "i", what: "choose this drink's icon" }
    ]]
    : root.showNotes
    ? [[
      { keys: "↑ ↓ k j", what: "move between days" },
      { keys: "↵  Space", what: "take the curve to that day" }
    ], [
      { keys: "x", what: "remove this note" },
      // Kept as a pair, unlike the catalog's: "N" is the key that opened this
      // page and pressing it again is how you close a thing you toggled.
      { keys: "Esc  N", what: "back to the panel" }
    ]]
    : root.showProfile
    ? [[
      { keys: "↑ ↓ k j", what: "move between questions" },
      { keys: "‹ ›  - +", what: "change the highlighted answer" }
    ], [
      { keys: "↵  Space", what: "the next answer along" },
      { keys: "Esc", what: "back to settings" }
    ]]
    : root.showSettings
    ? [[
      { keys: "↑ ↓ k j", what: "move between settings" },
      { keys: "↵  Space", what: "type a value, or flip a switch" },
      { keys: "Esc", what: "back to the panel" }
    ], [
      { keys: "‹ ›  - +", what: "change the highlighted setting" },
      { keys: "s", what: "back to the panel" }
    ]]
    : [[
      { keys: "1 – 5", what: "log a drink" },
      { keys: "← → h l", what: "move along a row" },
      { keys: "↵  Space", what: "log the highlighted drink" },
      // **D113 moves "m" across from the right-hand column**, and it is the
      // user's own placement. It reads better here than it did there: this is
      // the run about the drinks — log one of the five, walk along them, log
      // the one you walked to — and "show every drink" is the last question in
      // that run rather than the fourth thing on a column about the chart.
      //
      // It also settles the shape. The right column has been the longer one
      // since the share key landed, and putting `u` where "m" was would have
      // made that nine against eleven; moving "m" instead leaves ten and ten,
      // with the way out at the foot of the column you read first, which is
      // where D105 put it and why.
      { keys: "m", what: "show every drink" },
      // D95 took "- +" off this row and it was mandatory: those two keys open
      // and close More now, so the row was a lie the moment that landed. It is
      // a different question from whether the toggle gets a row of its own,
      // which it does not — the button says "+ More" in words, and removing a
      // lie is not the same as adding a hint.
      { keys: "‹ ›", what: "shift a dose by " + Caffeine.NUDGE_MINUTES + " minutes" },
      // The timeline. Written down in the Clock panel's own order — step,
      // jump, home — because a user who has met these keys anywhere in the
      // shell has met them there. The week sits beside the day rather than
      // under it, which is what the two columns bought.
      { keys: "{  }", what: "a week back, a week forward" },
      { keys: "p", what: root.pinWording },
      // A pin is where you are looking and a note is something you wrote
      // down, so the card says both in the words that separate them (D65).
      { keys: "N", what: "the days you have noted" },
      { keys: "s", what: "settings" },
      // **D105 puts the way out at the foot of the left column**, which is the
      // user's own placement and is the same move D103 made on the catalog
      // card. It takes "Esc" off the bottom-right corner where every card in
      // this plugin has ended, and it makes this one nine rows and eight where
      // it has always been eight and eight. Rendered before it was kept: the
      // card is read as a shape, the left column is the one you read first,
      // and a way out you meet at the end of that column is met sooner than
      // one at the end of the card.
      { keys: "Esc", what: "close" }
    ], [
      { keys: "6 – 0", what: "log one from More" },
      { keys: "↑ ↓ k j", what: "move between rows" },
      { keys: "x", what: "delete the highlighted dose" },
      // **D113, and the row above it is the whole argument for the slot.** A
      // key that takes something back has to be read in the same glance as the
      // key that took it away, or it is found after the damage rather than
      // before — which, for the mistake this exists to fix, is the difference
      // between a keypress and an evening spent remembering when you had your
      // coffees. So it is not sorted in beside the other letters; it is
      // adjacent to `x`, the way `D` is adjacent to `d` (D107).
      //
      // Four wordings were rendered against the column. `undo the last delete`
      // is the shortest and was thrown out for "delete" as a noun: nothing
      // else on this card names an operation, they all say what happens.
      // `put the dose back` does not admit that you can press it more than
      // once, which is the entire point. `put back the dose you deleted` says
      // "the", same problem, and runs two characters past the widest row in
      // the column, so it would have widened the card to be less true.
      //
      // This one is exactly as wide as `share this view as an image` — so the
      // card does not grow by a pixel — and its "a" rather than "the" is the
      // part doing the work: it says there may be more than one back there.
      { keys: "u", what: "put back a dose you deleted" },
      { keys: "[  ]", what: "a day back, a day forward" },
      { keys: "t", what: "back to today" },
      { keys: "n", what: "write a note on this day" },
      // "Tab next panel" was here and is deliberately gone (D83). It is a
      // real binding, and D40's whole arrangement is that the card is where
      // the keys that do not fit the footer line get written down — so this
      // is a decision rather than a tidy-up, and it is recorded as one.
      // "Panel" is not a word this plugin uses anywhere else, and what Tab
      // actually does is leave this plugin for the next widget on the bar. A
      // legend entry you have to mistranslate to read is worse than none.
      //
      // **D105's key, in the slot the user chose for it — where "Esc" was.**
      // It does *not* go on the footer line: D94 handed that line its first
      // free slot ever with an explicit instruction to leave it empty, this is
      // the first key to arrive since, and the card is where D40 says the keys
      // that do not fit the line get written down.
      //
      // Its description is built rather than typed, because it has a clock in
      // it and this plugin's rule is that copy with a number in it goes
      // through a formatter (formatKeyHint prints NUDGE_MINUTES the same way).
      // So the line follows `dayStart` and `dayEnd` when they change, and it
      // names the framing you are *in* rather than the one you would get.
      { keys: "d", what: Caffeine.formatFrameHint(
        root.frame, root.dayStartLabel, root.dayEndLabel) },
      // D107, directly under `d` because that is where the user put it — and
      // it takes the card back to nine rows and nine, where D105 left it nine
      // and eight. That is an accident of two placements rather than a reason
      // for either.
      //
      // It says only that it goes the other way. `d`'s line is built from the
      // setting and names the framing you are in; repeating any of that eight
      // pixels below it is D61's complaint at legend scale, and the row also
      // has to stay inside the column `d` already sets the width of.
      //
      // Four wordings rendered. `the framing before it` was thrown out on
      // sight: it repeats the two words the row above opens with, and two
      // adjacent lines starting "the framing" read as a stutter — D61's
      // finding at legend scale, which is what this row was warned about.
      // `back through the framings` is 25 characters against `the framing:
      // 7AM to 12AM` at 24, so a fixed row would have been setting the
      // column's width from under a row whose width already varies. `the
      // other way round` is a weaker case of the first problem — "the" twice
      // down the column, under "the framing:".
      //
      // This one is the shortest, it is an instruction rather than a phrase,
      // and its echo of `t back to today` four rows up is the two keys that
      // actually go backwards sharing a word. Which is a reason rather than
      // a coincidence.
      { keys: "D", what: "back the other way" },
      // The share key, last in the right-hand column because that is the
      // chart's column — `[ ]`, `t`, `n`, `d` and `D` are all about the
      // picture, and so is this. **After `D` and not between the two**: D107
      // put `D` directly under `d` and said so, and a row inserted into that
      // pair separates a key from the key it is the reverse of. It is the only
      // entry here that writes a file, which is its own argument for being the
      // one the column ends on.
      //
      // **It does not go on the footer legend, and that is D94's rule rather
      // than a shortage of room.** The line's own test for a slot, applied
      // twice (the timeline at Phase 11, the note at Phase 12), is that a key
      // earns one when it is something you *cannot* discover by looking at the
      // panel. This one has a mark on screen — the glyph that arrives on the
      // chart when you point at it — and the line's other standing rule is
      // that the item which leaves is the one with a control already doing its
      // job. So it would fail the test on the same evidence that got it a
      // glyph, and D94's free slot stays free.
      { keys: "c", what: "share this view as an image" }
    ]]

  // Esc takes one thing at a time, innermost first: the field being typed
  // into, then the key list, then the settings page, and only then the panel.
  // A key that dismisses two things at once dismisses the wrong one.
  function handleClose() {
    root.disarmPointer()
    if (root.editingSetting) root.endEditing()
    else if (root.showIconPicker) root.closeIconPicker()
    else if (root.showKeys) root.showKeys = false
    else if (root.showCatalog) root.closeCatalog()
    else if (root.showProfile) root.closeProfile()
    else if (root.showSettings) root.closeSettings()
    else if (root.showNotes) root.closeNotes()
    else root.close()
  }

  // A section that empties out (the last dose deleted, the overflow collapsed)
  // must not leave the cursor pointing into it.
  onCursorSectionsChanged: {
    // The first section that is actually on screen, not "presets": since the
    // settings page took the cursor over entirely, "presets" is a section that
    // sometimes does not exist, and landing the cursor in one leaves every key
    // pointing at controls nobody can see.
    if (root.cursorSections.indexOf(root.cursorSection) < 0)
      root.setCursor(root.cursorSections[0], 0)
    else if (root.cursorIndex >= root.sectionLength(root.cursorSection))
      root.setCursor(root.cursorSection, root.sectionLength(root.cursorSection) - 1)
  }

  // ------------------------------------------- one line of the arithmetic
  //
  // Two columns: what is being multiplied, right-aligned so the numbers form a
  // column whatever is in them, and what put it there. The base, each factor
  // and the total are all this one line with different weights, so a page that
  // shows its working cannot have the working and the answer drift apart.
  component DerivationLine: Item {
    id: line

    property string mark: ""
    property string note: ""
    property bool total: false
    // A total that is not the number the panel is using is a proposal, not a
    // conclusion, and it must not be the loudest thing on the page.
    property bool muted: false

    width: parent ? parent.width : 0
    height: markText.implicitHeight + Style.spacing.xxs

    Text {
      id: markText
      anchors.left: parent.left
      anchors.verticalCenter: parent.verticalCenter
      width: Math.ceil(derivationMarkMetrics.width)
      horizontalAlignment: Text.AlignRight
      textFormat: Text.PlainText
      text: line.mark
      // The total is the assertion and everything above it is the working,
      // which is D4's own arrangement one page down: the number being asserted
      // carries the weight and the qualification does not.
      color: line.total && !line.muted ? root.foreground : root.dim
      font.family: root.fontFamily
      font.pixelSize: line.total ? Style.font.body : Style.font.bodySmall
      font.bold: line.total && !line.muted
    }

    Text {
      anchors.left: markText.right
      anchors.leftMargin: Style.spacing.lg
      anchors.right: parent.right
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: line.note
      color: line.total ? root.dim : Qt.darker(root.foreground, 1.9)
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      elide: Text.ElideRight
    }
  }

  // ------------------------------------------------------- one list, two pages
  //
  // The settings and the catalog are the same list of the same row, asked
  // different questions — which is the whole reason the catalog was built on
  // SettingRow rather than beside it. Everything that differs between a
  // setting and a drink is answered by the rowX() functions above, so there is
  // one place where a row becomes pixels and it cannot drift between pages.
  component SettingList: Column {
    id: list

    property var rows: []
    property string section: ""
    property real valueWidth: 0
    // Non-zero on a list whose editor takes a sentence rather than a number.
    property real editWidth: 0
    property bool badgeSlot: false

    width: parent ? parent.width : 0
    spacing: Style.spacing.xxs

    function focusRow(index) {
      var item = rowRepeater.itemAt(index)
      if (item) item.focusEditor()
    }

    Repeater {
      id: rowRepeater
      model: list.rows

      SettingRow {
        id: listRow
        required property var modelData
        required property int index

        // D97. The row reports when it *takes* the cursor and the panel scrolls
        // to it — which is what makes a 29-drink catalog walkable at all.
        onHasCursorChanged: if (hasCursor) root.followCursor(listRow)

        readonly property bool isDrink: modelData.kind === "drink"
        readonly property bool isEditing:
          root.editingSection === list.section && root.editingIndex === index

        width: list.width
        label: root.rowLabel(modelData)
        description: root.rowDescription(modelData)
        valueText: root.rowValueText(modelData)
        valueWidth: list.valueWidth
        editWidth: modelData.kind === "add" ? list.editWidth : 0
        // D32, and the only thing on this page that shows a reorder having
        // worked: the digit is the drink's position, so it renumbers itself.
        badge: isDrink ? Presets.digitFor(modelData.index) : ""
        badgeSlot: list.badgeSlot
        // A note has no range to step through: the only thing its control
        // does is go to the day, which is Enter.
        adjustable: modelData.kind !== "action" && modelData.kind !== "page"
          && modelData.kind !== "add" && modelData.kind !== "note"
        // The last drink stays: an empty catalog reads back as the shipped
        // table, so removing it would look like a restore.
        removable: isDrink
          ? root.catalogPresets.length > 1
          : modelData.kind === "note"
        reorderable: isDrink && root.catalogPresets.length > 1
        armed: root.armedKey === modelData.key
        editing: isEditing
        editText: root.rowEditSeed(modelData)
        placeholder: modelData.kind === "clock"
          ? "23:00"
          : (modelData.kind === "add" ? root.catalogAddExample : "")
        // Empty is not yet wrong — a field that turns urgent the moment it
        // opens is scolding you for not having typed anything yet.
        editInvalid: isEditing && root.editingText !== ""
          && !root.rowParses(modelData, root.editingText)
        hasCursor: root.cursorOn(list.section, index)
        foreground: root.foreground
        accent: root.accent
        urgent: root.urgent
        fontFamily: root.fontFamily
        onPointerMoved: function(item, at) { root.selectFromPointer(list.section, index, item, at) }
        onAdjusted: function(direction) {
          root.setCursor(list.section, index)
          root.rowAdjust(list.section, index, direction)
        }
        onActivated: {
          root.setCursor(list.section, index)
          root.rowActivate(list.section, index)
        }
        // The ✕ the dose rows and the drink rows already carry, doing the
        // same job on a third list rather than a fourth idiom.
        onRemoved: {
          root.setCursor(list.section, index)
          if (list.section === "notes") root.removeNoteRow(index)
          else root.removeDrink(index)
        }
        onMoved: function(direction) { root.moveDrink(index, direction) }
        onEditTyped: function(text) { root.editingText = text }
        onEditCommitted: function(text) { root.commitEditing(text) }
        onEditCancelled: root.endEditing()
      }
    }
  }

  // ------------------------------------------------------------ the panel

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    // 440 held four pills at about 98px each, and six columns of that width
    // is 600. Judged from renders rather than chosen: at 560 the fifth pill
    // elided "Large coffee", and a shipped row with a cut-off drink on it
    // reads as broken. The Clock panel is 560, so this is the widest panel on
    // the bar by 40px and still in the shell's own range.
    contentWidth: panel.fittedContentWidth(Style.space(600))
    // `pages` and not `body`: the hero and the two footer lines are shared,
    // so the height that matters is the whole stack's, whichever page is up.
    contentHeight: panel.fittedContentHeight(pages.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // The gallery's contract for a panel with an inline editor: while a
      // field owns the keyboard the panel's cursor model freezes, or typing a
      // "5" into the bedtime would also log an espresso.
      blocked: root.editingSetting
      onCloseRequested: root.handleClose()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onMoveRequested: function(dx, dy) { root.moveCursor(dx, dy) }
      onActivateRequested: root.activateCursor()
      onDeleteRequested: root.deleteCursor()
      onTextKey: function(text) { root.handleTextKey(text) }

      Flickable {
        id: scroll
        anchors.fill: parent
        contentWidth: width
        contentHeight: pages.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        // The panel is two pages. What they share is above them both: the
        // hero, and the two footer lines. That is the whole argument for
        // settings living inside this panel rather than in a window of their
        // own — you move the sleep threshold and watch the verdict change
        // under it, instead of changing a number elsewhere and coming back to
        // find out what it did.
        Column {
          id: pages
          width: scroll.width
          spacing: Style.spacing.panelGap

          // ---------------------------------------------------------- hero
          //
          // Hand-built, and that is the decision rather than an oversight.
          // PanelHero pins its detail pill to a dimmed foreground, so it
          // cannot give the verdict either colour or weight — reaching for it
          // would quietly undo D4, which is the whole reason the curve leads
          // and the projection is stated at full typographic weight.
          Item {
            width: parent.width
            height: Math.max(heroLeft.implicitHeight, heroRight.implicitHeight)

            Row {
              id: heroLeft
              anchors.left: parent.left
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.spacing.xxl

              Cup {
                id: heroCup
                anchors.verticalCenter: parent.verticalCenter
                height: Style.space(44)
                // **D111's override is read here rather than assigned to
                // `fill`, and that is the whole trick.** `fill` is a binding;
                // assigning a number to it in QML destroys the binding
                // permanently, so the cup would empty once and then never
                // follow the level again — correction 12's family, and a
                // failure that looks like the animation working the first time.
                // Negative means "no replay in progress", because zero is a
                // real fill.
                fill: heroCup.emptied ? 0 : (root.hasDoses ? root.fill : 0)
                color: root.hasDoses ? root.foreground : root.dim

                property bool emptied: false

                // Cup.qml owns the pour but not the level, so the hero brings
                // its own easing for the level. Disabled while closed, or
                // every open would animate the liquid up from empty as if the
                // coffee had just arrived.
                property bool snapping: false

                Behavior on fill {
                  enabled: root.opened && !heroCup.snapping
                  NumberAnimation { duration: Caffeine.MOTION_POUR_MS; easing.type: Easing.OutCubic }
                }

                // D52, the same event the bar mark plays, off the same signal.
                // Both cups are the same file at two sizes, and this is what
                // makes them read that way: log a drink with the panel open
                // and the stream falls into a 44px cup while it falls into a
                // 15px one, in step, because there is one animation and one
                // trigger rather than two that agree.
                Connections {
                  target: root.store
                  // A drink logged mid-replay ends it, rather than pouring a
                  // stream into a cup that is on its way back up from empty.
                  // The pour is about a level that does not move (D73) and the
                  // replay is the level moving, so the two cannot share a
                  // frame and say anything.
                  function onLogged(dose) {
                    heroCup.settle()
                    heroCup.pour()
                  }
                }

                // ------------------------------------------------- D111
                //
                // **Press the cup and it empties, then fills back to exactly
                // where it was.** Pure delight: it changes nothing, reveals
                // nothing, and is over in 420ms.
                //
                // The animation is the `Behavior` directly above, which has
                // been on this cup since Phase 4 — dropping the fill to zero
                // and releasing it *is* the effect, and nothing new is
                // animated or timed. `Cup.pour()` is **not** this: D73's pour
                // is a stream falling into a level that does not move.
                //
                // **This takes no gesture away.** D36 put the units toggle on
                // the hero's *number*, in its own Column with its own
                // MouseArea; the cup has never had pointer handling. What it
                // does create is two adjacent targets with different jobs, one
                // of them a real setting — see the render.
                //
                // **It gets no keyboard route, and that is deliberate.** Every
                // *control* in this plugin has been keyboard-reachable since
                // Phase 4. This is not a control: there is nothing here to
                // reach, only something to enjoy, and a key for it would be a
                // key that does nothing anybody needs.
                // **The cup empties instantly and fills back.** Both readings
                // of the ask were built and rendered: easing the level *down*
                // first is a 420ms drain followed by a 420ms rise, and on the
                // frames it reads as a dip — the cup sagging and recovering,
                // which is a glitch rather than a gesture. Snapping to empty is
                // what "shows an empty mug and then animates to return" says,
                // and it is the one that has a moment in it.
                //
                // `snapping` turns the Behavior off for exactly one assignment,
                // which is how a property with an easing on it is moved without
                // easing. It is switched back on the same line, before anything
                // can render.
                function replay() {
                  // Nothing to empty, so nothing to watch: on an empty cup
                  // this would be an animation from zero to zero.
                  if (!root.hasDoses || root.fill <= 0) return
                  heroCup.snapping = true
                  heroCup.emptied = true
                  heroCup.snapping = false
                  refillTimer.restart()
                }

                function settle() {
                  refillTimer.stop()
                  heroCup.emptied = false
                }

                // **The beat the cup is held empty, and it is MOTION_REVEAL_MS
                // rather than a number.** That constant is this plugin's
                // "a state changed, notice it" duration, which is exactly the
                // job: long enough that the empty cup registers as a state and
                // not as a flicker, short enough that nothing waits. At
                // MOTION_POUR_MS — which is what the first build used, on the
                // reasoning that the hold should match the pour — the cup sits
                // blank for four hundred milliseconds and the delight becomes
                // a stall. The renders are unambiguous about it.
                Timer {
                  id: refillTimer
                  interval: Caffeine.MOTION_REVEAL_MS
                  onTriggered: heroCup.emptied = false
                }

                MouseArea {
                  anchors.fill: parent
                  cursorShape: Qt.PointingHandCursor
                  onClicked: heroCup.replay()
                }
              }

              Column {
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.spacing.xxs

                // D36. The number is the shortest route to the units
                // setting: click it and the whole panel flips mg <-> cups,
                // persisted, with the settings row still there for anyone who
                // would never think to try. The affordance is an underline
                // that arrives on hover rather than a border or a fill — this
                // is D4's surface, and control chrome around the hero's own
                // number would compete with the verdict beside it.
                Item {
                  width: heroLevel.implicitWidth
                  height: heroLevel.implicitHeight + Style.spacing.xs

                  Text {
                    id: heroLevel
                    textFormat: Text.PlainText
                    text: root.hasDoses ? Caffeine.formatAmountApprox(root.level, root.units, root.cupMg) : "—"
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.heading
                    font.bold: true
                  }

                  // Faint at rest rather than absent, and that is the
                  // decision. An affordance that only exists once you are
                  // already pointing at the thing cannot make the thing
                  // discoverable — and this is the only route to the units
                  // setting that does not go through the settings page. One
                  // hairline under one number is as quiet as a hint gets.
                  Rectangle {
                    visible: root.hasDoses
                    anchors.left: heroLevel.left
                    anchors.right: heroLevel.right
                    y: heroLevel.implicitHeight
                    height: Math.max(1, Style.spacing.hairline)
                    color: heroLevelMouse.containsMouse ? root.accent : root.dim
                    opacity: heroLevelMouse.containsMouse ? 1 : 0.55
                    Behavior on opacity { NumberAnimation { duration: Caffeine.MOTION_REVEAL_MS } }
                    Behavior on color { ColorAnimation { duration: Caffeine.MOTION_REVEAL_MS } }
                  }

                  MouseArea {
                    id: heroLevelMouse
                    anchors.fill: parent
                    enabled: root.hasDoses
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.toggleUnits()
                  }

                  PanelToolTip {
                    visible: heroLevelMouse.containsMouse
                    text: root.unitsToggleHint
                    fontFamily: root.fontFamily
                  }
                }

                Text {
                  textFormat: Text.PlainText
                  text: "ON BOARD NOW"
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                  font.letterSpacing: 1.2
                }
              }
            }

            Column {
              id: heroRight
              visible: root.hasDoses
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              spacing: Style.spacing.xxs

              Text {
                textFormat: Text.PlainText
                anchors.right: parent.right
                // Full weight, full colour. This is D4.
                text: Caffeine.projectionHeadline(root.projection, root.units,
                    root.clockOf(root.projection.bedtimeAt), root.cupMg)
                color: root.bandColor(root.projection.band)
                font.family: root.fontFamily
                font.pixelSize: Style.font.title
                font.bold: true
              }

              Text {
                textFormat: Text.PlainText
                anchors.right: parent.right
                text: Caffeine.projectionCaption(root.projection).toUpperCase()
                color: root.bandColor(root.projection.band)
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
                font.letterSpacing: 1.2
              }
            }
          }

          // ------------------------------------------------------ the pages
          //
          // Five pages in one slot, and the slot is what moves. Wrapping them
          // was the whole of Phase 13's page-transition decision: the hero
          // above and the two footer lines below are the frame, and a frame
          // that moved when the picture changed would be the panel rebuilding
          // itself rather than turning a page. So the shared furniture is
          // outside this Column and holds absolutely still, and everything
          // inside it arrives together.
          //
          // The direction is the hierarchy's, not the keystroke's: `pageDepth`
          // says how far in a page is, and a page deeper than the one it
          // replaced arrives from the right the way the next page of anything
          // does. Coming back it arrives from the left. Twelve pixels — enough
          // that the eye catches which way it went, small enough that nothing
          // on a 600px panel appears to travel.
          Column {
            id: pageStack
            width: parent.width
            spacing: 0

            opacity: 1
            transform: Translate { id: pageShift; x: 0 }

            ParallelAnimation {
              id: pageTurn
              // `from` is set by the handler below, because it is the only
              // part of this that knows which way the stack went.
              NumberAnimation {
                id: pageSlide
                target: pageShift; property: "x"
                from: 0; to: 0
                duration: Caffeine.MOTION_PAGE_MS
                easing.type: Easing.OutCubic
              }
              NumberAnimation {
                target: pageStack; property: "opacity"
                from: 0; to: 1
                duration: Caffeine.MOTION_PAGE_MS
                easing.type: Easing.OutCubic
              }
            }

            Connections {
              target: root
              function onPageDepthChanged() {
                pageSlide.from = root.pageDepth > root.lastPageDepth
                  ? root.pageTravel : -root.pageTravel
                root.lastPageDepth = root.pageDepth
                pageTurn.restart()
              }
            }

            // Everything the main page has that the settings page does not.
            // A positioner skips an invisible child, so swapping pages leaves
            // the shared hero and footer exactly where they were.
            Column {
              id: body
              visible: !root.showSettings && !root.showCatalog && !root.showNotes
              width: parent.width
              spacing: Style.spacing.panelGap

              // ------------------------------------------------- where you are
              //
              // D61. Left-aligned, so it reads as the chart's title rather than
              // as a fourth line of the hero's right-hand column — which is what
              // it did right-aligned, stacked under "CLEAR FOR SLEEP", a verdict
              // about now sitting directly above a caption about Wednesday.
              //
              // D90 makes it an Item with a mark on it, which is the idiom the
              // note line under it already uses: a glyph, then the line.
              Item {
                width: parent.width
                visible: root.hasDoses && (root.panned || root.ghostVisible
                  || root.hasPin || root.captionForced)
                height: visible ? dayText.implicitHeight : 0

                Text {
                  id: dayPin
                  visible: root.captionIsPinnedDay
                  anchors.left: parent.left
                  anchors.verticalCenter: dayText.verticalCenter
                  textFormat: Text.PlainText
                  text: root.pinGlyph
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }

                Text {
                  id: dayText
                  anchors.left: root.captionIsPinnedDay ? dayPin.right : parent.left
                  anchors.leftMargin: root.captionIsPinnedDay ? Style.spacing.md : 0
                  anchors.top: parent.top
                  textFormat: Text.PlainText
                  horizontalAlignment: Text.AlignLeft
                  text: root.viewDayLine
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  font.bold: true
                }

                // The other end of the same line, and only while the two ends
                // are about different days. Not bold: the day you are reading
                // is the subject and this is a note about somewhere else.
                Text {
                  visible: root.pinElsewhere
                  anchors.right: parent.right
                  anchors.verticalCenter: dayText.verticalCenter
                  textFormat: Text.PlainText
                  text: root.pinGlyph + "  " + root.pinnedDayLine
                  color: Qt.darker(root.foreground, 1.45)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }

              // ------------------------------------------- the note on this day
              //
              // D48, written where you are standing: on the day the timeline has
              // you on. That is what settles "which day is a note written at
              // 23:30 about?" without inventing a second calendar — D42
              // deliberately refused the plugin a general night boundary, and
              // this defers to the chart instead, with the caption directly
              // above naming the day.
              //
              // It carries no day of its own for D61's reason: the caption says
              // the day, and the same string twice eighty pixels apart is the
              // build D61 threw away. At home there is no caption and no
              // ambiguity — the day you are standing on is today.
              Item {
                width: parent.width
                visible: root.hasViewNote || root.editingNote || root.notesBlocked
                height: visible
                  ? Math.max(noteMark.implicitHeight,
                             root.editingNote ? noteField.height
                                              : noteText.implicitHeight)
                  : 0

                Text {
                  id: noteMark
                  anchors.left: parent.left
                  anchors.top: parent.top
                  textFormat: Text.PlainText
                  text: root.notesBlocked ? "!" : "✎"
                  color: root.editingNote ? root.accent : Qt.darker(root.foreground, 1.8)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }

                Text {
                  id: noteText
                  visible: !root.editingNote
                  anchors.left: noteMark.right
                  anchors.leftMargin: Style.spacing.md
                  anchors.right: parent.right
                  anchors.verticalCenter: noteMark.verticalCenter
                  textFormat: Text.PlainText
                  text: root.notesBlocked ? root.noteError : root.viewNoteText
                  color: root.notesBlocked ? root.urgent : Qt.darker(root.foreground, 1.45)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                  wrapMode: Text.WordWrap
                }

                // The field, and it wraps — which is D68, decided from a render
                // with a real two-sentence note in it. The kit's own TextField
                // was the other candidate and is what every text input in
                // Omarchy is: it holds about ninety characters at this width,
                // a two-sentence note is a hundred and eighteen, and seeded
                // selected it opens showing the tail with the first sentence
                // scrolled off the left and one keystroke from losing it.
                //
                // It is emphatically not a multi-line document: Enter commits
                // rather than inserting a newline, so what is stored is one
                // paragraph and the review list can never be handed a shape it
                // cannot draw. It is built rather than borrowed because the kit
                // has no wrapping input, and the borrowing is limited to the
                // parts that must match — the same BorderSurface, the same
                // focus/hover border spec, the same fills — so it reads as the
                // shell's own field with its wrap turned on rather than as a
                // second look.
                BorderSurface {
                  id: noteField
                  visible: root.editingNote
                  anchors.left: noteMark.right
                  anchors.leftMargin: Style.spacing.md
                  anchors.right: parent.right
                  anchors.top: parent.top
                  height: Math.max(Style.space(46), noteArea.implicitHeight
                    + Style.spacing.inputPaddingY * 2)
                  radius: Style.cornerRadius
                  color: Style.controlFill(noteArea.activeFocus, false,
                    root.foreground, root.accent)
                  borderSpec: Border.controlSpec(
                    noteArea.activeFocus ? "focus" : "normal", root.foreground, root.accent)

                  TextEdit {
                    id: noteArea
                    anchors.fill: parent
                    anchors.leftMargin: Style.spacing.controlPaddingX
                    anchors.rightMargin: Style.spacing.controlPaddingX
                    anchors.topMargin: Style.spacing.inputPaddingY
                    anchors.bottomMargin: Style.spacing.inputPaddingY
                    textFormat: TextEdit.PlainText
                    wrapMode: TextEdit.Wrap
                    color: root.foreground
                    selectionColor: Style.selectionFillFor(root.foreground, root.accent)
                    selectedTextColor: root.foreground
                    selectByMouse: true
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption

                    function focusEditor() {
                      noteArea.text = root.rowEditSeed({ kind: "note-edit" })
                      // The cursor at the end rather than the whole note
                      // selected: seeding an existing note selected means the
                      // first keystroke deletes what you came to add to.
                      noteArea.cursorPosition = noteArea.text.length
                      noteArea.forceActiveFocus()
                    }

                    onTextChanged: {
                      // The cap is enforced here as well as in the sanitiser,
                      // because a field that silently keeps taking characters it
                      // will not store is lying about what was saved.
                      if (noteArea.text.length > Caffeine.NOTE_TEXT_MAX) {
                        var at = noteArea.cursorPosition
                        noteArea.text = noteArea.text.slice(0, Caffeine.NOTE_TEXT_MAX)
                        noteArea.cursorPosition = Math.min(at, noteArea.text.length)
                      }
                      if (root.editingNote) root.editingText = noteArea.text
                    }

                    Keys.onPressed: function(event) {
                      if (event.key === Qt.Key_Escape) {
                        root.endEditing()
                        event.accepted = true
                      } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
                        root.commitEditing(noteArea.text)
                        event.accepted = true
                      }
                    }

                    // The placeholder the kit's TextField draws for itself.
                    Text {
                      anchors.left: parent.left
                      anchors.top: parent.top
                      visible: noteArea.text === ""
                      textFormat: Text.PlainText
                      text: Caffeine.NOTE_PLACEHOLDER
                      color: Qt.darker(root.foreground, 1.6)
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                    }
                  }
                }
              }

              // ---------------------------------------------------------- curve
              Item {
                id: chart
                width: parent.width
                visible: root.hasDoses
                height: visible ? curve.height + axis.height + Style.spacing.sm : 0

                // D112's mark, and the reason `c` is not on the footer legend.
                //
                // **It is on the chart and not at the corner, and that is
                // D94 being obeyed rather than worked around.** The corner is
                // one mark with a caption beside it, decided three times
                // (D87, D93, D94) and decided last on the sentence that two
                // items there "read as two items on a line that has run out".
                // A camera next to the bean would be exactly that, and would
                // reopen a question that has been closed twice.
                //
                // So it goes on the thing it is about. The share card is the
                // chart plus the verdict above it; putting the control on the
                // chart says which of the five pages this key belongs to
                // without a word of legend, and it is the only surface on the
                // panel with no pointer behaviour of its own to displace.
                //
                // Hidden until pointed at, because a control that is always
                // lit on a chart competes with the curve — the same argument
                // D36 settled for the hero's underline, and settled the same
                // way: the affordance arrives when the pointer does. The key
                // is the discoverable route, on the "?" card with the rest.
                // Hover detection for the mark above, and it took three
                // shapes to find one that works inside this surface. Written
                // first as `acceptedButtons: Qt.NoButton` — the documented way
                // to watch hover without taking the press — it never reported
                // `containsMouse` at all, and a `HoverHandler` did not either.
                // Both were rendered with the chart's bounds tinted and the
                // pointer parked on it, which is the only way this shows: the
                // mark simply stays hidden under a cursor that is on the
                // chart, and nothing anywhere says why.
                //
                // What works is a MouseArea that accepts a button. So it
                // accepts one and does nothing with it, which costs exactly
                // nothing here: the chart has never had a click behaviour, and
                // what a click on it reached before was the card's own
                // swallow-everything MouseArea, whose whole job is to do
                // nothing. The panel's cursor model (D82) is untouched — this
                // area never moves the cursor.
                MouseArea {
                  id: chartHover
                  anchors.fill: parent
                  acceptedButtons: Qt.LeftButton
                  hoverEnabled: true
                }


                PanelActionButton {
                  id: shareButton
                  anchors.right: parent.right
                  anchors.top: parent.top
                  visible: opacity > 0
                  // Both, because the button's own MouseArea takes the
                  // pointer the moment it crosses it. A mark that faded out
                  // from under the cursor reaching for it would be the one
                  // bug this affordance cannot have.
                  opacity: chartHover.containsMouse || shareButton.pointedAt ? 1 : 0
                  Behavior on opacity { NumberAnimation { duration: Caffeine.MOTION_REVEAL_MS } }
                  iconText: root.shareGlyph
                  tooltipText: "Share this view  (c)"
                  hasCursor: false
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  onClicked: root.captureShare()

                  property bool pointedAt: false
                  onHovered: function(isHovered) { shareButton.pointedAt = isHovered }
                }

                // A day with nothing on it says so, rather than leaving an
                // axis and a bedtime hairline over an empty box. The empty
                // state further down is about an empty *log* and is the wrong
                // sentence here — there is a record, and this is a day in it
                // that you drank nothing on, which is a fact rather than the
                // absence of one.
                //
                // Three words, and deliberately not "on this day": the window
                // is twelve hours each side of the moment it is centred on,
                // and the caption above already names the day. Printing the
                // day twice, with one of the two slightly wrong about which
                // hours it covers, is the build D61 threw away.
                Text {
                  visible: root.viewDayEmpty
                  anchors.centerIn: curve
                  textFormat: Text.PlainText
                  text: "Nothing logged"
                  color: Qt.darker(root.foreground, 1.8)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                }

                Curve {
                  id: curve
                  width: parent.width
                  height: Style.space(104)
                  samples: root.samples
                  maxValue: root.curveMax
                  fromTs: root.fromTs
                  toTs: root.toTs
                  nowTs: root.nowSeconds
                  // Nothing is drawn left of your first-ever drink. See
                  // Curve.recordFromTs — it is D64's rule about where the
                  // record starts, applied to the edge of the chart rather
                  // than to the edge of the pan.
                  recordFromTs: root.oldestDoseTs
                  // The bedtime clock, not the moment the hero is about. Past
                  // bedtime those differ (D42): the hero reports now, and the
                  // hairline stays on the bedtime that has just gone — which is at
                  // most four hours back and so still on the chart, where
                  // tomorrow's would be sixteen hours off it.
                  bedtimeTs: root.viewBedtimeTs
                  ghostSamples: root.ghostSamples
                  ghostVisible: root.ghostVisible
                  ghostColor: root.dim
                  color: root.foreground
                  areaColor: root.accent
                  bandColor: root.bandColor(root.projection.band)
                  fontFamily: root.fontFamily
                  // Bedtime names itself at the top of its own hairline instead of
                  // down on the axis. On the axis it sat beside "now", and the two
                  // collided every evening — precisely when the marker matters —
                  // whereupon the collision rule hid the more useful of the two.
                  bandLabel: root.bedtimeCaption
                }

                // The axis. Wall-clock hours under the majors the curve already
                // drew, plus "now" as the anchor. Absolute rather than relative:
                // the two other times on this panel — the projection and the
                // bedtime marker — are clocks, so an axis in elapsed hours would
                // be the only thing on screen you had to convert.
                Item {
                  id: axis
                  anchors.top: curve.bottom
                  anchors.topMargin: Style.spacing.sm
                  width: parent.width
                  height: nowLabel.implicitHeight

                  readonly property real nowCentre: curve.xAt(root.nowSeconds)

                  Repeater {
                    model: curve.hourMarks

                    Text {
                      required property var modelData
                      readonly property real centre: curve.xAt(modelData.ts)
                      // The anchor owns its patch of the axis; an hour that lands
                      // under it is simply not drawn.
                      visible: modelData.major
                        && (nowLabel.visible
                            ? Math.abs(centre - axis.nowCentre)
                              > (implicitWidth + nowLabel.implicitWidth) / 2 + Style.spacing.lg
                            : true)
                      textFormat: Text.PlainText
                      x: Math.round(Math.max(0, Math.min(axis.width - implicitWidth,
                           centre - implicitWidth / 2)))
                      text: root.axisLabelOf(modelData.ts)
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                    }
                  }

                  Text {
                    id: nowLabel
                    // Panned, "now" is not in the window; the caption and the
                    // midnight date say where you are instead. Putting the day's
                    // name on this anchor was built and lost: it reads as a
                    // point in time, which "Yesterday" is not, and it is wide
                    // enough to crowd the hour beside it.
                    //
                    // **`windowHasNow` and not just `!panned`, since D105, and
                    // the render is what found it.** Until this phase the two
                    // were the same statement — an unpanned window always
                    // contained now — and the `hours` framing breaks that: at
                    // 03:00 with a 07:00-midnight day you are at home on a
                    // window that ended hours ago. `x` clamps to the axis, so
                    // the label did not vanish, it **moved to the right-hand
                    // edge and asserted that the edge was now**. The seam
                    // hairline two elements up was already gated on the window
                    // and simply was not drawn, so the frame carried a bold
                    // "now" with no line under it, on a chart of yesterday.
                    visible: !root.panned && root.windowHasNow
                    textFormat: Text.PlainText
                    x: Math.round(Math.max(0, Math.min(axis.width - implicitWidth,
                         axis.nowCentre - implicitWidth / 2)))
                    text: "now"
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: true
                  }
                }
              }

              // The line the trials actually measured, as opposed to the residual
              // estimate above it, which is derived. Costs almost nothing and is
              // the more defensible of the two numbers.
              //
              // The one place on the panel that stays in milligrams whatever the
              // units setting says: 100 mg is a threshold read off dose x
              // hours-before-bed trials, and restating a measured figure in a unit
              // the studies never used would be dressing it up. The line names its
              // unit twice, and the footer defines the cup, so nothing is
              // ambiguous about which is which.
              Text {
                width: parent.width
                visible: root.hasDoses && root.lead !== null
                textFormat: Text.PlainText
                // The tail is Caffeine.formatLead rather than a duration and the
                // word "before": past midnight the next bedtime is nearly a day
                // out, and a 23:30 espresso read "23h 29m before bed" — true of
                // tomorrow night, and useless about tonight.
                text: root.lead === null ? "" :
                  (Caffeine.formatStrongDoseHead(root.lead.dose.mg,
                                                 Caffeine.STRONG_DOSE_MG)
                   + " — " + Caffeine.formatLead(root.lead))
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.bodySmall
                wrapMode: Text.WordWrap
              }

              // ------------------------------------------------------ empty state
              //
              // A fresh install gets this rather than a chart of zeroes: there is
              // nothing to plot, and a flat line at the baseline reads as broken.
              Column {
                width: parent.width
                visible: !root.hasDoses
                spacing: Style.spacing.sm

                Text {
                  textFormat: Text.PlainText
                  text: "Nothing logged yet"
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.subtitle
                  font.bold: true
                }

                Text {
                  width: parent.width
                  textFormat: Text.PlainText
                  text: "Tap a drink to start the curve. It fills over the first hour, "
                      + "the way the caffeine actually arrives."
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  wrapMode: Text.WordWrap
                }

                // The sentence that justifies this plugin existing, and the
                // only thing on it a person cannot work out by paying
                // attention: caffeine six hours before bed cost Drake's
                // subjects over an hour of measured sleep and their own sleep
                // diaries did not register it.
                //
                // Three placements were built and rendered, and what decided
                // it was D13 rather than the density the panel's other copy
                // decisions turn on. Under the strong-dose line it reads well
                // and is arguably where a citation belongs — it is the
                // citation for exactly that line — but it sits eight pixels
                // under a sentence about *your* 200 mg dose, and a general
                // finding printed under a specific measurement is read as a
                // verdict on it: "your drink cost you sleep you did not
                // notice". That is the plugin drawing a conclusion, which is
                // the one thing D13 does not allow it to do. On the settings
                // page it lands mid-paragraph after "23:00 or 11:00 PM both
                // work", so a trial finding reads as a continuation of how to
                // type a time.
                //
                // Here there is no number of yours anywhere near it, because
                // there is nothing logged — it is the reason to start rather
                // than a verdict on what you did. Which is also why it is
                // said once to someone with an empty log and never again: it
                // justifies the plugin, and that is a thing you need told
                // once.
                Text {
                  width: parent.width
                  textFormat: Text.PlainText
                  text: Caffeine.TRIAL_NOTE
                  color: Qt.darker(root.foreground, 1.8)
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  wrapMode: Text.WordWrap
                }
              }

              PanelSeparator { foreground: root.foreground }

              // ------------------------------------------------------------- log
              Item {
                width: parent.width
                height: logHeader.implicitHeight

                PanelSectionHeader {
                  id: logHeader
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  text: "LOG A DRINK"
                }

                Text {
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  // With a cap on, "0 / 400 mg today" is the answer to the
                  // question the setting asked; without one there is nothing to
                  // say about a day with no drinks in it yet.
                  visible: root.todayTotal > 0 || root.capShown
                  textFormat: Text.PlainText
                  text: root.todayText
                  color: root.overCap ? root.foreground : root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }

              // One grid, one cell metric, both rows. The main row and the
              // overflow used to be a Row and a Flow that each did their own
              // arithmetic; being the same positioner is what makes them line up
              // by construction rather than by two expressions agreeing.
              //
              // The overflow stays behind the "+" because a grid of seventeen
              // is a menu, and the point of the main row is that logging is one
              // tap.
              Grid {
                id: presetGrid
                width: parent.width
                columns: root.presetColumns
                spacing: Style.spacing.md

                readonly property int cellWidth:
                  Math.floor((width - spacing * (columns - 1)) / columns)

                Repeater {
                  model: root.mainPresets

                  PresetButton {
                    id: mainPill
                    required property var modelData
                    required property int index
                    width: presetGrid.cellWidth
                    height: root.presetHeight
                    compact: true
                    label: modelData.label
                    amountText: root.amountTextOf(modelData.mg)
                    keyLabel: Presets.digitFor(index)
                    icon: modelData.icon
                    tooltipText: Presets.labelOf(modelData)
                    hasCursor: root.cursorOn("drinks", index)
                    onHasCursorChanged: if (hasCursor) root.followCursor(mainPill)
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: root.fontFamily
                    onPointerMoved: function(item, at) { root.selectFromPointer("drinks", index, item, at) }
                    onClicked: root.logPreset(modelData)
                  }
                }

                PanelActionButton {
                  id: moreButton
                  // A cell of the grid rather than a square beside it. It is the
                  // sixth column on both rows, so the drinks underneath sit under
                  // the drinks above them instead of half a pill to the left.
                  //
                  // D88: and a cell of the *cursor's* grid too. The slot it
                  // occupies is the one the positioner puts it in — after the
                  // main row's delegates and before the overflow's — so this
                  // one expression is where the screen and the cursor agree.
                  readonly property int slot: root.mainPresets.length
                  hasCursor: root.cursorOn("drinks", moreButton.slot)
                  onHasCursorChanged: if (hasCursor) root.followCursor(moreButton)
                  // **The accent, and it took a render to see why.** The kit's
                  // action button paints its label `foreground` at rest and
                  // `hoverColor` when hot, and `hoverColor` defaults to
                  // `foreground` — so out of the box a cell that has the cursor
                  // and a cell that does not are *the same colour*, and the only
                  // cue is a fill a few percent lighter. A cell the arrows now
                  // stop on cannot be marked that quietly.
                  //
                  // Three treatments were rendered with the cursor on the
                  // toggle and on a drink beside it. Leaving it alone is the
                  // state described above. Dimming the resting label to the
                  // pill's own resting weight does make the pair differ, but
                  // only just, and it costs the "+" some of the presence it
                  // needs as the only way to eight drinks. The accent is
                  // unmistakable and it is what the pills already do: a pill
                  // under the cursor accents its digit and its icon, and this
                  // cell has neither — its label is all it has, so its label is
                  // what takes the accent.
                  hoverColor: root.accent
                  // The kit's own contract for an action button that is a
                  // cursor target is `hovered(bool)`, and it cannot be gated:
                  // by the time it arrives, *where* the pointer is has been
                  // thrown away (correction 34). A HoverHandler keeps the
                  // position, so the "+" answers the pointer through the same
                  // PointerMoveGate every pill does rather than through a
                  // second rule of its own.
                  HoverHandler {
                    id: moreHover
                    onPointChanged: root.selectFromPointer("drinks", moreButton.slot,
                      moreButton, { x: moreHover.point.position.x, y: moreHover.point.position.y })
                  }
                  width: presetGrid.cellWidth
                  height: root.presetHeight
                  size: root.presetHeight
                  // Worded rather than a bare glyph. As a full cell the "+" is
                  // the largest empty object on the panel, and it is also the
                  // only way to reach twelve of the seventeen drinks.
                  iconText: root.showAllPresets ? "− Less" : "+ More"
                  fontSize: Style.font.bodySmall
                  tooltipText: root.showAllPresets ? "Fewer  (m)" : "More drinks  (m)"
                  bordered: true
                  fontFamily: root.fontFamily
                  onClicked: root.showAllPresets = !root.showAllPresets
                }

                // A positioner skips invisible children, so an empty model here
                // leaves the grid exactly one row tall.
                Repeater {
                  model: root.showAllPresets ? root.overflowPresets : []

                  PresetButton {
                    id: overflowPill
                    required property var modelData
                    required property int index
                    width: presetGrid.cellWidth
                    height: root.presetHeight
                    compact: true
                    label: modelData.label
                    amountText: root.amountTextOf(modelData.mg)
                    keyLabel: Presets.digitFor(root.mainPresets.length + index)
                    icon: modelData.icon
                    tooltipText: Presets.labelOf(modelData)
                    hasCursor: root.cursorOn("drinks", moreButton.slot + 1 + index)
                    onHasCursorChanged: if (hasCursor) root.followCursor(overflowPill)
                    foreground: root.foreground
                    accent: root.accent
                    fontFamily: root.fontFamily
                    onPointerMoved: function(item, at) { root.selectFromPointer("drinks", moreButton.slot + 1 + index, item, at) }
                    onClicked: root.logPreset(modelData)
                  }
                }
              }

              // ---------------------------------------------------------- recent
              PanelSeparator {
                foreground: root.foreground
                visible: root.recentDoses.length > 0
              }

              PanelSectionHeader {
                visible: root.recentDoses.length > 0
                foreground: root.foreground
                fontFamily: root.fontFamily
                text: root.recentHeading
              }

              Column {
                width: parent.width
                spacing: Style.spacing.xxs

                Repeater {
                  model: root.recentDoses

                  DoseRow {
                    id: doseRow
                    required property var modelData
                    required property int index
                    width: parent.width
                    hasCursor: root.cursorOn("doses", index)
                    onHasCursorChanged: if (hasCursor) root.followCursor(doseRow)
                    onPointerMoved: function(item, at) { root.selectFromPointer("doses", index, item, at) }
                    label: modelData.dose.label
                    amountText: root.amountTextOf(modelData.dose.mg)
                    clock: root.clockOf(modelData.dose.ts)
                    ago: root.elapsedColumnOf(modelData.dose.ts)
                    amountWidth: Math.ceil(amountMetrics.width)
                    clockWidth: Math.ceil(clockMetrics.width)
                    agoWidth: Math.ceil(elapsedMetrics.width)
                    nudgeStepMinutes: Caffeine.NUDGE_MINUTES
                    foreground: root.foreground
                    accent: root.accent
                    urgent: root.urgent
                    fontFamily: root.fontFamily
                    unitsHint: root.unitsToggleHint
                    onNudged: function(minutes) { root.nudgeDose(modelData.index, minutes) }
                    onAmountClicked: root.toggleUnits()
                    onRemoved: if (root.store) root.store.removeAt(modelData.index)
                  }
                }
              }

            }

            // -------------------------------------------------- the settings page
            //
            // Everything the panel can be told, on one list, navigable with the
            // same cursor that walks the drinks (D33/D43). No dropdowns and no
            // dialogs: every row is a value in a pill with ‹ › on it, so the
            // page can be driven end to end from the keyboard, and the two
            // controls that want typing get a field in the same pill.
            Column {
              id: settingsPage
              visible: root.showSettings && !root.showCatalog && !root.showProfile
              width: parent.width
              spacing: Style.spacing.panelGap

              PanelSeparator { foreground: root.foreground }

              Item {
                width: parent.width
                height: settingsHeader.implicitHeight

                PanelSectionHeader {
                  id: settingsHeader
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  text: "SETTINGS"
                }

                Text {
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  textFormat: Text.PlainText
                  // Named rather than implied: this is the only page in the
                  // plugin you can be on and not be looking at the curve, so it
                  // says how to get back before you have to look for it.
                  text: "Esc to go back"
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }

              SettingList {
                id: settingsList
                rows: root.settingRows
                section: "settings"
                valueWidth: Math.ceil(settingValueMetrics.width)
              }

              // The helper script's own words, when it refuses. A control that
              // silently did nothing is the failure this page can most easily
              // hide, since the optimistic value is already on screen by then.
              Text {
                width: parent.width
                visible: root.config !== null && root.config.lastError !== ""
                textFormat: Text.PlainText
                text: root.config ? root.config.lastError : ""
                color: root.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
              }
            }

            // --------------------------------------------------- the drink catalog
            //
            // D31, on a page of its own (see showCatalog): the same list
            // component the settings page uses, over the user's drinks. Each row
            // carries the number key it answers to, so reordering renumbers in
            // front of you, and the row's amount is the amount the pill on the
            // other page will show — the same string through the same funnel.
            Column {
              id: catalogPage
              visible: root.showCatalog
              width: parent.width
              spacing: Style.spacing.panelGap

              PanelSeparator { foreground: root.foreground }

              Item {
                width: parent.width
                height: catalogHeader.implicitHeight

                PanelSectionHeader {
                  id: catalogHeader
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  text: "YOUR DRINKS"
                }

                Text {
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  textFormat: Text.PlainText
                  // What the order means, said once at the top rather than on
                  // every row: the first five are the row you log from, and the
                  // digits count down the list.
                  text: "The first " + Presets.MAIN_ROW_SIZE + " are the row  ·  Esc to go back"
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }

              SettingList {
                id: catalogList
                rows: root.catalogRows
                section: "catalog"
                valueWidth: Math.ceil(catalogValueMetrics.width)
                editWidth: Style.space(300)
                // Every row holds the digit's slot, including the ones past the
                // tenth that have no digit to paint, so every name starts at
                // one x rather than at two.
                badgeSlot: true
              }

              Text {
                width: parent.width
                visible: root.config !== null && root.config.lastError !== ""
                textFormat: Text.PlainText
                text: root.config ? root.config.lastError : ""
                color: root.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
              }
            }

            // -------------------------------------------------- the profile page
            //
            // D34, on a page of its own for D49's reason: five questions with a
            // sentence each, plus the arithmetic they add up to, is not five
            // more rows under eight settings.
            //
            // The derivation sits at the TOP, above the questions, and that is
            // D47's argument transposed one page down: the hero is above the
            // settings so you can watch the verdict move while you edit the
            // threshold under it, and the estimate is above the questions so you
            // can watch it move while you answer them. It is also the answer the
            // page exists to produce, and a page that makes you scroll past six
            // questions to reach its own conclusion has buried it.
            Column {
              id: profilePage
              visible: root.showProfile
              width: parent.width
              spacing: Style.spacing.panelGap

              PanelSeparator { foreground: root.foreground }

              Item {
                width: parent.width
                height: profileHeader.implicitHeight

                PanelSectionHeader {
                  id: profileHeader
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  text: "YOUR PROFILE"
                }

                Text {
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  textFormat: Text.PlainText
                  text: "Every figure is sourced  ·  Esc to go back"
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }

              // The arithmetic, factor by factor. Two columns, so the numbers
              // start at one x whatever is in them, measured off the widest
              // thing either column can hold — the same way the dose rows and
              // the setting pills are measured.
              Column {
                id: derivationBlock
                width: parent.width
                spacing: Style.spacing.xxs

                DerivationLine {
                  visible: Caffeine.derivationHasSteps(root.derivation)
                  mark: Caffeine.formatDerivationBase()
                  note: Caffeine.formatDerivationBaseNote()
                }

                Repeater {
                  model: root.derivation.steps

                  DerivationLine {
                    required property var modelData
                    mark: "× " + Caffeine.formatFactor(modelData.factor)
                    note: modelData.effect
                  }
                }

                // A rule under the working, because that is what an arithmetic
                // block looks like and the total has to read as a total. Its
                // width is the two columns and not the panel: a full-width line
                // over a 90px sum reads as a section break.
                Rectangle {
                  visible: Caffeine.derivationHasSteps(root.derivation)
                  width: Math.ceil(derivationMarkMetrics.width) + Style.spacing.lg * 3
                  height: Math.max(1, Style.spacing.hairline)
                  color: Qt.darker(root.foreground, 2.6)
                }

                DerivationLine {
                  mark: Caffeine.formatDerivationMark(root.derivation)
                  // The live half-life is passed only when it is NOT this one,
                  // which is what makes the line say so.
                  note: Caffeine.formatDerivationNote(root.derivation,
                    root.halfLifeIsCustom ? root.halfLifeHours : null)
                  total: true
                  muted: root.halfLifeIsCustom
                }
              }

              SettingList {
                id: profileList
                rows: root.profileRows
                section: "profile"
                valueWidth: Math.ceil(profileValueMetrics.width)
              }

              // The two things this page says it is NOT doing, and why.
              //
              // The science notes derive the bedtime threshold from a half-life
              // and the same notes say clearance and sleep sensitivity are
              // separate genes; the derivation, run at this model's ceiling,
              // would call 73 mg "clear" against a 76 mg residual the same
              // table records as still disrupting sleep. So it stays a setting
              // you move yourself.
              //
              // **And medication, since D100 took the fluvoxamine row off this
              // page.** That was the only drug interaction the model carried,
              // and what is honestly lost is that the estimate now runs short
              // for anyone on a strong CYP1A2 inhibitor. D13 is why that is
              // worth a sentence — and it is a sentence and not a row, because
              // the ask was for the question to go rather than to be replaced.
              Text {
                width: parent.width
                textFormat: Text.PlainText
                text: "None of this changes your sleep threshold. How fast you clear caffeine and how much it disturbs your sleep are separate things, so that one stays a setting you set yourself. Medication is not modelled at all — some drugs slow caffeine down a great deal, and this estimate does not know about any of them."
                color: Qt.darker(root.foreground, 2.0)
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
              }

              Text {
                width: parent.width
                visible: root.config !== null && root.config.lastError !== ""
                textFormat: Text.PlainText
                text: root.config ? root.config.lastError : ""
                color: root.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
              }
            }

            // ------------------------------------------------- the noted days
            //
            // D48's payoff, on a page of its own for D49's reason. Enter on a
            // row takes the timeline to that day — which is what makes this
            // navigation rather than a diary, and why the page hangs off the
            // curve rather than off the settings.
            //
            // What each row states is fixed by D13 and it is a short list: the
            // date, what was logged that day, what it came to at that day's
            // bedtime, and what you wrote. Nothing here correlates, scores,
            // averages or ranks, and no line anywhere reads "your data
            // suggests". The plugin shows the record; reading it is yours.
            Column {
              id: notesPage
              visible: root.showNotes
              width: parent.width
              spacing: Style.spacing.panelGap

              PanelSeparator { foreground: root.foreground }

              Item {
                width: parent.width
                height: notesHeader.implicitHeight

                PanelSectionHeader {
                  id: notesHeader
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                  foreground: root.foreground
                  fontFamily: root.fontFamily
                  text: "DAYS YOU HAVE NOTED"
                }

                Text {
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  textFormat: Text.PlainText
                  // The same rule as the footer's: on an empty page the only
                  // true thing left to say is the way out.
                  text: (root.hasNotes ? "↵ goes to that day  ·  " : "")
                    + "Esc to go back"
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }
              }

              SettingList {
                id: notesList
                rows: root.notesRows
                section: "notes"
                valueWidth: Math.ceil(noteValueMetrics.width)
              }

              Text {
                width: parent.width
                visible: root.notesBlocked
                textFormat: Text.PlainText
                text: root.noteError
                color: root.urgent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
              }

              // The empty state says the gesture rather than apologising for
              // the list: there is nothing wrong with not having written
              // anything yet, and the only thing worth saying is how to.
              Text {
                width: parent.width
                visible: root.notesRows.length === 0 && !root.notesBlocked
                textFormat: Text.PlainText
                text: "Nothing noted yet. Scroll the curve to a day with [ and ], then press n to write on it."
                color: root.dim
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                wrapMode: Text.WordWrap
              }
            }
          }

          // The keys, stated, and the corner that is always the same.
          //
          // Above the estimate line rather than below it, because the
          // disclaimer is the last word on the panel and a shortcut list
          // underneath it reads as part of it — and under the drink grid
          // instead, which was the other candidate, it captions the pills
          // while half of what it says is about the list below.
          Item {
            width: parent.width
            height: Math.max(keyHint.implicitHeight, beanButton.height)

            Text {
              id: keyHint
              anchors.left: parent.left
              anchors.right: helpHint.left
              anchors.rightMargin: Style.spacing.md
              anchors.verticalCenter: parent.verticalCenter
              // Empty in the quiet state, which is the whole of what quiet
              // does to this line now: the corner to its right is the same in
              // both states, so there is nothing left to fold.
              //
              // **D112 borrows the line for a moment.** A share is the only
              // thing this panel does whose result is somewhere else — every
              // other key changes something you are already looking at — so it
              // is the only one that has to say it happened. The legend is the
              // right place to say it: it is the line that talks about keys,
              // it is already the dimmest thing on the panel so a brief bright
              // sentence there is unmissable without being loud, and borrowing
              // it costs nothing, because a legend you are not reading is not
              // a legend you lose. It says so in the quiet state too, where
              // the line is otherwise empty and the notification would be the
              // only acknowledgement at all.
              visible: root.keyHintText !== "" || root.shareToast !== ""
              textFormat: Text.PlainText
              text: root.shareToast !== "" ? root.shareToast : root.keyHintText
              color: root.shareToast !== "" ? root.accent : Qt.darker(root.foreground, 1.8)
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }

            // ------------------------------------------------- the corner
            //
            // **D94, and it is the third decision about this bean.** D87
            // rejected it *as the settings mark* and D93 gave it the quiet
            // line *as the plugin's own mark*, on the sentence "beside ? help
            // it is not claiming to be a verb". It is now exactly that verb,
            // and what changed is not the argument but the line. D87's
            // objection was to a bean **instead of** a gear on a line that
            // also said "s settings" — two marks and a word competing to mean
            // one thing, where the render showed the native one winning. This
            // is **one mark at the corner**, with "s settings" still on the
            // legend beside it on the main page, so the line teaches the mark
            // rather than competing with it. D87's ❌ stands unchanged.
            //
            // **Quiet is the state where the bean is unglossed** — nothing on
            // that line names settings at all — so it is the state this was
            // rendered hardest in, and the state where the tooltip stops being
            // a nicety.
            //
            // The order was rendered both ways: the bean at the extreme right
            // where the gear was, inheriting its position and its muscle
            // memory, against the group *bean then "? help"* flush right,
            // which is the user's own wording. The bean on the outside won,
            // and the reason is visible in both captures: the corner is a
            // *mark with a caption*, and a caption sits under or before the
            // thing it names, never after it — with the bean inboard the two
            // read as two items on a line that has run out, which is the one
            // thing the fixed corner exists to stop being.
            Text {
              id: helpHint
              anchors.right: beanButton.left
              anchors.rightMargin: Style.spacing.sm
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              // Dim, and it stays dim: this is a key you may press, where the
              // bean beside it is a control you may hit. The user asked for
              // exactly that pair of weights.
              text: root.helpHintText
              color: Qt.darker(root.foreground, 1.8)
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            // The bean is the button now, and two mechanical things had to be
            // got right that no still frame with the pointer parked away can
            // show.
            //
            // **The kit's button recolours its own `Text`, and a `Shape` child
            // is not that `Text`.** But the gear it replaces never changed
            // colour either: `hoverColor` defaults to `foreground` and the
            // gear set only `foreground`, so what answered the pointer was
            // always the *fill* and never the glyph. So the faithful port is a
            // bean at one colour over a fill that moves — which is what this
            // is, and it needs no `hovered(bool)` wiring to answer the pointer.
            //
            // **`Bean.qml` cuts its seam by painting `voidColor` over the
            // body**, and the caller supplies that colour because only the
            // caller knows what is behind the mark. Inside a button with a
            // hover fill that stops being true: the seam would go on painting
            // the panel's background over a fill that is no longer it, and the
            // bean would grow a wrong-coloured crease on hover. Of D94's three
            // ways out this is the second — composite the fill and pass it —
            // because it is the only one that keeps both the gear's hover
            // treatment and D93's solid bean. It is a real calculation and not
            // a token: the kit's fills are an alpha over
            // `Color.popups.background`, and `beanButton.color` carries its own
            // 60ms animation, so the seam follows the fill in and out.
            PanelActionButton {
              id: beanButton
              anchors.right: parent.right
              anchors.verticalCenter: parent.verticalCenter
              tooltipText: root.showSettings ? "Back  (Esc)" : "Settings  (s)"
              hasCursor: false
              foreground: root.foreground
              fontFamily: root.fontFamily
              onClicked: root.toggleSettings()

              Bean {
                id: bean
                anchors.centerIn: parent
                // The gear's *glyph* size rather than the button's slot: the
                // slot is 22 or more and a bean drawn at that is a bigger mark
                // than anything else on the line, and louder than the hero's
                // cup is at 34 (D87's own objection, at a new size).
                height: Style.font.bodySmall + Style.spacing.xxs
                // Bright, at the gear's weight — the user's own word for it,
                // and the one thing that separates the mark from its caption.
                color: root.foreground
                solid: true
                voidColor: root.overPopup(beanButton.color)
              }
            }
          }

          // D13: the estimate is named as one, every time, and the half-life
          // it rests on is stated rather than implied.
          //
          // "Every time" is what D51 had to be built around. The line does not
          // stop existing when the panel goes quiet; it moves into the card
          // behind "?", where the footer's own last item is still pointing at
          // it, and it is the same string from the same function in both
          // places. A disclaimer with two wordings is two disclaimers.
          Text {
            width: parent.width
            visible: !root.quiet
            textFormat: Text.PlainText
            text: Caffeine.formatEstimateNote(root.halfLifeHours, root.units, root.cupMg)
            color: Qt.darker(root.foreground, 1.8)
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }
        }
      }

      // ---------------------------------------------------- the icon picker
      //
      // D53. The same scrim-and-card the "?" list uses, because it is the same
      // kind of thing: something over the panel that the panel's own keys
      // reach into. Twelve cells four wide, walked with the arrows the whole
      // plugin is walked with, Enter picks and Esc leaves without changing
      // anything.
      //
      // The name of the highlighted glyph is printed under the grid. Twelve
      // marks with nothing written on them is a rebus, and the stored value is
      // a codepoint nobody can type — so the card names what the cursor is on,
      // which is also the only way "No icon" can be a cell at all.
      Rectangle {
        anchors.fill: parent
        visible: root.showIconPicker
        color: Util.alpha(Color.popups.background, 0.82)

        MouseArea {
          anchors.fill: parent
          hoverEnabled: true
          onClicked: root.closeIconPicker()
        }

        BorderSurface {
          anchors.centerIn: parent
          width: Math.min(parent.width, iconContent.implicitWidth + Style.spacing.panelPadding * 2)
          height: iconContent.implicitHeight + Style.spacing.panelPadding * 2
          color: Color.popups.background
          borderSpec: Border.flat(root.accent, Style.normalBorderWidth)
          radius: Style.cornerRadius

          MouseArea { anchors.fill: parent; onClicked: {} }

          Column {
            id: iconContent
            anchors.centerIn: parent
            spacing: Style.spacing.lg

            PanelSectionHeader {
              // Since D31 the name in here is the user's own text, and it can
              // be a 24-character label with a 24-character detail after it.
              // Bounded by the grid below rather than by itself, so the card
              // stays the width of the thing it is for.
              width: Math.min(implicitWidth, iconGrid.implicitWidth)
              elide: Text.ElideRight
              foreground: root.foreground
              fontFamily: root.fontFamily
              // Says which drink, because the row it is about is behind the
              // scrim: a picker that does not name its subject is a picker you
              // have to close to find out what you were changing.
              text: root.canPickIcon
                ? ("ICON FOR " + Presets.labelOf(root.iconTargetRow.entry).toUpperCase())
                : "ICON"
            }

            Grid {
              id: iconGrid
              columns: root.iconColumns
              spacing: Style.spacing.md

              Repeater {
                model: root.iconChoices

                BorderSurface {
                  id: iconCell
                  required property var modelData
                  required property int index

                  readonly property bool hot: root.iconIndex === index
                  readonly property bool current: root.canPickIcon
                    && Presets.iconIndexOf(root.iconTargetRow.entry.icon) === index

                  width: Style.space(56)
                  height: Style.space(48)
                  radius: Style.cornerRadius
                  color: hot ? Style.hoverFillFor(root.foreground, root.accent)
                             : Style.normalFillFor(root.foreground, root.accent)
                  borderSpec: hot
                    ? Border.controlSpec("hover-cursor", root.foreground, root.accent)
                    : Border.controlSpec("normal", root.foreground, root.accent)

                  Behavior on color { ColorAnimation { duration: Caffeine.MOTION_TINT_MS } }

                  Text {
                    anchors.centerIn: parent
                    textFormat: Text.PlainText
                    // "No icon" is a cell like any other and it has to look
                    // like one, so it draws the em dash the hero uses for a
                    // reading it does not have rather than an empty box.
                    text: modelData.icon === Presets.ICON_NONE ? "—" : modelData.icon
                    color: parent.hot ? root.accent : root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.subtitle
                  }

                  // The drink's current icon, marked so the card says what it
                  // is changing *from* — the same job the settings page's
                  // value pill does for every other stored value.
                  Rectangle {
                    visible: parent.current
                    anchors.horizontalCenter: parent.horizontalCenter
                    anchors.bottom: parent.bottom
                    anchors.bottomMargin: Style.spacing.xs
                    width: Style.space(12)
                    height: Math.max(1, Style.spacing.hairline)
                    color: root.accent
                  }

                  MouseArea {
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    // D82. The picker's cells do not move, but the card
                    // opens *under* wherever the pointer is resting — and an
                    // open that stole the cursor to whatever cell happened to
                    // be beneath it would undo the whole point of opening on
                    // the drink's current icon.
                    onPositionChanged: function(mouse) {
                      root.selectIconFromPointer(index, iconCell, mouse)
                    }
                    onClicked: root.chooseIcon()
                  }
                }
              }
            }

            Text {
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              textFormat: Text.PlainText
              text: root.iconChoices[root.iconIndex]
                ? root.iconChoices[root.iconIndex].name : ""
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              font.bold: true
            }

            Text {
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              textFormat: Text.PlainText
              text: "↵  choose  ·  Esc  leave it as it was"
              color: Qt.darker(root.foreground, 1.8)
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }
        }
      }

      // ------------------------------------------------------- the key list
      //
      // Over the panel rather than beside it: the footer line is what is
      // always on screen, and this is what it promises. A scrim and a card,
      // which is the shell's own idiom for a modal (see Ui/ConfirmDialog) —
      // the first attempt washed the whole panel and left the list floating
      // in the empty half of a tall surface. Opened and closed with "?", and
      // Esc takes it before it takes the panel.
      Rectangle {
        anchors.fill: parent
        visible: root.showKeys
        color: Util.alpha(Color.popups.background, 0.82)

        // The scroll underneath is interactive, so the scrim has to actually
        // eat the clicks it covers.
        MouseArea {
          anchors.fill: parent
          hoverEnabled: true
          onClicked: root.showKeys = false
        }

        BorderSurface {
          id: keysCard
          anchors.centerIn: parent
          width: Math.min(parent.width, keysContent.implicitWidth + Style.spacing.panelPadding * 2)
          height: keysContent.implicitHeight + Style.spacing.panelPadding * 2
          color: Color.popups.background
          borderSpec: Border.flat(root.accent, Style.normalBorderWidth)
          radius: Style.cornerRadius

          MouseArea { anchors.fill: parent; onClicked: {} }

          Column {
            id: keysContent
            anchors.centerIn: parent
            spacing: Style.spacing.lg

            PanelSectionHeader {
              foreground: root.foreground
              fontFamily: root.fontFamily
              text: "KEYS"
            }

            // Two Columns in a Row, which is the honest shape for a layout
            // described column by column (D83). The Grid this replaced filled
            // row-major while its comment claimed otherwise, so the model had
            // to be interleaved to read down a column — and the moment the
            // columns are named, interleaving them is work done twice.
            Row {
              spacing: Style.spacing.xxl

              Repeater {
                model: root.keyBindings

                Column {
                  required property var modelData
                  spacing: Style.spacing.sm

                  Repeater {
                    model: parent.modelData

                    Row {
                      required property var modelData
                      Text {
                        textFormat: Text.PlainText
                        width: Math.ceil(keysMetrics.width) + Style.spacing.xxl
                        text: modelData.keys
                        color: root.accent
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.bodySmall
                        font.bold: true
                      }
                      Text {
                        textFormat: Text.PlainText
                        text: modelData.what
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.bodySmall
                      }
                    }
                  }
                }
              }
            }

            // D51. Quiet, this card is the *only* place the estimate line is,
            // so it is here rather than left under a panel that is no longer
            // drawing it — and it is here only then, because the alternative
            // is the same sentence twice on one screen eighty pixels apart,
            // which is the build D61 threw away for the day caption.
            //
            // Under a rule, and last, which puts the card in the same order
            // the panel is: the keys, then the estimate as the last word.
            // The rule is what stops this from reading as a third column of
            // the key grid — it is not a binding, and prose set among
            // bindings reads as one. D83 took the way-out caption out from
            // between the two and the order still holds, because the card now
            // ends where the panel ends.
            PanelSeparator {
              visible: root.quiet
              foreground: root.foreground
            }

            Text {
              visible: root.quiet
              width: Math.min(implicitWidth, keysCard.width - Style.spacing.panelPadding * 2)
              textFormat: Text.PlainText
              text: Caffeine.formatEstimateNote(root.halfLifeHours, root.units, root.cupMg)
              color: Qt.darker(root.foreground, 1.8)
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              wrapMode: Text.WordWrap
            }
          }
        }

        // One width for the key names, measured off the widest, the same way
        // the dose rows are measured.
        TextMetrics {
          id: keysMetrics
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          font.bold: true
          text: "‹ ›  - +"
        }
      }
    }

    // --------------------------------------------------------- the share stage
    //
    // Off the side of the surface, never composited, and grabbed on demand.
    // The offset is not a margin — nothing is being laid out here — so it is a
    // plain number rather than a Style token: the card has to be somewhere the
    // compositor will never put it, and any coordinate outside the surface
    // does. See `captureShare` for why this renders at all when it is never
    // drawn.
    //
    // It is a live item and not a snapshot taken at capture time, so it is
    // already laid out when `c` is pressed: the Curve rebuilds its path
    // imperatively and a card built inside the grab call would be captured a
    // frame before its own chart existed.
    ShareCard {
      id: shareStage
      x: -root.shareWidth
      y: -root.shareHeight

      levelText: Caffeine.formatAmountApprox(root.level, root.units, root.cupMg)
      headlineText: Caffeine.projectionHeadline(root.projection, root.units,
        root.clockOf(root.projection.bedtimeAt), root.cupMg)
      captionText: Caffeine.projectionCaption(root.projection).toUpperCase()
      estimateNote: Caffeine.formatEstimateNote(root.halfLifeHours, root.units, root.cupMg)
      // The panel draws this line only when the window has moved off today,
      // because on the panel you already know which day you are looking at.
      // On the card nobody does, so it is always drawn — and it therefore
      // cannot be `viewDayLine`, which is anchored at `captionAnchorTs` and so
      // points at the *pinned* day whenever the caption is not being forced.
      // At home with no pin that anchor is zero, and the first render of this
      // card duly said "20702 days ago · 0 mg" under a chart of today.
      dayCaption: root.shareDayLine
      hasDoses: root.hasDoses
      fill: root.fill

      samples: root.samples
      curveMax: root.curveMax
      fromTs: root.fromTs
      toTs: root.toTs
      nowTs: root.nowSeconds
      recordFromTs: root.oldestDoseTs
      bedtimeTs: root.viewBedtimeTs
      bandLabel: root.bedtimeCaption
      ghostSamples: root.ghostSamples
      ghostVisible: root.ghostVisible
      axisNowVisible: !root.panned && root.windowHasNow
      axisLabelOf: root.axisLabelOf

      foreground: root.foreground
      accent: root.accent
      dim: root.dim
      band: root.bandColor(root.projection.band)
      fontFamily: root.fontFamily
    }
  }
}
