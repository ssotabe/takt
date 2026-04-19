/**
 * Ensures core/models/ does not import from core/workflow/.
 * models is a lower layer; workflow depends on models, not the reverse.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

describe('layer boundary: core/models → core/workflow', () => {
  it('should not have imports from core/workflow in core/models', () => {
    const modelsDir = join(process.cwd(), 'src/core/models');
    const files = readdirSync(modelsDir).filter((f) => f.endsWith('.ts'));
    const violations: string[] = [];

    for (const file of files) {
      const content = readFileSync(join(modelsDir, file), 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (/from\s+['"]\.\.\/workflow\//.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
