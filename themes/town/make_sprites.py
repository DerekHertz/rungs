# Builds the town's models and renders each as a pixel-art sprite from one fixed
# isometric camera. Run headless: blender -b --factory-startup --python make_sprites.py -- <out dir>
import json
import math
import sys

import bmesh
import bpy
from mathutils import Vector

OUT = sys.argv[sys.argv.index("--") + 1]
PPU = 48  # pixels per metre, the same for every sprite so scales match
RISE = PPU * math.cos(math.radians(30))  # screen pixels per metre of height

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
for name in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
    try:
        scene.render.engine = name
        break
    except TypeError:
        continue

scene.render.film_transparent = True
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.render.filter_size = 0.01
scene.view_settings.view_transform = "Standard"
try:
    scene.eevee.taa_render_samples = 1
except Exception as error:  # noqa: BLE001
    print("taa", error)

world = bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
background = world.node_tree.nodes.get("Background")
background.inputs[0].default_value = (0.5, 0.56, 0.85, 1)
background.inputs[1].default_value = 0.32


def lin(hex_colour):
    def channel(v):
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4

    h = hex_colour.lstrip("#")
    return (channel(int(h[0:2], 16)), channel(int(h[2:4], 16)), channel(int(h[4:6], 16)), 1)


MATERIALS = {}


def toon(colour, pattern=None, second=None, mortar=None, scale=5.0, squash=1.0):
    """Three flat bands of light, tinted by a colour or by rows of bricks, tiles or planks."""
    key = ("toon", colour, pattern, second, mortar, scale, squash)
    if key in MATERIALS:
        return MATERIALS[key]
    m = bpy.data.materials.new("toon")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    diffuse = nt.nodes.new("ShaderNodeBsdfDiffuse")
    diffuse.inputs["Color"].default_value = (1, 1, 1, 1)
    to_rgb = nt.nodes.new("ShaderNodeShaderToRGB")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "CONSTANT"
    stops = ramp.color_ramp.elements
    stops[0].position, stops[0].color = 0.0, (0.2, 0.22, 0.42, 1)
    stops[1].position, stops[1].color = 0.3, (0.5, 0.5, 0.66, 1)
    top = stops.new(0.6)
    top.color = (1, 1, 1, 1)
    multiply = nt.nodes.new("ShaderNodeVectorMath")
    multiply.operation = "MULTIPLY"
    nt.links.new(diffuse.outputs[0], to_rgb.inputs[0])
    nt.links.new(to_rgb.outputs[0], ramp.inputs[0])
    nt.links.new(ramp.outputs[0], multiply.inputs[0])
    if pattern is None:
        multiply.inputs[1].default_value = lin(colour)[:3]
    else:
        coords = nt.nodes.new("ShaderNodeTexCoord")
        split = nt.nodes.new("ShaderNodeSeparateXYZ")
        across = nt.nodes.new("ShaderNodeMath")
        across.operation = "ADD"
        up = nt.nodes.new("ShaderNodeMath")
        up.operation = "MULTIPLY"
        up.inputs[1].default_value = squash
        join = nt.nodes.new("ShaderNodeCombineXYZ")
        brick = nt.nodes.new("ShaderNodeTexBrick")
        brick.inputs["Color1"].default_value = lin(colour)
        brick.inputs["Color2"].default_value = lin(second or colour)
        brick.inputs["Mortar"].default_value = lin(mortar or colour)
        brick.inputs["Scale"].default_value = scale
        brick.inputs["Mortar Size"].default_value = 0.02
        if pattern == "planks":
            brick.inputs["Brick Width"].default_value = 3.0
            brick.inputs["Row Height"].default_value = 0.5
        nt.links.new(coords.outputs["Object"], split.inputs[0])
        nt.links.new(split.outputs["X"], across.inputs[0])
        nt.links.new(split.outputs["Y"], across.inputs[1])
        nt.links.new(split.outputs["Z"], up.inputs[0])
        nt.links.new(across.outputs[0], join.inputs["X"])
        nt.links.new(up.outputs[0], join.inputs["Y"])
        nt.links.new(join.outputs[0], brick.inputs["Vector"])
        nt.links.new(brick.outputs["Color"], multiply.inputs[1])
    nt.links.new(multiply.outputs[0], out.inputs["Surface"])
    MATERIALS[key] = m
    return m


def glow(colour, strength=1.0):
    key = ("glow", colour, strength)
    if key in MATERIALS:
        return MATERIALS[key]
    m = bpy.data.materials.new("glow")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emission = nt.nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = lin(colour)
    emission.inputs["Strength"].default_value = strength
    nt.links.new(emission.outputs[0], out.inputs["Surface"])
    MATERIALS[key] = m
    return m


def mesh_object(name, verts, faces, material):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    return obj


CUBE_FACES = [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]


