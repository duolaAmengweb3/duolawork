import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = String(pkg.version || '3.0.0');

function parseCliArgs(argv) {
  let signIdentity = process.env.DUOLAWORK_SIGN_IDENTITY || '-';
  let notarize = Boolean(
    process.env.DUOLAWORK_NOTARY_PROFILE ||
      (process.env.APPLE_ID && process.env.APPLE_TEAM_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD)
  );
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sign' && argv[i + 1]) {
      signIdentity = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--sign=')) {
      signIdentity = arg.slice('--sign='.length);
    } else if (arg === '--notarize') {
      notarize = true;
    }
  }
  return { signIdentity: signIdentity.trim() || '-', notarize };
}

function buildNotaryAuthArgs() {
  const profile = (process.env.DUOLAWORK_NOTARY_PROFILE || '').trim();
  if (profile) {
    return ['--keychain-profile', profile];
  }
  const appleId = (process.env.APPLE_ID || '').trim();
  const teamId = (process.env.APPLE_TEAM_ID || '').trim();
  const password = (process.env.APPLE_APP_SPECIFIC_PASSWORD || '').trim();
  if (!appleId || !teamId || !password) {
    throw new Error(
      '[package:dmg] Notarization requested, but neither DUOLAWORK_NOTARY_PROFILE nor APPLE_ID + APPLE_TEAM_ID + APPLE_APP_SPECIFIC_PASSWORD is set.'
    );
  }
  return ['--apple-id', appleId, '--team-id', teamId, '--password', password];
}

function writeSha256File(dmgPath, shaPath) {
  const hash = createHash('sha256').update(fs.readFileSync(dmgPath)).digest('hex');
  const filename = path.basename(dmgPath);
  const content = `${hash}  ${filename}\n`;
  fs.writeFileSync(shaPath, content, 'utf8');
  return hash;
}

const { signIdentity, notarize } = parseCliArgs(process.argv.slice(2));
const distMacDir = path.join(rootDir, 'dist', 'mac');
const sourceApp = path.join(distMacDir, 'DuolaWork.app');

if (!fs.existsSync(path.join(sourceApp, 'Contents', 'MacOS', 'Electron'))) {
  throw new Error('[package:dmg] Missing dist/mac/DuolaWork.app. Run `npm run build && npm run package:mac` first.');
}

const dmgFilename = `DuolaWork-${version}-${process.arch}.dmg`;
const dmgPath = path.join(distMacDir, dmgFilename);
const shaPath = `${dmgPath}.sha256`;
const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-dmg-stage-'));

try {
  fs.mkdirSync(distMacDir, { recursive: true });
  fs.rmSync(dmgPath, { force: true });
  fs.rmSync(shaPath, { force: true });

  const stagedApp = path.join(stagingDir, 'DuolaWork.app');
  console.log(`[package:dmg] copying DuolaWork.app -> ${stagingDir}`);
  execFileSync('/usr/bin/ditto', [sourceApp, stagedApp], { stdio: 'inherit' });
  fs.symlinkSync('/Applications', path.join(stagingDir, 'Applications'));

  console.log(`[package:dmg] creating compressed UDZO DMG -> ${dmgPath}`);
  execFileSync(
    '/usr/bin/hdiutil',
    ['create', '-volname', `DuolaWork ${version}`, '-srcfolder', stagingDir, '-ov', '-format', 'UDZO', dmgPath],
    { stdio: 'inherit' }
  );

  if (signIdentity && signIdentity !== '-') {
    console.log(`[package:dmg] codesigning DMG with identity: ${signIdentity}`);
    execFileSync('/usr/bin/codesign', ['--force', '--timestamp', '--sign', signIdentity, dmgPath], {
      stdio: 'inherit'
    });
    execFileSync('/usr/bin/codesign', ['--verify', '--verbose=2', dmgPath], { stdio: 'inherit' });
  } else {
    console.log('[package:dmg] skipping DMG codesign (no Developer ID identity supplied)');
  }

  if (notarize) {
    if (!signIdentity || signIdentity === '-') {
      throw new Error('[package:dmg] Apple Notarization requires a Developer ID signing identity (`--sign` or DUOLAWORK_SIGN_IDENTITY).');
    }
    const authArgs = buildNotaryAuthArgs();
    console.log('[package:dmg] submitting DMG for Apple Notarization...');
    execFileSync('xcrun', ['notarytool', 'submit', dmgPath, ...authArgs, '--wait'], { stdio: 'inherit' });
    console.log('[package:dmg] stapling & validating notarization ticket...');
    execFileSync('xcrun', ['stapler', 'staple', dmgPath], { stdio: 'inherit' });
    execFileSync('xcrun', ['stapler', 'validate', dmgPath], { stdio: 'inherit' });
    execFileSync('/usr/sbin/spctl', ['-a', '-t', 'open', '--context', 'context:primary-signature', '-v', dmgPath], {
      stdio: 'inherit'
    });
  } else {
    console.log('[package:dmg] skipping notarization (set DUOLAWORK_NOTARY_PROFILE or APPLE_* env vars to notarize)');
  }

  const sha256 = writeSha256File(dmgPath, shaPath);
  console.log(`[package:dmg] ready dmg=${dmgPath} sha256=${sha256}`);
} finally {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
