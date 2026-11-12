package game;

public class Item {
  private final int value;

  public Item(int value) { this.value = value; }

  public void use(Player p) { p.addPoints(value); }
}
