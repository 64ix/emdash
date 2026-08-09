import { describe, expect, it } from 'vitest';
import { formatRunError } from './automation-run-format';

describe('formatRunError', () => {
  it('renders the project_unattached failure (ticket #138) as a user-facing message', () => {
    expect(
      formatRunError({ step: 'create_task', code: 'project_unattached' })
    ).toBe(
      'This project has no repository workspace on this machine — attach it before running'
    );
  });

  it('keeps existing create_task messages intact', () => {
    expect(formatRunError({ step: 'create_task', code: 'project_not_found' })).toBe(
      'Project could not be found or opened'
    );
  });
});
