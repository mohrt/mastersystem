// Downloads test ROMs for the tests: sverx's SMS Test Suite, which reports the console model,
// region, TV system and FM chip it finds. It has no licence, so it is only fetched for the
// tests and never published; the tests that need it skip when it is missing.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests', 'fixtures', 'test-roms');

const files = [
  {
    file: 'SMSTestSuite.sms',
    url: 'https://github.com/sverx/SMSTestSuite/releases/download/v0.38/SMSTestSuite.sms',
    sha256: 'edbe62071e94cbd10faa51f9035159f36b1b2fae8e3e4bec2a0f20848d877ebb',
  },
];

await mkdir(outDir, { recursive: true });
for (const { file, url, sha256 } of files) {
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`Download of ${file} failed: ${response.status} ${response.statusText}`);
    process.exit(1);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) {
    console.error(`${file} has changed (checksum mismatch)`);
    process.exit(1);
  }
  await writeFile(join(outDir, file), bytes);
  console.log(`Saved ${join(outDir, file)}`);
}
