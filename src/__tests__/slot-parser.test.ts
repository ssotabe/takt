/**
 * Unit tests for slot-parser module.
 *
 * Tests parseSlotSections: parsing decomposed output into per-slot
 * instruction sections based on ## headers with word boundary matching.
 */

import { describe, it, expect } from 'vitest';
import { parseSlotSections } from '../core/workflow/engine/slot-parser.js';

describe('parseSlotSections', () => {
  describe('正常系', () => {
    it('should parse two slot sections from content', () => {
      // Given
      const content = [
        '## slot_1',
        'Implement feature A',
        '',
        '## slot_2',
        'Implement feature B',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then
      expect(result.get('slot_1')).toBe('Implement feature A');
      expect(result.get('slot_2')).toBe('Implement feature B');
    });

    it('should parse three slot sections', () => {
      // Given
      const content = [
        '## slot_1',
        'Task A',
        '',
        '## slot_2',
        'Task B',
        '',
        '## slot_3',
        'Task C',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2', 'slot_3'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then
      expect(result.size).toBe(3);
      expect(result.get('slot_1')).toBe('Task A');
      expect(result.get('slot_2')).toBe('Task B');
      expect(result.get('slot_3')).toBe('Task C');
    });

    it('should include non-slot ## headers as part of preceding slot content', () => {
      // Given: ## Background is not a slot header, should be included in slot_1's content
      const content = [
        '## slot_1',
        'Main task',
        '## Background',
        'Some context',
        '',
        '## slot_2',
        'Other task',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then
      expect(result.get('slot_1')).toBe('Main task\n## Background\nSome context');
      expect(result.get('slot_2')).toBe('Other task');
    });

    it('should handle slots appearing in non-alphabetical order in content', () => {
      // Given: slot_2 appears before slot_1 in the content
      const content = [
        '## slot_2',
        'Second task',
        '',
        '## slot_1',
        'First task',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then
      expect(result.get('slot_2')).toBe('Second task');
      expect(result.get('slot_1')).toBe('First task');
    });

    it('should convert タスクなし marker to empty string', () => {
      // Given
      const content = [
        '## slot_1',
        'Real task',
        '',
        '## slot_2',
        'タスクなし',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then
      expect(result.get('slot_1')).toBe('Real task');
      expect(result.get('slot_2')).toBe('');
    });

    it('should trim whitespace around slot content', () => {
      // Given
      const content = [
        '## slot_1',
        '',
        '  Some content  ',
        '',
        '## slot_2',
        'Other content',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then
      expect(result.get('slot_1')).toBe('Some content');
      expect(result.get('slot_2')).toBe('Other content');
    });

    it('should include trailing content in last slot', () => {
      // Given
      const content = [
        '## slot_1',
        'Task description',
        '',
        'Additional details',
        'More info',
      ].join('\n');
      const slotNames = ['slot_1'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then
      expect(result.get('slot_1')).toBe('Task description\n\nAdditional details\nMore info');
    });
  });

  describe('word boundary matching (Feature F)', () => {
    it('should not match slot_10 header when looking for slot_1', () => {
      // Given: word boundary prevents partial match
      const content = [
        '## slot_10',
        'Task for slot 10',
        '',
        '## slot_1',
        'Task for slot 1',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_10'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then
      expect(result.get('slot_1')).toBe('Task for slot 1');
      expect(result.get('slot_10')).toBe('Task for slot 10');
    });

    it('should handle slot names with special regex characters', () => {
      // Given: slot name containing regex special chars
      const content = [
        '## slot.special',
        'Task content',
      ].join('\n');
      const slotNames = ['slot.special'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then
      expect(result.get('slot.special')).toBe('Task content');
    });
  });

  describe('異常系', () => {
    it('should throw when slotNames is empty', () => {
      // Given
      const content = '## slot_1\nSome content';
      const slotNames: string[] = [];

      // When / Then
      expect(() => parseSlotSections(content, slotNames)).toThrow(
        'slotNames must not be empty',
      );
    });

    it('should throw when a slot header is missing from content', () => {
      // Given
      const content = [
        '## slot_1',
        'Task content',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2'];

      // When / Then
      expect(() => parseSlotSections(content, slotNames)).toThrow(
        'Missing slot headers: slot_2',
      );
    });

    it('should throw listing all missing slot headers', () => {
      // Given
      const content = 'No headers here';
      const slotNames = ['slot_1', 'slot_2', 'slot_3'];

      // When / Then
      expect(() => parseSlotSections(content, slotNames)).toThrow(
        'Missing slot headers: slot_1, slot_2, slot_3',
      );
    });
  });

  describe('境界値', () => {
    it('should handle single slot with minimal content', () => {
      // Given
      const content = '## slot_1\nX';
      const slotNames = ['slot_1'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then
      expect(result.get('slot_1')).toBe('X');
    });

    it('should handle slot with only whitespace content', () => {
      // Given
      const content = '## slot_1\n   \n  \n';
      const slotNames = ['slot_1'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then
      expect(result.get('slot_1')).toBe('');
    });

    it('should handle content with preamble before first slot', () => {
      // Given: content before the first slot header should be ignored
      const content = [
        'Preamble text',
        '',
        '## slot_1',
        'Task content',
      ].join('\n');
      const slotNames = ['slot_1'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then
      expect(result.get('slot_1')).toBe('Task content');
    });

    it('should handle multiline slot content preserving internal structure', () => {
      // Given
      const content = [
        '## slot_1',
        '### Sub-heading',
        '- Item 1',
        '- Item 2',
        '',
        'Paragraph',
        '',
        '## slot_2',
        'Simple task',
      ].join('\n');
      const slotNames = ['slot_1', 'slot_2'];

      // When
      const result = parseSlotSections(content, slotNames);

      // Then
      expect(result.get('slot_1')).toBe('### Sub-heading\n- Item 1\n- Item 2\n\nParagraph');
      expect(result.get('slot_2')).toBe('Simple task');
    });
  });
});
