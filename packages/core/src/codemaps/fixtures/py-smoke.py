from enum import Enum


class Status(Enum):
    READY = "ready"
    DONE = "done"


class Worker:
    queue_name = "default"

    def run(self, status: Status) -> str:
        return status.value


def build_worker() -> Worker:
    return Worker()
