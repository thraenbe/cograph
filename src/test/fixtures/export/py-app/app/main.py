from app.store import make_store


def run(path):
    store = make_store(path)
    data = store.load()
    data["runs"] = data.get("runs", 0) + 1
    store.save(data)
    return report(data)


def report(data):
    return f"runs: {data['runs']}"
