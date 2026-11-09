import json


class Store:
    def __init__(self, path):
        self.path = path

    def load(self):
        with open(self.path) as f:
            return json.load(f)

    def save(self, data):
        with open(self.path, "w") as f:
            json.dump(data, f)


def make_store(path):
    return Store(path)
