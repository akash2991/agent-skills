"""GET /jobs/{id}. The response shape is `JobDetail` in contracts/kreate.openapi.yaml."""
from dataclasses import asdict, dataclass

from contentos.services.jobs.persistence import get_job_row


@dataclass(frozen=True)
class JobDetail:
    id: str
    post_id: str
    status: str


class JobNotFound(Exception):
    pass


def get_job(job_id: str) -> dict:
    row = get_job_row(job_id)
    if row is None:
        raise JobNotFound(job_id)
    return asdict(JobDetail(id=row.id, post_id=row.post_id, status=row.status))
