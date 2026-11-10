package game;

import game.io.Highscore;
import java.util.ArrayList;
import java.util.List;

public class Player extends Entity {
  private final List<Item> items = new ArrayList<Item>();
  private Highscore score;
  private int points;

  public Player() {
    super(0, 0);
    score = Highscore.getInstance();
  }

  @Override
  public void update() {
    move(1, 1);
    for (int i = 0; i < items.size(); i++) {
      items.get(i).use(this);
    }
    if (Constants.ONLINE) {
      score.save(points);
    }
    Highscore.getInstance().save(points);
    Runnable r = () -> points++;
    r.run();
    items.forEach(it -> it.use(this));
    new Thread(r) { }.start();
  }

  public void addPoints(int p) { points += p; }
}
