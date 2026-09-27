import { describe, expect, test } from 'bun:test';

import {
  compareNovaCodeVersions,
  hostMeetsNovaCodeEngine,
  novaCodeEngineMinimum,
  parseNovaCodeVersion,
} from './host-version.ts';

describe('openChamber host version', () => {
  test('parses core semver', () => {
    expect(parseNovaCodeVersion('1.22.0')).toEqual({ major: 1, minor: 22, patch: 0 });
    expect(parseNovaCodeVersion('v1.22.0-beta.1')).toEqual({ major: 1, minor: 22, patch: 0 });
    expect(parseNovaCodeVersion('junk')).toBeNull();
  });

  test('compares versions', () => {
    expect(compareNovaCodeVersions('1.22.0', '1.21.9')).toBeGreaterThan(0);
    expect(compareNovaCodeVersions('1.22.0', '1.22.0')).toBe(0);
    expect(compareNovaCodeVersions('1.21.0', '1.22.0')).toBeLessThan(0);
  });

  test('normalizes engines.novacode floors', () => {
    expect(novaCodeEngineMinimum('1.22.0')).toBe('1.22.0');
    expect(novaCodeEngineMinimum('>=1.22.0')).toBe('1.22.0');
    expect(novaCodeEngineMinimum('^1.22.0')).toBeNull();
  });

  test('checks host against engines.novacode', () => {
    expect(hostMeetsNovaCodeEngine('1.22.0', '>=1.22.0')).toBe(true);
    expect(hostMeetsNovaCodeEngine('1.22.0', '1.22.0')).toBe(true);
    expect(hostMeetsNovaCodeEngine('1.21.9', '>=1.22.0')).toBe(false);
    expect(hostMeetsNovaCodeEngine('unknown', '>=1.22.0')).toBe(false);
  });
});
