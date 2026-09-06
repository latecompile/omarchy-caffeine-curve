import QtQuick
import QtQuick.Shapes
import qs.Commons

import "Caffeine.js" as Caffeine

// The decay curve. Samples in, a polyline out, with an optional area fill
// under it — the fill is what makes the panel rhyme with the cup instead of
// reading as a widget plus a chart.
//
// The curve is drawn in two halves that meet at `nowTs`: what happened, solid
// and fully tinted, and what has not happened yet, dashed and half tinted.
// The path is rebuilt imperatively rather than bound, because a ShapePath's
// elements are not a bindable list and the panel only asks for a rebuild when
// it opens or when a dose lands.
Item {
  id: root

  // [{ ts, mg }], oldest first, spanning fromTs..toTs.
  property var samples: []
  property real maxValue: 1
  property bool filled: true

  property double fromTs: 0
  property double toTs: 0
  property double nowTs: 0

  // Where the record actually starts: the oldest dose still on file. Zero
  // means "as far left as the window goes", which is what a full log always
  // amounts to — thirty days of history is off the left edge of a
  // twenty-four-hour window and this changes nothing for it.
  //
  // It matters in exactly two places, and they are the same place seen twice.
  // On a fresh install, the flat zero line to the left of your first-ever
  // drink is the plugin asserting you had no caffeine at nine this morning,
  // which it has no way of knowing — you may have installed it at seven in the
  // evening. Panned all the way back, it is the same assertion about the day
  // before your first drink. D64 already settled this for the timeline, in as
  // many words: it stops going back at the oldest drink on file, because
  // further back is not a record of empty days. The curve's own left edge
  // follows the same rule rather than having a second opinion about it.
  property double recordFromTs: 0
  property double bedtimeTs: 0

  property color color: Color.foreground
  property string fontFamily: Style.font.family
  // The area has its own colour role, and it defaults to the accent rather
  // than to the line. Rendered across five themes at Phase 2, a
  // foreground-tinted fill reads as a shadow on the dark ones — the failure is
  // contrast, not hue, and the accent is the one role guaranteed to differ
  // from both the panel behind it and the line on top.
  property color areaColor: Color.accent
  property color bandColor: Color.accent
  // What the bedtime hairline calls itself, drawn at the top of that line.
  // Empty leaves the line unlabelled.
  property string bandLabel: ""
  property real thickness: Math.max(1, Style.space(2))
  property real fillAlpha: 0.22

  // Hour graduations: one every hour, taller every `majorEveryHours`. The
  // panel labels the majors, so the tick never has to carry the distinction
  // on its own.
  property int majorEveryHours: 3

  // ------------------------------------------------------------- the ghost
  //
  // A pinned day, resampled over its own window and stamped with today's
  // timestamps so it lines up by clock. Drawn under everything else, and it
  // must not read as the projection, which already owns "dashed + half tint"
  // (D22). D62: a dotted stroke over a quarter-strength fill. Four treatments
  // were built and rendered on a dark theme and a light one — see D62 for why
  // fill-only and hairline-only both lost.
  property var ghostSamples: []
  property bool ghostVisible: false
  property color ghostColor: Color.muted
  property real ghostFillAlpha: 0.14

  implicitHeight: Style.space(96)

  readonly property real span: maxValue > 0 ? maxValue : 1
  readonly property double timeSpan: toTs > fromTs ? toTs - fromTs : 1

  // Room for the stroke at the top and for the baseline rule at the bottom.
  readonly property real plotTop: thickness
  readonly property real plotBottom: height - thickness

  function xAt(ts) {
    return ((ts - root.fromTs) / root.timeSpan) * root.width
  }

  function yAt(mg) {
    var usable = Math.max(1, root.plotBottom - root.plotTop)
    var y = root.plotBottom - (mg / root.span) * usable
    return y < root.plotTop ? root.plotTop : y
  }

  // Height of the drawn curve at a moment, read off the sample list rather
  // than recomputed, so a marker sits *on* the line rather than near it.
  function yAtTs(ts) {
    var list = root.samples
    if (!list || list.length === 0) return root.plotBottom
    var index = Math.round(((ts - root.fromTs) / root.timeSpan) * (list.length - 1))
    if (index < 0) index = 0
    if (index > list.length - 1) index = list.length - 1
    return root.yAt(list[index].mg)
  }

  // Wall-clock hours across the window. Stepped from a real local hour rather
  // than from `fromTs` rounded, so a half-hour timezone still lands on the
  // hour; stepped by 3600s after that, so a DST change moves the marks with
  // the clock instead of against it.
  readonly property var hourMarks: {
    var out = []
    if (root.toTs <= root.fromTs) return out
    var start = new Date(root.fromTs * 1000)
    start.setMinutes(0, 0, 0)
    var ts = Math.floor(start.getTime() / 1000)
    if (ts < root.fromTs) ts += 3600
    var guard = 0
    while (ts <= root.toTs && guard++ < 64) {
      out.push({ ts: ts, major: new Date(ts * 1000).getHours() % root.majorEveryHours === 0 })
      ts += 3600
    }
    return out
  }

  // ---------------------------------------------------------------- entrance
  //
  // A left-to-right wipe: the curve draws itself in from the oldest sample to
  // the projection, and every mark on it arrives as the wipe reaches it. The
  // house pattern is SpeedTestOverlay's ignition sweep — an animation the
  // panel fires on open, rather than a Behavior that would also fire on every
  // resample.
  //
  // Done as a clip rather than by growing the sample list: rebuilding the path
  // every frame would allocate a hundred PathLines sixty times a second.
  //
  // The alternative was a rise out of the baseline, the way the cup fills. It
  // was built and lost twice over: scaling a stroked Shape vertically thins
  // the line while it is in flight, and the panel's curve is a timeline, so
  // sweeping it along time says more than growing it along level — which is
  // the bar mark's job anyway.
  property real revealFraction: 1

  function playEntrance() {
    entrance.restart()
  }

  NumberAnimation {
    id: entrance
    target: root
    property: "revealFraction"
    from: 0
    to: 1
    duration: Caffeine.MOTION_ENTRANCE_MS
    easing.type: Easing.OutCubic
  }

  // ------------------------------------------------------------------- paths

  // Fills one stroked path and its closed area from samples[first..last].
  function buildSegment(stroke, fill, list, first, last) {
    if (!list || last <= first) {
      stroke.pathElements = []
      fill.pathElements = []
      return
    }
    var strokeElements = []
    var fillElements = []
    var startX = root.xAt(list[first].ts)

    stroke.startX = startX
    stroke.startY = root.yAt(list[first].mg)
    fill.startX = startX
    fill.startY = root.plotBottom
    fillElements.push(lineElement.createObject(fill, { x: startX, y: stroke.startY }))

    for (var i = first + 1; i <= last; i++) {
      var x = root.xAt(list[i].ts)
      var y = root.yAt(list[i].mg)
      strokeElements.push(lineElement.createObject(stroke, { x: x, y: y }))
      fillElements.push(lineElement.createObject(fill, { x: x, y: y }))
    }

    var lastX = root.xAt(list[last].ts)
    fillElements.push(lineElement.createObject(fill, { x: lastX, y: root.plotBottom }))
    fillElements.push(lineElement.createObject(fill, { x: startX, y: root.plotBottom }))

    stroke.pathElements = strokeElements
    fill.pathElements = fillElements
  }

  function rebuild() {
    var list = root.samples
    if (!list || list.length < 2 || root.width <= 0 || root.height <= 0) {
      root.buildSegment(line, area, null, 0, 0)
      root.buildSegment(lineAhead, areaAhead, null, 0, 0)
      return
    }

    // The seam is the last sample at or before now, and both halves own it, so
    // they meet under the "now" hairline rather than leaving a gap there.
    var seam = list.length - 1
    for (var i = 0; i < list.length; i++) {
      if (list[i].ts > root.nowTs) { seam = Math.max(0, i - 1); break }
    }

    // One sample earlier than the first dose, so the record begins on the
    // baseline immediately before the drink rather than hanging in mid-air.
    var start = 0
    if (root.recordFromTs > 0) {
      for (var j = 0; j < list.length; j++) {
        if (list[j].ts >= root.recordFromTs) { start = Math.max(0, j - 1); break }
      }
      if (start > seam) start = seam
    }

    root.buildSegment(line, area, list, start, seam)
    root.buildSegment(lineAhead, areaAhead, list, seam, list.length - 1)

    var ghost = root.ghostSamples
    if (root.ghostVisible && ghost && ghost.length >= 2)
      root.buildSegment(ghostLine, ghostArea, ghost, 0, ghost.length - 1)
    else
      root.buildSegment(ghostLine, ghostArea, null, 0, 0)
  }

  onSamplesChanged: rebuild()
  onGhostSamplesChanged: rebuild()
  onGhostVisibleChanged: rebuild()
  onNowTsChanged: rebuild()
  onWidthChanged: rebuild()
  onHeightChanged: rebuild()
  Component.onCompleted: rebuild()

  Component {
    id: lineElement
    PathLine {}
  }

  // ------------------------------------------------------------------ pixels

  // Baseline. Present in both treatments: without it a line curve floats. Not
  // part of the entrance — it is the vessel the curve pours into, so it is
  // there before anything is drawn.
  Rectangle {
    anchors.left: parent.left
    anchors.right: parent.right
    y: Math.round(root.plotBottom)
    height: Math.max(1, Style.spacing.hairline)
    color: Qt.rgba(root.color.r, root.color.g, root.color.b, 0.22)
  }

  // Everything that is "the drawing" lives inside the wipe.
  Item {
    id: reveal
    width: Math.round(root.width * root.revealFraction)
    height: root.height
    clip: root.revealFraction < 1

    Shape {
      width: root.width
      height: root.height
      antialiasing: true
      preferredRendererType: Shape.CurveRenderer

      // Under everything, because it is the day you are comparing against and
      // not the day you are reading.
      ShapePath {
        id: ghostArea
        strokeWidth: 0
        strokeColor: "transparent"
        fillColor: Qt.rgba(root.ghostColor.r, root.ghostColor.g,
                           root.ghostColor.b, root.ghostFillAlpha)
      }

      ShapePath {
        id: ghostLine
        strokeColor: Qt.rgba(root.ghostColor.r, root.ghostColor.g,
                             root.ghostColor.b, 0.7)
        strokeWidth: root.thickness
        fillColor: "transparent"
        capStyle: ShapePath.RoundCap
        joinStyle: ShapePath.RoundJoin
        // Dotted, not dashed: D22 spends the dash on the projection, and a
        // second dashed line on the same chart would say "not yet" about
        // something that already happened.
        strokeStyle: ShapePath.DashLine
        dashPattern: [0.6, 2.4]
      }

      ShapePath {
        id: area
        strokeWidth: 0
        strokeColor: "transparent"
        fillColor: root.filled
          ? Qt.rgba(root.areaColor.r, root.areaColor.g, root.areaColor.b, root.fillAlpha)
          : "transparent"
      }

      // The same liquid, half as strong, because it is not in you yet.
      ShapePath {
        id: areaAhead
        strokeWidth: 0
        strokeColor: "transparent"
        fillColor: root.filled
          ? Qt.rgba(root.areaColor.r, root.areaColor.g, root.areaColor.b, root.fillAlpha * 0.5)
          : "transparent"
      }

      ShapePath {
        id: line
        strokeColor: root.color
        strokeWidth: root.thickness
        fillColor: "transparent"
        capStyle: ShapePath.RoundCap
        joinStyle: ShapePath.RoundJoin
      }

      // What has not happened yet, said so in the one idiom nobody has to be
      // taught. Drawn continuous and it is indistinguishable from the record.
      ShapePath {
        id: lineAhead
        strokeColor: root.color
        strokeWidth: root.thickness
        fillColor: "transparent"
        capStyle: ShapePath.RoundCap
        joinStyle: ShapePath.RoundJoin
        strokeStyle: ShapePath.DashLine
        dashPattern: [2.2, 2.2]
      }
    }

    // Now. The seam between record and projection. It carries no dot: with one
    // there, the marginal band — which by D18 makes no colour claim — puts two
    // identical dots on the curve and neither says which is which. The stroke
    // going dashed at this exact x is a stronger statement than a dot anyway.
    Rectangle {
      visible: root.nowTs > root.fromTs && root.nowTs < root.toTs
      x: Math.round(root.xAt(root.nowTs))
      width: Math.max(1, Style.spacing.hairline)
      y: 0
      height: root.height
      color: Qt.rgba(root.color.r, root.color.g, root.color.b, 0.45)
    }

    // Bedtime: a hairline in the band colour with a dot where the curve
    // crosses it. The dot is the number the panel states, placed on the curve.
    Item {
      visible: root.bedtimeTs > root.fromTs && root.bedtimeTs < root.toTs
      anchors.fill: parent

      Rectangle {
        x: Math.round(root.xAt(root.bedtimeTs))
        width: Math.max(1, Style.spacing.hairline)
        y: 0
        height: root.height
        color: Qt.rgba(root.bandColor.r, root.bandColor.g, root.bandColor.b, 0.55)
      }

      Rectangle {
        readonly property real dotSize: Style.space(8)
        x: Math.round(root.xAt(root.bedtimeTs) - dotSize / 2)
        y: Math.round(root.yAtTs(root.bedtimeTs) - dotSize / 2)
        width: dotSize
        height: dotSize
        radius: dotSize / 2
        color: root.bandColor
        // Ringed in the surface behind it, so it stays a dot where the curve
        // runs along its own marker.
        border.width: Math.max(1, Style.spacing.hairline)
        border.color: Color.popups.background
      }

      // The line names itself, at the top of it, rather than down on the axis.
      // On the axis it sat beside "now" and the two collided every evening —
      // precisely when the marker matters — whereupon the collision rule hid
      // the more useful of the two. Flips to the other side near the right
      // edge rather than being clipped off.
      Text {
        visible: root.bandLabel.length > 0
        textFormat: Text.PlainText
        readonly property real anchorX: root.xAt(root.bedtimeTs)
        readonly property bool flip: anchorX + implicitWidth + Style.spacing.xs > root.width
        x: Math.round(flip ? anchorX - implicitWidth - Style.spacing.xs
                           : anchorX + Style.spacing.xs)
        y: 0
        text: root.bandLabel
        color: root.bandColor
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
        font.bold: true
        font.letterSpacing: 1.0
      }
    }
  }

  // The graduations, printed on top of the liquid. Under it they vanish
  // wherever the fill is deep, which is most of the day.
  Repeater {
    model: root.hourMarks

    Rectangle {
      required property var modelData
      readonly property bool major: modelData.major
      x: Math.round(root.xAt(modelData.ts))
      width: Math.max(1, Style.spacing.hairline)
      height: major ? Style.space(9) : Style.space(4)
      y: Math.round(root.plotBottom - height)
      color: Qt.rgba(root.color.r, root.color.g, root.color.b, major ? 0.34 : 0.2)
    }
  }
}
