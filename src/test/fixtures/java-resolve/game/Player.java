package game;

import game.util.*;
import static game.util.Tools.clamp;
import java.net.URLEncoder;
import java.util.ArrayList;

public class Player extends Entity {
    private ArrayList<Item> items = new ArrayList<Item>();
    private Item[] slots = new Item[4];
    private Kind kind = Kind.HERO;

    public Player() { super(new Vec(1, 2)); }

    public float area() { return 1f; }

    public void draw(java.awt.Graphics g) { g.drawString(Tools.name(kind), 0, 0); }

    @Override
    public void update() {
        super.update();
        move(getPos());
        this.pos.len();
        Vec v = getPos().add(new Vec());
        v.len();
        items.get(0).use(this);
        slots[1].use(this);
        for (Item it : items) it.use(this, 2);
        Object o = slots[0];
        ((Item) o).use(this);
        int h = clamp(5, 0, 3);
        float f = Tools.clamp(1.5f, 0f, 1f);
        String s = Tools.name("x");
        kind.label();
        new Inner().ping();
        s = URLEncoder.encode(s);
        s.length();
    }

    void hit(Item it) { it.use(this); }

    void schedule() {
        Runnable r = new Runnable() {
            public void run() { area(); }
        };
        r.run();
    }

    class Inner {
        void ping() { hit(slots[2]); schedule(); }
    }
}
