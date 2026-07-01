import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const projectRoot = process.cwd();
const nodeBin = process.execPath;
const cliPath = path.join(projectRoot, "dist", "src", "cli.js");
const binDir = path.join(homedir(), ".local", "bin");

await mkdir(binDir, { recursive: true });
await chmod(cliPath, 0o755);

for (const name of ["deep-research-yolo", "dryolo"]) {
  await rm(path.join(binDir, name), { force: true });
}

for (const name of ["delve"]) {
  const wrapperPath = path.join(binDir, name);
  await rm(wrapperPath, { force: true });
  await writeFile(
    wrapperPath,
    `#!/usr/bin/env bash\nexec ${JSON.stringify(nodeBin)} --no-warnings ${JSON.stringify(cliPath)} "$@"\n`,
    "utf8"
  );
  await chmod(wrapperPath, 0o755);
  console.error(`installed ${wrapperPath} -> ${nodeBin} ${cliPath}`);
}
