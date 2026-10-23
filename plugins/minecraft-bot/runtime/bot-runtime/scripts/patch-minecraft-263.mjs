import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 为 bot-runtime 打上 Minecraft 26.3（protocol 777）支持。
// 依赖上游尚未合并的 PR：全部按 sha256 钉死下载校验，补丁用本文件自带的 unified diff 应用器套上去
// （不依赖 git），任何非预期结果一律失败，不做静默降级。
// 用法：在 bot-runtime 目录先 `npm install`，再 `node scripts/patch-minecraft-263.mjs`。
// 需要 tar；若 fetch 报 UNABLE_TO_VERIFY_LEAF_SIGNATURE（本机根证书不在 Node 默认信任链），
// 改用 `node --use-system-ca scripts/patch-minecraft-263.mjs`。`--pin` 只重新打印 tarball 哈希供更新钉点。

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.resolve(scriptDir, "..");
const nodeModules = path.join(runtimeDir, "node_modules");

const MINEFLAYER_MASTER = "7b4bb8d2b56be9cdb832474af873acd37e609746"; // 2026-10-10，含已合并的 #4137 tick_end
const MINEFLAYER_TARBALL_SHA256 = "f97a12357a800278d0f04b2cd7f8cf01e48cdae1849bd913cd0495efe37351db";

// 上游 PR diff：下载地址 + 内容哈希（2026-10-22 取自各 PR 的 .diff）
// dest 是包内的落地相对路径；minecraft-data 的 npm 包把仓库内容整体嵌在 minecraft-data/ 下，
// 所以它的 data/... 路径要落到 node_modules/minecraft-data/minecraft-data/。
const PR_PATCHES = [
  { repo: "PrismarineJS/minecraft-data", pr: 1300, sha256: "039725d6751b312cb17e782a8705c94c959b39c88b4251e12600b62e6a599dcc", dest: "minecraft-data/minecraft-data" },
  { repo: "PrismarineJS/minecraft-data", pr: 1301, sha256: "168c68b12a0708588e6fe1c2905f6e1f00ef4f45d3e3a95e6ca99e60d7074e37", dest: "minecraft-data/minecraft-data" },
  // 仓库名与包目录名不一致时要显式写 dest
  { repo: "PrismarineJS/node-minecraft-protocol", pr: 1532, sha256: "55cdeb23c82251e29a2268fdbfa2e134b9389c2655bd4c3c4583c3f26d24e0d4", dest: "minecraft-protocol" },
  { repo: "PrismarineJS/node-minecraft-protocol", pr: 1538, sha256: "d1969089c4ddfa64d35d487ad985281b83b99e127f864ecfda39cbe1e4772203", dest: "minecraft-protocol" },
  { repo: "PrismarineJS/node-minecraft-protocol", pr: 1542, sha256: "35dee3dffbbcb876b3bfeaa830f1983cea6919277398e40eaa9debda46f9b4fb", dest: "minecraft-protocol" },
  { repo: "PrismarineJS/prismarine-chunk", pr: 333, sha256: "32c207a9af3e634c611f79ba0eeaa216a71f95c86cad5e742f33ccacb2d561e0" },
  { repo: "PrismarineJS/prismarine-chunk", pr: 331, sha256: "85cd91dcdb0e1b9f47c189bfaa2d9839ef4a8d68223ced894912288b74bd1d78", tolerate: ["src/index.js"] },
  { repo: "PrismarineJS/prismarine-chunk", pr: 340, sha256: "bcbec566affe03a62bb43b16207f802dbc00f10dc93216444b8ba9e15b0f210d" },
  { repo: "PrismarineJS/prismarine-chunk", pr: 334, sha256: "3af00922862034beba108f12882eb1bf462b64159644384e2a0c05a80f1801eb", tolerate: ["src/index.js"] },
  { repo: "PrismarineJS/prismarine-physics", pr: 145, sha256: "a3e0f2e543a67001a72f1ad39234c3139c966a7d074c973d688ef5b7935e86ad", tolerate: ["lib/features.json"] },
  // mineflayer 三个补丁打在上面的 master 快照上（#4137 只存在于 master，其 diff 套不到发布版 4.39.0）
  { repo: "PrismarineJS/mineflayer", pr: 4130, sha256: "3af9ae1934c92c6838eef1201c3db1e71c26bc4ee9e2a934b4bcd159ee40c004" },
  { repo: "PrismarineJS/mineflayer", pr: 4144, sha256: "100cc5b8a7703adc614a0a4807a5a30e12824b6c606996fa16897a93d11a4049" },
  { repo: "PrismarineJS/mineflayer", pr: 4146, sha256: "f60c7dc92f6d0e734fbd0c3af9f350f2bda6166e89dd4a28c96e1b918ed7b388" },
];

