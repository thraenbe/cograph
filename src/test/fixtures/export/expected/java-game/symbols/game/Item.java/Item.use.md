# game/Item.java::Item.use

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).
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

## Callers within depth 2

1 function(s) within depth 2 call game/Item.java::Item.use:

depth 1:
- game/Player.java::Player.update  L18  ←0 →9

## Callees within depth 2 (with libraries)

1 function(s) within depth 2 are called by game/Item.java::Item.use:

depth 1:
- game/Player.java::Player.addPoints  L33  ←1 →0

## Impact

Changing game/Item.java::Item.use (1 function(s)) can affect 1 caller(s) in 1 file(s), up to 1 call(s) away.

By file (nearest first: file, functions affected, nearest distance):
- game/Player.java  1 fn, 1 hop(s)

Entry points on these call chains (nothing calls them) (1):
- game/Player.java::Player.update  L18  ←0 →9

Nearest callers (1 of 1):
- game/Player.java::Player.update  L18  ←0 →9  1 hop(s)

## Call sites (1)

- L8  p.addPoints(value)  [-> game/Player.java::Player.addPoints]
