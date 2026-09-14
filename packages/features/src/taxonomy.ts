import type { EventType } from "@builder/types";

/**
 * Event-type groupings used by feature extraction.
 *
 * Deliberately expressed over Doc 2 §4 event types rather than tool names. Tool
 * names are agent-specific — Claude Code says `Read`, Cursor says something
 * else — so classifying on them would make every feature need per-adapter
 * knowledge. Event types are the normalized layer; that is what they are for.
 */

/** Reading and looking around: the observable shape of orienting before acting. */
export const EXPLORATION_EVENTS: ReadonlySet<EventType> = new Set(["file_read"]);

/** Changing the world. The first of these marks the end of upfront exploration. */
export const MUTATION_EVENTS: ReadonlySet<EventType> = new Set([
  "file_write",
  "file_edit",
  "git_commit",
  "deployment",
]);

/** Doc 2 §6 debugging family. */
export const FAILURE_EVENTS: ReadonlySet<EventType> = new Set(["test_failure"]);

export const SHIPPING_EVENTS: ReadonlySet<EventType> = new Set(["git_commit", "deployment"]);

export function isExploration(t: EventType): boolean {
  return EXPLORATION_EVENTS.has(t);
}

export function isMutation(t: EventType): boolean {
  return MUTATION_EVENTS.has(t);
}
