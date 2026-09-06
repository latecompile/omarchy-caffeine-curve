import QtQuick
import QtQuick.Shapes
import qs.Commons

import "Caffeine.js" as Caffeine

// The cup mark: a tapered outline with a liquid level inside it.
//
// The liquid is its own quad rather than a clipped rectangle, because the cup
// tapers — interpolating the side walls at the fill line is both cheaper than
// a clip and gives the liquid the same silhouette as the cup that holds it.
//
// Sized from the caller through `height`; the width follows the ink. At bar
// scale that is Style.bar.statusSlot; the panel reuses the same file at
// whatever size it wants. The caller also owns the *level's* motion — there is
// no Behavior on `fill` here, because the bar drives it along the absorption
// curve and a second easing layered under that one would only add lag.
//
// The pour (D52) is the exception, and it is the exception for a reason worth
// stating: it is not a level change. Logging a drink moves the level by
// exactly nothing — the caffeine has not been absorbed yet, which is Phase 3's
// whole argument and the reason the cup fills over the following hour instead
// of jumping. So the acknowledgement cannot be a rise without lying about when
// the coffee arrives. It is a stream falling into the cup: the drink went in
// now, the level follows over the next hour, and the two never contradict each
// other because they are two different things being drawn. Because it is one
// event rather than a bound value, and because the bar's cup and the hero's
// have to play the *same* event to read as one object seen at two sizes, it
// lives here rather than in either caller.
Item {
  id: root

  // 0..1. Caffeine.cupFill supplies this; nothing here clamps beyond the
  // paint, so a caller passing junk gets an empty or a full cup, not a crash.
  property real fill: 0
  property color color: Color.foreground
  property real thickness: Math.max(1, Math.round(height / 14))

  // Below the dim threshold the mark should recede rather than vanish, so the
  // caller sets this and the liquid follows the outline down.
  property real liquidOpacity: 1.0

  readonly property real clamped: fill < 0 ? 0 : (fill > 1 ? 1 : fill)

  // Everything is keyed off `height`, never `width`, so the box can hug the
  // ink without the geometry chasing its own bounds. Strokes are centered on
  // their path, so all x positions carry `pad` and the extents allow another
  // half stroke — at 96px an unpadded rim paints 3px outside the box.
  readonly property real pad: thickness / 2
  readonly property real bodyRight: pad + height * 0.70
  readonly property real bodyTop: height * 0.15
  readonly property real bodyBottom: height * 0.90
  readonly property real bodyHeight: bodyBottom - bodyTop
  readonly property real taper: height * 0.14
  readonly property real slope: taper / bodyHeight

  // The handle's ends sit exactly on the right wall's centerline, with the
  // radius at half the resulting chord, so the arc is a true semicircle that
  // stays welded to the wall at every size. Phase 2 floated the chord on one
  // vertical instead, which read fine at fifteen pixels — and at 96px left
  // both end caps hanging in mid-air with the rim poking past the arc like a
  // spoon. Judged at panel scale before trusting any of these ratios.
  readonly property real handleTop: bodyTop + bodyHeight * 0.26
  readonly property real handleBottom: bodyTop + bodyHeight * 0.74
  readonly property real handleTopX: bodyRight - slope * (handleTop - bodyTop)
  readonly property real handleBottomX: bodyRight - slope * (handleBottom - bodyTop)
  readonly property real handleRadius: Math.sqrt(
    (handleTopX - handleBottomX) * (handleTopX - handleBottomX)
    + (handleBottom - handleTop) * (handleBottom - handleTop)) / 2

  // How far the arc reaches right of the chord's midpoint: one radius along
  // the chord's perpendicular, which leans off horizontal by the wall slope.
  readonly property real handleReach:
    (handleTopX + handleBottomX) / 2
    + handleRadius / Math.sqrt(1 + slope * slope)

  implicitWidth: Math.ceil(Math.max(bodyRight, handleReach) + pad)
  implicitHeight: Style.bar.statusSlot

  // The liquid is inset from the wall centerlines by three quarters of the
  // stroke: enough that a hairline of background separates it from the wall's
  // inner edge at panel scale, close enough that it still touches at bar
  // scale. A full stroke of inset — the Phase 2 value — reads as a moat at
  // 96px, and liquid does not float inside its glass.
  readonly property real liquidInset: thickness * 0.75
  readonly property real innerTop: bodyTop + liquidInset
  readonly property real innerBottom: bodyBottom - liquidInset

  readonly property real fillY: innerBottom - clamped * (innerBottom - innerTop)
  readonly property real fillLeft: pad + slope * (fillY - bodyTop) + liquidInset
  readonly property real fillRight: bodyRight - slope * (fillY - bodyTop) - liquidInset
  readonly property real baseLeft: pad + slope * (innerBottom - bodyTop) + liquidInset
  readonly property real baseRight: bodyRight - slope * (innerBottom - bodyTop) - liquidInset

  // ------------------------------------------------------------- the pour
  //
  // Two positions along the fall, both 0 at the lip and 1 at the liquid's
  // surface: `pourTail` is the top of the falling column and `pourHead` the
  // bottom of it. Parked at 1 so the column has zero length and paints
  // nothing at rest.
  //
  // The lip is the top of this item's box rather than the rim of the cup: a
  // pour comes from something the cup is not, so the stream has to enter from
  // outside it. There is exactly one item-height's worth of room up there
  // because the walls start at 0.15.
  property real pourHead: 1
  property real pourTail: 1

  readonly property real lipY: 0
  readonly property real pourSpan: fillY - lipY
  readonly property real pourHeadY: lipY + clampUnit(pourHead) * pourSpan
  readonly property real pourTailY: lipY + clampUnit(pourTail) * pourSpan
  readonly property bool pouring: pourHeadY - pourTailY > 0.5

  // Off the stroke rather than off the height, so the stream is the same
  // weight as the line that draws the cup at every size — at bar scale that
  // is a hairline, which is all fifteen pixels can hold and all it needs.
  readonly property real pourWidth: thickness * 1.2
  readonly property real pourCentreX: (pad + bodyRight) / 2

  function clampUnit(value) { return value < 0 ? 0 : (value > 1 ? 1 : value) }

  // Fired by the caller when a drink is logged, at either scale.
  function pour() { pourAnimation.restart() }

  SequentialAnimation {
    id: pourAnimation

    // The column falls, runs, and stops — one liquid, one lip, one gravity,
    // so the fall and the stop take the same accelerating easing. OutCubic
    // (the shell's, and everything else in this plugin's) would have the
    // stream slow as it neared the surface, which is a bar chart growing
    // rather than coffee falling.
    PropertyAction { target: root; property: "pourTail"; value: 0 }
    NumberAnimation {
      target: root; property: "pourHead"
      from: 0; to: 1
      duration: Caffeine.POUR_FALL_MS
      easing.type: Easing.InQuad
    }
    PauseAnimation { duration: Caffeine.POUR_RUN_MS }
    NumberAnimation {
      target: root; property: "pourTail"
      from: 0; to: 1
      duration: Caffeine.POUR_STOP_MS
      easing.type: Easing.InQuad
    }
  }

  Shape {
    anchors.fill: parent
    antialiasing: true
    preferredRendererType: Shape.CurveRenderer

    // The stream, under the outline with the liquid and above nothing: it is
    // the same coffee a moment earlier, so it is the same fill.
    ShapePath {
      strokeWidth: 0
      strokeColor: "transparent"
      fillColor: root.pouring
        ? Qt.rgba(root.color.r, root.color.g, root.color.b,
                  root.color.a * root.liquidOpacity)
        : "transparent"
      startX: root.pourCentreX - root.pourWidth / 2
      startY: root.pourTailY
      PathLine { x: root.pourCentreX + root.pourWidth / 2; y: root.pourTailY }
      PathLine { x: root.pourCentreX + root.pourWidth / 2; y: root.pourHeadY }
      PathLine { x: root.pourCentreX - root.pourWidth / 2; y: root.pourHeadY }
      PathLine { x: root.pourCentreX - root.pourWidth / 2; y: root.pourTailY }
    }

    // Liquid first, so the outline strokes over its edges.
    ShapePath {
      strokeWidth: 0
      strokeColor: "transparent"
      fillColor: Qt.rgba(root.color.r, root.color.g, root.color.b,
                         root.color.a * root.liquidOpacity)
      startX: root.fillLeft
      startY: root.fillY
      PathLine { x: root.fillRight; y: root.fillY }
      PathLine { x: root.baseRight; y: root.innerBottom }
      PathLine { x: root.baseLeft; y: root.innerBottom }
      PathLine { x: root.fillLeft; y: root.fillY }
    }

    // Body outline, open at the top — a cup you can pour into reads better at
    // 20px than a closed box does.
    ShapePath {
      strokeColor: root.color
      strokeWidth: root.thickness
      fillColor: "transparent"
      capStyle: ShapePath.RoundCap
      joinStyle: ShapePath.RoundJoin
      startX: root.pad
      startY: root.bodyTop
      PathLine { x: root.pad + root.taper; y: root.bodyBottom }
      PathLine { x: root.bodyRight - root.taper; y: root.bodyBottom }
      PathLine { x: root.bodyRight; y: root.bodyTop }
    }

    // Handle.
    ShapePath {
      strokeColor: root.color
      strokeWidth: root.thickness
      fillColor: "transparent"
      capStyle: ShapePath.RoundCap
      startX: root.handleTopX
      startY: root.handleTop
      PathArc {
        x: root.handleBottomX
        y: root.handleBottom
        radiusX: root.handleRadius
        radiusY: root.handleRadius
        direction: PathArc.Clockwise
      }
    }
  }
}