// 上游 diff 与 npm 版上下文对不上、必须由本脚本手工补的地方
const MANUAL_EDITS = [
  {
    file: "prismarine-chunk/src/index.js",
    before: "    26.2: require('./pc/1.18/chunk')",
    after: "    26.2: require('./pc/1.18/chunk'),\n    26.3: require('./pc/1.18/chunk')",
    why: "#331 与 #334 都改这段版本映射且互相冲突，两个 hunk 都无法套用",
  },
  {
    file: "prismarine-physics/lib/features.json",
    before: '"1.21", "26.1"]',
    after: '"1.21", "26.1", "26.2", "26.3"]',
    why: "#145 基于已含 26.2 的 master，npm 版只到 26.1；缺 26.3 会让 Physics() 抛 'No liquid gravity settings'",
  },
  {
    file: "minecraft-protocol/src/version.js",
    before: "'26.1', '26.3']",
    after: "'26.1', '26.2', '26.3']",
    why: "#1532 只把 26.3 加进 supportedVersions，#1301 却带全了 26.2 的数据；补上后 26.2 服务端可直接连，不必手动锁版本",
  },
  {
    file: "mineflayer/lib/version.js",
    before: "'1.21.11', '26.1']",
    after: "'1.21.11', '26.1', '26.2', '26.3']",
    why: "等价于 #4124 的 testedVersions 改动；不在表里 loader 会抛 'Server version 26.3 is not supported'",
  },
];

