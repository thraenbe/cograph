# Feature Highscore

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).

## Entries (2)

- Highscore  (class, 2 fn)
- game/Player.java::Player.update  (method, 1 fn)

## Classes (2)

### game/Player.java::Player  (class, lines 7-34)
Declaration: package game; public class Player extends Entity
Methods: 3
Fields (3):
- L8 private final List<Item> items = new ArrayList<Item>()
- L9 private Highscore score
- L10 private int points

### game/io/Highscore.java::Highscore  (class, lines 10-31)
Declaration: package game.io; public class Highscore
Methods: 2
Fields (2):
- L11 private static Highscore instance = new Highscore()
- L12 private final String file = "highscore.txt"
String literals naming a URL, an asset or a file (1):
- L12 asset "highscore.txt"

## Functions (3)

### game/Player.java::Player.update

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

Call sites (12):
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

### game/io/Highscore.java::Highscore.getInstance

game/io/Highscore.java::Highscore.getInstance
  where: game/io/Highscore.java:14
  language: java
  class: Highscore

Called by (2):
- game/Player.java::Player.constructor  L12  ←0 →2
- game/Player.java::Player.update  L18  ←0 →9

Calls: none in the graph.

Signature: public static Highscore getInstance()
Body: lines 14-14
Javadoc: none

Call sites (0):
none

### game/io/Highscore.java::Highscore.save

game/io/Highscore.java::Highscore.save
  where: game/io/Highscore.java:16
  language: java
  class: Highscore

Called by (1):
- game/Player.java::Player.update  L18  ←0 →9

Calls (10):
- library::java.io.DataOutputStream::<init>  (library java.io.DataOutputStream)  ←1 →0
- library::java.io.DataOutputStream::close  (library java.io.DataOutputStream)  ←1 →0
- library::java.io.DataOutputStream::writeBytes  (library java.io.DataOutputStream)  ←1 →0
- library::java.io.FileWriter::<init>  (library java.io.FileWriter)  ←1 →0
- library::java.io.FileWriter::close  (library java.io.FileWriter)  ←1 →0
- library::java.io.FileWriter::write  (library java.io.FileWriter)  ←1 →0
- library::java.lang.String::valueOf  (library java.lang.String)  ←1 →0
- library::java.net.URL::<init>  (library java.net.URL)  ←1 →0
- library::java.net.URL::openConnection  (library java.net.URL)  ←1 →0
- library::java.net.URLConnection::getOutputStream  (library java.net.URLConnection)  ←1 →0

Signature: public boolean save(int points)
Body: lines 16-30
Javadoc: none
Static fields read (1):
- Constants.SAVE_URL  (String = "http://example.org/save.php")

Call sites (10):
- L18  new URL(Constants.SAVE_URL)  [-> library::java.net.URL::<init>]
- L19  url.openConnection()  [-> library::java.net.URL::openConnection]
- L20  new DataOutputStream(conn.getOutputStream())  [-> library::java.io.DataOutputStream::<init>]
- L20  conn.getOutputStream()  [-> library::java.net.URLConnection::getOutputStream]
- L21  out.writeBytes("points=" + points)  [-> library::java.io.DataOutputStream::writeBytes]
- L22  out.close()  [-> library::java.io.DataOutputStream::close]
- L23  new FileWriter(file)  [-> library::java.io.FileWriter::<init>]
- L24  w.write(String.valueOf(points))  [-> library::java.io.FileWriter::write]
- L24  String.valueOf(points)  [-> library::java.lang.String::valueOf]
- L25  w.close()  [-> library::java.io.FileWriter::close]

## Callers within depth 2, outside the entries (1)

- game/Player.java::Player.constructor  L12  ←0 →2  1 hop(s) from game/io/Highscore.java::Highscore.getInstance

## Callees within depth 2, outside the entries (with libraries) (20)

- library::java.io.DataOutputStream::<init>  (library java.io.DataOutputStream)  ←1 →0  1 hop(s) from game/io/Highscore.java::Highscore.save
- library::java.io.DataOutputStream::close  (library java.io.DataOutputStream)  ←1 →0  1 hop(s) from game/io/Highscore.java::Highscore.save
- library::java.io.DataOutputStream::writeBytes  (library java.io.DataOutputStream)  ←1 →0  1 hop(s) from game/io/Highscore.java::Highscore.save
- library::java.io.FileWriter::<init>  (library java.io.FileWriter)  ←1 →0  1 hop(s) from game/io/Highscore.java::Highscore.save
- library::java.io.FileWriter::close  (library java.io.FileWriter)  ←1 →0  1 hop(s) from game/io/Highscore.java::Highscore.save
- library::java.io.FileWriter::write  (library java.io.FileWriter)  ←1 →0  1 hop(s) from game/io/Highscore.java::Highscore.save
- library::java.lang.Runnable::run  (library java.lang.Runnable)  ←1 →0  1 hop(s) from game/Player.java::Player.update
- library::java.lang.String::valueOf  (library java.lang.String)  ←1 →0  1 hop(s) from game/io/Highscore.java::Highscore.save
- library::java.lang.Thread::start  (library java.lang.Thread)  ←1 →0  1 hop(s) from game/Player.java::Player.update
- library::java.net.URL::<init>  (library java.net.URL)  ←1 →0  1 hop(s) from game/io/Highscore.java::Highscore.save
- library::java.net.URL::openConnection  (library java.net.URL)  ←1 →0  1 hop(s) from game/io/Highscore.java::Highscore.save
- library::java.net.URLConnection::getOutputStream  (library java.net.URLConnection)  ←1 →0  1 hop(s) from game/io/Highscore.java::Highscore.save
- library::java.util.List::forEach  (library java.util.List)  ←1 →0  1 hop(s) from game/Player.java::Player.update
- library::java.util.List::get  (library java.util.List)  ←1 →0  1 hop(s) from game/Player.java::Player.update
- library::java.util.List::size  (library java.util.List)  ←1 →0  1 hop(s) from game/Player.java::Player.update
- game/Entity.java::Entity.move:12  L12  ←1 →2  1 hop(s) from game/Player.java::Player.update
- game/Item.java::Item.use  L8  ←1 →1  1 hop(s) from game/Player.java::Player.update
- game/Entity.java::Entity.move:10  L10  ←1 →1  2 hop(s) from game/Player.java::Player.update
- game/Entity.java::Entity.clamp  L14  ←2 →2  2 hop(s) from game/Player.java::Player.update
- game/Player.java::Player.addPoints  L33  ←1 →0  2 hop(s) from game/Player.java::Player.update

## Impact

Changing feature Highscore (3 function(s)) can affect 1 caller(s) in 1 file(s), up to 1 call(s) away.

By file (nearest first: file, functions affected, nearest distance):
- game/Player.java  1 fn, 1 hop(s)

Entry points on these call chains (nothing calls them) (2):
- game/Player.java::Player.constructor  L12  ←0 →2
- game/Player.java::Player.update  L18  ←0 →9

Nearest callers (1 of 1):
- game/Player.java::Player.constructor  L12  ←0 →2  1 hop(s)
