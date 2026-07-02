import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { access, cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

export interface CodexSkillStatus {
  sourcePath: string;
  targetPath: string;
  sourceExists: boolean;
  targetExists: boolean;
  installed: boolean;
  matchesPackagedSkill: boolean;
}

export interface InstallCodexSkillOptions {
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  targetPath?: string;
  force?: boolean;
  dryRun?: boolean;
}

export interface InstallCodexSkillResult extends CodexSkillStatus {
  ok: boolean;
  action: "install" | "overwrite" | "already-installed" | "dry-run-install" | "dry-run-overwrite";
  dryRun: boolean;
  files: string[];
}

export function resolveCodexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME && env.CODEX_HOME.length > 0 ? env.CODEX_HOME : path.join(homedir(), ".codex");
}

export function packagedSkillPath(projectRoot: string): string {
  return path.join(projectRoot, "codex", "skills", "delve");
}

export function defaultSkillTargetPath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveCodexHome(env), "skills", "delve");
}

export async function getCodexSkillStatus(input: {
  projectRoot: string;
  env: NodeJS.ProcessEnv;
  targetPath?: string;
}): Promise<CodexSkillStatus> {
  const sourcePath = packagedSkillPath(input.projectRoot);
  const targetPath = path.resolve(input.targetPath ?? defaultSkillTargetPath(input.env));
  const sourceExists = await pathExists(sourcePath);
  const targetExists = await pathExists(targetPath);
  const matchesPackagedSkill = sourceExists && targetExists ? await directoriesMatch(sourcePath, targetPath) : false;
  return {
    sourcePath,
    targetPath,
    sourceExists,
    targetExists,
    installed: targetExists,
    matchesPackagedSkill
  };
}

export async function installCodexSkill(options: InstallCodexSkillOptions): Promise<InstallCodexSkillResult> {
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const status = await getCodexSkillStatus(options);
  if (!status.sourceExists) {
    throw new Error(`Packaged Delve skill is missing at ${status.sourcePath}`);
  }

  const files = await listRelativeFiles(status.sourcePath);
  if (status.targetExists && status.matchesPackagedSkill) {
    return {
      ...status,
      ok: true,
      action: "already-installed",
      dryRun,
      files
    };
  }

  if (status.targetExists && !force && !dryRun) {
    throw new Error(`Codex skill already exists at ${status.targetPath}; pass --force to overwrite it`);
  }

  const action = status.targetExists
    ? dryRun
      ? "dry-run-overwrite"
      : "overwrite"
    : dryRun
      ? "dry-run-install"
      : "install";

  if (!dryRun) {
    await mkdir(path.dirname(status.targetPath), { recursive: true });
    if (status.targetExists) await rm(status.targetPath, { recursive: true, force: true });
    await cp(status.sourcePath, status.targetPath, { recursive: true });
  }

  return {
    ...(await getCodexSkillStatus(options)),
    ok: true,
    action,
    dryRun,
    files
  };
}

async function directoriesMatch(left: string, right: string): Promise<boolean> {
  const [leftFiles, rightFiles] = await Promise.all([listRelativeFiles(left), listRelativeFiles(right)]);
  if (leftFiles.length !== rightFiles.length) return false;
  for (let i = 0; i < leftFiles.length; i += 1) {
    if (leftFiles[i] !== rightFiles[i]) return false;
  }
  const hashes = await Promise.all(
    leftFiles.map(async (file) => {
      const [leftHash, rightHash] = await Promise.all([
        fileHash(path.join(left, file)),
        fileHash(path.join(right, file))
      ]);
      return leftHash === rightHash;
    })
  );
  return hashes.every(Boolean);
}

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, "");
  return files.sort();

  async function walk(base: string, relativeDir: string): Promise<void> {
    const dir = path.join(base, relativeDir);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relative = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        await walk(base, relative);
      } else if (entry.isFile()) {
        files.push(relative);
      }
    }
  }
}

async function fileHash(file: string): Promise<string> {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await access(file);
    await stat(file);
    return true;
  } catch {
    return false;
  }
}
