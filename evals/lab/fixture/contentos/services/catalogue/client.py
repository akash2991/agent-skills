"""The catalogue service's client. The only way another service reads catalogue data."""
from dataclasses import dataclass

from contentos.services.catalogue.persistence import get_post_row


@dataclass(frozen=True)
class Post:
    id: str
    title: str


class PostNotFound(Exception):
    pass


class PostsClient:
    def get_post(self, post_id: str) -> Post:
        row = get_post_row(post_id)
        if row is None:
            raise PostNotFound(post_id)
        return Post(id=row.id, title=row.title)
