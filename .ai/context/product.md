# Product Context

## Target User
Python developers working in VS Code on medium-to-large codebases who want to understand function-level call structure without reading every file manually.

## Core Value Proposition
Instant, interactive call graph visualization of any Python project — click a node, jump to the function. No configuration required.

## Non-Goals
- Runtime/dynamic call tracing (static analysis only)
- Support for languages other than Python
- Visualization of third-party library internals
- Cloud sync or team collaboration features
- Full IDE beyond VS Code

## UX Principles
- Fast: graph appears within seconds for typical projects
- Minimal: one command to launch, no setup wizard
- No enterprise complexity: no accounts, no config files required to get started

## Benchmark Projects
Used to validate correctness and performance at scale:
NumPy, Requests, Pandas, Matplotlib, Scikit-learn, TensorFlow, PyTorch, Django, Flask, Pillow, SciPy, SQLAlchemy, Pytest, Celery, FastAPI, Boto3, Pydantic, BeautifulSoup, Scrapy, OpenCV, Keras, Selenium, Cryptography, NLTK, Airflow
