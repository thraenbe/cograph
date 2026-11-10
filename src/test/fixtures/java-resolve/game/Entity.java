package game;

import game.util.Vec;

public abstract class Entity implements Shape {
    protected Vec pos;

    public Entity(Vec pos) { this.pos = pos; }

    public Vec getPos() { return pos; }

    public void move(Vec d) { pos = pos.add(d); }

    public void update() { move(Vec.zero()); }
}
