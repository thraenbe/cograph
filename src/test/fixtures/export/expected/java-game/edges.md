# Edges and call sites

CoGraph export: deterministic, no AI. Ids are CoGraph's MCP ids (see README.md).

## Per language

| Language | Files | Functions | Internal edges | Library edges | Functions without callers | Call sites | Not linked |
|---|---|---|---|---|---|---|---|
| java | 5 | 12 | 10 | 17 | 4 | 30 | 2 |

## Java call sites without an edge, by reason

- anonymous-class: 1
- unknown-type: 1

## Per file

| File | Functions | Edges out | Edges in | Library edges out | Without callers | Call sites | Not linked |
|---|---|---|---|---|---|---|---|
| game/Constants.java | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| game/Entity.java | 5 | 3 | 5 | 2 | 1 | 5 | 0 |
| game/Item.java | 2 | 1 | 1 | 0 | 1 | 1 | 0 |
| game/Player.java | 3 | 6 | 1 | 5 | 2 | 14 | 2 |
| game/io/Highscore.java | 2 | 0 | 3 | 10 | 0 | 10 | 0 |
