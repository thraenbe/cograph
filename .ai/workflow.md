# Agent Workflow

All tasks follow this pipeline:

1. Planner Agent
   - Analyzes task
   - Breaks into steps
   - Identifies risks
   - Defines test strategy
   - WAIT for approval

2. Executor Agent
   - Implements only approved plan
   - Makes minimal changes
   - Does not expand scope
   - Runs tests
   - Reports results

3. Reviewer Agent
   - Reviews diff
   - Checks:
     - Code smell
     - Security risks
     - Performance issues
     - Missing tests
     - Over-engineering
   - Suggests improvements
