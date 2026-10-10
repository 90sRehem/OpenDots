import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { WorkspaceDialog } from '../src/client/WorkspaceDialog';
import type { Dot, State, WorkspaceState } from '../src/shared/types';

// The Automatic Learning copy describes local delivery. It must not still ask the
// owner to create a container in Intelligence or enable delivery there.

const dot: Dot = {
  id: 'dot1',
  spaceId: 'space',
  spaceIds: ['space'],
  name: 'Research Dot',
  instructions: 'Research carefully.',
  researchAllowed: true,
  memoryAllowed: true,
  createdAt: 0,
  learningContainerId: 'research-workflow',
  skillDeliveryEnabled: true,
  learningEnabled: false,
};

const state = {
  settings: {
    name: 'Owner',
    paused: false,
    researchAllowed: true,
    memoryAllowed: true,
  },
  tasks: [],
  memories: [],
  mode: 'live',
  configured: true,
} as unknown as State;

const workspace = {
  spaces: [],
  dots: [dot],
  conversations: [],
  setup: { missing: [] },
  calls: [],
} as unknown as WorkspaceState;

/** The Automatic Learning fieldset, and nothing outside it. */
function learningFieldset(markup: string) {
  const start = markup.indexOf('<fieldset');
  const legendAt = markup.indexOf('Automatic Learning', start);
  const end = markup.indexOf('</fieldset>', legendAt);
  if (start < 0 || legendAt < 0 || end < 0)
    throw new Error('Automatic Learning fieldset not rendered.');
  return markup.slice(start, end);
}

it('describes local delivery and drops the Intelligence container for the Dot', () => {
  const markup = renderToStaticMarkup(
    <WorkspaceDialog
      dialog={{ type: 'dot', dot, spaceId: 'space' }}
      state={state}
      workspace={workspace}
      onClose={() => {}}
      mutate={async () => true}
    />,
  );
  const fieldset = learningFieldset(markup);
  expect(fieldset).toContain('Nothing is sent to Intelligence.');
  expect(fieldset).toContain('Use approved lessons');
  expect(fieldset).toContain('Learn from future conversations');
  expect(fieldset).toContain('Review lessons');
  expect(fieldset).not.toContain('container');
  expect(fieldset).not.toContain('Create this container');
  expect(fieldset).not.toContain('Enable delivery in Intelligence');
  expect(fieldset).not.toContain('copilotkit.ai/learning');
  expect(fieldset).not.toContain('Set up Learning');
  expect(markup).not.toContain('learning-container');
});

it('asks for a saved Dot before lessons can be reviewed for a new Dot', () => {
  const markup = renderToStaticMarkup(
    <WorkspaceDialog
      dialog={{ type: 'dot', spaceId: 'space' }}
      state={state}
      workspace={workspace}
      onClose={() => {}}
      mutate={async () => true}
    />,
  );
  const fieldset = learningFieldset(markup);
  expect(fieldset).toContain('Save this Dot to write or review lessons.');
  expect(fieldset).not.toContain('Review lessons');
  expect(fieldset).not.toContain('Learn from future conversations');
});
