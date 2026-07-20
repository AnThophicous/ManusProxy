export type ManusModel = {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  /** maps to Manus task/chat mode when known */
  mode?: string;
};

const NOW = Math.floor(Date.now() / 1000);

export const MANUS_MODELS: ManusModel[] = [
  {
    id: 'manus',
    object: 'model',
    created: NOW,
    owned_by: 'manus',
    mode: 'chat',
  },
  {
    id: 'manus-chat',
    object: 'model',
    created: NOW,
    owned_by: 'manus',
    mode: 'chat',
  },
  {
    id: 'manus-agent',
    object: 'model',
    created: NOW,
    owned_by: 'manus',
    mode: 'agent',
  },
  {
    id: 'manus-adaptive',
    object: 'model',
    created: NOW,
    owned_by: 'manus',
    mode: 'adaptive',
  },
];

export function resolveMode(modelId: string): string {
  const hit = MANUS_MODELS.find((m) => m.id === modelId);
  return hit?.mode || 'chat';
}
