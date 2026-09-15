"""Frameless SSH display generated through Blender MCP; named layers remain editable.
Blender X/-Y/Z become glTF X/Z/Y. The existing archive package is reused.
"""
import bpy
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
scene = bpy.data.scenes.new('Rhine_Terminal_Work')
bpy.context.window.scene = scene
for old in list(bpy.data.scenes):
    if old != scene and old.name.startswith('Rhine_Terminal_Asset'):
        for obj in list(old.objects):
            if len(obj.users_scene) == 1:
                bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.scenes.remove(old)
scene.name = 'Rhine_Terminal_Asset'
for mat in list(bpy.data.materials):
    if mat.name.startswith('Terminal_') and mat.users == 0:
        bpy.data.materials.remove(mat)

def material(name, color, roughness, metalness=0, emission=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metalness
    bsdf.inputs['Emission Color'].default_value = (*color, 1)
    bsdf.inputs['Emission Strength'].default_value = emission
    return mat

shell = material('Terminal_Shell', (.20, .27, .30), .32, .48)
seam = material('Terminal_Seam', (.02, .04, .055), .65, .2)
board = material('Terminal_Board', (.04, .09, .10), .46, .35)
guide = material('Terminal_Guide', (.32, .57, .63), .24, .15, .6)
amber = material('Terminal_Amber', (.66, .44, .22), .28, .2, .5)
display = material('Terminal_Display', (.01, .02, .03), .7)
parts = {}
for name, depth in [('bezel', .096), ('screen', .139), ('vents', -.001), ('board', -.045), ('backplate', -.108)]:
    obj = bpy.data.objects.new('Terminal_' + name, None)
    scene.collection.objects.link(obj)
    obj.location = (0, -depth, 1.565)
    obj['deckPart'] = name
    parts[name] = obj

def box(part, name, x, y, z, w, h, d, mat, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = (w, d, h)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    if bevel:
        mod = obj.modifiers.new('Micro edge', 'BEVEL')
        mod.width, mod.segments = bevel, 2
        bpy.ops.object.modifier_apply(modifier=mod.name)
        mod = obj.modifiers.new('Hard normals', 'WEIGHTED_NORMAL')
        bpy.ops.object.modifier_apply(modifier=mod.name)
    obj.parent = parts[part]
    obj.location = (x, -z, y)
    return obj

# The display covers the entire face of the rear stack.
mesh = bpy.data.meshes.new('Edge display surface')
mesh.from_pydata([(-2.18, 0, -1.21), (2.18, 0, -1.21), (2.18, 0, 1.21), (-2.18, 0, 1.21)], [], [(0, 1, 2, 3)])
mesh.update()
uv = mesh.uv_layers.new(name='UVMap')
for loop, xy in zip(uv.data, [(0, 0), (1, 0), (1, 1), (0, 1)]):
    loop.uv = xy
obj = bpy.data.objects.new('Terminal_Screen', mesh)
scene.collection.objects.link(obj)
obj.parent = parts['screen']
obj['terminalScreen'] = True
mesh.materials.append(display)
box('screen', 'Glass substrate', 0, 0, -.016, 4.36, 2.42, .026, seam, .004)

# Tiny optical alignment marks replace the perimeter bezel.
for x in [-2.188, 2.188]:
    for y in [-1.218, 1.218]:
        box('bezel', 'Alignment guide', x, y - (.055 if y > 0 else -.055), .047, .012, .12, .012, guide)
        box('bezel', 'Alignment guide', x - (.055 if x > 0 else -.055), y, .047, .12, .012, .012, guide)
box('bezel', 'Status light', 1.91, -1.223, .047, .22, .010, .012, amber)
box('vents', 'Thermal sheet', 0, 0, 0, 4.30, 2.36, .032, shell, .008)
for x in [-2.152, 2.152]:
    for i in range(9):
        box('vents', 'Side thermal slot', x, -.8 + i * .2, 0, .006, .09, .030, seam)
box('board', 'Circuit carrier', 0, 0, 0, 4.18, 2.24, .026, board, .004)
for i, (x, y, w, h) in enumerate([(-1.5, .6, .5, .3), (-.6, .55, .7, .45), (.55, .5, .6, .35), (1.5, .6, .5, .3), (-1.1, -.4, .9, .32), (.35, -.35, .6, .5), (1.4, -.4, .55, .3)]):
    box('board', 'Logic module', x, y, -.026, w, h, .025, seam if i % 3 else shell, .003)
for y in [-.8, .85]:
    box('board', 'Signal bus', 0, y, -.018, 3.75, .012, .006, guide)
box('backplate', 'Rear plate', 0, 0, 0, 4.30, 2.36, .034, shell, .008)
box('backplate', 'Rear recess', 0, 0, -.019, 3.8, 1.85, .014, seam, .006)
for x in [-1.25, 0, 1.25]:
    box('backplate', 'Interface recess', x, -.97, -.024, .7, .11, .012, seam)

for obj in scene.objects:
    obj['assetRole'] = 'ssh-terminal-insert'
    obj.select_set(True)
output = ROOT / 'art/.cache/ssh-terminal.glb'
output.parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=str(output), export_format='GLB', use_selection=True, use_active_scene=True, export_apply=True, export_extras=True)
destination = ROOT / 'src/ssh/assets/ssh-terminal.glb'
destination.parent.mkdir(parents=True, exist_ok=True)
os.replace(output, destination)
bpy.data.libraries.write(str(ROOT / 'art/ssh-terminal.blend'), {scene}, fake_user=True)
print('Frameless terminal exported: 4.36 x 2.42 display, five named layers')