// 允许套不上的 hunk（纯文档、或 26.3 用不到的旧版本数据），其余套不上就失败
const TOLERATED = [
  "README.md",
  "docs/README.md",
  ".github/workflows/ci.yml",
  "data/pc/26.1/protocol.json",
  "data/pc/latest/proto.yml",
  "data/pc/26.1/proto.yml",
  "test/", // npm 包不含测试目录
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function fetchVerified(url, expected) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`下载失败 ${res.status}：${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== expected) throw new Error(`校验不通过：${url}\n实际 sha256=${sha256(buf)}\n（上游可能 force-push 过，需人工复核后更新钉点）`);
  return buf;
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.error) throw new Error(`${cmd} 执行失败：${r.error.message}（cwd=${cwd}）`);
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function isTolerated(file, extra = []) {
  const f = file.replaceAll("\\", "/");
  return [...TOLERATED, ...extra].some((t) => f === t || f.endsWith(`/${t}`) || f.includes(t));
}

/** 解析一个 .diff 文本为 [{ file, hunks, newFile, deletedFile }] */
function parsePatch(text) {
  const lines = text.split("\n");
  const files = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      const m = / b\/(.+)$/.exec(line);
      cur = { file: m ? m[1] : null, hunks: [], newFile: false, deletedFile: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("new file mode")) { cur.newFile = true; continue; }
    if (line.startsWith("deleted file mode")) { cur.deletedFile = true; continue; }
    if (line.startsWith("Binary files")) { cur.binary = true; continue; }
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new Error(`无法解析 hunk 头：${line}`);
      const hunk = { oldStart: Number(m[1]), newStart: Number(m[3]), oldLines: [], newLines: [] };
      // 按 hunk 头声明的行数收线：diff 文本结尾常带一个空行，当上下文收进来就会多出一行对不上
      const wantOld = m[2] === undefined ? 1 : Number(m[2]);
      const wantNew = m[4] === undefined ? 1 : Number(m[4]);
      i++;
      for (; i < lines.length; i++) {
        if (hunk.oldLines.length >= wantOld && hunk.newLines.length >= wantNew) { i--; break; } // 回退一格，否则外层 i++ 会吃掉下一个文件的 diff 头
        const h = lines[i];
        if (h.startsWith("@@") || h.startsWith("diff --git ")) { i--; break; }
        if (h.startsWith("\\")) continue; // \ No newline at end of file
        if (h.startsWith(" ")) { hunk.oldLines.push(h.slice(1)); hunk.newLines.push(h.slice(1)); }
        else if (h.startsWith("-")) { hunk.oldLines.push(h.slice(1)); }
        else if (h.startsWith("+")) { hunk.newLines.push(h.slice(1)); }
        else if (h === "") { hunk.oldLines.push(""); hunk.newLines.push(""); }
        else { i--; break; }
      }
      if (hunk.oldLines.length !== wantOld || hunk.newLines.length !== wantNew) {
        throw new Error(`hunk 行数与声明不符（声明 ${wantOld}/${wantNew}，实收 ${hunk.oldLines.length}/${hunk.newLines.length}）：${line}`);
      }
      cur.hunks.push(hunk);
    }
  }
  return files.filter((f) => f.file);
}

/** 在 out 数组里找 oldLines 的落点：先按声明行号精确试，再向两侧找；找不到返回 -1 */
function locate(out, hunk) {
  const need = hunk.oldLines;
  if (!need.length) return Math.min(Math.max(hunk.newStart - 1, 0), out.length);
  const tryAt = (at) => {
    if (at < 0 || at + need.length > out.length) return false;
    return need.every((l, k) => out[at + k] === l);
  };
  const declared = hunk.oldStart - 1;
  if (tryAt(declared)) return declared;
  for (let delta = 1; delta <= 200; delta++) {
    if (tryAt(declared + delta)) return declared + delta;
    if (tryAt(declared - delta)) return declared - delta;
  }
  return -1;
}

/** 把一个 diff 应用到 root 目录下，返回 { applied, skipped, failed } */
async function applyPatch(patchText, root, tolerate = []) {
  const applied = [];
  const skipped = [];
  const failed = [];
  for (const fileSpec of parsePatch(patchText)) {
    const target = path.join(root, fileSpec.file);
    if (fileSpec.binary) { (isTolerated(fileSpec.file, tolerate) ? skipped : failed).push(`${fileSpec.file}（二进制）`); continue; }

    if (fileSpec.deletedFile) {
      await rm(target, { force: true });
      applied.push(`${fileSpec.file}（删除）`);
      continue;
    }

    let exists = true;
    let text = "";
    try { text = await readFile(target, "utf8"); } catch { exists = false; }

    if (fileSpec.newFile && exists) {
      // 已由前一个 PR 建好（#1301 叠在 #1300 上时会遇到），内容一致就算通过
      const want = fileSpec.hunks.flatMap((h) => h.newLines).join("\n");
      if (text.replace(/\r\n/g, "\n").trimEnd() === want.trimEnd()) { applied.push(`${fileSpec.file}（已存在，一致）`); continue; }
      (isTolerated(fileSpec.file, tolerate) ? skipped : failed).push(`${fileSpec.file}（已存在且内容不同）`);
      continue;
    }

    if (!exists) {
      if (!fileSpec.newFile) { (isTolerated(fileSpec.file, tolerate) ? skipped : failed).push(`${fileSpec.file}（目标不存在）`); continue; }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, fileSpec.hunks.flatMap((h) => h.newLines).join("\n") + "\n");
      applied.push(`${fileSpec.file}（新建）`);
      continue;
    }

    let out = text.replace(/\r\n/g, "\n").split("\n");
    let offset = 0;
    let broke = false;
    for (const hunk of fileSpec.hunks) {
      const shifted = { ...hunk, oldStart: hunk.oldStart + offset };
      const at = locate(out, shifted);
      if (at < 0) { broke = true; break; }
      offset = at - (hunk.oldStart - 1);
      out = [...out.slice(0, at), ...hunk.newLines, ...out.slice(at + hunk.oldLines.length)];
    }
    if (broke) {
      (isTolerated(fileSpec.file, tolerate) ? skipped : failed).push(`${fileSpec.file}（hunk 上下文对不上）`);
      continue;
    }
    await writeFile(target, out.join("\n"));
    applied.push(fileSpec.file);
  }
  return { applied, skipped, failed };
}

async function installPinnedMineflayer() {
  const tmp = await mkdtemp(path.join(runtimeDir, ".mf263-"));
  try {
    await writeFile(path.join(tmp, "mineflayer.tgz"), await fetchVerified(
      `https://codeload.github.com/PrismarineJS/mineflayer/tar.gz/${MINEFLAYER_MASTER}`,
      MINEFLAYER_TARBALL_SHA256,
    ));
    // 相对路径调 tar：Git 版 tar 会把 "D:\..." 当成远端 cpio 地址
    const x = run("tar", ["-xzf", "mineflayer.tgz"], tmp);
    if (x.status !== 0) throw new Error(`解压失败：${x.out}`);
    const dirs = (await readdir(tmp, { withFileTypes: true })).filter((e) => e.isDirectory());
    if (dirs.length !== 1) throw new Error(`tarball 顶层目录不唯一：${dirs.map((d) => d.name).join(", ")}`);
    await rm(path.join(nodeModules, "mineflayer"), { recursive: true, force: true });
    await cp(path.join(tmp, dirs[0].name), path.join(nodeModules, "mineflayer"), { recursive: true });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function replaceOnce(relFile, before, after) {
  const file = path.join(nodeModules, relFile);
  const source = await readFile(file, "utf8");
  if (source.includes(after)) return; // 已打过，允许重复执行
  if (!source.includes(before)) throw new Error(`手工补丁 ${relFile} 的锚点文本已变化，需人工复核`);
  await writeFile(file, source.replace(before, after));
}

