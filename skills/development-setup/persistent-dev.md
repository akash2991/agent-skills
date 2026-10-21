# Persistent development machines and migration

Use this workflow for a user-designated persistent personal dev machine or an approved Mac-to-VM migration. It is not the disposable shared fleet in [cloud.md](cloud.md). Record the machine's owner, purpose, access method, paths, storage and backup policy in `docs/DEVELOPMENT.md` before making changes. Do not infer approval to provision infrastructure, transfer credentials, or delete source data from a request to plan a migration.

## Persistent personal EC2

- Keep work and personal repositories, credentials and sessions separate. Inventory ownership before copying anything; ask about directories without a clear owner.
- Treat the instance as replaceable and its home volume as durable. Use an encrypted EBS home volume in the instance's availability zone, a fixed user UID/GID, and confirm `DeleteOnTermination=false`. Format only a positively identified empty volume with explicit approval; never format a recovery volume.
- Mount by UUID or label and enforce an automated fail-closed check on every boot and development-session start: the home path must be a mount of the expected durable volume, not the root filesystem or another disk. Login/editor services, background tools and agents must not write into that home until the check succeeds. Use a mandatory mount, service mount dependencies plus expected-volume verification, or an equivalent gate; a one-time/manual `findmnt` check is insufficient with `nofail`. If the volume is absent or wrong, refuse the development session, report the failure and recover/retry after the correct mount is restored; never create a replacement home on the root disk. Test this failure path during provisioning.
- Repos, worktrees, session data and home-installed tools persist on that volume. System packages and services need an idempotent bootstrap stored with the durable data. Keep the same relative repo layout where useful; create legacy absolute-path links only with approval and only if the destination does not already exist.
- Use private access, such as EC2 Instance Connect Endpoint, with no public IP and narrowly scoped security groups; require IMDSv2 and encrypted volumes. A private instance still needs an approved outbound route or endpoints for package installs and GitHub access; document that route and its cost before provisioning.
- Set instance-initiated shutdown behaviour to **stop**, not terminate. An idle-stop timer may use absence of SSH connections, not lingering editor-server processes, and must offer an explicit keep-awake marker for detached jobs. Verify cold-start access and idle stopping before relying on them. A start-on-connect helper must handle stopped, stopping, pending and running states, fail on AWS errors, and wait for SSH readiness with a timeout. SSH readiness alone is not a usable development session: the automated expected-home-volume gate must also succeed before allowing home writers.
- Budget storage and snapshots while stopped. Configure and verify backups (for example daily snapshots with seven retained), and test restoration. Stopping preserves disk, not running processes; sessions must be resumed. Push approved work to its intended remote before leaving; snapshots also protect uncommitted files and session data.
- Prefer narrowly scoped instance roles for AWS access, not copied long-lived AWS keys. User logins belong only on a user-approved machine with restrictive file permissions. Never copy credentials to the disposable shared fleet.

Continue to isolate each agent's worktree, containers, ports and database. Do not run `cloud-up.sh`, `cloud-down.sh` or `cloud-reap.sh` against this machine, tag it `brain=dev`, or apply the disposable fleet's termination schedule. Replacing an instance, deleting a volume, or removing backups requires explicit approval.

## Mac-to-VM migration

### 1. Inventory and approve

Inventory source and destination read-only: repository owners/remotes, all branches and exact commit IDs, local tags (including annotated tag objects), detached commits, live worktrees, stashes, staged/unstaged changes, unmerged index entries, active merge/rebase/cherry-pick/revert/bisect operations, untracked and ignored files, submodules, Git LFS usage and required payloads, session folders, tool versions, disk capacity and existing destination state. Include worktrees outside the repository's parent. Identify local metadata such as repository config, hooks, `.git/info/exclude`, sparse-checkout settings and index flags; disclose anything outside the supported transfer rather than claiming it is preserved. Classify personal versus work data and identify secrets before transfer.

