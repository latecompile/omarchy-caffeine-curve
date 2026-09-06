import QtQuick
import qs.Commons
import qs.Ui

import "Caffeine.js" as Caffeine

// One line of the settings view:
//
//   Bedtime                                        [ ‹ 11:00 PM › ]
//   Everything about sleep is measured back from this.
//
// The value sits in the same bordered pill the dose row uses for its clock,
// with the same chevrons appearing only while the row is under the cursor —
// deliberately, so the two pages of this panel teach the same gesture once.
// Adjusting is ‹ ›, activating is Enter or a click on the pill: for a switch
// or a two-way choice those are the same thing, and for the bedtime they are
// not (Enter types, ‹ › nudges by a quarter hour).
//
// Like DoseRow, this renders strings and never converts. The panel owns the
// units setting and formats everything through amountTextOf, so a control here
// cannot show a number in a unit the rest of the panel is not using.
//
// Phase 9 made it the drink catalog's row as well, which cost three optional
// parts and no new layout: a badge for the number key the drink answers to, a
// pair of reorder chevrons, and the ✕ the dose rows already use. A catalog row
// is otherwise exactly a setting - a label, and a value in a pill you can step
// with ‹ › or type into - which is why the catalog is built on this file
// rather than beside it.
Item {
  id: root

  property string label: ""
  property string description: ""
  property string valueText: ""

  // Draws the chevrons and accepts adjusted(). An action row (restore
  // defaults) has neither: there is nothing to step through.
  property bool adjustable: true
  // Swaps the value for a text field. The panel owns which row is editing.
  property bool editing: false
  property string editText: ""
  property string placeholder: ""
  // The editor's content does not parse. Says so on the border rather than
  // by refusing a keystroke, and the panel refuses the commit.
  property bool editInvalid: false

  // D32's digit, painted at the row's leading edge. It is not decoration: the
  // key a drink answers to is its position, so this is the only thing on the
  // page that shows a reorder having worked.
  property string badge: ""

  // The two catalog-only controls. Both hold their slots whether or not they
  // are painted, the way the dose row's chevrons do - a row that changes width
  // under the cursor moves the thing you were aiming at.
  property bool removable: false
  property bool reorderable: false

  // A wider field than the pill, for a row whose editor takes a sentence
  // rather than a number ("Flat white (small) 130mg"). Zero means the
  // field is exactly the pill it replaces.
  property real editWidth: 0

  // A destructive action waiting for its second press. Restore-defaults is
  // confirmed by pressing it again rather than by a dialog (there is nothing
  // to read that the row does not already say), so the row has to look
  // different in between or the confirmation is invisible.
  property bool armed: false

  property color foreground: Color.foreground
  property color accent: Color.accent
  property color urgent: Color.urgent
  property string fontFamily: Style.font.family

  // Paint from the panel's one cursor, never from local hover — the same
  // CursorSurface contract every other row in this plugin follows.
  property bool hasCursor: false

  // The pill's width, handed down by the panel so every row's value starts at
  // the same x. Measured off the widest value the view can show, the way the
  // dose rows measure their columns.
  property real valueWidth: 0

  // Reserved for the badge even on a row that paints none, so a list of rows
  // is one column and not eleven left edges.
  property bool badgeSlot: false
  readonly property real badgeWidth: Style.space(9)

  readonly property color dim: Qt.darker(foreground, 1.45)
  readonly property real chevronSlot: Style.space(13)
  readonly property bool showChevrons: root.adjustable && !root.editing
    && (root.hasCursor || rowHover.hovered)
  readonly property bool showReorder: root.reorderable && !root.editing
    && (root.hasCursor || rowHover.hovered)

  readonly property bool editorFocused: field.activeFocus

  signal adjusted(int direction)
  signal activated()
  signal removed()
  signal moved(int direction)
  // D82. A position rather than a boolean — see PresetButton for why.
  signal pointerMoved(var item, var at)
  signal editCommitted(string text)
  signal editCancelled()
  signal editTyped(string text)

  implicitHeight: Math.max(content.implicitHeight + Style.spacing.md * 2,
                           root.removable ? removeButton.height : 0)
  height: implicitHeight

  function focusEditor() {
    field.text = root.editText
    field.selectAll()
    field.forceActiveFocus()
  }

  component Chevron: Item {
    id: chevron

    property string glyph: ""
    property int direction: 0
    // The value pill's chevrons adjust; the reorder pair moves the row. Both
    // are the same painted target, so the difference is which signal the
    // caller wires up rather than two near-identical components.
    signal pressed()

    width: root.chevronSlot
    height: parent ? parent.height : 0
    opacity: root.showReorder || root.showChevrons ? 1 : 0
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
      enabled: root.showChevrons || root.showReorder
      cursorShape: Qt.PointingHandCursor
      onClicked: chevron.pressed()
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
    onPointChanged: root.pointerMoved(root, rowHover.point.position)
  }

  // The number key, at the leading edge and out of the label's way. Same
  // typographic weight as the digit on the pill it names (D38), because they
  // are the same fact stated in two places.
  Text {
    id: badgeText
    visible: root.badge !== ""
    anchors.left: parent.left
    anchors.leftMargin: Style.spacing.sm
    anchors.verticalCenter: parent.verticalCenter
    textFormat: Text.PlainText
    text: root.badge
    color: root.hasCursor ? root.accent : Qt.darker(root.foreground, 2.0)
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    font.bold: true
  }

  Column {
    id: content
    anchors.left: parent.left
    // The badge slot is held whether or not a digit is in it, so a drink past
    // the tenth - which has no key, and says so by painting nothing - still
    // lines its name up with the ten above it.
    anchors.leftMargin: root.badge === "" && !root.badgeSlot
      ? Style.spacing.sm
      : Style.spacing.sm + root.badgeWidth + Style.spacing.md
    anchors.right: reorderControls.visible ? reorderControls.left : valuePill.left
    anchors.rightMargin: Style.spacing.lg
    anchors.verticalCenter: parent.verticalCenter
    spacing: Style.spacing.xxs

    Text {
      width: parent.width
      textFormat: Text.PlainText
      text: root.label
      color: root.armed ? root.urgent : root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
      elide: Text.ElideRight
    }

    Text {
      width: parent.width
      visible: root.description !== ""
      textFormat: Text.PlainText
      text: root.description
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  // The value, in the dose row's clock pill. Bordered while live so it reads
  // as a control rather than as a label that happens to change when you touch
  // it — the same reasoning, and the same component, as the timestamp.
  // ✕ deletes the drink, and it is the dose row's ✕ exactly: same component,
  // same urgent hover, same trailing edge. A destructive action that looked
  // different on two pages of one panel would be two actions to learn.
  PanelActionButton {
    id: removeButton
    visible: root.removable
    anchors.right: parent.right
    anchors.verticalCenter: parent.verticalCenter
    iconText: "✕"
    tooltipText: "Remove this drink  (x)"
    foreground: root.foreground
    hoverColor: root.urgent
    fontFamily: root.fontFamily
    fontSize: Style.font.bodySmall
    onClicked: root.removed()
  }

  // Up and down rather than ‹ ›, and that is the decision rather than the
  // glyph nearest to hand: ‹ › mean "move in time" on the dose rows and
  // "change this value" on the pill six pixels to the right of here, and a
  // third meaning on the same row would make all three ambiguous. The keys
  // are K and J, which is the same movement the cursor already answers to.
  Item {
    id: reorderControls
    visible: root.reorderable
    anchors.right: valuePill.left
    anchors.rightMargin: Style.spacing.sm
    anchors.verticalCenter: parent.verticalCenter
    width: root.chevronSlot * 2
    height: parent.height

    Chevron {
      anchors.left: parent.left
      glyph: "⌃"
      direction: -1
      onPressed: root.moved(-1)
    }

    Chevron {
      anchors.right: parent.right
      glyph: "⌄"
      direction: 1
      onPressed: root.moved(1)
    }
  }

  BorderSurface {
    id: valuePill
    anchors.right: root.removable ? removeButton.left : parent.right
    anchors.rightMargin: Style.spacing.sm
    anchors.verticalCenter: parent.verticalCenter
    width: root.editing && root.editWidth > 0
      ? root.editWidth
      : root.valueWidth + root.chevronSlot * 2 + Style.spacing.sm * 2
    height: Math.max(valueText.implicitHeight, field.implicitHeight) + Style.spacing.xs * 2
    radius: Style.cornerRadius
    color: root.editing
      ? "transparent"
      : (root.hasCursor || rowHover.hovered
         ? Style.hoverFillFor(root.foreground, root.accent)
         : "transparent")
    borderSpec: root.editing
      ? Border.none()
      : (root.hasCursor || rowHover.hovered
         ? Border.controlSpec("hover-cursor", root.foreground, root.accent)
         : Border.none())

    Behavior on color { ColorAnimation { duration: Caffeine.MOTION_TINT_MS } }

    Chevron {
      visible: root.adjustable
      anchors.left: parent.left
      anchors.leftMargin: Style.spacing.xs
      glyph: "‹"
      direction: -1
      onPressed: root.adjusted(-1)
    }

    Text {
      id: valueText
      visible: !root.editing
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: root.valueText
      color: root.armed
        ? root.urgent
        : (root.hasCursor || rowHover.hovered ? root.foreground : root.dim)
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    // Inline editing, the way the weather panel edits its location: the value
    // is replaced in place rather than opening a dialog, and the panel sets
    // PanelKeyCatcher.blocked while this owns the keys.
    TextField {
      id: field
      visible: root.editing
      anchors.centerIn: parent
      width: root.editWidth > 0 ? root.editWidth - Style.spacing.sm * 2
                                : root.valueWidth + root.chevronSlot * 2
      verticalPadding: Style.spacing.xxs
      font.pixelSize: Style.font.bodySmall
      placeholderText: root.placeholder
      foreground: root.editInvalid ? root.urgent : root.foreground
      accent: root.editInvalid ? root.urgent : root.accent
      font.family: root.fontFamily

      onTextChanged: if (root.editing) root.editTyped(text)

      Keys.onPressed: function(event) {
        if (event.key === Qt.Key_Escape) {
          root.editCancelled()
          event.accepted = true
        } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
          root.editCommitted(field.text)
          event.accepted = true
        }
      }
    }

    Chevron {
      visible: root.adjustable
      anchors.right: parent.right
      anchors.rightMargin: Style.spacing.xs
      glyph: "›"
      direction: 1
      onPressed: root.adjusted(1)
    }

    MouseArea {
      anchors.fill: parent
      enabled: !root.editing
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      // The chevrons sit on top of this and take their own clicks, so a click
      // that reaches here is a click on the value itself.
      onClicked: root.activated()
    }
  }
}
