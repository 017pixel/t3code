const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");
const extraThemes = require("./generated-uniwind-theme-names.json");

/** @type {import("expo/metro-config").MetroConfig} */
const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, "../..");
const generatedLicenseModuleRoot = path.join(__dirname, ".generated", "third-party-licenses");
const licenseGeneratorSource = path.join(
  workspaceRoot,
  "scripts",
  "lib",
  "third-party-licenses.ts",
);
const escapedWorkspaceRoot = workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mobileShikiRoot = path.dirname(require.resolve("shiki/package.json", { paths: [__dirname] }));
const generatedDeviceStreamRoot = path.join(__dirname, ".generated", "device-stream");
const generatedPreviewStreamRoot = path.join(__dirname, ".generated", "preview-stream");
const resolveShikiDependencyRoot = (packageName) => {
  const entryPath = require.resolve(packageName, { paths: [mobileShikiRoot] });
  let currentDir = path.dirname(entryPath);

  while (!fs.existsSync(path.join(currentDir, "package.json"))) {
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not resolve package root for ${packageName}`);
    }
    currentDir = parentDir;
  }

  return currentDir;
};

// With pnpm's global virtual store (see .pnpmfile.cjs), package files live in
// the shared store, outside the workspace, and Metro only reads files inside
// watchFolders. Watch the store slot of each package reachable from this app,
// not the whole store: it holds every project's packages. A slot's
// node_modules holds the package and links to its dependencies.
const modulesState = JSON.parse(
  fs.readFileSync(path.join(workspaceRoot, "node_modules", ".modules.yaml"), "utf8"),
);
const isInWorkspace = (dir) => !path.relative(workspaceRoot, dir).startsWith("..");
const usesGlobalStore = !isInWorkspace(
  path.resolve(workspaceRoot, "node_modules", modulesState.virtualStoreDir),
);
// pnpm still hoists every package here. Store packages are not below it, so
// Node reaches it through NODE_PATH, and Metro through nodeModulesPaths. Some
// packages import dependencies they never declare.
const hoistedModulesDir = path.join(workspaceRoot, "node_modules", ".pnpm", "node_modules");

function globalStoreSlotDirs() {
  const slotDirs = new Set();
  const visited = new Set();
  const pending = [
    path.join(__dirname, "node_modules"),
    path.join(workspaceRoot, "node_modules"),
    hoistedModulesDir,
  ];
  while (pending.length > 0) {
    const modulesDir = pending.pop();
    if (visited.has(modulesDir)) continue;
    visited.add(modulesDir);
    let entries;
    try {
      entries = fs.readdirSync(modulesDir, { withFileTypes: true });
    } catch {
      continue;
    }
    const scoped = path.basename(modulesDir).startsWith("@");
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = path.join(modulesDir, entry.name);
      if (!scoped && entry.name.startsWith("@")) {
        pending.push(entryPath);
        continue;
      }
      let realDir;
      try {
        realDir = fs.realpathSync(entryPath);
      } catch {
        continue;
      }
      if (isInWorkspace(realDir)) {
        // A workspace package: its own node_modules links into the store.
        pending.push(path.join(realDir, "node_modules"));
        continue;
      }
      const slotDir = scoped ? path.dirname(path.dirname(realDir)) : path.dirname(realDir);
      if (!slotDirs.has(slotDir)) {
        slotDirs.add(slotDir);
        pending.push(slotDir);
      }
    }
  }
  return [...slotDirs];
}

config.watchFolders = [
  ...new Set([
    ...(config.watchFolders ?? []),
    workspaceRoot,
    ...(usesGlobalStore ? globalStoreSlotDirs() : []),
  ]),
];
config.resolver = {
  ...config.resolver,
  blockList: [
    ...(Array.isArray(config.resolver?.blockList)
      ? config.resolver.blockList
      : config.resolver?.blockList
        ? [config.resolver.blockList]
        : []),
    new RegExp(`${escapedWorkspaceRoot}[/\\\\]\\.t3[/\\\\].*`),
  ],
  ...(usesGlobalStore && {
    nodeModulesPaths: [...(config.resolver?.nodeModulesPaths ?? []), hoistedModulesDir],
  }),
  extraNodeModules: {
    ...config.resolver?.extraNodeModules,
    "@t3tools/mobile-third-party-licenses": generatedLicenseModuleRoot,
    "@t3tools/mobile-device-stream": generatedDeviceStreamRoot,
    "@t3tools/mobile-preview-stream": generatedPreviewStreamRoot,
    shiki: mobileShikiRoot,
    "@shikijs/core": resolveShikiDependencyRoot("@shikijs/core"),
    "@shikijs/engine-javascript": resolveShikiDependencyRoot("@shikijs/engine-javascript"),
    "@shikijs/engine-oniguruma": resolveShikiDependencyRoot("@shikijs/engine-oniguruma"),
    "@shikijs/langs": resolveShikiDependencyRoot("@shikijs/langs"),
    "@shikijs/themes": resolveShikiDependencyRoot("@shikijs/themes"),
    "@shikijs/types": resolveShikiDependencyRoot("@shikijs/types"),
    "@shikijs/vscode-textmate": resolveShikiDependencyRoot("@shikijs/vscode-textmate"),
  },
};

async function writeFileIfChanged(filePath, contents) {
  try {
    if ((await fs.promises.readFile(filePath, "utf8")) === contents) return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.promises.writeFile(filePath, contents, "utf8");
}

async function generateMobileThirdPartyLicenses() {
  await fs.promises.mkdir(generatedLicenseModuleRoot, { recursive: true });
  const generatorVersion = (await fs.promises.stat(licenseGeneratorSource)).mtimeMs;
  const { generateThirdPartyLicenseManifest } = await import(
    `${pathToFileURL(licenseGeneratorSource).href}?version=${String(generatorVersion)}`
  );
  const manifest = await generateThirdPartyLicenseManifest({
    configFile: path.join(workspaceRoot, "third-party-licenses.config.json"),
    packageManifests: [{ bundle: "mobile", path: path.join(__dirname, "package.json") }],
    allowMissingGeneratedNotices:
      process.env.NODE_ENV !== "production" &&
      process.env.EAS_BUILD !== "true" &&
      process.env.T3CODE_LICENSES_STRICT !== "1",
  });

  await Promise.all([
    writeFileIfChanged(
      path.join(generatedLicenseModuleRoot, "index.js"),
      `module.exports = ${JSON.stringify(manifest)};\n`,
    ),
    writeFileIfChanged(
      path.join(generatedLicenseModuleRoot, "package.json"),
      '{"main":"index.js"}\n',
    ),
  ]);
}

async function prepareStreamScripts() {
  const { generateDeviceStreamScript, generatePreviewStreamScript } = await import(
    pathToFileURL(path.join(__dirname, "scripts", "generate-device-stream.mts")).href
  );
  const generateAll = () =>
    Promise.all([generateDeviceStreamScript(), generatePreviewStreamScript()]);
  await generateAll();
  if (process.env.NODE_ENV !== "production") {
    let rebuild = Promise.resolve();
    for (const [directory, files, generate] of [
      [
        "apps/mobile/src/features/devices",
        ["device-stream.browser.ts"],
        generateDeviceStreamScript,
      ],
      [
        "apps/mobile/src/features/browser",
        ["preview-stream.browser.ts"],
        generatePreviewStreamScript,
      ],
      ["packages/client-runtime/src/device", ["stream.ts", "hubAccess.ts"], generateAll],
      [
        "packages/client-runtime/src/preview",
        ["serverBrowserStream.ts"],
        generatePreviewStreamScript,
      ],
    ]) {
      fs.watch(path.join(workspaceRoot, directory), { persistent: false }, (_event, filename) => {
        if (filename && !files.includes(String(filename))) return;
        rebuild = rebuild
          .then(generate)
          .then(() => undefined)
          .catch((error) => {
            console.error("Could not rebuild a WebView stream script:", error);
          });
      });
    }
  }
}

module.exports = Promise.all([generateMobileThirdPartyLicenses(), prepareStreamScripts()]).then(
  () =>
    withUniwindConfig(config, {
      cssEntryFile: "./global.css",
      extraThemes,
      polyfills: { rem: 14 },
    }),
);
