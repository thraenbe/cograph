# game/Entity.java::Entity.move:12

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).
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

## Callers within depth 2

1 function(s) within depth 2 call game/Entity.java::Entity.move:12:

depth 1:
- game/Player.java::Player.update  L18  ←0 →9

## Callees within depth 2 (with libraries)

4 function(s) within depth 2 are called by game/Entity.java::Entity.move:12:

depth 1:
- game/Entity.java::Entity.move:10  L10  ←1 →1
- game/Entity.java::Entity.clamp  L14  ←2 →2

depth 2:
- library::java.lang.Math::max  (library java.lang.Math)  ←1 →0  via game/Entity.java::Entity.clamp
- library::java.lang.Math::min  (library java.lang.Math)  ←1 →0  via game/Entity.java::Entity.clamp

## Impact

Changing game/Entity.java::Entity.move:12 (1 function(s)) can affect 1 caller(s) in 1 file(s), up to 1 call(s) away.

By file (nearest first: file, functions affected, nearest distance):
- game/Player.java  1 fn, 1 hop(s)

Entry points on these call chains (nothing calls them) (1):
- game/Player.java::Player.update  L18  ←0 →9

Nearest callers (1 of 1):
- game/Player.java::Player.update  L18  ←0 →9  1 hop(s)

## Call sites (2)

- L12  move(dx)  [-> game/Entity.java::Entity.move:10]
- L12  clamp(y + dy)  [-> game/Entity.java::Entity.clamp]
