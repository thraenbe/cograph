# game/Player.java::Player.update

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).
game/Player.java::Player.update
  where: game/Player.java:18
  language: java
  class: Player extends Entity

Called by: none in the graph.

Calls (9):
- library::java.lang.Runnable::run  (library java.lang.Runnable)  ←1 →0
- library::java.lang.Thread::start  (library java.lang.Thread)  ←1 →0
- library::java.util.List::forEach  (library java.util.List)  ←1 →0
- library::java.util.List::get  (library java.util.List)  ←1 →0
- library::java.util.List::size  (library java.util.List)  ←1 →0
- game/Entity.java::Entity.move:12  L12  ←1 →2
- game/Item.java::Item.use  L8  ←1 →1
- game/io/Highscore.java::Highscore.getInstance  L14  ←2 →0
- game/io/Highscore.java::Highscore.save  L16  ←1 →10

Signature: @Override public void update()
Body: lines 18-31
Javadoc: none
Static fields read (1):
- Constants.ONLINE  (boolean = true)

## Callers within depth 2

Nothing in the graph calls game/Player.java::Player.update. Static analysis misses dynamic dispatch, callbacks and reflection, so this is not proof it is unused.

## Callees within depth 2 (with libraries)

22 function(s) within depth 2 are called by game/Player.java::Player.update:

depth 1:
- library::java.lang.Runnable::run  (library java.lang.Runnable)  ←1 →0
- library::java.lang.Thread::start  (library java.lang.Thread)  ←1 →0
- library::java.util.List::forEach  (library java.util.List)  ←1 →0
- library::java.util.List::get  (library java.util.List)  ←1 →0
- library::java.util.List::size  (library java.util.List)  ←1 →0
- game/Entity.java::Entity.move:12  L12  ←1 →2
- game/Item.java::Item.use  L8  ←1 →1
- game/io/Highscore.java::Highscore.getInstance  L14  ←2 →0
- game/io/Highscore.java::Highscore.save  L16  ←1 →10

depth 2:
- library::java.io.DataOutputStream::<init>  (library java.io.DataOutputStream)  ←1 →0  via game/io/Highscore.java::Highscore.save
- library::java.io.DataOutputStream::close  (library java.io.DataOutputStream)  ←1 →0  via game/io/Highscore.java::Highscore.save
- library::java.io.DataOutputStream::writeBytes  (library java.io.DataOutputStream)  ←1 →0  via game/io/Highscore.java::Highscore.save
- library::java.io.FileWriter::<init>  (library java.io.FileWriter)  ←1 →0  via game/io/Highscore.java::Highscore.save
- library::java.io.FileWriter::close  (library java.io.FileWriter)  ←1 →0  via game/io/Highscore.java::Highscore.save
- library::java.io.FileWriter::write  (library java.io.FileWriter)  ←1 →0  via game/io/Highscore.java::Highscore.save
- library::java.lang.String::valueOf  (library java.lang.String)  ←1 →0  via game/io/Highscore.java::Highscore.save
- library::java.net.URL::<init>  (library java.net.URL)  ←1 →0  via game/io/Highscore.java::Highscore.save
- library::java.net.URL::openConnection  (library java.net.URL)  ←1 →0  via game/io/Highscore.java::Highscore.save
- library::java.net.URLConnection::getOutputStream  (library java.net.URLConnection)  ←1 →0  via game/io/Highscore.java::Highscore.save
- game/Entity.java::Entity.move:10  L10  ←1 →1  via game/Entity.java::Entity.move:12
- game/Entity.java::Entity.clamp  L14  ←2 →2  via game/Entity.java::Entity.move:12
- game/Player.java::Player.addPoints  L33  ←1 →0  via game/Item.java::Item.use
The walk stopped at depth 2; more lie beyond (max depth 5).

## Impact

Nothing in the graph calls into game/Player.java::Player.update (1 function(s)). Static analysis misses dynamic dispatch, callbacks and reflection; check those before assuming it is safe.

## Call sites (12)

- L19  move(1, 1)  [-> game/Entity.java::Entity.move:12]
- L20  items.size()  [-> library::java.util.List::size]
- L21  items.get(i)  [-> library::java.util.List::get]
- L21  items.get(i).use(this)  [-> game/Item.java::Item.use]
- L24  score.save(points)  [-> game/io/Highscore.java::Highscore.save]
- L26  Highscore.getInstance()  [-> game/io/Highscore.java::Highscore.getInstance]
- L26  Highscore.getInstance().save(points)  [-> game/io/Highscore.java::Highscore.save]
- L28  r.run()  [-> library::java.lang.Runnable::run]
- L29  items.forEach(it -> it.use(this))  [-> library::java.util.List::forEach]
- L29  it.use(this)  [not linked: unknown-type]
- L30  new Thread(r)  [not linked: anonymous-class]
- L30  new Thread(r) { }.start()  [-> library::java.lang.Thread::start]