If either checkout has an active Git operation or unmerged index entries, stop and ask unless a separately approved, tested method preserves that state. Do not automatically abort or finish the operation, reconstruct it from ordinary patches, or call the repository safe for source cleanup. Missing LFS payloads or unsupported metadata must be reported as incomplete/excluded and resolved with the user before proceeding with the affected transfer.

Agree on host, home/path mapping, included repositories, exclusions and credential handling. Ask before copying secrets, changing an existing destination checkout, or writing editor databases. Never push, delete source files, or install unrelated tools as a side effect.

### 2. Prepare the destination

Verify SSH, free disk, repository access and required tools, including their availability to non-interactive shells. Prefer fresh user authentication over transferring tokens. A matching relative layout under the VM home avoids unnecessary path rewrites; absolute compatibility links are optional, approved changes. Do not overwrite an existing directory or link.

### 3. Copy repository state without destroying destination state

Transfer commits using a verified Git bundle or another local-only mechanism; do not push migration branches to a remote without approval. Preserve every local branch, approved local tag (its exact ref and annotated object, not just its target commit), and detached worktree commit; stop rather than replace a differing destination tag. A bundle carries ordinary Git objects, not LFS payloads or active-operation state. Copy and verify approved LFS payloads needed by the migrated refs, or explicitly report them as incomplete/excluded and stop for a decision; a successful bundle import is not proof those files arrived. Bundle exclusions must be commits known to exist at the destination, not merely stale source remote-tracking refs. Verify the bundle before import.

Create missing branches and worktrees at their exact source commits. If a destination branch, worktree or stash stack already differs, stop for a reconciliation decision; do not reset a branch, clear stashes, or overwrite dirty files to make the copy match. Preserve stash messages and order, including untracked stash content, without replacing destination stashes.

Preserve index and worktree state separately (including staged-only changes, staged deletions, binary files and file modes); one `git diff HEAD` patch does not preserve staging. Copy untracked and approved ignored files, excluding platform-specific dependencies and caches, then rebuild those on the VM. Handle submodules explicitly. Use NUL-delimited Git paths and transfer lists so spaces, quotes and newlines cannot corrupt a copy; do not interpolate file paths into remote shell commands.

### 4. Copy session data and editor artifacts

Confirm the installed tool's current path encoding and storage layout rather than assuming it is stable across versions. Copy only the approved projects and memory folders. Preserve both versions when a destination session already differs; `--ignore-existing` and equal file sizes do not prove a complete copy. Compare content or checksums from a stable snapshot.

For Remote-SSH editors, distinguish the local UI's chat/window databases from remote extension and project artifacts. Copying a local UI database onto the VM does not migrate its chats. Database transformations require explicit approval, a backup, a tested dry run against a snapshot, and the editor fully closed for live writes. Do not promise chat continuation based only on opening a copied transcript. Missing companion scripts are not available capabilities: inspect and test any proposed tool before use.

### 5. Verify and hand over

Produce a per-item evidence report: exact refs/commits and tag objects, stash contents and order, index state, binary worktree diffs, untracked and approved ignored file checksums, submodule state, required LFS payload integrity, session content, unsupported operation/metadata state and excluded files. A missing payload or unsupported Git state is not a successful migration and must not authorize source cleanup. Status filenames alone cannot detect changed content. Re-run verification after any resumed work; report all conflicts and skips as incomplete, with nonzero exit status for automation.

Keep the Mac untouched. Only prepare a narrowly scoped deletion proposal for items whose copies are verified, with a fresh verification step and explicit user approval required before deletion. Exclude mixed personal/work editor databases and anything not copied. The user should test builds, authentication and session resumption on the VM before approving cleanup.

## Automation safety

Do not adopt an ad-hoc migration helper merely because a prior migration succeeded. Before using one, test first-copy, rerun, divergent destination, empty stash, detached HEAD, missing commits, staged/unstaged changes, unusual filenames, transfer failure and interrupted-copy cases in disposable repositories. Fail closed on transport or Git errors; use unique temporary directories, clean up temporary refs/files, and never present a partial transfer as safe for deletion.
