import QtQuick
import qs.Commons
import qs.Ui

import "Caffeine.js" as Caffeine

// One tap-to-log pill: the drink on top, its dose beneath.
//
// Hand-built rather than a qs.Ui Button because a Button lays its label out in
// a single Row, and the mg has to be readable without being as loud as the
// name — stacking them is the whole point. Everything else is the kit's:
// the fills come from Style's state tokens, so a theme that restyles controls
// restyles these too.
//
// The serving detail ("Double", "240 ml") is deliberately not painted. Five
// pills and a "+" across the panel leaves about 88px each, and "240 ml · 200
// mg" needs 110 — it rendered touching both borders. The dose already
// separates every ambiguous pair in the table (the two espressos are 63 and
// 125, the two teas 29 and 47, and 0.7/1.3 and 0.3/0.5 in cups), so the detail
// moves to the tooltip and loses nothing.
//
// The label elides rather than overflowing, because since D31 the name is the
// user's text and nothing here can promise it fits.
BorderSurface {
  id: root

  property string label: ""
  property string detail: ""
  // Formatted by the panel, which owns the units setting. In cups the pill for
  // a 240 ml coffee reads "1 cup", which is circular and is exactly the point:
  // it is the definition the rest of the panel converts against, stated where
  // you cannot miss it.
  property string amountText: ""
  property color foreground: Color.foreground
  property color accent: Color.accent
  property string fontFamily: Style.font.family
  property bool compact: false
  property string tooltipText: ""

  // D32. The digit that logs this drink, painted on it so the mapping is
  // discoverable without a legend. Empty past the tenth drink, which is the
  // honest thing to show for a pill no digit reaches.
  property string keyLabel: ""

  // D53. One of Presets.ICONS, or "" for a drink that carries none — which is
  // every drink until someone chooses one, and so is the layout this pill has
  // to look right in first.
  property string icon: ""
  readonly property bool hasIcon: root.icon !== ""

  // The kit's contract for a panel with a keyboard cursor: the item never
  // paints from its own containsMouse, it paints from `hasCursor` and reports
  // hover upward so the panel can move the one cursor that exists. That is
  // what keeps exactly one highlight on screen whichever input is driving.
  property bool hasCursor: false

  signal clicked()
  // D82, and defect #8. Not a hover *report* but a pointer *movement*. A row
  // that slides under a stationary pointer fires containsMouse on a mouse
  // nobody touched, and the panel used to move its one cursor there — so a
  // K/J reorder was unusable with the pointer anywhere over the panel. What
  // travels upward now is where the pointer is, and qs.Ui.PointerMoveGate at
  // the other end decides whether it moved.
  signal pointerMoved(var item, var at)

  readonly property bool hot: hasCursor
  readonly property color dim: Qt.darker(foreground, 1.45)

  implicitWidth: content.implicitWidth + Style.spacing.controlPaddingX * 2
  implicitHeight: content.implicitHeight + Style.spacing.controlPaddingY * 2
  radius: Style.cornerRadius

  color: mouse.pressed
    ? Style.pressedFillFor(foreground, accent)
    : (hot ? Style.hoverFillFor(foreground, accent) : Style.normalFillFor(foreground, accent))
  borderSpec: hot
    ? Border.controlSpec("hover-cursor", foreground, accent)
    : Border.controlSpec("normal", foreground, accent)

  Behavior on color { ColorAnimation { duration: Caffeine.MOTION_TINT_MS } }

  Column {
    id: content
    anchors.centerIn: parent
    spacing: Style.spacing.xxs

    Text {
      textFormat: Text.PlainText
      anchors.horizontalCenter: parent.horizontalCenter
      // Bounded by the cell rather than by its own text: the pill is one
      // column of a grid now, and a long drink name must shorten instead of
      // pushing its neighbours out of line.
      width: Math.min(implicitWidth, root.width - Style.spacing.sm * 2)
      horizontalAlignment: Text.AlignHCenter
      elide: Text.ElideRight
      text: root.label
      color: root.hot ? root.foreground : Qt.darker(root.foreground, 1.1)
      font.family: root.fontFamily
      font.pixelSize: root.compact ? Style.font.bodySmall : Style.font.body
      font.bold: true
    }

    Text {
      textFormat: Text.PlainText
      anchors.horizontalCenter: parent.horizontalCenter
      text: root.amountText
      color: root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
    }
  }

  // The digit rides at the pill's foot, out of the layout entirely and on the
  // short line. Two other placements were built and rendered: in the top-left
  // corner it has to be given room out of the name's width, which elided
  // "Large coffee" and "Energy drink" off the shipped row; inline before the
  // mg it fits, but the dose is then centred as part of a pair, so the mg
  // stops lining up column to column. Down here it costs the name nothing,
  // leaves the dose centred, and sits far enough from it that "1  1.3 cups"
  // cannot be misread as one number.
  Text {
    visible: root.keyLabel !== ""
    textFormat: Text.PlainText
    anchors.left: parent.left
    anchors.leftMargin: Style.spacing.sm
    y: root.height - height - Style.spacing.xs
    text: root.keyLabel
    color: root.hot ? root.accent : Qt.darker(root.foreground, 2.0)
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    font.bold: true
  }

  // D53. The icon rides at the pill's foot on the trailing edge, opposite the
  // digit, and the reason is D38's own reason read a second time: the foot is
  // the pill's short line and the only part of it with room to spare. D38 put
  // the digit down here after two other placements cost the name its width;
  // this fills the other end of the same line and costs the name nothing.
  //
  // Two placements were built and rendered against the longest names in a full
  // catalog, and both failed exactly as D53 predicted they would. Above the
  // name it needs a third line the pill's fixed height does not have, so the
  // glyph paints over the top border and the dose is clipped off the bottom —
  // and buying it the height costs two grid rows of it. Inline before the name
  // it shares the name's width, and five shipped names that fit without an
  // icon elide with one: "Large cof…", "Energy dr…", "Nightcap …". That is
  // D38's finding reproduced verbatim, three phases later, by a different mark.
  //
  // Not the same weight as the digit: the digit is a key you press and this is
  // a thing you recognise, so it is a shade dimmer at rest and takes the accent
  // under the cursor the way the digit does.
  Text {
    visible: root.hasIcon
    textFormat: Text.PlainText
    anchors.right: parent.right
    anchors.rightMargin: Style.spacing.sm
    y: root.height - height - Style.spacing.xs
    text: root.icon
    color: root.hot ? root.accent : Qt.darker(root.foreground, 1.35)
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }

  MouseArea {
    id: mouse
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onPositionChanged: function(mouse) { root.pointerMoved(root, mouse) }
    onClicked: root.clicked()
  }

  PanelToolTip {
    visible: root.tooltipText !== "" && mouse.containsMouse
    text: root.tooltipText
    fontFamily: root.fontFamily
  }
}
