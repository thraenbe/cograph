# game/Entity.java::Entity.move:10

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).
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

## Callers within depth 2

2 function(s) within depth 2 call game/Entity.java::Entity.move:10:

depth 1:
- game/Entity.java::Entity.move:12  L12  ←1 →2

depth 2:
- game/Player.java::Player.update  L18  ←0 →9  via game/Entity.java::Entity.move:12

## Callees within depth 2 (with libraries)

3 function(s) within depth 2 are called by game/Entity.java::Entity.move:10:

depth 1:
- game/Entity.java::Entity.clamp  L14  ←2 →2

depth 2:
- library::java.lang.Math::max  (library java.lang.Math)  ←1 →0  via game/Entity.java::Entity.clamp
- library::java.lang.Math::min  (library java.lang.Math)  ←1 →0  via game/Entity.java::Entity.clamp

## Impact

Changing game/Entity.java::Entity.move:10 (1 function(s)) can affect 2 caller(s) in 2 file(s), up to 2 call(s) away.

By file (nearest first: file, functions affected, nearest distance):
- game/Entity.java  1 fn, 1 hop(s)
- game/Player.java  1 fn, 2 hop(s)

Entry points on these call chains (nothing calls them) (1):
- game/Player.java::Player.update  L18  ←0 →9

Nearest callers (2 of 2):
- game/Entity.java::Entity.move:12  L12  ←1 →2  1 hop(s)
- game/Player.java::Player.update  L18  ←0 →9  2 hop(s)

## Call sites (1)

- L10  clamp(x + dx)  [-> game/Entity.java::Entity.clamp]
