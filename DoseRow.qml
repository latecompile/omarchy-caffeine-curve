import QtQuick
import qs.Commons
import qs.Ui

import "Caffeine.js" as Caffeine

// One logged drink, in five columns:
//
//   [ name ................. ][ 125 mg ][ 4h ][ ‹ 9:22 PM › ][ ✕ ]
//
// Two affordances, deliberately separated:
//
//   the chevrons → move the drink in 15-minute steps, both ways, and into
//                  the future. No date picker, ever.
//   the ×        → deletes it.
//
// The plan says "tap to delete", and the delete is a distinct target at the
// row's trailing edge rather than the whole row, because a row that deletes
// wherever you touch it is a trap sitting directly under a tap-to-correct
// control. The × uses the kit's urgent hover, which is what every other
// destructive row action in the shell looks like.
//
// **Every column is a width handed down by the panel**, and that is load
// bearing rather than tidy. Until Phase 6 each one hugged its own text, so
// `mg` sat at a different x on every row, and the clock pill swapped its text
// on hover — which moved the whole row under the pointer that was aiming at
// it. The chevrons are a third width on that same element, so they could not
// be built until the columns were fixed. They occupy their slots whether or
// not they are painted: zero idle ink, full-time width.
Item {
  id: root

  property string label: ""
  // Formatted by the panel, which owns the units setting. The row renders
  // strings and never converts, so a cups/mg change cannot reach it half-done.
  property string amountText: ""
  property string clock: ""
  property string ago: ""

  // One width per column, measured by the panel off the widest row.
  property real amountWidth: 0
  property real agoWidth: 0
  property real clockWidth: 0

  property color foreground: Color.foreground
  property color accent: Color.accent
  property color urgent: Color.urgent
  property string fontFamily: Style.font.family

  // Caffeine.NUDGE_MINUTES, handed down rather than repeated here, so the
  // keyboard and the chevrons cannot end up disagreeing about the step.
  property int nudgeStepMinutes: 15

  // Paint from the panel's single cursor, never from local hover — see the
  // CursorSurface contract. Hover is reported upward instead.
  property bool hasCursor: false

  readonly property color dim: Qt.darker(foreground, 1.45)
  readonly property real chevronSlot: Style.space(13)

  // Discoverable exactly when you are pointing at the thing they act on
  // (D20). Under the keyboard cursor too, so the panel is drivable without a
  // pointer — nothing else on the row would say the keys exist.
  readonly property bool showNudge: root.hasCursor || rowHover.hovered

  // The amount's underline follows the same rule as the chevrons rather than
  // pure mouse hover: the panel is fully keyboard-driven, so an affordance
  // that only a pointer can reveal is one a keyboard user never learns about.
  // Unlike the hero's number this is not faintly drawn at rest — five rows of
  // permanent underline is texture, not a hint.
  readonly property bool showAmountHint: root.hasCursor || amountMouse.containsMouse

  // What the amount's tooltip says it will do. Handed down rather than decided
  // here, for the same reason the amount text is: the row does not know which
  // unit is in force, only what it was told to print.
  property string unitsHint: ""

  signal nudged(int minutes)
  signal removed()
  // D82. A position rather than a boolean — see PresetButton for why.
  signal pointerMoved(var item, var at)
  signal amountClicked()

  implicitHeight: Math.max(Style.spacing.popupRowHeight, remove.height)
  height: implicitHeight

  component Chevron: Item {
    id: chevron

    property string glyph: ""
    property int minutes: 0

    width: root.chevronSlot
    height: parent ? parent.height : 0
    opacity: root.showNudge ? 1 : 0
    Behavior on opacity { NumberAnimation { duration: Caffeine.MOTION_REVEAL_MS } }

    Text {
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: chevron.glyph
      color: chevronMouse.containsMouse ? root.accent : root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
    }

    MouseArea {
      id: chevronMouse
      anchors.fill: parent
      hoverEnabled: true
      // Painted and clickable together: an invisible target that still
      // responds is worse than no target at all.
      enabled: root.showNudge
      cursorShape: Qt.PointingHandCursor
      onClicked: root.nudged(chevron.minutes)
    }
  }

  CursorSurface {
    anchors.fill: parent
    hasCursor: root.hasCursor
    foreground: root.foreground
    accent: root.accent
  }

  HoverHandler {
    id: rowHover
    // `hovered` still drives this row's own chevrons below, which is a
    // pointer affordance and correctly follows the pointer. What must not
    // follow it is the panel's cursor, so that goes out as a position.
    onPointChanged: root.pointerMoved(root, rowHover.point.position)
  }

  Text {
    id: name
    anchors.left: parent.left
    anchors.leftMargin: Style.spacing.sm
    anchors.verticalCenter: parent.verticalCenter
    width: Math.max(0, amount.x - x - Style.spacing.md)
    textFormat: Text.PlainText
    text: root.label === "" ? "Logged" : root.label
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    elide: Text.ElideRight
  }

  // D36. The amount is a click target: clicking any displayed quantity flips
  // the whole panel between mg and cups. Underlined under the cursor rather
  // than pilled — the clock beside it is already a pill, and two bordered controls
  // on one row would read as a pair of buttons rather than as a reading with
  // one editable time on it.
  Item {
    id: amount
    anchors.right: elapsed.left
    anchors.rightMargin: Style.spacing.lg
    anchors.verticalCenter: parent.verticalCenter
    width: root.amountWidth
    height: amountText.implicitHeight + Style.spacing.xs

    Text {
      id: amountText
      anchors.right: parent.right
      width: parent.width
      horizontalAlignment: Text.AlignRight
      textFormat: Text.PlainText
      text: root.amountText
      color: root.showAmountHint ? root.foreground : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Rectangle {
      anchors.right: parent.right
      width: Math.min(parent.width, amountText.implicitWidth)
      y: amountText.implicitHeight
      height: Math.max(1, Style.spacing.hairline)
      color: root.accent
      opacity: root.showAmountHint ? 1 : 0
      Behavior on opacity { NumberAnimation { duration: Caffeine.MOTION_REVEAL_MS } }
    }

    MouseArea {
      id: amountMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: root.amountClicked()
    }

    PanelToolTip {
      visible: amountMouse.containsMouse && root.unitsHint !== ""
      text: root.unitsHint
      fontFamily: root.fontFamily
    }
  }

  Text {
    id: elapsed
    anchors.right: clockPill.left
    anchors.rightMargin: Style.spacing.md
    anchors.verticalCenter: parent.verticalCenter
    width: root.agoWidth
    horizontalAlignment: Text.AlignRight
    textFormat: Text.PlainText
    text: root.ago
    color: root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  // The tap target for the nudge. Bordered while live so it reads as a
  // control rather than as a label that happens to move when you touch it.
  BorderSurface {
    id: clockPill
    anchors.right: remove.left
    anchors.rightMargin: Style.spacing.sm
    anchors.verticalCenter: parent.verticalCenter
    width: root.clockWidth + root.chevronSlot * 2 + Style.spacing.sm * 2
    height: clockText.implicitHeight + Style.spacing.xs * 2
    radius: Style.cornerRadius
    color: root.showNudge
      ? Style.hoverFillFor(root.foreground, root.accent)
      : "transparent"
    borderSpec: root.showNudge
      ? Border.controlSpec("hover-cursor", root.foreground, root.accent)
      : Border.none()

    Behavior on color { ColorAnimation { duration: Caffeine.MOTION_TINT_MS } }

    Chevron {
      anchors.left: parent.left
      anchors.leftMargin: Style.spacing.xs
      glyph: "‹"
      minutes: -root.nudgeStepMinutes
    }

    Text {
      id: clockText
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: root.clock
      color: root.showNudge ? root.foreground : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Chevron {
      anchors.right: parent.right
      anchors.rightMargin: Style.spacing.xs
      glyph: "›"
      minutes: root.nudgeStepMinutes
    }

    PanelToolTip {
      visible: rowHover.hovered
      text: "Move this drink earlier or later"
      fontFamily: root.fontFamily
    }
  }

  PanelActionButton {
    id: remove
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    iconText: "✕"
    tooltipText: "Delete"
    foreground: root.foreground
    hoverColor: root.urgent
    fontFamily: root.fontFamily
    fontSize: Style.font.bodySmall
    onClicked: root.removed()
  }
}
