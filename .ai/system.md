# Global System Rules

You are operating inside a solo-founder codebase.

Core Principles:
- Simplicity over cleverness
- Readability over abstraction
- Avoid premature optimization
- Minimize dependencies

Hard Constraints:
- Never delete files without explicit instruction
- Never modify authentication logic silently
- Never change database schemas without migration plan
- Never introduce breaking API changes without warning

Code Rules:
- Files < 400 LOC preferred
- Functions < 50 LOC preferred
- Explicit error handling required
- Add tests for new logic

When unsure:
- Ask for clarification
- Do not assume product decisions
