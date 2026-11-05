# game/Player.java::Player.addPoints

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).
game/Player.java::Player.addPoints
  where: game/Player.java:33
  language: java
  class: Player extends Entity

Called by (1):
- game/Item.java::Item.use  L8  ←1 →1

Calls: none in the graph.

Signature: public void addPoints(int p)
Body: lines 33-33
Javadoc: none

## Callers within depth 2

2 function(s) within depth 2 call game/Player.java::Player.addPoints:

depth 1:
- game/Item.java::Item.use  L8  ←1 →1

depth 2:
- game/Player.java::Player.update  L18  ←0 →9  via game/Item.java::Item.use

## Callees within depth 2 (with libraries)

game/Player.java::Player.addPoints calls nothing that the analysis resolved.

## Impact

Changing game/Player.java::Player.addPoints (1 function(s)) can affect 2 caller(s) in 2 file(s), up to 2 call(s) away.

By file (nearest first: file, functions affected, nearest distance):
- game/Item.java  1 fn, 1 hop(s)
- game/Player.java  1 fn, 2 hop(s)

Entry points on these call chains (nothing calls them) (1):
- game/Player.java::Player.update  L18  ←0 →9

Nearest callers (2 of 2):
- game/Item.java::Item.use  L8  ←1 →1  1 hop(s)
- game/Player.java::Player.update  L18  ←0 →9  2 hop(s)

## Call sites (0)

none
