import QtQuick
import qs.Commons

import "Caffeine.js" as Caffeine

// The card that leaves the machine.
//
// Everything else this plugin draws is read by the person who logged the
// drinks, on a bar that already says whose it is. This one is read by someone
// who has never seen it — so it is a different picture of the same reading,
// and the differences are all consequences of that.
//
// **It is 16:9 because the timelines are.** The panel is a tall, dense
// instrument; posted as-is it gets centre-cropped toward 16:9 by every client
// that shows it, and what falls off the top and bottom is the verdict and the
// axis — the two things the picture is for. Framing it here means the crop
// never happens.
//
// **It carries the verdict and the curve and nothing else.** No drink rows, no
// times, no notes. That is partly editorial — a reader gets about a second and
// a half, and three lines of log spend it — and partly the only privacy
// decision in the plugin: this is the one artefact that travels, and what
// you drank at 08:52 is nobody's business by default. Anyone who does want the
// literal panel already has `omarchy screenshot region`.
//
// **It signs itself.** A screenshot with no name on it is a nice chart; the
// wordmark and the repo are what make it something a reader can go and find.
//
// **It is drawn at panel scale and captured larger.** Every size here is a
// Style token doing what it does on the panel, because that is what makes the
// card look like the plugin rather than like a poster about it;
// `Panel.captureShare` then grabs this item at 1600x900 and Qt re-rasterises
// the glyphs at that resolution, so the type is sharp at a size the tokens
// never have to know about. Proved with a render before this file existed.
Item {
  id: root

  // 16:9 off the width, so the one number a caller sets is the one that
  // matters and the ratio cannot drift.
  implicitWidth: Style.space(600)
  implicitHeight: Math.round(width * 9 / 16)

  // ------------------------------------------------------------- the reading
  //
  // Strings rather than numbers, and that is deliberate: every one of these is
  // already formatted by the panel that is showing them. The card recomputing
  // any of it would be a second opinion about what the user is looking at, and
  // the estimate note in particular is a disclaimer — a disclaimer with two
  // wordings is two disclaimers.
  property string levelText: ""
  property string headlineText: ""
  property string captionText: ""
  property string estimateNote: ""
  property string dayCaption: ""
  property bool hasDoses: false
  property real fill: 0

  // ------------------------------------------------------------- the curve
  property var samples: []
  property real curveMax: 1
  property double fromTs: 0
  property double toTs: 0
  property double nowTs: 0
  property double recordFromTs: 0
  property double bedtimeTs: 0
  property string bandLabel: ""
  property var ghostSamples: []
  property bool ghostVisible: false
  property string axisNowLabel: "now"
  property bool axisNowVisible: true
  // The panel owns the wall-clock wording for an hour mark, so the axis under
  // this curve is labelled by the same function as the axis under that one.
  property var axisLabelOf: null

  // ------------------------------------------------------------- the palette
  //
  // Injected rather than read from Color here, because two of the four are the
  // bar's roles and not the theme's, and the card has to be the colour of the
  // panel it was taken from.
  property color foreground: Color.foreground
  property color accent: Color.accent
  property color dim: Color.muted
  property color band: Color.accent
  property string fontFamily: Style.font.family

  Rectangle {
    anchors.fill: parent
    color: Color.popups.background

    // ------------------------------------------------------------ the hero
    //
    // The panel's own hero, at the panel's own sizes but one step up the type
    // scale: display where the panel says heading, heading where it says
    // title. The picture is the same object seen from further away, so the
    // proportions hold and only the emphasis moves.
    Item {
      id: hero
      anchors.top: parent.top
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: Style.spacing.panelPadding
      height: Math.max(heroLeft.height, heroRight.height)

      Row {
        id: heroLeft
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        spacing: Style.spacing.xxl

        Cup {
          anchors.verticalCenter: parent.verticalCenter
          height: Style.space(38)
          fill: root.hasDoses ? root.fill : 0
          color: root.hasDoses ? root.foreground : root.dim
        }

        Column {
          anchors.verticalCenter: parent.verticalCenter
          spacing: Style.spacing.xxs

          Text {
            textFormat: Text.PlainText
            text: root.hasDoses ? root.levelText : "—"
            color: root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.display
            font.bold: true
          }

          Text {
            textFormat: Text.PlainText
            text: "ON BOARD NOW"
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
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
          anchors.right: parent.right
          textFormat: Text.PlainText
          text: root.headlineText
          color: root.band
          font.family: root.fontFamily
          font.pixelSize: Style.font.heading
          font.bold: true
        }

        Text {
          anchors.right: parent.right
          textFormat: Text.PlainText
          text: root.captionText
          color: root.band
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          font.bold: true
          font.letterSpacing: 1.2
        }
      }
    }

    // ------------------------------------------------------------- the foot
    //
    // Laid out before the curve because the curve takes what is left: the
    // signature and the disclaimer are fixed-height and the chart is the part
    // that should grow when someone renders this wider.
    Column {
      id: foot
      anchors.bottom: parent.bottom
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.margins: Style.spacing.panelPadding
      spacing: Style.spacing.md

      // D13's line, on the one surface where it is being read by someone who
      // did not choose the half-life it names. Same function as the panel
      // footer, so it cannot drift from it.
      Text {
        width: parent.width
        textFormat: Text.PlainText
        text: root.estimateNote
        color: Qt.darker(root.foreground, 1.8)
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        elide: Text.ElideRight
      }

      Item {
        width: parent.width
        height: wordmark.implicitHeight

        // The name at full weight and the address dim beside it: one is what
        // this is, the other is where it is, and a reader who wants the second
        // is already looking for it.
        Text {
          id: wordmark
          anchors.left: parent.left
          textFormat: Text.PlainText
          text: Caffeine.SHARE_NAME
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          font.bold: true
        }

        Text {
          anchors.right: parent.right
          anchors.baseline: wordmark.baseline
          textFormat: Text.PlainText
          text: Caffeine.SHARE_URL
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }
      }
    }

    // ------------------------------------------------------------ the curve
    //
    // Everything between the hero and the foot, which on a 16:9 frame is about
    // half the card — where on the panel the same chart is a third of it. That
    // is the whole reframing: the panel is a page with a chart on it, and this
    // is a chart with a caption.
    Item {
      id: chart
      anchors.top: hero.bottom
      anchors.bottom: foot.top
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.leftMargin: Style.spacing.panelPadding
      anchors.rightMargin: Style.spacing.panelPadding
      anchors.topMargin: Style.spacing.panelGap
      anchors.bottomMargin: Style.spacing.panelGap

      Text {
        visible: !root.hasDoses
        anchors.centerIn: parent
        textFormat: Text.PlainText
        text: "Nothing logged"
        color: Qt.darker(root.foreground, 1.8)
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
      }

      // The day this is a picture of, top-left of the chart. On today's curve
      // the panel leaves this implicit — you are looking at now — but a card
      // read tomorrow by a stranger has no such context.
      Text {
        id: dayLabel
        visible: root.hasDoses && root.dayCaption !== ""
        anchors.top: parent.top
        anchors.left: parent.left
        textFormat: Text.PlainText
        text: root.dayCaption
        color: root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }

      Curve {
        id: curve
        visible: root.hasDoses
        anchors.top: dayLabel.visible ? dayLabel.bottom : parent.top
        anchors.topMargin: dayLabel.visible ? Style.spacing.sm : 0
        anchors.bottom: axis.top
        anchors.bottomMargin: Style.spacing.sm
        width: parent.width

        samples: root.samples
        maxValue: root.curveMax
        fromTs: root.fromTs
        toTs: root.toTs
        nowTs: root.nowTs
        recordFromTs: root.recordFromTs
        bedtimeTs: root.bedtimeTs
        bandLabel: root.bandLabel
        ghostSamples: root.ghostSamples
        ghostVisible: root.ghostVisible
        ghostColor: root.dim
        color: root.foreground
        areaColor: root.accent
        bandColor: root.band
        fontFamily: root.fontFamily
      }

      // The panel's axis, transposed. The collision rule comes with it: an
      // hour that lands under "now" is not drawn, because two labels on top of
      // each other is worse than one label missing.
      Item {
        id: axis
        visible: root.hasDoses
        anchors.bottom: parent.bottom
        anchors.left: parent.left
        anchors.right: parent.right
        height: nowLabel.implicitHeight

        readonly property real nowCentre: curve.xAt(root.nowTs)

        Repeater {
          model: curve.hourMarks

          Text {
            required property var modelData
            readonly property real centre: curve.xAt(modelData.ts)
            visible: modelData.major
              && (nowLabel.visible
                  ? Math.abs(centre - axis.nowCentre)
                    > (implicitWidth + nowLabel.implicitWidth) / 2 + Style.spacing.lg
                  : true)
            textFormat: Text.PlainText
            x: Math.round(Math.max(0, Math.min(axis.width - implicitWidth,
                 centre - implicitWidth / 2)))
            text: root.axisLabelOf ? root.axisLabelOf(modelData.ts) : ""
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
          }
        }

        Text {
          id: nowLabel
          visible: root.axisNowVisible
          textFormat: Text.PlainText
          x: Math.round(Math.max(0, Math.min(axis.width - implicitWidth,
               axis.nowCentre - implicitWidth / 2)))
          text: root.axisNowLabel
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          font.bold: true
        }
      }
    }
  }
}
