"""One SQLite connection per process. Every service uses it; every service owns only its tables."""
import sqlite3

_CONN: sqlite3.Connection | None = None


def connection() -> sqlite3.Connection:
    global _CONN
    if _CONN is None:
        _CONN = sqlite3.connect(":memory:")
        _CONN.row_factory = sqlite3.Row
        _CONN.executescript(
            """
            CREATE TABLE posts (id TEXT PRIMARY KEY, title TEXT NOT NULL, channel TEXT NOT NULL);
            CREATE TABLE jobs (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, status TEXT NOT NULL);
            INSERT INTO posts VALUES ('post-1', 'Ten ways to brew', 'coffee');
            INSERT INTO jobs VALUES ('job-1', 'post-1', 'queued');
            """
        )
    return _CONN
