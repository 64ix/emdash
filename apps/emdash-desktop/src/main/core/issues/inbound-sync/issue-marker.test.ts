import { describe, expect, it } from 'vitest';
import { parseEmdashTaskMarker } from './issue-marker';

describe('parseEmdashTaskMarker', () => {
  it('parses a marker on the final line', () => {
    const body = ['## Summary', '', 'Some spec content.', '', 'Emdash-Task: abc-123'].join('\n');
    expect(parseEmdashTaskMarker(body)).toBe('abc-123');
  });

  it('parses a marker with no trailing newline', () => {
    expect(parseEmdashTaskMarker('Body.\nEmdash-Task: task-1')).toBe('task-1');
  });

  it('tolerates surrounding whitespace on the marker line', () => {
    expect(parseEmdashTaskMarker('Body.\nEmdash-Task:   task-1   ')).toBe('task-1');
  });

  it('returns null when no marker line is present', () => {
    expect(parseEmdashTaskMarker('Just a regular issue body.')).toBeNull();
  });

  it('returns null for an empty or missing body', () => {
    expect(parseEmdashTaskMarker('')).toBeNull();
    expect(parseEmdashTaskMarker(null)).toBeNull();
    expect(parseEmdashTaskMarker(undefined)).toBeNull();
  });

  it('does not match the marker embedded mid-sentence', () => {
    const body = 'This mentions Emdash-Task: task-1 in prose, not as its own line.';
    expect(parseEmdashTaskMarker(body)).toBeNull();
  });

  it('is case-sensitive to the documented marker prefix', () => {
    expect(parseEmdashTaskMarker('emdash-task: task-1')).toBeNull();
  });

  it('takes the last marker line when the body was edited to add another', () => {
    const body = ['Emdash-Task: old-task', 'More notes.', 'Emdash-Task: new-task'].join('\n');
    expect(parseEmdashTaskMarker(body)).toBe('new-task');
  });

  it('returns null for a marker line with no id', () => {
    expect(parseEmdashTaskMarker('Emdash-Task: ')).toBeNull();
  });
});
