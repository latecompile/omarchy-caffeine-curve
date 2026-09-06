// The plugin's own mark: a coffee bean, drawn.
//
// D93 put it on the quiet footer line as the plugin's signature; **D94 made it
// the footer's corner on every page, and the thing you press to open the
// settings.** That is the third decision about this bean and it is the one
// D87 refused it — and what changed is the line rather than the argument. D87
// rejected a bean **instead of** a gear on a line that also said
// "s settings": two marks and a word competing to mean one thing, where the
// render showed the native one winning. One mark in a fixed corner, with the
// legend beside it still naming the key, is a different question. D87's ❌
// stands unchanged, and the geometry it left at plan/phase13b-bean.qml.txt is
// what this file was restored from.
//
// **`voidColor` is load-bearing and the caller has to think about it.** The
// seam is cut by painting the background *over* the body, so the caller has to
// pass what is actually behind the mark — which stopped being the panel's own
// background the moment D94 put the bean inside a button with a hover fill.
// See `Panel.overPopup`.
//
import QtQuick
import QtQuick.Shapes
import qs.Commons

// There is no coffee bean in JetBrainsMono Nerd Font — probed across Font
// Awesome, the Font Awesome Extension range and Material Design Icons, it has
// cups (f0f4, e256, e61b, f0176), a leaf and a seedling-ish swirl, and no bean
// — and D53 established what a codepoint the shell cannot draw does: it paints
// a tofu box. So the bean is drawn, which is this plugin's own precedent
// rather than a new idea. D3 chose a hand-built cup over a glyph, and Cup.qml
// serves the bar at 15px and the hero at 44 from one file; this is the same
// hand at a third size.
//
// An oval and a seam, and both halves of that are load-bearing. The oval is
// tilted, because an untilted one is an egg; the seam is an S rather than a
// straight line, because a straight one is a lemon. At footer size the whole
// mark is about eleven pixels, so there is room for exactly those two strokes
// and nothing else — no highlight, no second bean, no roast line.
Item {
  id: root

  property color color: Color.foreground
  // Off the height, like Cup.qml's, so the bean is the same weight as the
  // panel's other drawn mark at whatever size it is asked for.
  property real thickness: Math.max(1, Math.round(height / 10))
  // A filled body with the seam cut out of it reads as an object at eleven
  // pixels where an outline reads as three concentric lines. Solid won.
  property bool solid: false
  // What the seam is cut out of when the body is filled. The caller supplies
  // it because only the caller knows what is behind the mark, and a hardcoded
  // one would be the first literal colour in the plugin.
  property color voidColor: Color.popups.background

  // A bean is longer than it is wide, and the tilt is what makes it a bean
  // rather than an egg standing up.
  readonly property real tilt: -24
  implicitHeight: Style.bar.statusSlot
  implicitWidth: Math.ceil(height * 0.86)

  Shape {
    id: shape
    anchors.centerIn: parent
    width: root.height * 0.72
    height: root.height
    rotation: root.tilt
    preferredRendererType: Shape.CurveRenderer

    readonly property real cx: width / 2
    readonly property real cy: height / 2
    readonly property real rx: (width - root.thickness) / 2
    readonly property real ry: (height - root.thickness) / 2

    // The body.
    ShapePath {
      strokeColor: root.color
      strokeWidth: root.thickness
      fillColor: root.solid ? root.color : "transparent"
      capStyle: ShapePath.RoundCap
      joinStyle: ShapePath.RoundJoin
      PathAngleArc {
        centerX: shape.cx
        centerY: shape.cy
        radiusX: shape.rx
        radiusY: shape.ry
        startAngle: 0
        sweepAngle: 360
      }
    }

    // The seam, tip to tip. Stopped a little short of both ends so it reads as
    // a crease in the bean rather than as a line cutting it in half — at the
    // tips the two walls are already a stroke apart and a seam that reached
    // them would close the gap and paint a solid blob.
    ShapePath {
      strokeColor: root.solid ? root.voidColor : root.color
      strokeWidth: root.thickness
      fillColor: "transparent"
      capStyle: ShapePath.RoundCap

      startX: shape.cx
      startY: shape.cy - shape.ry * 0.72
      PathCubic {
        control1X: shape.cx + shape.rx * 0.62
        control1Y: shape.cy - shape.ry * 0.30
        control2X: shape.cx - shape.rx * 0.62
        control2Y: shape.cy + shape.ry * 0.30
        x: shape.cx
        y: shape.cy + shape.ry * 0.72
      }
    }
  }
}
