"""The catalogue service's client. The only way another service reads catalogue data."""
from contentos.services.catalogue.persistence import get_post_row


class PostNotFound(Exception):
    pass


class PostsClient:
    def post_exists(self, post_id: str) -> bool:
        return get_post_row(post_id) is not None
