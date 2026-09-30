import unreal
lib=unreal.EditorAssetLibrary
edit=unreal.MaterialEditingLibrary
for path in lib.list_assets('/Game/Models/ArchiveAssembly/archive-assembly/Materials'):
    mat=lib.load_asset(path)
    if not isinstance(mat,unreal.MaterialInstanceConstant): continue
    unreal.log('OPTICS_AUDIT '+mat.get_name()+' parent='+str(mat.get_editor_property('parent')))
    unreal.log('OPTICS_COLOR '+str(edit.get_material_instance_vector_parameter_value(mat,'BaseColorFactor')))
world=unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
for actor in unreal.GameplayStatics.get_all_actors_of_class(world,unreal.Actor):
    unreal.log('OPTICS_ACTOR '+actor.get_name()+' '+actor.get_class().get_name())
for path in lib.list_assets('/Game/Models/ArchiveAssembly/archive-assembly/StaticMeshes'):
    mesh=lib.load_asset(path)
    if isinstance(mesh,unreal.StaticMesh):
        unreal.log('OPTICS_MESH '+mesh.get_name()+' '+str(mesh.get_editor_property('nanite_settings')))
