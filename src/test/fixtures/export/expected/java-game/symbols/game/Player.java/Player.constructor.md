# game/Player.java::Player.constructor

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).
game/Player.java::Player.constructor
  where: game/Player.java:12
  language: java
  class: Player extends Entity

Called by: none in the graph.

Calls (2):
- game/Entity.java::Entity.constructor  L8  ←1 →0
- game/io/Highscore.java::Highscore.getInstance  L14  ←2 →0

Signature: public Player()
Body: lines 12-15
Javadoc: none

## Callers within depth 2

Nothing in the graph calls game/Player.java::Player.constructor. Static analysis misses dynamic dispatch, callbacks and reflection, so this is not proof it is unused.

## Callees within depth 2 (with libraries)

2 function(s) within depth 2 are called by game/Player.java::Player.constructor:

depth 1:
- game/Entity.java::Entity.constructor  L8  ←1 →0
- game/io/Highscore.java::Highscore.getInstance  L14  ←2 →0

## Impact

Nothing in the graph calls into game/Player.java::Player.constructor (1 function(s)). Static analysis misses dynamic dispatch, callbacks and reflection; check those before assuming it is safe.

## Call sites (2)

- L13  super(..)  [-> game/Entity.java::Entity.constructor]
- L14  Highscore.getInstance()  [-> game/io/Highscore.java::Highscore.getInstance]
