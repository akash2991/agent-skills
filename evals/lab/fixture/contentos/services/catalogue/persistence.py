from dataclasses import dataclass

from contentos.db import connection


@dataclass(frozen=True)
class PostRow:
    id: str
    title: str
    channel: str


def get_post_row(post_id: str) -> PostRow | None:
    row = connection().execute("SELECT id, title, channel FROM posts WHERE id = ?", (post_id,)).fetchone()
    if row is None:
        return None
    return PostRow(id=row["id"], title=row["title"], channel=row["channel"])
