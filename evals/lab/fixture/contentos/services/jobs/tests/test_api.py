import pytest

from contentos.services.jobs.api import JobNotFound, get_job


def test_get_job_returns_the_contract_shape():
    assert get_job("job-1") == {"id": "job-1", "post_id": "post-1", "status": "queued"}


def test_get_job_unknown_raises():
    with pytest.raises(JobNotFound):
        get_job("job-404")
