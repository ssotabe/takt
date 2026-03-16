/**
 * Unit tests for slot-parser module.
 *
 * Tests parseSlotSections() which extracts slot-specific instructions
 * from decompose output with ## slot_N markdown headers.
 *
 * Covers:
 * - Normal: all 3 slots have task instructions
 * - Normal: some slots have "タスクなし" (no task)
 * - Normal: 2 slots requested (variable slot count)
 * - Error: no slot headers found
 * - Error: some expected slot headers missing
 * - Edge: extra text before first slot header
 * - Edge: extra text after last slot section
 * - Edge: whitespace variations in headers
 * - Edge: slot content with nested markdown headers (### h3)
 */

import { describe, it, expect } from 'vitest';
import { parseSlotSections } from '../core/piece/engine/slot-parser.js';

describe('parseSlotSections', () => {
  // =====================================================
  // 1. Normal: all 3 slots have task instructions
  // =====================================================
  describe('all slots with instructions', () => {
    it('should parse 3 slots with task instructions', () => {
      // Given: decompose output with 3 slot sections
      const content = [
        '## slot_1',
        'Implement user authentication module.',
        '',
        '## slot_2',
        'Add database migration for users table.',
        '',
        '## slot_3',
        'Write integration tests for auth flow.',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2', 'slot_3'];

      // When: parsing slot sections
      const result = parseSlotSections(content, slotNames);

      // Then: each slot has its instruction text
      expect(result.get('slot_1')).toBe('Implement user authentication module.');
      expect(result.get('slot_2')).toBe('Add database migration for users table.');
      expect(result.get('slot_3')).toBe('Write integration tests for auth flow.');
    });

    it('should preserve multiline content within a slot', () => {
      // Given: slot with multiline instructions
      const content = [
        '## slot_1',
        'Line 1 of instructions.',
        'Line 2 of instructions.',
        '',
        'Line 4 after blank line.',
        '',
        '## slot_2',
        'タスクなし',
        '',
        '## slot_3',
        'タスクなし',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2', 'slot_3'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then: multiline content is preserved with blank lines
      expect(result.get('slot_1')).toBe(
        'Line 1 of instructions.\nLine 2 of instructions.\n\nLine 4 after blank line.'
      );
    });
  });

  // =====================================================
  // 2. Normal: some slots have "タスクなし"
  // =====================================================
  describe('slots with no task', () => {
    it('should return empty string for slots marked "タスクなし"', () => {
      // Given: slot_2 and slot_3 have no task
      const content = [
        '## slot_1',
        'Implement feature X.',
        '',
        '## slot_2',
        'タスクなし',
        '',
        '## slot_3',
        'タスクなし',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2', 'slot_3'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then: slots with "タスクなし" have empty content
      expect(result.get('slot_1')).toBe('Implement feature X.');
      expect(result.get('slot_2')).toBe('');
      expect(result.get('slot_3')).toBe('');
    });

    it('should handle all slots having no task', () => {
      // Given: all slots have no task
      const content = [
        '## slot_1',
        'タスクなし',
        '',
        '## slot_2',
        'タスクなし',
        '',
        '## slot_3',
        'タスクなし',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2', 'slot_3'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then
      expect(result.get('slot_1')).toBe('');
      expect(result.get('slot_2')).toBe('');
      expect(result.get('slot_3')).toBe('');
    });
  });

  // =====================================================
  // 3. Normal: variable slot count (2 slots)
  // =====================================================
  describe('variable slot count', () => {
    it('should parse 2 slots when only 2 are requested', () => {
      // Given: only 2 slot names requested
      const content = [
        '## slot_1',
        'Task A instructions.',
        '',
        '## slot_2',
        'Task B instructions.',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then
      expect(result.size).toBe(2);
      expect(result.get('slot_1')).toBe('Task A instructions.');
      expect(result.get('slot_2')).toBe('Task B instructions.');
    });

    it('should parse single slot', () => {
      // Given: only 1 slot
      const content = [
        '## slot_1',
        'Solo task instructions.',
      ].join('\n');
      const slotNames = ['slot_1'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then
      expect(result.size).toBe(1);
      expect(result.get('slot_1')).toBe('Solo task instructions.');
    });
  });

  // =====================================================
  // 4. Error: no slot headers found
  // =====================================================
  describe('error: no slot headers', () => {
    it('should throw when content has no slot headers', () => {
      // Given: content without any ## slot_N headers
      const content = 'This is just some text without any slot headers.';
      const slotNames = ['slot_1', 'slot_2', 'slot_3'];

      // When/Then: should throw error, NOT fallback
      expect(() => parseSlotSections(content, slotNames)).toThrow();
    });

    it('should throw when content is empty', () => {
      // Given: empty content
      const content = '';
      const slotNames = ['slot_1'];

      // When/Then
      expect(() => parseSlotSections(content, slotNames)).toThrow();
    });
  });

  // =====================================================
  // 5. Error: some expected slot headers missing
  // =====================================================
  describe('error: missing slot headers', () => {
    it('should throw when slot_3 header is missing', () => {
      // Given: content with only slot_1 and slot_2 but expecting 3
      const content = [
        '## slot_1',
        'Task 1 instructions.',
        '',
        '## slot_2',
        'Task 2 instructions.',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2', 'slot_3'];

      // When/Then: should throw — missing slot_3
      expect(() => parseSlotSections(content, slotNames)).toThrow();
    });

    it('should throw when slot_1 header is missing (middle slot present)', () => {
      // Given: slot_2 and slot_3 present but slot_1 missing
      const content = [
        '## slot_2',
        'Task 2 instructions.',
        '',
        '## slot_3',
        'Task 3 instructions.',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2', 'slot_3'];

      // When/Then: should throw — missing slot_1
      expect(() => parseSlotSections(content, slotNames)).toThrow();
    });

    it('should include missing slot names in error message', () => {
      // Given: only slot_1 present
      const content = [
        '## slot_1',
        'Task 1.',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2', 'slot_3'];

      // When/Then: error message should be descriptive
      expect(() => parseSlotSections(content, slotNames)).toThrow(/slot_2|slot_3/);
    });
  });

  // =====================================================
  // 6. Edge: extra text before first slot header
  // =====================================================
  describe('edge: extra text around slots', () => {
    it('should ignore text before the first slot header', () => {
      // Given: preamble text before slot headers
      const content = [
        'Here is the decomposition result:',
        '',
        '## slot_1',
        'Task 1 instructions.',
        '',
        '## slot_2',
        'タスクなし',
        '',
        '## slot_3',
        'タスクなし',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2', 'slot_3'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then: preamble is ignored, slot content is correct
      expect(result.get('slot_1')).toBe('Task 1 instructions.');
    });

    it('should handle trailing whitespace after last section', () => {
      // Given: trailing whitespace/newlines
      const content = [
        '## slot_1',
        'Task 1.',
        '',
        '## slot_2',
        'Task 2.',
        '',
        '',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then: trailing whitespace is trimmed
      expect(result.get('slot_2')).toBe('Task 2.');
    });
  });

  // =====================================================
  // 7. Edge: slot content with nested markdown headers
  // =====================================================
  describe('edge: nested markdown headers in slot content', () => {
    it('should not confuse ### h3 headers with ## slot headers', () => {
      // Given: slot content containing h3 headers
      const content = [
        '## slot_1',
        '### Background',
        'This feature needs auth.',
        '### Implementation',
        'Add JWT token handling.',
        '',
        '## slot_2',
        'タスクなし',
        '',
        '## slot_3',
        'タスクなし',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2', 'slot_3'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then: h3 content belongs to slot_1
      const slot1Content = result.get('slot_1')!;
      expect(slot1Content).toContain('### Background');
      expect(slot1Content).toContain('### Implementation');
      expect(slot1Content).toContain('Add JWT token handling.');
    });

    it('should not confuse ## non-slot headers with slot headers', () => {
      // Given: content with non-slot ## headers within a slot
      const content = [
        '## slot_1',
        '## Background',
        'Some context.',
        '',
        '## slot_2',
        'タスクなし',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then: only ## slot_N are treated as boundaries
      const slot1Content = result.get('slot_1')!;
      expect(slot1Content).toContain('## Background');
      expect(slot1Content).toContain('Some context.');
    });
  });

  // =====================================================
  // 8. Edge: empty slotNames array
  // =====================================================
  describe('edge: empty slotNames', () => {
    it('should throw when slotNames is empty', () => {
      // Given: no slot names requested
      const content = '## slot_1\nSome content.';
      const slotNames: string[] = [];

      // When/Then: should throw — no slots to parse
      expect(() => parseSlotSections(content, slotNames)).toThrow();
    });
  });

  // =====================================================
  // 9. Header matching with suffixes (word boundary)
  // =====================================================
  describe('header matching with suffixes', () => {
    it('should match header without suffix', () => {
      // Given: standard header with no suffix
      const content = [
        '## slot_1',
        'Task 1 instructions.',
        '',
        '## slot_2',
        'Task 2 instructions.',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then: both slots are parsed
      expect(result.get('slot_1')).toBe('Task 1 instructions.');
      expect(result.get('slot_2')).toBe('Task 2 instructions.');
    });

    it('should match header with colon suffix', () => {
      // Given: LLM output with colon + text after slot name
      const content = [
        '## slot_1: 認証モジュール実装',
        'Implement user authentication.',
        '',
        '## slot_2: DB移行',
        'Add database migration.',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then: slots are parsed despite colon suffix
      expect(result.get('slot_1')).toContain('Implement user authentication.');
      expect(result.get('slot_2')).toContain('Add database migration.');
    });

    it('should match header with space suffix', () => {
      // Given: LLM output with space + text after slot name
      const content = [
        '## slot_1 タスク名',
        'Task 1 body.',
        '',
        '## slot_2 別タスク',
        'Task 2 body.',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then: slots are parsed despite space suffix
      expect(result.get('slot_1')).toContain('Task 1 body.');
      expect(result.get('slot_2')).toContain('Task 2 body.');
    });

    it('should not match slot_10 when searching for slot_1', () => {
      // Given: slot_10 header exists but we search for slot_1
      const content = [
        '## slot_10',
        'This is slot 10 content.',
        '',
        '## slot_2',
        'This is slot 2 content.',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2'];

      // When/Then: should throw because slot_1 is missing (slot_10 must not match)
      expect(() => parseSlotSections(content, slotNames)).toThrow(/slot_1/);
    });
  });
});
