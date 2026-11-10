# Overview

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).
workspace: 12 function(s) in 4 file(s).
Languages: java 12.

Folders (functions, files, AI summary if annotated):
./  12 fn in 4 file(s)
  game/  12 fn in 4 file(s)
    io/  2 fn in 1 file(s)

Entry points (nothing calls them; tests excluded):
- game/Player.java::Player.update  L18  ←0 →9
- game/Player.java::Player.constructor  L12  ←0 →2

Hot spots (most callers):
- game/Entity.java::Entity.clamp  L14  ←2 →2
- game/io/Highscore.java::Highscore.getInstance  L14  ←2 →0
- game/Entity.java::Entity.constructor  L8  ←1 →0
- game/Entity.java::Entity.move:10  L10  ←1 →1
- game/Entity.java::Entity.move:12  L12  ←1 →2
- game/Item.java::Item.use  L8  ←1 →1
- game/Player.java::Player.addPoints  L33  ←1 →0
- game/io/Highscore.java::Highscore.save  L16  ←1 →10

Java classes (5):
- game/Constants.java::Constants
- game/Entity.java::Entity
- game/Item.java::Item
- game/Player.java::Player extends Entity
- game/io/Highscore.java::Highscore
