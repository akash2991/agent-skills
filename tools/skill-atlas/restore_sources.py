#!/usr/bin/env python3
"""Restore the atlas's pinned read-only source snapshots, not the live repository.
Existing directories are never overwritten. Uses git and public HTTPS remotes.
"""
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent


def git(path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args], text=True).strip()


def main():
    repos = json.loads((ROOT / 'data.json').read_text())['repos']
    for repo in repos:
        target = ROOT / 'sources' / repo['id']
        sha = repo['sha']
        remote = repo['url'].split('/tree/', 1)[0] + '.git'
        if target.exists():
            if Path(git(target, 'rev-parse', '--show-toplevel')).resolve() != target.resolve():
                raise RuntimeError(f'Not a separate snapshot checkout: {target}')
            if git(target, 'rev-parse', 'HEAD') != sha:
                raise RuntimeError(f'Snapshot differs; refusing to overwrite {target}')
            print(f'Already present: {repo["id"]} @ {sha[:8]}')
            continue
        target.mkdir(parents=True)
        git(target, 'init')
        git(target, 'remote', 'add', 'origin', remote)
        git(target, 'fetch', '--depth=1', 'origin', sha)
        if repo['id'] == 'cursor':
            git(target, 'sparse-checkout', 'init', '--cone')
            git(target, 'sparse-checkout', 'set', 'pstack')
        git(target, 'checkout', '--detach', 'FETCH_HEAD')
        print(f'Restored {repo["id"]} @ {sha[:8]}')


if __name__ == '__main__':
    main()
