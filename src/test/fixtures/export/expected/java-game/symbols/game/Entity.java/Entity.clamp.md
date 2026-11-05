# game/Entity.java::Entity.clamp

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).
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

## Callers within depth 2

3 function(s) within depth 2 call game/Entity.java::Entity.clamp:

depth 1:
- game/Entity.java::Entity.move:10  L10  ←1 →1
- game/Entity.java::Entity.move:12  L12  ←1 →2

depth 2:
- game/Player.java::Player.update  L18  ←0 →9  via game/Entity.java::Entity.move:12

## Callees within depth 2 (with libraries)

2 function(s) within depth 2 are called by game/Entity.java::Entity.clamp:

depth 1:
- library::java.lang.Math::max  (library java.lang.Math)  ←1 →0
- library::java.lang.Math::min  (library java.lang.Math)  ←1 →0

## Impact

Changing game/Entity.java::Entity.clamp (1 function(s)) can affect 3 caller(s) in 2 file(s), up to 2 call(s) away.

By file (nearest first: file, functions affected, nearest distance):
- game/Entity.java  2 fn, 1 hop(s)
- game/Player.java  1 fn, 2 hop(s)

Entry points on these call chains (nothing calls them) (1):
- game/Player.java::Player.update  L18  ←0 →9

Nearest callers (3 of 3):
- game/Entity.java::Entity.move:10  L10  ←1 →1  1 hop(s)
- game/Entity.java::Entity.move:12  L12  ←1 →2  1 hop(s)
- game/Player.java::Player.update  L18  ←0 →9  2 hop(s)

## Call sites (2)

- L14  Math.max(0, Math.min(v, Constants.WIDTH))  [-> library::java.lang.Math::max]
- L14  Math.min(v, Constants.WIDTH)  [-> library::java.lang.Math::min]
