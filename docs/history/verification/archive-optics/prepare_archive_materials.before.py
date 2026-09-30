"""Prepare project-owned material parents for the native archive instance array.

Run with UnrealEditor-Cmd -run=pythonscript -script=<this file>, then cook.
Do not modify the engine/plugin master materials in place.
"""
import unreal

library = unreal.EditorAssetLibrary
editing = unreal.MaterialEditingLibrary
destination = "/Game/Materials/Archive"
library.make_directory(destination)
parents = {}


def local_parent(source):
    path = source.get_path_name()
    if path in parents:
        return parents[path]
    if path.startswith(destination + "/"):
        target = source
    else:
        target_path = destination + "/" + source.get_name()
        target = library.load_asset(target_path) if library.does_asset_exist(target_path) else library.duplicate_asset(path, target_path)
    assert target, path
    parents[path] = target
    if isinstance(target, unreal.Material):
        editing.set_material_usage(target, unreal.MaterialUsage.MATUSAGE_INSTANCED_STATIC_MESHES)
        editing.recompile_material(target)
    elif isinstance(target, unreal.MaterialInstanceConstant):
        parent = source.get_editor_property("parent")
        editing.set_material_instance_parent(target, local_parent(parent))
        editing.update_material_instance(target)
    library.save_loaded_asset(target, only_if_is_dirty=False)
    return target


count = 0
for path in library.list_assets("/Game/Models/ArchiveAssembly/archive-assembly/Materials", recursive=True):
    material = library.load_asset(path)
    if not isinstance(material, unreal.MaterialInstanceConstant):
        continue
    editing.set_material_instance_parent(material, local_parent(material.get_editor_property("parent")))
    editing.update_material_instance(material)
    library.save_loaded_asset(material, only_if_is_dirty=False)
    count += 1
assert count == 16, count
unreal.log("RHINE_ARCHIVE_MATERIALS_READY instances=%d parents=%d" % (count, len(parents)))


def constant_material(name, color, unlit=False, opacity=None):
    path = destination + "/" + name
    if library.does_asset_exist(path):
        return library.load_asset(path)
    material = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, destination, unreal.Material, unreal.MaterialFactoryNew())
    material.set_editor_property("two_sided", True)
    material.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT if unlit else unreal.MaterialShadingModel.MSM_DEFAULT_LIT)
    vector = editing.create_material_expression(material, unreal.MaterialExpressionVectorParameter, -300, 0)
    vector.set_editor_property("parameter_name", "Color")
    vector.set_editor_property("default_value", unreal.LinearColor(*color, 1.0))
    editing.connect_material_property(vector, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR if unlit else unreal.MaterialProperty.MP_BASE_COLOR)
    roughness = editing.create_material_expression(material, unreal.MaterialExpressionConstant, -300, 150)
    roughness.set_editor_property("r", 0.48 if opacity is None else 0.2)
    editing.connect_material_property(roughness, "", unreal.MaterialProperty.MP_ROUGHNESS)
    if opacity is not None:
        material.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
        alpha = editing.create_material_expression(material, unreal.MaterialExpressionScalarParameter, -300, 250)
        alpha.set_editor_property("parameter_name", "Opacity")
        alpha.set_editor_property("default_value", opacity)
        editing.connect_material_property(alpha, "", unreal.MaterialProperty.MP_OPACITY)
    editing.set_material_usage(material, unreal.MaterialUsage.MATUSAGE_INSTANCED_STATIC_MESHES)
    editing.recompile_material(material)
    library.save_loaded_asset(material, only_if_is_dirty=False)
    return material


constant_material("M_ArchiveBackground", (0.823, 0.784, 0.753), unlit=True)
constant_material("M_ArchivePolymer", (0.723, 0.687, 0.631))
constant_material("M_ArchiveGlass", (0.723, 0.687, 0.631), opacity=0.18)


def scanning_glass():
    # Rebuild our own graph in place so repeated runs update existing assets.
    material = library.load_asset(destination + "/M_ArchiveGlass")
    editing.delete_all_material_expressions(material)
    material.set_editor_property("translucency_lighting_mode", unreal.TranslucencyLightingMode.TLM_SURFACE)
    def parameter(kind, name, value, y):
        node = editing.create_material_expression(material, kind, -600, y)
        node.set_editor_property("parameter_name", name)
        node.set_editor_property("default_value", value)
        return node
    color = parameter(unreal.MaterialExpressionVectorParameter, "Color", unreal.LinearColor(.723, .687, .631, 1), 0)
    origin = parameter(unreal.MaterialExpressionVectorParameter, "ScanOrigin", unreal.LinearColor(0, 0, 0, 0), 150)
    up = parameter(unreal.MaterialExpressionVectorParameter, "ScanUp", unreal.LinearColor(0, 0, 1, 0), 300)
    reveal = parameter(unreal.MaterialExpressionScalarParameter, "Reveal", 0.0, 450)
    position = editing.create_material_expression(material, unreal.MaterialExpressionWorldPosition, -600, 600)
    scan = editing.create_material_expression(material, unreal.MaterialExpressionCustom, -300, 300)
    scan.set_editor_property("output_type", unreal.CustomMaterialOutputType.CMOT_FLOAT1)
    scan.set_editor_property("description", "Top-down clearing front in the rotating card's local height")
    scan.set_editor_property("code", "float height = dot(Position - Origin, Up) / 370.0; return smoothstep(0.0, 0.08, height + Reveal * 1.2 - 1.1);")
    inputs = []
    for name in ["Position", "Origin", "Up", "Reveal"]:
        item = unreal.CustomInput()
        item.set_editor_property("input_name", name)
        inputs.append(item)
    scan.set_editor_property("inputs", inputs)
    for source, name in [(position, "Position"), (origin, "Origin"), (up, "Up"), (reveal, "Reveal")]:
        editing.connect_material_expressions(source, "", scan, name)
    editing.connect_material_property(color, "", unreal.MaterialProperty.MP_BASE_COLOR)
    for y, start, end, prop in [(300, .98, .12, unreal.MaterialProperty.MP_OPACITY), (450, .48, .09, unreal.MaterialProperty.MP_ROUGHNESS)]:
        blend = editing.create_material_expression(material, unreal.MaterialExpressionLinearInterpolate, 0, y)
        blend.set_editor_property("const_a", start)
        blend.set_editor_property("const_b", end)
        editing.connect_material_expressions(scan, "", blend, "Alpha")
        editing.connect_material_property(blend, "", prop)
    editing.recompile_material(material)
    library.save_loaded_asset(material, only_if_is_dirty=False)
    unreal.log("RHINE_ARCHIVE_SCAN_GLASS_READY")


scanning_glass()
