"use strict";
// Hermetic: no real curl, apt, sudo, npm, installers, or real HOME. Host probes
// are overridden only after sourcing the guarded script, never via production hooks.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const script = path.resolve(__dirname, "../skills/development-setup/scripts/bootstrap-vm.sh");
const bash = "/bin/bash";
const baseTools = ["git", "gh", "rg", "jq", "rsync", "curl", "python3"];
const nativeTools = ["herdr", "uv", "bun", "claude"];
const executable = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, { mode: 0o755 }); };
const dispatcher = `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const cmd=path.basename(process.argv[1]),args=process.argv.slice(2),e=process.env;
const event={cmd,args,home:e.HOME,shell:e.SHELL,herdr:e.HERDR_INSTALL_DIR,uv:e.UV_INSTALL_DIR,noModify:e.UV_NO_MODIFY_PATH,bun:e.BUN_INSTALL};
fs.appendFileSync(e.TEST_LOG,JSON.stringify(event)+'\\n');
const die=n=>process.exit(n),write=(p,s)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,s,{mode:0o755});};
const create=(dir,name)=>write(path.join(dir,name),fs.readFileSync(e.TEST_DISPATCH));
if(cmd==='id'){console.log(e.TEST_UID||'1000');die(0);}
if(cmd==='uname'){console.log(args[0]==='-m'?(e.TEST_ARCH||'x86_64'):(e.TEST_OS||'Linux'));die(0);}
if(cmd==='sudo'){if(e.FAIL_SUDO)die(1);if(args.includes('apt-get')&&!args.includes('--version')&&e.FAIL_APT)die(42);if(args.includes('install')&&args.includes('docker.io'))create(e.HOME+'/.local/bin','docker');console.log('stub sudo');die(0);}
if(cmd==='flock')die(e.FAIL_LOCK?1:0);
if(cmd==='timeout'){
 if(e.FAIL_TIMEOUT)die(124);
 const r=cp.spawnSync(args[2],args.slice(3),{stdio:'inherit',env:e});die(r.status??1);
}
if(cmd==='curl'){
 if(args[0]==='--version'){console.log('curl stub');die(0);}
 if(!args.includes('--max-time')||!args.includes('--connect-timeout'))throw Error('unbounded curl');
 const url=args.find(x=>x.startsWith('https://'));
 if(!url)throw Error('no URL');
 if(e.FAIL_DOWNLOAD&&url.includes(e.FAIL_DOWNLOAD))die(22);
 const oi=args.findIndex(x=>x==='--output'||x==='-o'),out=args[oi+1];
 if(oi<0||!out.startsWith(e.HOME+'/'))throw Error('unsafe download destination');
 const mapping=JSON.parse(fs.readFileSync(e.TEST_MAPPING));
 if(!mapping[url])throw Error('unexpected URL '+url);
 let data=fs.readFileSync(mapping[url]);
 if(e.BAD_CHECKSUM&&url.includes(e.BAD_CHECKSUM))data=Buffer.from(data.toString().replace(/^[a-f0-9]{64}/,'0'.repeat(64)));
 fs.writeFileSync(out,data);die(0);
}
if(cmd==='stub-install'){
 const name=args[0];
 if(e.FAIL_INSTALL===name)die(31);
 const expected={herdr:[],uv:[],bun:['bun-v1.3.14'],claude:['2.1.306']};
 if(JSON.stringify(args.slice(1))!==JSON.stringify(expected[name]))throw Error('bad installer args');
 if(name==='herdr'&&e.HERDR_INSTALL_DIR!==e.HOME+'/.local/bin')throw Error('herdr dir');
 if(name==='uv'&&(e.UV_INSTALL_DIR!==e.HOME+'/.local/bin'||e.UV_NO_MODIFY_PATH!=='1'))throw Error('uv env');
 if(name==='bun'&&(e.BUN_INSTALL!==e.HOME+'/.local'||e.SHELL!=='/bin/false'))throw Error('bun env');
 create(e.HOME+'/.local/bin',name);console.log('installer stdout noise');die(0);
}
if(cmd==='node'){
 const v=fs.readFileSync(path.join(path.dirname(process.argv[1]),'.node-version'),'utf8');
 console.log(v.trim());die(0);
}
if(cmd==='npm'){
 if(args[0]==='--version'){console.log('10.9.3');die(0);}
 if(args[0]!=='install'||!args.includes('--ignore-scripts')||!args.includes('--global'))throw Error('unsafe npm');
 const prefix=args[args.indexOf('--prefix')+1];
 if(prefix!==e.HOME+'/.local/share/npm')throw Error('bad npm prefix');
 if(e.FAIL_NPM)die(43);
 const pkg=args.at(-1),name=pkg==='pnpm@9.15.9'?'pnpm':pkg==='@earendil-works/pi-coding-agent@1.3.0'?'pi':null;
 if(!name)throw Error('unexpected npm package');
 create(prefix+'/bin',name);die(0);
}
if(e.FAIL_VERIFY===cmd)die(1);
console.log(cmd+' stub version');
`;
function fixture(t, { existing = false, nodeVersion, arch = "x86_64" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vm-bootstrap-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home with spaces");
  const bin = path.join(root, "bin");
  fs.mkdirSync(home); fs.mkdirSync(bin);
  const dispatch = path.join(root, "dispatch");
  executable(dispatch, dispatcher);
  // Only harmless filesystem/hash/archive tools pass through to the host.
  for (const cmd of ["mkdir", "rm", "chmod", "mv", "awk", "cmp", "grep", "install", "mktemp", "tar", "unzip", "sha256sum"]) {
    const found = spawnSync(bash, ["-c", 'command -v "$1"', "test", cmd], { encoding: "utf8" }).stdout.trim();
    assert.ok(found.startsWith("/"), `test dependency missing: ${cmd}`);
    fs.symlinkSync(found, path.join(bin, cmd));
  }
  fs.symlinkSync(bash, path.join(bin, "bash"));
  const seed = (dir, cmd) => executable(path.join(dir, cmd), dispatcher);
  for (const cmd of [...baseTools, "id", "uname", "sudo", "flock", "timeout", "stub-install"]) seed(bin, cmd);
  if (existing) for (const cmd of [...nativeTools, "pnpm", "pi", "terraform", "docker"]) seed(bin, cmd);
  if (nodeVersion || existing) {
    seed(bin, "node"); seed(bin, "npm");
    fs.writeFileSync(path.join(bin, ".node-version"), nodeVersion || "v24.2.0");
  }
  const probe = path.join(root, "probe"); fs.writeFileSync(probe, "local fixture, never a network request\n");
  const mapping = { "https://fixture.invalid/probe": probe };
  for (const name of nativeTools) {
    const installer = path.join(root, `${name}-installer`);
    executable(installer, `#!/bin/bash\nset -e\nprintf 'upstream noise\\n'\ncurl --fail https://fixture.invalid/probe --output "$HOME/.cache/fixture-installer-probe"\nrm "$HOME/.cache/fixture-installer-probe"\nstub-install ${name} "$@"\n`);
    mapping[{ herdr: "https://herdr.dev/install.sh", uv: "https://astral.sh/uv/0.12.5/install.sh", bun: "https://bun.sh/install", claude: "https://claude.ai/install.sh" }[name]] = installer;
  }
  const nodeArch = arch === "aarch64" ? "arm64" : "x64";
  const nodeName = `node-v22.23.2-linux-${nodeArch}`;
  const stage = path.join(root, "stage");
  fs.mkdirSync(path.join(stage, nodeName, "bin"), { recursive: true });
  seed(path.join(stage, nodeName, "bin"), "node"); seed(path.join(stage, nodeName, "bin"), "npm");
  fs.writeFileSync(path.join(stage, nodeName, "bin/.node-version"), "v22.23.2");
  const archive = path.join(root, `${nodeName}.tar.xz`);
  const packed = spawnSync("/usr/bin/tar", ["-cJf", archive, "-C", stage, nodeName], { encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const nodeSums = path.join(root, "node-sums");
  const digest = f => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  fs.writeFileSync(nodeSums, `${digest(archive)}  ${nodeName}.tar.xz\n`);
  mapping[`https://nodejs.org/dist/v22.23.2/${nodeName}.tar.xz`] = archive;
  mapping["https://nodejs.org/dist/v22.23.2/SHASUMS256.txt"] = nodeSums;
  const tfStage = path.join(root, "terraform-stage");
  seed(tfStage, "terraform");
  const tfName = `terraform_1.16.1_linux_${arch === "aarch64" ? "arm64" : "amd64"}.zip`;
  const tfZip = path.join(root, tfName);
  const zipped = spawnSync("/usr/bin/zip", ["-q", tfZip, "terraform"], { cwd: tfStage, encoding: "utf8" });
  assert.equal(zipped.status, 0, zipped.stderr);
  const tfSums = path.join(root, "tf-sums");
  fs.writeFileSync(tfSums, `${digest(tfZip)}  ${tfName}\n`);
  mapping[`https://releases.hashicorp.com/terraform/1.16.1/${tfName}`] = tfZip;
  mapping["https://releases.hashicorp.com/terraform/1.16.1/terraform_1.16.1_SHA256SUMS"] = tfSums;
  const mappingFile = path.join(root, "mapping.json"); fs.writeFileSync(mappingFile, JSON.stringify(mapping));
  const log = path.join(root, "events"); fs.writeFileSync(log, "");
  const env = {
    HOME: home, PATH: bin, SHELL: "/bin/bash", LC_ALL: "C", TMPDIR: root,
    TEST_DISPATCH: dispatch, TEST_MAPPING: mappingFile, TEST_LOG: log, TEST_ARCH: arch,
  };
  const run = (args = ["--apply"], extra = {}, cli = false) => {
    const harness = 'source "$1"; host_release() { [[ ${TEST_RELEASE:-24.04} == 24.04 ]]; }; main "${@:2}"';
    const r = spawnSync(bash, cli ? [script, ...args] : ["-c", harness, "test", script, ...args], {
      env: { ...env, ...extra }, encoding: "utf8", timeout: 15000,
    });
    assert.ifError(r.error);
    return r;
  };
  const events = () => fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const clean = () => assert.deepEqual(fs.readdirSync(path.join(home, ".cache")).filter(n => n.startsWith("vm-bootstrap.") && n !== "vm-bootstrap.lock"), []);
  return { root, home, bin, env, run, events, clean, seed };
}
function success(r) { assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); }
function failure(r, pattern) { assert.notEqual(r.status, 0, r.stderr); assert.match(r.stderr, pattern); assert.equal(JSON.parse(r.stdout).status, "error"); }

test("CLI default/explicit plan, optional plan, help and invalid option are mutation-free", t => {
  const f = fixture(t);
  for (const args of [[], ["--dry-run"], ["--with-docker", "--with-terraform"], ["--apply", "--dry-run"]]) {
    assert.equal(success(f.run(args, {}, true)).status, "planned");
  }
  const help = f.run(["--help"], {}, true); assert.equal(help.status, 0); assert.match(help.stdout, /Usage:/);
  const bad = f.run(["--wat"], {}, true); assert.equal(bad.status, 2); assert.match(bad.stderr, /unknown option/);
  assert.deepEqual(fs.readdirSync(f.home), []); assert.deepEqual(f.events(), []);
});

test("first apply really installs, verifies canonical Node checksum, then rerun skips working tools", t => {
  const f = fixture(t);
  const first = success(f.run());
  assert.deepEqual(first.installed, ["node", "pnpm", "pi", ...nativeTools]);
  assert.equal(first.status, "ok");
  const initial = f.events();
  assert.equal(initial.filter(e => e.cmd === "npm" && e.args[0] === "install").length, 2);
  assert.equal(initial.filter(e => e.cmd === "stub-install").length, 4);
  assert.ok(initial.some(e => e.cmd === "sudo" && e.args.includes("python3-venv") && e.args.includes("gh")));
  assert.ok(initial.some(e => e.cmd === "curl" && e.args.some(a => a.endsWith("node-v22.23.2-linux-x64.tar.xz"))));
  assert.equal(fs.existsSync(path.join(f.home, ".npmrc")), false);
  const count = initial.length;
  const second = success(f.run());
  assert.deepEqual(second.installed, []);
  assert.deepEqual(second.skipped, ["node", "pnpm", "pi", ...nativeTools]);
  assert.ok(!f.events().slice(count).some(e => (e.cmd === "curl" && e.args[0] !== "--version") || e.cmd === "stub-install" || (e.cmd === "npm" && e.args[0] === "install")));
  f.clean();
});

test("PATH preserves existing content, source is idempotent, installers avoid shell edits", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.home, ".profile"), "# existing profile\n");
  fs.writeFileSync(path.join(f.home, ".bashrc"), "# existing bashrc\n");
  success(f.run()); success(f.run());
  for (const name of [".profile", ".bashrc"]) {
    const text = fs.readFileSync(path.join(f.home, name), "utf8");
    assert.match(text, /^# existing /); assert.equal(text.split("vm-bootstrap-env.sh").length - 1, 2);
    assert.equal(text.trim().split("\n").filter(l => l.startsWith("[ ! -r")).length, 1);
  }
  const r = spawnSync(bash, ["-c", '. "$HOME/.config/vm-bootstrap-env.sh"; a=$PATH; . "$HOME/.config/vm-bootstrap-env.sh"; [[ $a == "$PATH" ]] || exit 1; printf "%s" "$PATH"'], { env: f.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.split(":").filter(p => p === `${f.home}/.local/bin`).length, 1);
  assert.ok(r.stdout.endsWith(f.bin));
  assert.ok(f.events().some(e => e.cmd === "stub-install" && e.args[0] === "bun" && e.shell === "/bin/false"));
});

for (const version of ["v22.0.0", "v22.18.9", "v20.19.0", "v22.19.0", "v22.23.2", "v24.2.0"]) {
  test(`Node minimum: ${version}`, t => {
    const f = fixture(t, { existing: true, nodeVersion: version });
    const s = success(f.run());
    const upgrade = ["v22.0.0", "v22.18.9", "v20.19.0"].includes(version);
    assert.equal(s.installed.includes("node"), upgrade);
    assert.equal(f.events().some(e => e.cmd === "curl" && e.args[0] !== "--version"), upgrade);
    f.clean();
  });
}

test("fallback Node takes priority over an old user-local Node without overwriting it", t => {
  const f = fixture(t, { existing: true, nodeVersion: "v24.2.0" });
  const local = path.join(f.home, ".local/bin");
  f.seed(local, "node"); f.seed(local, "npm");
  fs.writeFileSync(path.join(local, ".node-version"), "v20.19.0");
  assert.ok(success(f.run()).installed.includes("node"));
  assert.equal(fs.readFileSync(path.join(local, ".node-version"), "utf8"), "v20.19.0");
  const r = spawnSync(bash, ["-c", '. "$HOME/.config/vm-bootstrap-env.sh"; node --version'], {
    env: { ...f.env, PATH: `${local}:${f.env.PATH}` }, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "v22.23.2");
  assert.ok(success(f.run()).skipped.includes("node"));
  f.clean();
});

test("supported Node without working npm installs official Node/npm instead of trusting node alone", t => {
  const f = fixture(t, { existing: true }); fs.unlinkSync(path.join(f.bin, "npm"));
  assert.ok(success(f.run()).installed.includes("node"));
});

test("optional Docker apt and verified Terraform binary execute on arm64", t => {
  const f = fixture(t, { arch: "aarch64" });
  // Docker is produced ONLY by our pretend apt install, never a real daemon.
  const s = success(f.run(["--apply", "--with-docker", "--with-terraform"]));
  assert.ok(s.installed.includes("docker") && s.installed.includes("terraform"));
  assert.ok(fs.existsSync(path.join(f.home, ".local/bin/terraform")));
  assert.ok(f.events().some(e => e.cmd === "sudo" && e.args.includes("docker.io") && e.args.includes("docker-compose-v2")));
  assert.ok(f.events().some(e => e.cmd === "docker" && e.args.join(" ") === "compose version"));
  assert.ok(f.events().some(e => e.cmd === "curl" && e.args.some(a => a.includes("terraform_1.16.1_linux_arm64.zip"))));
  assert.match(fs.readFileSync(path.join(f.home, ".config/vm-bootstrap-env.sh"), "utf8"), /linux-arm64/);
  const count = f.events().length;
  success(f.run(["--apply", "--with-terraform"]));
  assert.ok(!f.events().slice(count).some(e => e.cmd === "curl" && e.args[0] !== "--version"));
  f.clean();
});

for (const [name, extra, pattern] of [
  ["root", { TEST_UID: "0" }, /root/],
  ["OS", { TEST_OS: "Darwin" }, /Linux required/],
  ["release", { TEST_RELEASE: "22.04" }, /24.04 required/],
  ["arch", { TEST_ARCH: "riscv64" }, /x86_64 or aarch64/],
  ["sudo", { FAIL_SUDO: "1" }, /sudo apt privileges/],
]) {
  test(`reject ${name} before mutations`, t => {
    const f = fixture(t); failure(f.run(["--apply"], extra), pattern);
    assert.deepEqual(fs.readdirSync(f.home), []);
    assert.ok(!f.events().some(e => e.cmd === "curl" || (e.args.includes("apt-get") && !e.args.includes("--version"))));
  });
}

test("real CLI entry enforces root gate (no sourced helper override)", t => {
  const f = fixture(t); failure(f.run(["--apply"], { TEST_UID: "0" }, true), /root/);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test("missing/relative HOME rejected before any install", t => {
  const f = fixture(t);
  for (const home of ["relative", path.join(f.root, "absent")]) failure(f.run(["--apply"], { HOME: home }), /HOME/);
  assert.ok(!f.events().some(e => e.args.includes("apt-get") && !e.args.includes("--version")));
});

for (const [name, extra, pattern] of [
  ["lock contention", { FAIL_LOCK: "1" }, /another bootstrap/],
  ["apt failure", { FAIL_APT: "1" }, /failed/],
  ["archive download", { FAIL_DOWNLOAD: ".tar.xz" }, /failed/],
  ["checksum download", { FAIL_DOWNLOAD: "SHASUMS256" }, /failed/],
  ["Node checksum mismatch", { BAD_CHECKSUM: "SHASUMS256" }, /checksum failed/],
  ["npm failure", { FAIL_NPM: "1" }, /failed/],
  ["installer download", { FAIL_DOWNLOAD: "herdr.dev" }, /failed/],
  ["installer timeout", { FAIL_TIMEOUT: "1" }, /failed/],
  ["verification", { FAIL_VERIFY: "git" }, /verification failed: git/],
  ["installer success but broken tool", { FAIL_VERIFY: "uv" }, /verification failed: uv/],
  ["installer internal download", { FAIL_DOWNLOAD: "fixture.invalid" }, /failed/],
  ...nativeTools.map(name => [`${name} installer`, { FAIL_INSTALL: name }, /failed/]),
]) {
  test(`apply fails nonzero and cleans temp files: ${name}`, t => {
    const f = fixture(t); failure(f.run(["--apply"], extra), pattern); f.clean();
    if (name === "lock contention") assert.ok(!f.events().some(e => e.args.includes("apt-get") && !e.args.includes("--version")));
    if (name === "Node checksum mismatch") assert.equal(fs.existsSync(path.join(f.home, ".local/lib/nodejs/node-v22.23.2-linux-x64")), false);
  });
}

test("Terraform checksum failure prevents extraction/installation", t => {
  const f = fixture(t);
  failure(f.run(["--apply", "--with-terraform"], { BAD_CHECKSUM: "SHA256SUMS" }), /checksum failed/);
  assert.equal(fs.existsSync(path.join(f.home, ".local/bin/terraform")), false); f.clean();
});

for (const symlink of [false, true]) {
  test(`unrelated env ${symlink ? "symlink" : "file"} is never overwritten`, t => {
    const f = fixture(t);
    const envFile = path.join(f.home, ".config/vm-bootstrap-env.sh");
    fs.mkdirSync(path.dirname(envFile));
    const target = symlink ? path.join(f.root, "precious") : envFile;
    fs.writeFileSync(target, "precious content\n");
    if (symlink) fs.symlinkSync(target, envFile);
    failure(f.run(), /refusing to overwrite/);
    assert.equal(fs.readFileSync(target, "utf8"), "precious content\n");
    assert.ok(!f.events().some(e => e.args.includes("apt-get") && !e.args.includes("--version"))); f.clean();
  });
}

test("source guard has no actions", t => {
  const f = fixture(t);
  const r = spawnSync(bash, ["-c", 'source "$1"', "test", script], { env: f.env, encoding: "utf8" });
  assert.equal(r.status, 0); assert.equal(r.stdout, ""); assert.equal(r.stderr, "");
  assert.deepEqual(f.events(), []); assert.deepEqual(fs.readdirSync(f.home), []);
});
