"""The shape every nightly job has."""


class BaseJob:
    """Opens a connection, runs, closes it."""

    def __init__(self, conn):
        self.conn = conn

    def run(self):
        raise NotImplementedError
