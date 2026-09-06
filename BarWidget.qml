import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

import "Caffeine.js" as Caffeine

// The bar mark: a cup that empties, with the estimate beside it.
//
// Chosen at Phase 2 against a sparkline variant and a typographic one, rendered
// side by side in this bar across five themes. The cup won on two counts — it
// is the only candidate that is both legible at fifteen pixels and recognisably
// about coffee, and it is the same component the panel's hero draws at 34.
//
// The panel hangs off it. The lifecycle contract below — injectPanel, opened,
// open, close, closeForPopoutSwitch — is weather's, and the names are load
// bearing: Bar.findPanelWidget looks up a popout by exactly these on the bar
// widget, not on the panel nested inside it.
BarWidget {
  id: root
  moduleName: "latecompile.caffeine-curve"

  // ------------------------------------------------------------- settings
  //
  // Not the bar's `settings` — ours (D43). Everything the user can change
  // lives in ~/.local/state/omarchy/settings/caffeine-curve.json, read by the
  // Settings component below and written by the helper script beside it, the
  // way the first-party weather panel keeps its location. This widget owns the
  // one reader and injects it into the panel, exactly as it does the dose
  // Store, so the mark and the panel can never disagree about a setting.
  //
  // **`omarchy bar set` is inert for this widget.** Inline settings on the
  // shell.json entry are not read, and the manifest declares no schema, so a
  // settings form landing in a later Omarchy cannot write somewhere we ignore.
  //
  // Every read goes through Caffeine's sanitisers rather than Number() at the
  // call site: these values have been through a text field and a JSON file a
  // hand edit can reach, and this runs unsandboxed inside the shell process.
  Settings { id: config }

  readonly property real halfLifeHours: config.halfLifeHours
  readonly property string units: config.units
  // D84. The mark and the hero are the same reading, so a cup the user has
  // moved has to reach both — the bar saying "2.3 cups" beside a panel saying
  // "1.6 cups" is defect #6's complaint arriving through the units.
  readonly property real cupMg: config.cupMg

  // D89. Whether the reading is painted beside the cup: "always", "never", or
  // "moving" — for one Tmax after a drink, which is as long as the number is
  // still climbing. `barSeconds` is the coarse clock the glide already keeps;
  // the boundary it is being compared against is 48 minutes out, so a minute
  // of lag on either side of it is not a thing anyone can see.
  readonly property string barNumber: config.barNumber
  property int barSeconds: 0
  readonly property bool numberShown: Caffeine.barNumberShown(
    root.barNumber, store.doses, root.barSeconds, root.halfLifeHours)

  // A half-life change reshapes the curve the mark rides, so the reading has
  // to be recomputed rather than waited for: the next tick is up to a minute
  // away and the setting was just changed by someone watching the bar.
  onHalfLifeHoursChanged: {
    if (!root.ready) return
    root.apply(store.nowSeconds(), Caffeine.MOTION_POUR_MS, Easing.OutCubic)
    resumeGlide.restart()
  }

  // The displayed reading. These are animated, not stepped: every tick the
  // widget computes where the curve will be one tick from now and glides there
  // linearly, so the mark rides the Bateman curve itself — a fresh dose reads
  // 0mg (correct: nothing is absorbed yet) and then the cup visibly fills over
  // the next hour as the caffeine actually arrives. That rise is the model
  // doing visible work, and the reason a flat one-shot easing was not enough.
  property real level: 0
  property real fill: 0

  // Per-segment curvature at 60s resolution is far below what the rounding
  // can show, so the segments are linear; easing would scallop the motion.
  property int motionMs: 0
  property int motionEasing: Easing.Linear

  readonly property color markColor: root.bar ? root.bar.barForeground : Color.bar.text

  Store {
    id: store

    // D52. The one place a dose is *added* — which is the only edit a pour is
    // true about. A delete, a nudge and an external write to doses.json all
    // reach onDosesChanged below and none of them poured anything; this signal
    // is what separates them, and it was already there, emitted by add() since
    // Phase 1 with nothing listening.
    onLogged: markCup.pour()
    // First load lands before `loaded` flips, so it snaps into place; anything
    // after that is a real edit — a log, a delete, an external write to
    // doses.json — and gets a quick acknowledgement at `now` before the glide
    // resumes. For a fresh dose the ack barely moves (the level at Δt = 0 is
    // the level without the dose), but a deletion drops immediately rather
    // than draining over a minute, and a rescaled cup settles visibly.
    onDosesChanged: {
      if (!root.ready) return
      // A drink logged now opens the window now: the next tick is up to a
      // minute away and the whole point of "moving" is that the number is
      // there for the drink you just had.
      root.barSeconds = store.nowSeconds()
      if (!store.loaded) {
        root.apply(store.nowSeconds(), 0, Easing.Linear)
        root.glideTick()
      } else {
        root.apply(store.nowSeconds(), Caffeine.MOTION_POUR_MS, Easing.OutCubic)
        resumeGlide.restart()
      }
      glideTimer.restart()
    }
  }

  // The notes (D48). Data, like the doses, and read here for the same reason
  // the doses and the settings are: one FileView per file for the whole
  // plugin, injected into the panel, so nothing can hold two views of one
  // file. The bar mark itself shows nothing from it — a note is about a day,
  // and the mark is about now.
  Notes { id: notes_ }

  // Guards against the Store's first assignment arriving while this component
  // is still being built, before the animation plumbing exists.
  property bool ready: false
  Component.onCompleted: {
    root.ready = true
    root.barSeconds = store.nowSeconds()
    root.apply(store.nowSeconds(), 0, Easing.Linear)
    root.glideTick()
  }

  function apply(atSeconds, ms, easingType) {
    root.motionMs = ms
    root.motionEasing = easingType
    var doses = store.doses
    root.level = Caffeine.levelAt(doses, atSeconds, root.halfLifeHours)
    root.fill = Caffeine.cupFill(doses, atSeconds, root.halfLifeHours)
  }

  // Aim one tick ahead and take the whole tick to get there. Each retarget
  // starts from wherever the previous glide left the display, so the motion is
  // continuous and lands on the true value at every tick boundary.
  function glideTick() {
    var horizon = glideTimer.interval / 1000
    root.barSeconds = store.nowSeconds()
    root.apply(store.nowSeconds() + horizon, glideTimer.interval, Easing.Linear)
  }

  Behavior on level {
    NumberAnimation { duration: root.motionMs; easing.type: root.motionEasing }
  }
  Behavior on fill {
    NumberAnimation { duration: root.motionMs; easing.type: root.motionEasing }
  }

  // A minute is finer than the readout can show: the level moves by less than
  // 1mg between ticks except right after a dose, and it costs arithmetic over
  // a few dozen numbers.
  Timer {
    id: glideTimer
    interval: 60000
    running: true
    repeat: true
    onTriggered: root.glideTick()
  }

  // Lets a dose edit's acknowledgement land before the glide takes the reins
  // again. The half-second phase offset this leaves against glideTimer is
  // worth less than a milligram of display error.
  Timer {
    id: resumeGlide
    interval: 450
    repeat: false
    onTriggered: root.glideTick()
  }

  // ------------------------------------------------------------ the panel

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
    // One FileView over doses.json for the whole plugin: the bar reads the
    // same store the panel writes, so a logged dose reaches the mark without
    // a round trip through the file watcher.
    if ("store" in target) target.store = store
    // And one FileView over the settings, for the same reason: the mark reads
    // the half-life the panel writes without a round trip through the watcher.
    if ("config" in target) target.config = config
    if ("notes" in target) target.notes = notes_
  }

  onBarChanged: injectPanel()

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item && panelLoader.item.openFromHotkey) panelLoader.item.openFromHotkey()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  // Forwarded so this widget can stand in for the panel as the bar's popout
  // identity: Bar.requestPopout prefers closeForPopoutSwitch over close.
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  // The plugin's whole IPC surface, in the one scope that holds both the store
  // and the panel (D16). It went in at Phase 1 as the only way to prove the
  // round trip before there was anything to click; having built the panel, it
  // stays, because it does a different job. The panel is for looking at the
  // curve; this is for logging a coffee without looking at anything —
  // `omarchy-shell caffeine-curve log 125 Espresso` on a Hyprland keybind is
  // strictly fewer actions than opening the panel and tapping. Method names
  // are API from here.
  IpcHandler {
    target: "caffeine-curve"

    function log(mg: string, label: string): string {
      var dose = store.add(Number(mg), label)
      return dose ? JSON.stringify(dose) : "refused"
    }

    function list(): string {
      return JSON.stringify(store.doses)
    }

    function level(halfLife: string): string {
      return String(store.levelNow(Number(halfLife) || root.halfLifeHours))
    }

    function clear(): string {
      store.clear()
      return "ok"
    }

    // The share, without opening anything. Same argument as `log`: on a
    // Hyprland keybind this is one keystroke where the panel route is three,
    // and it is the only way to get the card while another window is focused.
    // The panel is where the picture is composed, so this is a forward.
    function share(): string {
      var target = panelLoader.item
      if (!target || typeof target.captureShare !== "function") return "no panel"
      return target.captureShare() ? "ok" : "refused"
    }

    function open(): void { root.open() }
    function close(): void { root.close() }
    function toggle(): void { root.togglePanel() }
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar

    // The label is a cup and a number rather than a string, so WidgetButton's
    // own Text is turned off and the content sizes the slot instead.
    labelVisible: false
    hasVisualContent: true
    // Phase 3 left this off on purpose — a pointing-hand cursor over something
    // that does nothing is a lie. There is a panel now, so it is true.
    pressable: true
    active: root.opened

    onPressed: function(mouseButton) { root.togglePanel() }

    // Below 20mg the mark has nothing to say, so the whole button recedes the
    // way every other idle bar widget does. Dimming only the liquid was built
    // and compared at Phase 3: at that level the liquid is a two-pixel sliver,
    // so dimming it is invisible and the widget stays loud. The threshold is a
    // visual cue only — no claim attached (D13).
    dimmed: root.level < Caffeine.DIM_THRESHOLD_MG
    // **D89's real decision, and the slot simply follows its content.** Four
    // ways out were rendered on the bar with the number in and out of its
    // window. *Holding* the width — the number kept in the layout and only
    // stopped from painting, which is the only version that reserves it
    // exactly — leaves a gap the width of the number between the cup and the
    // next widget, and that reads as something that failed to load rather
    // than as a tidier bar; it also spends exactly the space the setting was
    // asked for. Reserving it by measuring the string instead recentres the
    // Row, so the *cup* slides half the number's width, and the cup is the
    // mark. Animating the width has no precedent in the shell.
    //
    // And the render supplied the argument that settles it: **this slot
    // already reflows.** The reading is monospaced, so the widget is one
    // character wider at 100 mg than at 99, and at 3 / 44 / 217 mg the bar's
    // right edge measured 10 px and then 9 px apart. Letting the number come
    // and go scales a behaviour that has shipped since Phase 3; it does not
    // introduce one.
    fixedWidth: root.vertical
      ? -1
      : Math.round(mark.implicitWidth + Style.spaceReal(horizontalMargin) * 2)
    tooltipText: Caffeine.formatAmountApprox(root.level, root.units, root.cupMg) + " estimated"

    Row {
      id: mark
      anchors.centerIn: parent
      spacing: Style.spacing.md

      Cup {
        id: markCup
        anchors.verticalCenter: parent.verticalCenter
        height: Style.bar.statusSlot * 0.80
        fill: root.fill
        color: root.markColor
      }

      Text {
        // D89. Out of the layout, not just unpainted: the slot is sized to
        // its content and closing up is what the setting was asked for.
        visible: root.numberShown
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: Caffeine.formatAmount(root.level, root.units, root.cupMg)
        color: root.markColor
        font.family: root.bar ? root.bar.fontFamily : Style.font.family
        font.pixelSize: Style.font.body
        renderType: Text.NativeRendering
      }
    }
  }
}
