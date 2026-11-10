# Feature Board

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).

## Entries (2)

- Item.use  (method, 1 fn)
- game/Entity.java  (file, 5 fn)

## Classes (2)

### game/Entity.java::Entity  (class, lines 4-17)
Declaration: package game; public abstract class Entity
Javadoc: Something on the board.
Methods: 5
Fields (2):
- L5 protected int x
- L6 protected int y

### game/Item.java::Item  (class, lines 3-9)
Declaration: package game; public class Item
Methods: 2
Fields (1):
- L4 private final int value

## Functions (6)

### game/Entity.java::Entity.constructor

game/Entity.java::Entity.constructor
  where: game/Entity.java:8
  language: java
  class: Entity

Called by (1):
- game/Player.java::Player.constructor  L12  ←0 →2

Calls: none in the graph.

Signature: public Entity(int x, int y)
Body: lines 8-8
Javadoc: none

Call sites (0):
none

### game/Entity.java::Entity.move:10

game/Entity.java::Entity.move:10
  where: game/Entity.java:10
  language: java
  class: Entity

Called by (1):
- game/Entity.java::Entity.move:12  L12  ←1 →2

Calls (1):
- game/Entity.java::Entity.clamp  L14  ←2 →2

Signature: public void move(int dx)
Body: lines 10-10
Javadoc: none

Call sites (1):
- L10  clamp(x + dx)  [-> game/Entity.java::Entity.clamp]

### game/Entity.java::Entity.move:12

game/Entity.java::Entity.move:12
  where: game/Entity.java:12
  language: java
  class: Entity

Called by (1):
- game/Player.java::Player.update  L18  ←0 →9

Calls (2):
- game/Entity.java::Entity.move:10  L10  ←1 →1
- game/Entity.java::Entity.clamp  L14  ←2 →2

Signature: public void move(int dx, int dy)
Body: lines 12-12
Javadoc: none

Call sites (2):
- L12  move(dx)  [-> game/Entity.java::Entity.move:10]
- L12  clamp(y + dy)  [-> game/Entity.java::Entity.clamp]

### game/Entity.java::Entity.clamp

game/Entity.java::Entity.clamp
  where: game/Entity.java:14
  language: java
  class: Entity

Called by (2):
- game/Entity.java::Entity.move:10  L10  ←1 →1
- game/Entity.java::Entity.move:12  L12  ←1 →2

Calls (2):
- library::java.lang.Math::max  (library java.lang.Math)  ←1 →0
- library::java.lang.Math::min  (library java.lang.Math)  ←1 →0

Signature: int clamp(int v)
Body: lines 14-14
Javadoc: none
Static fields read (1):
- Constants.WIDTH  (int = 640)

Call sites (2):
- L14  Math.max(0, Math.min(v, Constants.WIDTH))  [-> library::java.lang.Math::max]
- L14  Math.min(v, Constants.WIDTH)  [-> library::java.lang.Math::min]

### game/Entity.java::Entity.update

game/Entity.java::Entity.update
  where: game/Entity.java:16
  language: java
  class: Entity

Called by: none in the graph.

Calls: none in the graph.

Signature: public abstract void update()  [abstract]
Body: lines 16-16
Javadoc: none

Call sites (0):
none

### game/Item.java::Item.use

game/Item.java::Item.use
  where: game/Item.java:8
  language: java
  class: Item

Called by (1):
- game/Player.java::Player.update  L18  ←0 →9

Calls (1):
- game/Player.java::Player.addPoints  L33  ←1 →0

Signature: public void use(Player p)
Body: lines 8-8
Javadoc: none

Call sites (1):
- L8  p.addPoints(value)  [-> game/Player.java::Player.addPoints]

## Callers within depth 2, outside the entries (2)

- game/Player.java::Player.constructor  L12  ←0 →2  1 hop(s) from game/Entity.java::Entity.constructor
- game/Player.java::Player.update  L18  ←0 →9  1 hop(s) from game/Entity.java::Entity.move:12

## Callees within depth 2, outside the entries (with libraries) (3)

- library::java.lang.Math::max  (library java.lang.Math)  ←1 →0  1 hop(s) from game/Entity.java::Entity.clamp
- library::java.lang.Math::min  (library java.lang.Math)  ←1 →0  1 hop(s) from game/Entity.java::Entity.clamp
- game/Player.java::Player.addPoints  L33  ←1 →0  1 hop(s) from game/Item.java::Item.use

## Impact

Changing feature Board (6 function(s)) can affect 2 caller(s) in 1 file(s), up to 1 call(s) away.

By file (nearest first: file, functions affected, nearest distance):
- game/Player.java  2 fn, 1 hop(s)

Entry points on these call chains (nothing calls them) (3):
- game/Entity.java::Entity.update  L16  ←0 →0
- game/Player.java::Player.constructor  L12  ←0 →2
- game/Player.java::Player.update  L18  ←0 →9

Nearest callers (2 of 2):
- game/Player.java::Player.constructor  L12  ←0 →2  1 hop(s)
- game/Player.java::Player.update  L18  ←0 →9  1 hop(s)