async function main() {
  if (!(await stat(nodeModules)).isDirectory()) throw new Error("缺少 node_modules；请先在 bot-runtime 执行 npm install");
  if (MINEFLAYER_TARBALL_SHA256.length !== 64) throw new Error("MINEFLAYER_TARBALL_SHA256 未填写，拒绝使用未校验的 tarball");

  console.log(`· mineflayer → master ${MINEFLAYER_MASTER.slice(0, 8)}`);
  await installPinnedMineflayer();

  const patchDir = await mkdtemp(path.join(runtimeDir, ".263-patches-"));
  try {
    for (const p of PR_PATCHES) {
      const name = `${p.repo.replace("/", "-")}-${p.pr}.diff`;
      const file = path.join(patchDir, name);
      await writeFile(file, await fetchVerified(`https://github.com/${p.repo}/pull/${p.pr}.diff`, p.sha256));
      const pkg = p.repo.split("/")[1];
      const { applied, skipped, failed } = await applyPatch(await readFile(file, "utf8"), path.join(nodeModules, p.dest ?? pkg), p.tolerate);
      console.log(`· ${p.repo}#${p.pr} → ${pkg}: 套上 ${applied.length} 个文件` + (skipped.length ? `，跳过 ${skipped.length}` : ""));
      if (failed.length) throw new Error(`${p.repo}#${p.pr} 有非预期失败：\n  ${failed.join("\n  ")}`);
    }
  } finally {
    await rm(patchDir, { recursive: true, force: true });
  }

  for (const edit of MANUAL_EDITS) {
    await replaceOnce(edit.file, edit.before, edit.after);
    console.log(`· 手工补 ${edit.file} —— ${edit.why}`);
  }

  const gen = run(process.execPath, ["bin/generate_data.js"], path.join(nodeModules, "minecraft-data"));
  if (gen.status !== 0) throw new Error(`minecraft-data 索引重生成失败：${gen.out}`);
  console.log("· 已重生成 data.js 索引（不跑这步 minecraft-data('26.3') 返回 null）");

  const req = createRequire(path.join(runtimeDir, "src", "index.mjs"));
  const check = {
    "26.3 protocol": req("minecraft-data")("26.3")?.version?.version,
    nmp支持: req("minecraft-protocol/src/version.js").supportedVersions.includes("26.3"),
    mineflayer支持: req("mineflayer/lib/version.js").testedVersions.includes("26.3"),
    tick_end补丁在位: (await readFile(path.join(nodeModules, "mineflayer/lib/plugins/physics.js"), "utf8")).includes("'tick_end'"),
    限速特征在位: (await readFile(path.join(nodeModules, "minecraft-data/minecraft-data/data/pc/common/features.json"), "utf8")).includes("sendsClientTickEndPacket"),
  };
  console.log("· 自检:", JSON.stringify(check));
  if (check["26.3 protocol"] !== 777 || !check.nmp支持 || !check.mineflayer支持 || !check.tick_end补丁在位) {
    throw new Error("自检未通过，26.3 支持没有真正装上");
  }
  console.log("26.3 运行时补丁完成");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (process.argv.includes("--pin")) {
    const res = await fetch(`https://codeload.github.com/PrismarineJS/mineflayer/tar.gz/${MINEFLAYER_MASTER}`, { redirect: "follow" });
    if (!res.ok) throw new Error(`下载失败 ${res.status}`);
    console.log(`MINEFLAYER_TARBALL_SHA256 = "${sha256(Buffer.from(await res.arrayBuffer()))}"   // master ${MINEFLAYER_MASTER}`);
  } else {
    main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
  }
}
