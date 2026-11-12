# game/Entity.java

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).

## Classes

### game/Entity.java::Entity  (class, lines 4-17)
Declaration: package game; public abstract class Entity
Javadoc: Something on the board.
Methods: 5
Fields (2):
- L5 protected int x
- L6 protected int y

## Functions

game/Entity.java: 5 function(s) in 1 file(s).
Languages: java 5.

Functions (id, line, ←callers →callees):
- game/Entity.java::Entity.constructor  L8  ←1 →0
- game/Entity.java::Entity.move:10  L10  ←1 →1
- game/Entity.java::Entity.move:12  L12  ←1 →2
- game/Entity.java::Entity.clamp  L14  ←2 →2
- game/Entity.java::Entity.update  L16  ←0 →0

### game/Entity.java::Entity.constructor

Called by (1):
- game/Player.java::Player.constructor  L12  ←0 →2

Calls (0):
none

### game/Entity.java::Entity.move:10

Called by (1):
- game/Entity.java::Entity.move:12  L12  ←1 →2

Calls (1):
- game/Entity.java::Entity.clamp  L14  ←2 →2

### game/Entity.java::Entity.move:12

Called by (1):
- game/Player.java::Player.update  L18  ←0 →9

Calls (2):
- game/Entity.java::Entity.move:10  L10  ←1 →1
- game/Entity.java::Entity.clamp  L14  ←2 →2

### game/Entity.java::Entity.clamp

Called by (2):
- game/Entity.java::Entity.move:10  L10  ←1 →1
- game/Entity.java::Entity.move:12  L12  ←1 →2

Calls (2):
- library::java.lang.Math::max  (library java.lang.Math)  ←1 →0
- library::java.lang.Math::min  (library java.lang.Math)  ←1 →0

### game/Entity.java::Entity.update

Called by (0):
none

Calls (0):
none
