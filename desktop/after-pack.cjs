// The packaging tool leaves every folder called node_modules out of the app's
// extra resources, which would ship the app without the libraries it needs:
// it would start only on a computer that happens to have them elsewhere.
// This step, run after the app is assembled and before it is signed and put
// in the installer, copies the server's libraries in.
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const from = path.join(__dirname, "build", "server", "node_modules");
  const resources =
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");
  const to = path.join(resources, "server", "node_modules");
  if (!fs.existsSync(from)) throw new Error(`The server's libraries are missing at ${from}. Run "npm run prepare-server" first.`);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  const count = fs.readdirSync(to).length;
  if (count < 5) throw new Error("The server's libraries were not copied into the app.");
  console.log(`  • copied the server's libraries into the app  packages=${count}`);
};
