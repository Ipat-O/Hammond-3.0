import type { ComposedLayers } from './types';

/**
 * Composes the four instruction layers in the fixed order: shared role,
 * provider variant, project override, optional task work order. An empty
 * string omits that layer; whitespace-only content is content and is kept.
 * Included layers are joined with exactly two newline characters. Pure and
 * side-effect free: no filesystem, network, or mutation of its input.
 */
export function composeInstructions(layers: ComposedLayers): string {
  return [layers.sharedRole, layers.provider, layers.projectOverride, layers.taskWorkOrder]
    .filter((layer) => layer.length > 0)
    .join('\n\n');
}
