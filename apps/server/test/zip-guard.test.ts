import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { archiveIsReasonable, readArchiveClaim } from '../src/docx/zipGuard.js';
import { exportDocx } from '../src/docx/export.js';
import { importDocx } from '../src/docx/import.js';

/** A zip whose entries genuinely expand to roughly the size asked for. */
function archiveOf(uncompressedBytes: number): Buffer {
  return Buffer.from(zipSync({ 'big.bin': new Uint8Array(uncompressedBytes) }));
}

describe('reading what an archive claims', () => {
  it('reports the size its entries expand to', () => {
    const claim = readArchiveClaim(archiveOf(50000));
    expect(claim?.entries).toBe(1);
    expect(claim?.declaredBytes).toBe(50000);
    expect(claim?.zip64).toBe(false);
  });

  it('adds up every entry', () => {
    const archive = Buffer.from(
      zipSync({ 'a.bin': new Uint8Array(1000), 'b.bin': new Uint8Array(2000) }),
    );
    const claim = readArchiveClaim(archive);
    expect(claim?.entries).toBe(2);
    expect(claim?.declaredBytes).toBe(3000);
  });

  it('has no opinion about something that is not a zip', () => {
    expect(readArchiveClaim(Buffer.from('not a zip at all'))).toBeNull();
    expect(readArchiveClaim(Buffer.alloc(0))).toBeNull();
  });

  it('reads a real exported document', async () => {
    const buffer = await exportDocx(
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] },
      { title: 'Small' },
    );
    const claim = readArchiveClaim(buffer);
    expect(claim).not.toBeNull();
    expect(claim?.entries).toBeGreaterThan(0);
  });
});

describe('deciding whether to convert an archive', () => {
  it('accepts one that expands to a sensible size', () => {
    expect(archiveIsReasonable(archiveOf(10000), 1024 * 1024)).toEqual({ ok: true });
  });

  it('refuses one that declares far more than the limit', () => {
    const verdict = archiveIsReasonable(archiveOf(500000), 100000);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/expands to more than/u);
  });

  it('says nothing about a file it cannot read as a zip', () => {
    // No opinion is not the same as safe: the format check upstream is what
    // rejects a file that is not a Word document at all.
    expect(archiveIsReasonable(Buffer.from('rubbish'), 1000)).toEqual({ ok: true });
  });

  it('refuses a document whose archive expands past the limit, through the importer', async () => {
    // A small upload declaring an enormous payload is the shape of a zip bomb.
    const bomb = archiveOf(300 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(2 * 1024 * 1024);
    await expect(importDocx(bomb)).rejects.toThrow(/expands to more than/u);
  });

  it('still converts an ordinary document', async () => {
    const buffer = await exportDocx(
      { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ordinary' }] }] },
      { title: 'Ordinary' },
    );
    const result = await importDocx(buffer);
    expect(JSON.stringify(result.content)).toContain('ordinary');
  });
});