def box(size, at, material):
    """A box `size` big whose base centre sits at `at`."""
    sx, sy = size[0] / 2, size[1] / 2
    x, y, z = at
    verts = [(x + dx * sx, y + dy * sy, z + dz * size[2]) for dz in (0, 1) for dx, dy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    return mesh_object("box", verts, CUBE_FACES, material)


def beam(start, end, thickness, material):
    """A square bar from one point to another, for braces and rails at any angle."""
    a, b = Vector(start), Vector(end)
    along = (b - a).normalized()
    side = along.cross(Vector((0, 0, 1)))
    if side.length < 1e-4:
        side = Vector((1, 0, 0))
    side.normalize()
    up = along.cross(side).normalized()
    h = thickness / 2
    verts = [tuple(p + side * dx * h + up * dy * h) for p in (a, b) for dx, dy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
    return mesh_object("beam", verts, CUBE_FACES, material)


def hip_roof(sx, sy, height, at, material):
    x, y, z = at
    a, b = sx / 2, sy / 2
    ridge = max(0.0, (sx - sy) / 2)
    verts = [(x - a, y - b, z), (x + a, y - b, z), (x + a, y + b, z), (x - a, y + b, z), (x - ridge, y, z + height), (x + ridge, y, z + height)]
    return mesh_object("roof", verts, [(0, 1, 2, 3), (0, 1, 5, 4), (1, 2, 5), (2, 3, 4, 5), (3, 0, 4)], material)


def frustum(bottom, top, at, height, material, segments=8):
    """A round-ish tapered column: a cylinder, a cone or one slice of a dome."""
    x, y, z = at
    ring = lambda r, zz: [(x + r * math.cos(2 * math.pi * i / segments), y + r * math.sin(2 * math.pi * i / segments), zz) for i in range(segments)]
    verts = ring(bottom, z) + ring(max(top, 0.001), z + height)
    faces = [tuple(range(segments)), tuple(range(segments, 2 * segments))]
    faces += [(i, (i + 1) % segments, segments + (i + 1) % segments, segments + i) for i in range(segments)]
    return mesh_object("frustum", verts, faces, material)


def barrel_roof(length, radius, at, material, segments=8):
    """Half a cylinder lying along X."""
    x, y, z = at
    arc = [(radius * math.cos(math.pi * i / segments), radius * math.sin(math.pi * i / segments)) for i in range(segments + 1)]
    verts = [(x + side * length / 2, y + dy, z + dz) for side in (-1, 1) for dy, dz in arc]
    n = segments + 1
    faces = [tuple(range(n)), tuple(range(n, 2 * n))] + [(i, i + 1, n + i + 1, n + i) for i in range(segments)]
    return mesh_object("barrel", verts, faces, material)


# One camera and one sun for every sprite.
camera_data = bpy.data.cameras.new("Camera")
camera_data.type = "ORTHO"
camera_data.sensor_fit = "HORIZONTAL"
camera = bpy.data.objects.new("Camera", camera_data)
scene.collection.objects.link(camera)
scene.camera = camera
VIEW = Vector((math.cos(math.radians(30)) * math.sin(math.radians(45)), -math.cos(math.radians(30)) * math.cos(math.radians(45)), math.sin(math.radians(30))))

sun_data = bpy.data.lights.new("Sun", "SUN")
sun_data.energy = 3.3
sun_data.angle = 0
sun = bpy.data.objects.new("Sun", sun_data)
scene.collection.objects.link(sun)
sun.rotation_euler = Vector((-0.8, 0.35, -0.9)).to_track_quat("-Z", "Y").to_euler()

try:
    scene.render.use_freestyle = True
    scene.render.line_thickness = 1.0
    view_layer = bpy.context.view_layer
    lineset = view_layer.freestyle_settings.linesets.new("outline") if not view_layer.freestyle_settings.linesets else view_layer.freestyle_settings.linesets[0]
    style = bpy.data.linestyles.new("outline")
    lineset.linestyle = style
    style.color = (0.05, 0.05, 0.12)
    style.thickness = 1.0
    lineset.select_silhouette = True
    lineset.select_border = True
    lineset.select_crease = True
    view_layer.freestyle_settings.crease_angle = math.radians(120)
except Exception as error:  # noqa: BLE001
    print("freestyle", error)

SHEET = {}


def render(name, top, width=288, pad=150):
    """Renders what is in the scene, records where the model's ground origin lands, then clears it.

    The origin recorded in sprites.json (ox, oy) is the model's ground point at (0, 0, 0): the
    base centre of a building, a tile's centre, the foot of a post, the middle of a gate's gap.
    """
    height = int(top * RISE + pad)
    aim = top / 2 - 0.25
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.resolution_percentage = 100
    camera_data.ortho_scale = width / PPU
    target = Vector((0, 0, aim))
    camera.location = target + VIEW * 40
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = OUT + "\\" + name + ".png"
    bpy.ops.render.render(write_still=True)
    SHEET[name] = {"w": width, "h": height, "ox": width / 2, "oy": height / 2 + aim * RISE}
    print("RENDERED", name)
    for obj in [o for o in scene.collection.objects if o.type == "MESH"]:
        bpy.data.objects.remove(obj, do_unlink=True)


BRICK = toon("#c98a6e", "brick", "#b5745c", "#e9dccb")
TRIM = toon("#efe6d2")
STONE = toon("#9a968f")
ROOF = toon("#56B4E9", "brick", "#3f9fd8", "#2f7fb5", scale=7.0, squash=1.6)
WOOD = toon("#a8733f", "planks", "#98632f", "#6f4a26", scale=6.0)
DARK = toon("#2a2f3a")
STEEL = toon("#d79a45")
METAL = toon("#aab3bd")
PANE = glow("#ffd66b", 1.0)
PINK = glow("#ff5fa8", 1.0)


def window(face, along, z, half=1.2, pane=None, wide=0.4):
    """A framed, lit window on the +X wall ("x") or the -Y wall ("y") of a building `half` deep."""
    pane = pane or PANE
    a, b, c = half + 0.02, half + 0.045, half + 0.05
    if face == "x":
        box((0.06, wide + 0.12, 0.66), (a, along, z - 0.04), TRIM)
        box((0.05, wide, 0.5), (b, along, z + 0.04), pane)
        box((0.06, 0.035, 0.5), (c, along, z + 0.04), TRIM)
        box((0.06, wide, 0.035), (c, along, z + 0.27), TRIM)
        box((0.1, wide + 0.2, 0.05), (c, along, z - 0.07), TRIM)
    else:
        box((wide + 0.12, 0.06, 0.66), (along, -a, z - 0.04), TRIM)
        box((wide, 0.05, 0.5), (along, -b, z + 0.04), pane)
        box((0.035, 0.06, 0.5), (along, -c, z + 0.04), TRIM)
        box((wide, 0.06, 0.035), (along, -c, z + 0.27), TRIM)
        box((wide + 0.2, 0.1, 0.05), (along, -c, z - 0.07), TRIM)


def workshop(floors):
    """A source file: a brick workshop with a blue hipped roof, one storey per size step."""
    tall = 1.05 * floors
    box((2.7, 2.7, 0.16), (0, 0, 0), STONE)
    box((2.4, 2.4, tall), (0, 0, 0.16), BRICK)
    for floor in range(floors):
        z = 0.62 + floor * 1.05
        if floor:
            box((2.46, 2.46, 0.08), (0, 0, 0.16 + floor * 1.05 - 0.02), TRIM)
        for along in (-0.6, 0.6):
            window("x", along, z)
        if floor:
            for along in (-0.72, 0.72):
                window("y", along, z)
    window("y", 0.74, 0.62)
    box((0.62, 0.06, 0.96), (-0.45, -1.22, 0.16), TRIM)
    box((0.5, 0.05, 0.88), (-0.45, -1.245, 0.16), WOOD)
    box((0.05, 0.05, 0.05), (-0.28, -1.28, 0.58), PANE)
    box((0.8, 0.34, 0.08), (-0.45, -1.4, 0.08), STONE)
    if floors > 1:
        mesh_object("awning", [(-0.85, -1.2, 1.3), (-0.05, -1.2, 1.3), (-0.05, -1.62, 1.12), (-0.85, -1.62, 1.12), (-0.85, -1.2, 1.24), (-0.05, -1.2, 1.24), (-0.05, -1.62, 1.06), (-0.85, -1.62, 1.06)], CUBE_FACES, ROOF)
        box((0.1, 0.1, 0.12), (0.05, -1.27, 1.0), PANE)
    box((0.42, 0.42, 0.42), (0.75, -1.5, 0.0), WOOD)
    if floors > 1:
        box((0.3, 0.3, 0.3), (0.72, -1.48, 0.42), WOOD)
    box((0.3, 0.3, 0.5), (1.5, -0.95, 0.0), DARK)
    top = 0.16 + tall
    box((2.86, 2.86, 0.1), (0, 0, top), TRIM)
    hip_roof(3.0, 3.0, 1.25, (0, 0, top + 0.1), ROOF)
    box((0.4, 0.4, 1.25), (-0.55, 0.45, top + 0.24), BRICK)
    box((0.5, 0.5, 0.08), (-0.55, 0.45, top + 1.49), STONE)
    box((0.24, 0.24, 0.12), (-0.55, 0.45, top + 1.57), DARK)
    return top + 1.7


def lab(floors):
    """A test file: a white tiled lab with a green roof deck and a glass dome."""
    tile = toon("#f2f5f7", "brick", "#e4eaee", "#c3ccd5", scale=4.0)
    green = toon("#009E73")
    glass = glow("#bff5e6", 0.95)
    tall = 1.05 * floors
    box((2.7, 2.7, 0.16), (0, 0, 0), STONE)
    box((2.4, 2.4, tall), (0, 0, 0.16), tile)
    for floor in range(floors):
        z = 0.62 + floor * 1.05
        box((2.46, 2.46, 0.07), (0, 0, 0.16 + floor * 1.05 + 0.98), green)
        window("x", 0.0, z, pane=glass, wide=1.3)
        if floor:
            window("y", 0.0, z, pane=glass, wide=1.3)
    window("y", 0.55, 0.62, pane=glass, wide=0.7)
    box((0.62, 0.06, 0.96), (-0.6, -1.22, 0.16), TRIM)
    box((0.5, 0.05, 0.88), (-0.6, -1.245, 0.16), green)
    box((0.8, 0.34, 0.08), (-0.6, -1.4, 0.08), STONE)
    top = 0.16 + tall
    box((2.6, 2.6, 0.14), (0, 0, top), green)
    for dx, dy, sx, sy in ((0, 1.25, 2.6, 0.1), (0, -1.25, 2.6, 0.1), (1.25, 0, 0.1, 2.6), (-1.25, 0, 0.1, 2.6)):
        box((sx, sy, 0.16), (dx, dy, top + 0.14), TRIM)
    frustum(0.86, 0.86, (0, 0, top + 0.14), 0.12, TRIM, 10)
    frustum(0.8, 0.68, (0, 0, top + 0.26), 0.26, glass, 10)
    frustum(0.68, 0.42, (0, 0, top + 0.52), 0.24, glass, 10)
    frustum(0.42, 0.06, (0, 0, top + 0.76), 0.18, glass, 10)
    box((0.3, 0.3, 0.4), (0.85, 0.85, top + 0.14), METAL)
    return top + 1.0


def library():
    """A docs file: a low cream hall with columns, steps and a yellow roof."""
    wall = toon("#eadfc4")
    yellow = toon("#F0E442", "brick", "#e2d53a", "#b8ab22", scale=7.0, squash=1.6)
    box((3.0, 2.5, 0.12), (0, 0, 0), STONE)
    box((2.8, 0.5, 0.1), (0, -1.3, 0.0), STONE)
    box((2.6, 2.0, 1.5), (0, 0, 0.12), wall)
    for along in (-0.5, 0.5):
        window("x", along, 0.75, half=1.3)
    box((0.6, 0.06, 1.1), (0, -1.02, 0.12), TRIM)
    box((0.46, 0.05, 1.0), (0, -1.045, 0.12), WOOD)
    for x in (-1.1, -0.4, 0.4, 1.1):
        frustum(0.1, 0.09, (x, -1.25, 0.12), 1.38, TRIM, 8)
        box((0.26, 0.26, 0.06), (x, -1.25, 0.12), STONE)
    box((2.9, 2.8, 0.14), (0, -0.15, 1.5), TRIM)
    hip_roof(3.0, 2.9, 0.75, (0, -0.15, 1.64), yellow)
    return 2.5


def shed():
    """A config file: a small plank shed with a dark blue lean-to roof."""
    plank = toon("#93a7bb", "planks", "#8397ab", "#5f7388", scale=6.0)
    blue = toon("#0072B2", "brick", "#0a66a0", "#06507e", scale=7.0, squash=1.6)
    box((1.7, 1.7, 0.1), (0, 0, 0), STONE)
    box((1.5, 1.5, 1.0), (0, 0, 0.1), plank)
    mesh_object("lean", [(-0.9, -0.95, 1.05), (0.9, -0.95, 1.05), (0.9, 0.9, 1.5), (-0.9, 0.9, 1.5), (-0.9, -0.95, 1.15), (0.9, -0.95, 1.15), (0.9, 0.9, 1.6), (-0.9, 0.9, 1.6)], CUBE_FACES, blue)
    mesh_object("gable", [(0.75, -0.75, 1.1), (0.75, 0.75, 1.1), (0.75, 0.75, 1.46), (0.75, -0.75, 1.1), (-0.75, 0.75, 1.1), (-0.75, 0.75, 1.46)], [(0, 1, 2), (1, 4, 5, 2)], plank)
    box((0.5, 0.05, 0.8), (-0.2, -0.77, 0.1), WOOD)
    box((0.05, 0.4, 0.34), (0.77, 0.1, 0.5), PANE)
    box((0.4, 0.3, 0.28), (0.5, -1.0, 0.0), toon("#d04f4f"))
    box((0.1, 0.1, 0.7), (1.0, 0.5, 0.0), METAL)
    return 1.7


def warehouse():
    """A generated file: a long metal store with an orange barrel roof and a roller door."""
    sheet = toon("#b9c0c9", "brick", "#adb4bd", "#8f97a1", scale=12.0, squash=0.15)
    orange = toon("#D55E00", "brick", "#c25400", "#9a4300", scale=9.0, squash=0.2)
    box((3.3, 2.5, 0.1), (0, 0, 0), STONE)
    box((3.0, 2.2, 1.25), (0, 0, 0.1), sheet)
    barrel_roof(3.1, 1.16, (0, 0, 1.35), orange, 8)
    box((1.3, 0.05, 1.0), (-0.5, -1.12, 0.1), DARK)
    for i in range(5):
        box((1.3, 0.06, 0.03), (-0.5, -1.13, 0.25 + i * 0.18), METAL)
    box((1.5, 0.07, 0.08), (-0.5, -1.13, 1.1), toon("#f2b632"))
    window("x", 0.0, 0.6, half=1.5, wide=0.9)
    box((0.5, 0.5, 0.5), (1.0, -1.45, 0.0), orange)
    return 2.6


def hut():
    """A file with no recognised role: a plain grey hut."""
    plaster = toon("#cfd3d9")
    box((1.6, 1.6, 0.1), (0, 0, 0), STONE)
    box((1.4, 1.4, 0.85), (0, 0, 0.1), plaster)
    box((1.56, 1.56, 0.12), (0, 0, 0.95), toon("#c9ced6"))
    box((0.4, 0.05, 0.62), (-0.2, -0.72, 0.1), WOOD)
    box((0.05, 0.36, 0.3), (0.72, 0.1, 0.45), PANE)
    return 1.15


def scaffolding(rx, ry, tall):
    """The overlay for a changed file: poles, decks and braces around the two near walls."""
    ys = [-ry + i * (2 * ry) / 3 for i in range(4)]
    xs = [-rx + i * (2 * rx) / 3 for i in range(3)]
    for x, y in [(rx, y) for y in ys] + [(x, -ry) for x in xs]:
        box((0.08, 0.08, tall), (x, y, 0), STEEL)
        box((0.2, 0.2, 0.05), (x, y, 0), DARK)
    levels = [1.15 + i * 1.1 for i in range(int((tall - 0.4) // 1.1))]
    for z in levels + [tall - 0.12]:
        beam((rx, -ry, z), (rx, ry, z), 0.07, STEEL)
        beam((-rx, -ry, z), (rx, -ry, z), 0.07, STEEL)
    for z in levels:
        box((0.42, 2 * ry + 0.06, 0.06), (rx - 0.19, 0, z + 0.04), WOOD)
        box((2 * rx + 0.06, 0.42, 0.06), (0, -ry + 0.19, z + 0.04), WOOD)
        beam((rx, -ry, z + 0.55), (rx, ry, z + 0.55), 0.05, STEEL)
        beam((-rx, -ry, z + 0.55), (rx, -ry, z + 0.55), 0.05, STEEL)
    low = [0.05] + levels
    for i in range(len(low) - 1):
        a, b = (ys[i % 3], ys[i % 3 + 1]) if i % 2 == 0 else (ys[i % 3 + 1], ys[i % 3])
        beam((rx, a, low[i]), (rx, b, low[i + 1]), 0.05, STEEL)
        c, d = (xs[i % 2], xs[i % 2 + 1]) if i % 2 == 0 else (xs[i % 2 + 1], xs[i % 2])
        beam((c, -ry, low[i]), (d, -ry, low[i + 1]), 0.05, STEEL)
    if levels:
        for dx in (-0.16, 0.16):
            beam((rx * 0.55 + dx, -ry - 0.1, 0.0), (rx * 0.55 + dx, -ry + 0.12, 1.3), 0.05, STEEL)
        for i in range(5):
            t = 0.15 + i * 0.2
            beam((rx * 0.55 - 0.16, -ry - 0.1 + 0.22 * t, 1.3 * t), (rx * 0.55 + 0.16, -ry - 0.1 + 0.22 * t, 1.3 * t), 0.04, STEEL)
    return tall + 0.1


def tower_crane():
    """Stands beside a changed file so the change shows above the roofs."""
    yellow = toon("#f2b632")
    box((0.9, 0.9, 0.2), (0, 0, 0), STONE)
    box((0.3, 0.3, 6.6), (0, 0, 0.2), yellow)
    for i in range(12):
        box((0.34, 0.34, 0.05), (0, 0, 0.6 + i * 0.52), DARK)
    box((0.6, 0.6, 0.45), (0, 0, 6.8), TRIM)
    box((0.05, 0.3, 0.26), (0.31, 0, 6.9), PANE)
    beam((-1.4, 0, 7.4), (3.6, 0, 7.4), 0.2, yellow)
    beam((0, 0, 8.2), (3.4, 0, 7.5), 0.05, DARK)
    beam((0, 0, 8.2), (-1.3, 0, 7.5), 0.05, DARK)
    box((0.2, 0.2, 0.95), (0, 0, 7.25), yellow)
    box((0.7, 0.5, 0.5), (-1.2, 0, 6.85), STONE)
    beam((2.9, 0, 7.3), (2.9, 0, 5.6), 0.035, DARK)
    box((0.4, 0.4, 0.4), (2.9, 0, 5.2), PINK)
    return 8.4


def dock_crane():
    """The harbour's process structure: a gantry crane lifting a container."""
    red = toon("#d04f4f")
    for x, y in ((-0.7, -0.6), (-0.7, 0.6), (0.7, -0.6), (0.7, 0.6)):
        box((0.2, 0.2, 3.0), (x, y, 0), red)
    box((1.8, 1.6, 0.25), (0, 0, 3.0), red)
    beam((-1.2, 0, 3.6), (3.4, 0, 3.6), 0.26, red)
    beam((0, 0, 4.6), (3.2, 0, 3.75), 0.05, DARK)
    box((0.2, 0.2, 1.0), (0, 0, 3.6), red)
    box((0.7, 0.6, 0.5), (0.3, 0.55, 3.1), TRIM)
    beam((2.6, 0, 3.5), (2.6, 0, 2.0), 0.035, DARK)
    box((1.1, 0.5, 0.5), (2.6, 0, 1.5), toon("#e8a23c", "brick", "#d8922c", "#a86a1c", scale=10.0, squash=0.1))
    box((1.1, 0.5, 0.5), (-0.1, -1.4, 0.0), toon("#4f9fd0"))
    box((1.1, 0.5, 0.5), (-0.1, -1.4, 0.5), toon("#58b070"))
    return 4.8


def dish(at, aim, radius):
    """A shallow satellite dish on a short arm, its open face turned toward `aim`."""
    quat = Vector(aim).normalized().to_track_quat("Z", "Y")
    forward = quat @ Vector((0, 0, 1))
    start = Vector(at)
    bowl = frustum(0.03, radius, (0, 0, 0), 0.16, TRIM, 12)
    face = frustum(radius * 0.9, radius * 0.9, (0, 0, 0.155), 0.015, toon("#9fb3d1"), 12)
    for part, shift in ((bowl, 0.0), (face, 0.0)):
        part.rotation_euler = quat.to_euler()
        part.location = start + forward * (0.12 + shift)
    beam(tuple(start), tuple(start + forward * 0.14), 0.06, DARK)
    beam(tuple(start + forward * (0.12 + 0.16)), tuple(start + forward * (0.12 + 0.3)), 0.03, DARK)
    box((0.07, 0.07, 0.07), tuple(start + forward * (0.12 + 0.3) - Vector((0.035, 0.035, 0.035))), PINK)


def radio_mast():
    """The harbour's network structure: a mast with a dish and a relay hut."""
    box((1.2, 1.1, 0.8), (-0.3, 0.5, 0), toon("#cfd3d9"))
    box((1.3, 1.2, 0.1), (-0.3, 0.5, 0.8), toon("#56B4E9"))
    box((0.05, 0.3, 0.3), (0.31, 0.5, 0.35), PANE)
    box((0.18, 0.18, 5.2), (0.5, -0.4, 0), METAL)
    for i in range(9):
        box((0.26, 0.26, 0.04), (0.5, -0.4, 0.5 + i * 0.55), DARK)
    for z, r, aim in ((3.5, 0.22, (0.75, -0.65, 0.2)), (4.4, 0.16, (1.0, -0.25, 0.15))):
        dish((0.5, -0.4, z), aim, r)
    box((0.26, 0.26, 0.26), (0.5, -0.4, 5.2), PINK)
    return 5.6


def silos():
    """The harbour's file-system structure: two storage silos."""
    steel = toon("#d9dde3", "brick", "#ccd1d8", "#aab1ba", scale=6.0, squash=0.6)
    for x, y in ((-0.6, 0.3), (0.75, -0.35)):
        frustum(0.8, 0.8, (x, y, 0), 2.6, steel, 12)
        frustum(0.86, 0.12, (x, y, 2.6), 0.6, METAL, 12)
        box((0.1, 0.1, 0.2), (x, y, 3.2), DARK)
    for i in range(9):
        box((0.3, 0.05, 0.04), (0.75, -1.17, 0.3 + i * 0.28), DARK)
    beam((-0.6, 0.3, 2.9), (0.75, -0.35, 2.9), 0.1, METAL)
    return 3.5


def clock_tower():
    """The harbour's timer structure: a brick clock tower."""
    box((1.3, 1.3, 0.15), (0, 0, 0), STONE)
    box((1.05, 1.05, 3.2), (0, 0, 0.15), BRICK)
    box((1.2, 1.2, 0.12), (0, 0, 2.3), TRIM)
    box((1.25, 1.25, 0.12), (0, 0, 3.35), TRIM)
    hip_roof(1.4, 1.4, 1.0, (0, 0, 3.47), toon("#8a5a3a", "brick", "#7a4a2a", "#5a3a20", scale=7.0, squash=1.6))
    face_x = frustum(0.36, 0.36, (0, 0, 0), 0.06, glow("#fffbe8", 1.0), 12)
    face_x.rotation_euler = (0, math.radians(90), 0)
    face_x.location = (0.53, 0, 2.85)
    face_y = frustum(0.36, 0.36, (0, 0, 0), 0.06, glow("#fffbe8", 1.0), 12)
    face_y.rotation_euler = (math.radians(90), 0, 0)
    face_y.location = (0, -0.53, 2.85)
    box((0.03, 0.04, 0.26), (0.6, 0, 2.85), DARK)
    box((0.03, 0.2, 0.04), (0.6, 0.1, 2.85), DARK)
    box((0.04, 0.03, 0.26), (0, -0.6, 2.85), DARK)
    box((0.2, 0.03, 0.04), (0.1, -0.6, 2.85), DARK)
    box((0.4, 0.05, 0.7), (0, -0.54, 0.15), WOOD)
    return 4.6


def tree():
    leaf = toon("#2c8a56")
    box((0.2, 0.2, 0.55), (0, 0, 0), toon("#6a5038"))
    frustum(0.75, 0.38, (0, 0, 0.45), 0.6, leaf, 7)
    frustum(0.6, 0.24, (0, 0, 1.0), 0.6, leaf, 7)
    frustum(0.42, 0.0, (0, 0, 1.55), 0.65, leaf, 7)
    return 2.3


def lamp():
    box((0.16, 0.16, 0.12), (0, 0, 0), DARK)
    box((0.08, 0.08, 1.9), (0, 0, 0.1), DARK)
    beam((0, 0, 1.95), (0.35, 0, 1.95), 0.06, DARK)
    box((0.22, 0.22, 0.2), (0.35, 0, 1.7), glow("#ffe08a", 1.0))
    return 2.1



def fence(along_x):
    """One metre of construction barrier, for the edge of a mostly-new folder."""
    orange = toon("#ff8a2a")
    for t in (-0.5, 0.5):
        box((0.08, 0.08, 0.78), (t, 0, 0) if along_x else (0, t, 0), DARK)
    for i in range(4):
        t = -0.375 + i * 0.25
        for z in (0.24, 0.52):
            box((0.25, 0.05, 0.16) if along_x else (0.05, 0.25, 0.16), (t, 0, z) if along_x else (0, t, z), orange if (i + (z > 0.4)) % 2 else TRIM)
    return 0.85


def sign():
    """The board that names a mostly-new folder."""
    orange = toon("#ff8a2a")
    for x in (-1.0, 1.0):
        box((0.12, 0.12, 2.7), (x, 0, 0), DARK)
    box((2.5, 0.1, 1.3), (0, 0, 1.3), orange)
    box((2.3, 0.06, 1.1), (0, -0.06, 1.4), TRIM)
    for i in range(6):
        box((0.2, 0.07, 0.14), (-1.0 + i * 0.4, -0.07, 1.42), orange if i % 2 else DARK)
    for x in (-0.7, 0.7):
        beam((x, -0.05, 2.6), (x, -0.4, 2.75), 0.05, DARK)
        box((0.16, 0.16, 0.12), (x, -0.42, 2.66), glow("#ffe08a", 1.0))
    return 2.9


# ---- Sprites added for the adopted SPEC (issue #100). Each is chosen by one fact. ----

RED = toon("#d04f4f")
ORANGE = toon("#ff8a2a")
CREAM = toon("#eadfc4")


def posed(obj, at, rotation=(0, 0, 0)):
    """Moves an object made at the origin to `at`, turned by `rotation` about its own base."""
    obj.rotation_euler = rotation
    obj.location = at
    return obj


def slab(low, high, material):
    """A prism between two quads, for hulls, ramps and leaning lids."""
    return mesh_object("slab", list(low) + list(high), CUBE_FACES, material)


def arch(centre, inner, outer, thick, material, segments=9):
    """A half ring standing in the XZ plane, centred on `centre`, built from closed wedges."""
    cx, cy, cz = centre
    for i in range(segments):
        a0, a1 = math.pi * i / segments, math.pi * (i + 1) / segments
        low = [(cx + inner * math.cos(a0), cy - thick / 2, cz + inner * math.sin(a0)), (cx + outer * math.cos(a0), cy - thick / 2, cz + outer * math.sin(a0)), (cx + outer * math.cos(a1), cy - thick / 2, cz + outer * math.sin(a1)), (cx + inner * math.cos(a1), cy - thick / 2, cz + inner * math.sin(a1))]
        high = [(x, y + thick, z) for x, y, z in low]
        mesh_object("wedge", low + high, CUBE_FACES, material)


# Harbour: one structure per kind of outside resource. Queue and code loaded at run time are new.
def port_queue():
    """The harbour's queue structure: a quay with a rail line and a train of wagons waiting."""
    box((3.6, 1.7, 0.2), (0, 0, 0), STONE)
    for y in (-0.38, 0.38):
        box((3.5, 0.07, 0.05), (0, y, 0.2), METAL)
    for i in range(9):
        box((0.1, 1.0, 0.05), (-1.6 + i * 0.4, 0, 0.2), WOOD)
    for i, colour in enumerate(("#4f9fd0", "#58b070", "#e8a23c", "#d04f4f")):
        x = -1.15 + i * 0.78
        box((0.66, 0.74, 0.5), (x, 0, 0.3), toon(colour))
        box((0.7, 0.78, 0.07), (x, 0, 0.8), TRIM)
        for dx in (-0.2, 0.2):
            box((0.14, 0.78, 0.14), (x + dx, 0, 0.22), DARK)
    box((0.2, 0.9, 0.5), (1.65, 0, 0.2), RED)
    box((0.26, 0.96, 0.1), (1.65, 0, 0.7), toon("#f2b632"))
    return 1.4


def port_dynamic_load():
    """The harbour's code-loaded-at-run-time structure: a cargo barge with its hatch open."""
    hull = toon("#8aa6cc")
    slab([(-1.8, -0.6, 0.0), (1.4, -0.6, 0.0), (1.4, 0.6, 0.0), (-1.8, 0.6, 0.0)], [(-1.95, -0.7, 0.8), (1.8, -0.7, 0.8), (1.8, 0.7, 0.8), (-1.95, 0.7, 0.8)], hull)
    box((3.7, 1.4, 0.05), (-0.07, 0, 0.8), WOOD)
    box((0.9, 1.0, 0.9), (-1.25, 0, 0.85), TRIM)
    box((0.05, 0.6, 0.3), (-0.79, 0, 1.3), PANE)
    box((1.0, 0.9, 0.5), (-1.25, 0, 1.75), RED)
    box((1.2, 0.9, 0.04), (0.5, 0, 0.85), glow("#ffd66b", 1.0))
    box((1.3, 1.0, 0.18), (0.5, 0, 0.8), DARK)
    box((1.2, 0.9, 0.04), (0.5, 0, 0.98), glow("#ffd66b", 1.0))
    slab([(-0.1, 0.5, 1.0), (1.1, 0.5, 1.0), (1.1, 0.56, 1.0), (-0.1, 0.56, 1.0)], [(-0.1, 0.5, 1.9), (1.1, 0.5, 1.9), (1.1, 0.56, 1.9), (-0.1, 0.56, 1.9)], WOOD)
    for x in (1.35, 1.35):
        box((0.12, 0.12, 0.85), (x, -0.45, 0.8), METAL)
    box((0.12, 0.12, 0.85), (1.35, 0.45, 0.8), METAL)
    return 2.5


# Plinth: the stone a building stands on, in four steps. The building's own base sits on the top.
def plinth(height):
    box((3.4, 3.4, 0.12), (0, 0, 0), STONE)
    box((3.2, 3.2, height - 0.2), (0, 0, 0.12), toon("#9a968f", "brick", "#8c8882", "#6f6c67", scale=4.0, squash=1.4))
    box((3.3, 3.3, 0.08), (0, 0, height - 0.08), TRIM)
    steps = max(1, round(height / 0.3))
    for i in range(steps):
        box((0.9, 0.3 * (steps - i), height * (i + 1) / steps), (0, -1.7 - 0.3 * (steps - i), 0), STONE)
    return height + 0.3


def gate():
    """A way in: an archway across the front of a lot, the gap centred on the origin."""
    for x in (-0.75, 0.75):
        box((0.36, 0.5, 1.5), (x, 0, 0), STONE)
        box((0.46, 0.6, 0.12), (x, 0, 0.0), TRIM)
        box((0.46, 0.6, 0.12), (x, 0, 1.5), TRIM)
    arch((0, 0, 1.56), 0.58, 0.93, 0.5, STONE)
    box((0.3, 0.56, 0.3), (0, 0, 2.38), TRIM)
    for x in (-0.75, 0.75):
        box((0.2, 0.2, 0.22), (x, -0.32, 1.62), glow("#ffe08a", 1.0))
    return 2.8


def footpath(along_x):
    """One metre of footpath, laid from the road to a door. Same stones, kept apart by axis."""
    slate = toon("#b9b2a4")
    alt = toon("#a39c8e")
    box((1.0, 1.0, 0.03), (0, 0, 0), toon("#7d776b"))
    for i in range(2):
        for j in range(2):
            box((0.46, 0.46, 0.045), (-0.25 + i * 0.5, -0.25 + j * 0.5, 0.0), slate if (i + j) % 2 else alt)
    if along_x:
        box((1.0, 0.04, 0.05), (0, 0.0, 0.0), toon("#7d776b"))
    else:
        box((0.04, 1.0, 0.05), (0, 0.0, 0.0), toon("#7d776b"))
    return 0.2


def rubble():
    """What a removed or moved file leaves on its lot: broken brick, stone and beams."""
    items = [
        ((0.9, 0.7, 0.45), (-0.6, 0.2, 0), (0, 0.1, 0.4), BRICK),
        ((0.6, 0.5, 0.35), (0.5, 0.4, 0), (0.2, 0, -0.5), STONE),
        ((0.5, 0.4, 0.3), (0.1, -0.5, 0), (0, -0.2, 0.9), BRICK),
        ((0.7, 0.5, 0.3), (-0.2, -0.1, 0.3), (0.2, 0.3, 0.2), STONE),
        ((0.4, 0.4, 0.3), (0.8, -0.4, 0), (0.1, 0.2, 0.3), TRIM),
        ((0.35, 0.3, 0.25), (-0.9, -0.5, 0), (0, 0, 1.1), STONE),
        ((0.3, 0.25, 0.2), (0.35, 0.05, 0.28), (0.4, 0.2, 0.2), BRICK),
    ]
    for size, at, rot, material in items:
        posed(box(size, (0, 0, 0), material), at, rot)
    for at, rot, length in (((-0.3, 0.7, 0.05), (0, 0, 0.3), 1.5), ((0.6, -0.7, 0.05), (0.1, 0.0, -0.4), 1.2), ((-0.1, 0.0, 0.35), (0.3, 0.1, 1.2), 1.0)):
        posed(box((length, 0.12, 0.12), (0, 0, 0), WOOD), at, rot)
    return 1.0


def sign_moved():
    """A small signpost with a blank board, for the new path. Board centre is 0.93 m up the post."""
    for x in (-0.55, 0.55):
        box((0.09, 0.09, 1.2), (x, 0, 0), DARK)
    box((1.4, 0.07, 0.62), (0, 0, 0.62), WOOD)
    box((1.26, 0.05, 0.48), (0, -0.06, 0.69), TRIM)
    for x in (-0.55, 0.55):
        box((0.12, 0.12, 0.06), (x, 0, 1.2), ORANGE)
    return 1.4


# Inside a file, walls down. Tiles are one metre; origin is the tile's centre on the floor.
FLOOR_A = toon("#a89b88")
FLOOR_B = toon("#968a79")


def floor_tile():
    box((1.0, 1.0, 0.06), (0, 0, 0), toon("#5f4a34"))
    for i in range(4):
        box((0.23, 0.94, 0.04), (-0.355 + i * 0.237, 0, 0.05), FLOOR_A if i % 2 else FLOOR_B)
    return 0.2


def floor_changed():
    """The floor of a changed function's room: an orange and cream check."""
    box((1.0, 1.0, 0.06), (0, 0, 0), toon("#5f4a34"))
    for i in range(2):
        for j in range(2):
            box((0.47, 0.47, 0.045), (-0.25 + i * 0.5, -0.25 + j * 0.5, 0.05), toon("#ff7a1a") if (i + j) % 2 else TRIM)
    return 0.2


def wall_x():
    """A low wall one metre long, running along X, centred on the origin."""
    box((1.0, 0.14, 0.55), (0, 0, 0), CREAM)
    box((1.04, 0.18, 0.06), (0, 0, 0.55), TRIM)
    return 0.7


def wall_y():
    box((0.14, 1.0, 0.55), (0, 0, 0), CREAM)
    box((0.18, 1.04, 0.06), (0, 0, 0.55), TRIM)
    return 0.7


def door_outside():
    """A one-metre wall segment, along X, with an open doorway to the outside."""
    box((0.3, 0.14, 0.55), (-0.35, 0, 0), CREAM)
    box((0.3, 0.14, 0.55), (0.35, 0, 0), CREAM)
    box((0.4, 0.14, 0.1), (0, 0, 0.45), CREAM)
    box((1.04, 0.18, 0.06), (0, 0, 0.55), TRIM)
    box((0.4, 0.02, 0.45), (0, 0.04, 0.0), glow("#8fb4ff", 0.9))
    box((0.07, 0.17, 0.45), (-0.2, 0, 0), WOOD)
    box((0.07, 0.17, 0.45), (0.2, 0, 0), WOOD)
    box((0.46, 0.17, 0.05), (0, 0, 0.4), WOOD)
    box((0.7, 0.24, 0.03), (0, -0.2, 0), toon("#b04a4a"))
    return 0.7


def cone():
    """A traffic cone, for a changed function's room."""
    box((0.3, 0.3, 0.04), (0, 0, 0), DARK)
    frustum(0.13, 0.03, (0, 0, 0.04), 0.46, ORANGE, 8)
    frustum(0.097, 0.07, (0, 0, 0.2), 0.1, TRIM, 8)
    return 0.6


# Room objects, one per kind of outside call.
def object_process():
    """A call that starts a process: a terminal on a desk."""
    box((0.8, 0.45, 0.04), (0, 0, 0.4), WOOD)
    for x in (-0.34, 0.34):
        box((0.06, 0.4, 0.4), (x, 0, 0), WOOD)
    box((0.1, 0.1, 0.08), (0, 0.05, 0.44), DARK)
    box((0.5, 0.06, 0.36), (0, 0.04, 0.52), DARK)
    box((0.44, 0.04, 0.3), (0, -0.0, 0.55), glow("#7be0a0", 1.0))
    box((0.4, 0.14, 0.03), (0, -0.2, 0.44), METAL)
    return 1.1


def object_network():
    """A call across the network: an antenna mast on a box."""
    box((0.5, 0.5, 0.3), (0, 0, 0), toon("#cfd3d9"))
    box((0.07, 0.07, 1.0), (0, 0, 0.3), METAL)
    for z, w in ((0.7, 0.5), (0.95, 0.36), (1.18, 0.22)):
        box((w, 0.04, 0.04), (0, 0, z), DARK)
    box((0.14, 0.14, 0.14), (0, 0, 1.3), PINK)
    box((0.05, 0.1, 0.1), (0.26, 0, 0.12), PANE)
    return 1.6


def object_file_system():
    """A call to the file system: a filing cabinet."""
    metal = toon("#8fa0b4")
    box((0.55, 0.5, 0.95), (0, 0, 0), metal)
    for i in range(3):
        z = 0.07 + i * 0.3
        box((0.47, 0.04, 0.24), (0, -0.26, z), toon("#a2b2c4"))
        box((0.2, 0.06, 0.04), (0, -0.29, z + 0.12), DARK)
        box((0.2, 0.05, 0.07), (0, -0.28, z + 0.15), TRIM)
    return 1.15


def object_queue():
    """A call to a queue: a post box with a flag, letters waiting."""
    box((0.08, 0.08, 0.5), (0, 0, 0), DARK)
    box((0.7, 0.4, 0.34), (0, 0, 0.5), RED)
    barrel_roof(0.7, 0.2, (0, 0, 0.84), RED, 8)
    box((0.34, 0.05, 0.06), (0, -0.21, 0.62), DARK)
    box((0.04, 0.05, 0.3), (0.38, 0, 0.84), toon("#f2b632"))
    box((0.1, 0.18, 0.08), (0.38, 0, 1.1), toon("#f2b632"))
    return 1.35


def object_timer():
    """A call that waits on a timer: a standing clock."""
    box((0.42, 0.3, 0.2), (0, 0, 0), WOOD)
    box((0.3, 0.22, 0.7), (0, 0, 0.2), WOOD)
    box((0.46, 0.34, 0.08), (0, 0, 0.9), WOOD)
    face = frustum(0.19, 0.19, (0, 0, 0), 0.04, glow("#fffbe8", 1.0), 12)
    posed(face, (0, -0.11, 0.66), (math.radians(90), 0, 0))
    box((0.025, 0.03, 0.15), (0, -0.14, 0.66), DARK)
    box((0.11, 0.03, 0.025), (0.04, -0.14, 0.66), DARK)
    return 1.2


def object_dynamic_load():
    """A call that loads code at run time: a floor hatch with its lid standing open."""
    box((0.9, 0.9, 0.06), (0, 0, 0), STONE)
    box((0.7, 0.7, 0.07), (0, 0, 0.0), glow("#ffd66b", 1.0))
    box((0.74, 0.74, 0.03), (0, 0, 0.06), toon("#4a5878"))
    slab([(-0.36, 0.38, 0.06), (0.36, 0.38, 0.06), (0.36, 0.45, 0.06), (-0.36, 0.45, 0.06)], [(-0.36, 0.0, 0.7), (0.36, 0.0, 0.7), (0.36, 0.07, 0.7), (-0.36, 0.07, 0.7)], WOOD)
    return 1.0


for floors in (1, 2, 3):
    render("workshop-%d" % floors, workshop(floors))
for floors in (1, 2):
    render("lab-%d" % floors, lab(floors))
render("library", library())
render("shed", shed(), 192)
render("warehouse", warehouse())
render("hut", hut(), 192)
for name, (rx, ry, tall) in {"scaffold-1": (1.62, 1.62, 2.75), "scaffold-2": (1.62, 1.62, 3.75), "scaffold-3": (1.62, 1.62, 4.8), "scaffold-low": (1.75, 1.5, 2.5), "scaffold-small": (1.05, 1.05, 1.9)}.items():
    render(name, scaffolding(rx, ry, tall))
render("crane", tower_crane(), 384)
render("port-process", dock_crane(), 384)
render("port-network", radio_mast(), 240)
render("port-file-system", silos(), 240)
render("port-timer", clock_tower(), 192)
render("tree", tree(), 112)
render("lamp", lamp(), 96)

render("fence-x", fence(True), 112)
render("fence-y", fence(False), 112)
render("sign", sign(), 208)

# Added for #100. Names are the fact that chooses the sprite.
render("port-queue", port_queue(), 288)
render("port-dynamic-load", port_dynamic_load(), 288)
for step, height in enumerate((0.3, 0.6, 0.9, 1.2), 1):
    render("plinth-%d" % step, plinth(height), 288, 190)
render("gate", gate(), 144, 60)
render("footpath-x", footpath(True), 96, 80)
render("footpath-y", footpath(False), 96, 80)
render("rubble", rubble(), 192, 60)
render("sign-moved", sign_moved(), 176, 60)
render("floor", floor_tile(), 96, 80)
render("floor-changed", floor_changed(), 96, 80)
render("wall-x", wall_x(), 96, 40)
render("wall-y", wall_y(), 96, 40)
render("door-outside", door_outside(), 96, 40)
render("cone", cone(), 64, 30)
render("object-process", object_process(), 112, 40)
render("object-network", object_network(), 96, 40)
render("object-file-system", object_file_system(), 96, 40)
render("object-queue", object_queue(), 112, 40)
render("object-timer", object_timer(), 96, 40)
render("object-dynamic-load", object_dynamic_load(), 96, 40)

with open(OUT + "\\sprites.json", "w") as handle:
    json.dump(SHEET, handle, indent=1)
print("DONE", len(SHEET))
