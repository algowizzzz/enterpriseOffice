import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const KEY_BYTES = 32; // AES-256

/**
 * The key that encrypts `llm_endpoints.auth_secret` at rest, generated once
 * per installation and kept on disk from then on. There is nothing here for
 * an operator to choose or remember, unlike `DOCFORGE_ADMIN_PASSWORD`: the
 * key only has to be the same key next time the server starts, so it is
 * created the first time it is needed and simply read after that. `:memory:`
 * (what tests pass) skips the file and hands back a fresh key on every call,
 * matching the same escape hatch `databaseFile` already has.
 */
export function loadOrCreateSecretKey(keyFile: string): Buffer {
  if (keyFile === ':memory:') return randomBytes(KEY_BYTES);

  if (existsSync(keyFile)) {
    const key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `${keyFile} does not hold a valid key. Move it aside to have a new one generated ` +
          `(existing encrypted secrets will no longer decrypt).`,
      );
    }
    return key;
  }

  mkdirSync(dirname(keyFile), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  // `writeFileSync`'s mode is masked by the process umask, so it is not
  // trustworthy on its own: set the permission explicitly afterwards.
  chmodSync(keyFile, 0o600);
  return key;
}
