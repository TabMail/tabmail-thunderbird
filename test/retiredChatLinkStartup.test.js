import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('retired ChatLink startup', () => {
  it('loads only the active background scripts in order', () => {
    const manifestUrl = new URL('../manifest.json', import.meta.url);
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
    const activeScripts = [
      'keepalive/background.js',
      'updates/background.js',
      'theme/background.js',
      'agent/background.js',
      'compose/background.js',
      'chat/background.js',
    ];
    const resolve = script => new URL(script, manifestUrl).href;
    expect(manifest.background.scripts.map(resolve)).toEqual(activeScripts.map(resolve));
  });
});
