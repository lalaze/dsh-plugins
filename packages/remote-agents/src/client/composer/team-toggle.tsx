import React from 'react';
import { decorateSlotEntry, type CatalogEntry, type CatalogSlots } from '../sessions/delegated-model.js';
import { useCurrentModel } from './usage.js';

/** DSH's "Use agent teams" switch in the model and reasoning menu (`@deepseek-ai/dsh-client-ui-agent-team`). */
export const TEAM_SLOT = 'conversation.input.model.options';
export const TEAM_ID = 'agent-team';
const remote = (provider: string) => provider === 'remote-cli' || provider.startsWith('remote-cli-');

/**
 * Hide DSH's agent-team switch while a conversation's model is a remote CLI. The team mode only adds task tools and a
 * prompt to DSH's own model requests; a CLI receives neither, so the switch did nothing there. It shows again as soon as
 * a native model is selected, with the conversation's saved choice unchanged.
 */
export function installTeamToggleFilter(slots: CatalogSlots<React.ComponentType<any>>): () => void {
  return decorateSlotEntry(slots, TEAM_SLOT, TEAM_ID, (original: CatalogEntry<React.ComponentType<any>>) => {
    const Native = original.component;
    const NativeModelsOnly = (props: { sessionId?: string }) => {
      const selection = useCurrentModel(props.sessionId);
      return selection && remote(selection.provider) ? null : <Native {...props} />;
    };
    return NativeModelsOnly;
  });
}
