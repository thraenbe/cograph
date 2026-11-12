package game;

public enum Kind {
    HERO, VILLAIN;

    public String label() { return name().toLowerCase(); }
}
