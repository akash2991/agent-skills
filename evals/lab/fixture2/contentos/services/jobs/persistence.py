from dataclasses import dataclass

from contentos.db import connection


@dataclass(frozen=True)
class JobRow:
    id: str
    post_id: str
    status: str


def get_job_row(job_id: str) -> JobRow | None:
    row = connection().execute("SELECT id, post_id, status FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if row is None:
        return None
    return JobRow(id=row["id"], post_id=row["post_id"], status=row["status"])
