// Run after `npx cap sync android` to:
//  - Force landscape orientation on the main activity
//  - Replace launcher icons with our own (resized via sharp)
//  - Set the splash background color
//
// Idempotent.

import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const androidDir = join(root, "android");
const manifestPath = join(
  androidDir,
  "app/src/main/AndroidManifest.xml"
);

if (!existsSync(androidDir)) {
  console.log("⚠️  android/ not found — skipping customization. Run `npx cap add android` first.");
  process.exit(0);
}

// 1. AndroidManifest patch — landscape lock
{
  let xml = await readFile(manifestPath, "utf8");
  if (!xml.includes('android:screenOrientation="sensorLandscape"')) {
    xml = xml.replace(
      /<activity\b/,
      '<activity android:screenOrientation="sensorLandscape"'
    );
    await writeFile(manifestPath, xml, "utf8");
    console.log("✓ Manifest: orientation = sensorLandscape");
  } else {
    console.log("• Manifest: orientation already set");
  }
}

// 2. Launcher icons (replace defaults from Capacitor)
{
  const sharp = (await import("sharp")).default;
  const srcSvg = join(root, "www", "icons", "icon.svg");
  const sizes = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  for (const [bucket, size] of Object.entries(sizes)) {
    const outDir = join(
      androidDir,
      "app/src/main/res/mipmap-" + bucket
    );
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    await sharp(srcSvg)
      .resize(size, size)
      .png()
      .toFile(join(outDir, "ic_launcher.png"));
    await sharp(srcSvg)
      .resize(size, size)
      .png()
      .toFile(join(outDir, "ic_launcher_round.png"));
    await sharp(srcSvg)
      .resize(size, size)
      .png()
      .toFile(join(outDir, "ic_launcher_foreground.png"));
  }
  console.log("✓ Icons: replaced for all densities");
}

// 3. Splash / window background — pitch deep
{
  const colorsPath = join(
    androidDir,
    "app/src/main/res/values/colors.xml"
  );
  if (existsSync(colorsPath)) {
    let xml = await readFile(colorsPath, "utf8");
    xml = xml.replace(
      /<color name="colorPrimary">#?[0-9a-fA-F]+<\/color>/,
      '<color name="colorPrimary">#052e16</color>'
    );
    xml = xml.replace(
      /<color name="colorPrimaryDark">#?[0-9a-fA-F]+<\/color>/,
      '<color name="colorPrimaryDark">#052e16</color>'
    );
    xml = xml.replace(
      /<color name="colorAccent">#?[0-9a-fA-F]+<\/color>/,
      '<color name="colorAccent">#16a34a</color>'
    );
    await writeFile(colorsPath, xml, "utf8");
    console.log("✓ Colors: pitch theme applied");
  }
}
